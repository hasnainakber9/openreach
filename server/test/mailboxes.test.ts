import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE } from '../src/clock.js';
import type { Sequence } from '../src/engine/sequence.js';
import { composeEmail, newMessageId } from '../src/mail/compose.js';
import { checkDomain, type DnsResolver } from '../src/mail/deliverability.js';
import { findParts, imapError, parseDeliveryStatus, type InboundEmail } from '../src/mail/imap.js';
import { syncJobKey } from '../src/mail/inbound.js';
import { effectiveDailyLimit, ensureLegacyMailboxes, isReservedAddress, retireMailbox, setCampaignMailboxes } from '../src/mail/mailboxes.js';
import { signToken } from '../src/mail/tracking.js';
import { MailError } from '../src/services/email.js';
import type { CampaignLeadRow, EmailMessageRow, LeadRow, MailboxRow } from '../src/types.js';
import { addLeads, fakeImap, mailerOf, makeApi, makeCampaign, makeWorld, runFor, type World } from './helpers.js';

const oneEmail: Sequence = { start: 'e', nodes: { e: { id: 'e', type: 'email', subject: 'Hello {{firstName}}', body: 'Hi {{firstName}}, see https://acme.dev/offer?x=1 for details.', next: null } } };
const twoEmails: Sequence = {
  start: 'e1',
  nodes: {
    e1: { id: 'e1', type: 'email', subject: 'Quick idea for {{company}}', body: 'Hi {{firstName}}', next: 'w' },
    w: { id: 'w', type: 'wait', days: 1, hours: 0, next: 'e2' },
    e2: { id: 'e2', type: 'email', subject: 'Following up', body: 'Bumping this, {{firstName}}.', replyInThread: true, next: null },
  },
};

function addMailbox(w: World, o: Record<string, any> = {}): number {
  const real = o.provider === 'smtp';
  return w.ctx.db.insert('mailboxes', {
    workspace_id: w.workspaceId,
    name: o.name ?? 'Box',
    provider: 'simulated',
    from_name: 'Sara Seller',
    from_email: o.from_email ?? 'sara@sender.dev',
    work_days: '[0,1,2,3,4,5,6]',
    daily_limit: 40,
    warmup: 0,
    gap_min_sec: 60,
    gap_max_sec: 120,
    created_at: w.ctx.clock.now(),
    ...(real ? { smtp_enc: w.ctx.sealer.seal(JSON.stringify({ host: 'smtp.sender.dev', port: 465, secure: true, user: 'sara@sender.dev', pass: 'app-password-1234' })) } : {}),
    ...o,
  });
}

function emailLeads(w: World, n: number, domain = 'acme.dev', prefix = 'lead') {
  const ids = addLeads(w, n, prefix);
  ids.forEach((id, i) => w.ctx.db.run('UPDATE leads SET email = ? WHERE id = ?', [`person${i}@${domain}`, id]));
  return ids;
}

function emailCampaign(w: World, seq: Sequence, leads: number[], mailboxes: number[], settings: Record<string, unknown> = {}) {
  const c = makeCampaign(w, seq, settings, leads, []);
  setCampaignMailboxes(w.ctx, c.id, mailboxes);
  return c;
}

const sentRows = (w: World, campaignId?: number) =>
  w.ctx.db.all<EmailMessageRow>(`SELECT * FROM email_messages WHERE direction = 'out'${campaignId ? ' AND campaign_id = ?' : ''} ORDER BY id`, campaignId ? [campaignId] : []);
const lead = (w: World, id: number) => w.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id])!;
const cl = (w: World, campaignId: number, leadId: number) => w.ctx.db.get<CampaignLeadRow>('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?', [campaignId, leadId])!;
const mailbox = (w: World, id: number) => w.ctx.db.get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', [id])!;

function inbound(o: Partial<InboundEmail> & { uid: number; from: string }): InboundEmail {
  return { messageId: `<in-${o.uid}@remote.dev>`, inReplyTo: null, references: [], fromName: '', subject: 'Re: hello', date: Date.now(), text: 'Thanks, interested!', ...o };
}

describe('mailbox limits and warm-up', () => {
  it('ramps the daily limit from the start value to the full limit over the warm-up days', () => {
    const base = { daily_limit: 40, warmup: 1, warmup_days: 14, warmup_start: 5, created_at: 0 };
    expect(effectiveDailyLimit(base, 0)).toBe(5);
    expect(effectiveDailyLimit(base, 7 * DAY)).toBe(22);
    expect(effectiveDailyLimit(base, 14 * DAY)).toBe(40);
    expect(effectiveDailyLimit(base, 60 * DAY)).toBe(40);
    expect(effectiveDailyLimit({ ...base, warmup: 0 }, 0)).toBe(40);
    // A start above the limit never exceeds the limit.
    expect(effectiveDailyLimit({ ...base, daily_limit: 3, warmup_start: 10 }, 0)).toBe(3);
  });

  it('sends within the daily limit, the sending window and the random gaps', async () => {
    const w = makeWorld();
    const mb = addMailbox(w, { daily_limit: 3, gap_min_sec: 600, gap_max_sec: 600, work_days: '[1,2,3,4,5]', work_start: '09:00', work_end: '17:00' });
    const leads = emailLeads(w, 6);
    const { id } = emailCampaign(w, oneEmail, leads, [mb]);
    await runFor(w, 16 * HOUR);
    const monday = sentRows(w, id);
    expect(monday).toHaveLength(3);
    for (const r of monday) {
      const h = new Date(r.sent_at).getUTCHours();
      expect(h >= 9 && h < 17).toBe(true);
    }
    for (let i = 1; i < monday.length; i++) expect(monday[i].sent_at - monday[i - 1].sent_at).toBeGreaterThanOrEqual(10 * MINUTE);
    await runFor(w, DAY);
    expect(sentRows(w, id)).toHaveLength(6);
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE type = 'email' AND status = 'ok' AND mailbox_id = ? AND account_id IS NULL", [mb])!.n).toBe(6);
  });

  it('applies the warm-up ramp to a new mailbox', async () => {
    const w = makeWorld();
    const mb = addMailbox(w, { warmup: 1, warmup_start: 2, warmup_days: 10, daily_limit: 30 });
    const { id } = emailCampaign(w, oneEmail, emailLeads(w, 8), [mb]);
    await runFor(w, 12 * HOUR);
    expect(sentRows(w, id)).toHaveLength(2);
  });

  it('never sends twice when two ticks overlap', async () => {
    const w = makeWorld();
    const mb = addMailbox(w);
    emailCampaign(w, oneEmail, emailLeads(w, 3), [mb]);
    const fake = mailerOf(w);
    const send = fake.send;
    fake.send = async (t, m) => {
      await new Promise((r) => setTimeout(r, 20));
      return send(t, m);
    };
    w.ctx.clock.advance(MINUTE);
    await Promise.all([w.engine.mail.tick(), w.engine.mail.tick()]);
    expect(fake.sent).toHaveLength(1);
  });
});

describe('mailbox rotation', () => {
  it('spreads leads across mailboxes and keeps each lead on its mailbox, threading the follow-up', async () => {
    const w = makeWorld();
    const a = addMailbox(w, { name: 'A', daily_limit: 2, from_email: 'a@sender.dev' });
    const b = addMailbox(w, { name: 'B', daily_limit: 2, from_email: 'b@sender.dev' });
    const leads = emailLeads(w, 4);
    const { id } = emailCampaign(w, twoEmails, leads, [a, b], { stopOnReply: false });
    await runFor(w, 3 * DAY);
    const rows = sentRows(w, id);
    expect(rows).toHaveLength(8);
    // Each mailbox took two leads, and never more than its limit on one day.
    const firsts = rows.filter((r) => r.node_id === 'e1');
    expect(firsts.filter((r) => r.mailbox_id === a)).toHaveLength(2);
    expect(firsts.filter((r) => r.mailbox_id === b)).toHaveLength(2);
    for (const l of leads) {
      const mine = rows.filter((r) => r.lead_id === l);
      expect(new Set(mine.map((r) => r.mailbox_id)).size).toBe(1);
      const [first, second] = mine;
      expect(cl(w, id, l).mailbox_id).toBe(first.mailbox_id);
      expect(second.in_reply_to).toBe(first.message_id);
      expect(second.refs).toBe(first.message_id);
      expect(second.subject).toBe(`Re: ${first.subject}`);
      expect(second.conversation_id).toBe(first.conversation_id);
    }
    const perDay = w.ctx.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE type = 'email' AND status = 'ok' GROUP BY mailbox_id, day");
    expect(Math.max(...perDay.map((r) => r.n))).toBeLessThanOrEqual(2);
    // The second email went out as a real reply.
    const followUp = mailerOf(w).sent.find((s) => s.msg.subject.startsWith('Re:'))!;
    expect(followUp.msg.inReplyTo).toMatch(/^<.+@sender\.dev>$/);
    expect(followUp.msg.references).toHaveLength(1);
  });

  it('hands unstarted leads of a paused mailbox to the other one', async () => {
    const w = makeWorld();
    const a = addMailbox(w, { name: 'A' });
    const b = addMailbox(w, { name: 'B' });
    w.ctx.db.run("UPDATE mailboxes SET status = 'paused' WHERE id = ?", [a]);
    const { id } = emailCampaign(w, oneEmail, emailLeads(w, 3), [a, b]);
    await runFor(w, 2 * HOUR);
    expect(sentRows(w, id).every((r) => r.mailbox_id === b)).toBe(true);
    expect(sentRows(w, id)).toHaveLength(3);
  });
});

describe('composing emails', () => {
  it('builds Message-ID, threading, plain text + HTML and the unsubscribe headers', () => {
    const messageId = newMessageId('sara@sender.dev', () => 0.5);
    expect(messageId).toMatch(/^<[a-z0-9.]+@sender\.dev>$/);
    const msg = composeEmail({
      from: '"Sara" <sara@sender.dev>',
      fromEmail: 'sara@sender.dev',
      to: 'ann@acme.dev',
      subject: 'ignored when threaded',
      body: 'Hi <Ann>,\nsee https://acme.dev/x.\n\nBye',
      signature: 'Sara\nSender Inc',
      messageId,
      thread: { inReplyTo: '<one@sender.dev>', references: ['<root@sender.dev>', '<one@sender.dev>'], subject: 'Hello Ann' },
      links: { unsubscribe: 'https://app.dev/u/tok', openPixel: null, click: null },
    });
    expect(msg.subject).toBe('Re: Hello Ann');
    expect(msg.inReplyTo).toBe('<one@sender.dev>');
    expect(msg.references).toEqual(['<root@sender.dev>', '<one@sender.dev>']);
    expect(msg.headers!['List-Unsubscribe']).toBe('<https://app.dev/u/tok>, <mailto:sara@sender.dev?subject=unsubscribe>');
    expect(msg.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(msg.text).toContain('-- \nSara\nSender Inc');
    expect(msg.text).toContain('Unsubscribe: https://app.dev/u/tok');
    expect(msg.html).toContain('Hi &lt;Ann&gt;,<br>see <a href="https://acme.dev/x">https://acme.dev/x</a>.');
    expect(msg.html).not.toContain('<img');
    // Inbox replies carry no footer or list headers.
    const reply = composeEmail({ from: 'sara@sender.dev', fromEmail: 'sara@sender.dev', to: 'a@b.dev', subject: 'Re: x', body: 'ok', messageId, footer: false, links: { unsubscribe: 'https://app.dev/u/t' } });
    expect(reply.headers).toEqual({});
    expect(reply.text).toBe('ok');
  });

  it('sends campaign email from a real mailbox with an unsubscribe link and no tracking by default', async () => {
    const w = makeWorld();
    const mb = addMailbox(w, { provider: 'smtp' });
    emailCampaign(w, oneEmail, emailLeads(w, 1), [mb]);
    await runFor(w, 30 * MINUTE);
    const [sent] = mailerOf(w).sent;
    expect(sent.transport).toMatchObject({ host: 'smtp.sender.dev', port: 465, secure: true });
    expect(sent.msg.from).toBe('"Sara Seller" <sara@sender.dev>');
    expect(sent.msg.messageId).toMatch(/@sender\.dev>$/);
    expect(sent.msg.headers!['List-Unsubscribe']).toMatch(/^<http:\/\/localhost:8787\/u\/\d+\.\d+\.\d+\.[\w-]{22}>, <mailto:sara@sender\.dev\?subject=unsubscribe>$/);
    expect(sent.msg.html).not.toContain('/t/o/');
    expect(sent.msg.html).not.toContain('/t/c/');
    expect(sent.msg.html).toContain('href="https://acme.dev/offer?x=1"');
    expect(sentRows(w)[0].status).toBe('sent');
  });

  it('never sends to a reserved test address from a real mailbox', async () => {
    const w = makeWorld();
    const mb = addMailbox(w, { provider: 'smtp' });
    const { id } = emailCampaign(w, oneEmail, emailLeads(w, 1, 'initech.example'), [mb]);
    await runFor(w, 30 * MINUTE);
    expect(mailerOf(w).sent).toHaveLength(0);
    expect(w.ctx.db.get<{ status: string; detail: string }>("SELECT status, detail FROM activity WHERE type = 'email' AND campaign_id = ?", [id])).toMatchObject({ status: 'skipped', detail: expect.stringMatching(/reserved test address/) });
    expect(isReservedAddress('x@foo.test')).toBe(true);
    expect(isReservedAddress('x@example.com')).toBe(true);
    expect(isReservedAddress('x@examples.com')).toBe(false);
  });

  it('puts a real mailbox on needs attention without PUBLIC_URL or when SMTP refuses the login', async () => {
    const w = makeWorld();
    const mb = addMailbox(w, { provider: 'smtp' });
    const leads = emailLeads(w, 2);
    const { id } = emailCampaign(w, oneEmail, leads, [mb]);
    const events: string[] = [];
    w.ctx.webhooks.subscribe((_ws, e) => events.push(e));
    w.ctx.config.publicUrl = undefined;
    await runFor(w, 10 * MINUTE);
    expect(mailbox(w, mb)).toMatchObject({ status: 'needs_attention', status_message: expect.stringMatching(/PUBLIC_URL/) });
    expect(mailerOf(w).sent).toHaveLength(0);

    w.ctx.config.publicUrl = 'http://localhost:8787';
    w.ctx.db.run("UPDATE mailboxes SET status = 'active' WHERE id = ?", [mb]);
    mailerOf(w).failures.push(new MailError('AUTH', 'Invalid login: 535 5.7.8'));
    await runFor(w, 10 * MINUTE);
    expect(mailbox(w, mb)).toMatchObject({ status: 'needs_attention', status_message: expect.stringMatching(/SMTP login refused/) });
    expect(events.filter((e) => e === 'mailbox.needs_attention')).toHaveLength(2);
    expect(sentRows(w, id).map((r) => r.status)).toEqual(['failed']);
    // Nothing went out, so the lead is free again: not pinned to the broken mailbox.
    expect(leads.map((l) => cl(w, id, l))).toEqual(leads.map(() => expect.objectContaining({ state: 'active', mailbox_id: null })));

    // A second mailbox takes over; removing the broken one doesn't skip leads it never reached.
    const other = addMailbox(w, { provider: 'smtp', from_email: 'tom@sender.dev' });
    setCampaignMailboxes(w.ctx, id, [mb, other]);
    retireMailbox(w.ctx, mb);
    await runFor(w, 30 * MINUTE);
    expect(leads.map((l) => cl(w, id, l).state)).toEqual(['done', 'done']);
    expect(sentRows(w, id).filter((r) => r.status === 'sent').map((r) => r.mailbox_id)).toEqual([other, other]);
  });
});

describe('unsubscribe and tracking links', () => {
  async function sentWorld(settings: Record<string, unknown> = {}) {
    const w = makeWorld();
    const mb = addMailbox(w, { provider: 'smtp' });
    const leads = emailLeads(w, 1);
    const c = emailCampaign(w, oneEmail, leads, [mb], settings);
    await runFor(w, 30 * MINUTE);
    const api = await makeApi(w);
    const row = sentRows(w)[0];
    const p = { workspaceId: w.workspaceId, leadId: leads[0], emailMessageId: row.id };
    return { w, api, leadId: leads[0], campaignId: c.id, row, p, msg: mailerOf(w).sent[0].msg };
  }

  it('asks on GET and unsubscribes on the one-click POST, stopping every campaign', async () => {
    const { w, api, leadId, msg } = await sentWorld();
    // Also running in a LinkedIn campaign.
    const other = makeCampaign(w, { start: 'v', nodes: { v: { id: 'v', type: 'wait', days: 5, hours: 0, next: null } } }, { skipIfInOtherCampaign: false }, [leadId]);
    const url = /<(http[^>]+)>/.exec(msg.headers!['List-Unsubscribe'])![1].replace('http://localhost:8787', '');

    const page = await api.app.inject({ method: 'GET', url });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<form method="post">');
    expect(w.ctx.db.get('SELECT 1 FROM suppressions WHERE lead_id = ?', [leadId])).toBeUndefined();

    const post = await api.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(post.statusCode).toBe(200);
    expect(post.body).toContain('unsubscribed');
    expect(w.ctx.db.all<{ kind: string; reason: string }>('SELECT kind, reason FROM suppressions WHERE lead_id = ? ORDER BY kind', [leadId])).toEqual([
      { kind: 'email', reason: 'unsubscribe' },
      { kind: 'linkedin', reason: 'unsubscribe' },
    ]);
    expect(cl(w, other.id, leadId).state).toBe('skipped');
    // Again: still fine.
    expect((await api.app.inject({ method: 'POST', url })).statusCode).toBe(200);
  });

  it('refuses bad or tampered tokens', async () => {
    const { w, api, p } = await sentWorld();
    expect((await api.app.inject({ method: 'GET', url: '/u/nonsense' })).statusCode).toBe(404);
    const good = signToken(w.ctx, 'u', p);
    const tampered = good.replace(/^\d+/, String(p.workspaceId + 1));
    expect((await api.app.inject({ method: 'POST', url: `/u/${tampered}` })).statusCode).toBe(404);
    // An open-pixel token is not an unsubscribe token.
    expect((await api.app.inject({ method: 'POST', url: `/u/${signToken(w.ctx, 'o', p)}` })).statusCode).toBe(404);
    expect(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM suppressions')!.n).toBe(0);
  });

  it('tracks opens and clicks only when turned on, and redirects only to signed URLs', async () => {
    const { w, api, msg, row } = await sentWorld({ trackOpens: true, trackClicks: true });
    const pixel = /src="http:\/\/localhost:8787(\/t\/o\/[^"]+)"/.exec(msg.html!)![1];
    const click = /href="http:\/\/localhost:8787(\/t\/c\/[^"]+)"/.exec(msg.html!)![1].replace(/&amp;/g, '&');
    const gif = await api.app.inject({ method: 'GET', url: pixel });
    expect(gif.headers['content-type']).toBe('image/gif');
    await api.app.inject({ method: 'GET', url: pixel });
    const go = await api.app.inject({ method: 'GET', url: click });
    expect(go.statusCode).toBe(302);
    expect(go.headers.location).toBe('https://acme.dev/offer?x=1');
    const evil = click.replace(encodeURIComponent('https://acme.dev/offer?x=1'), encodeURIComponent('https://evil.dev/'));
    expect((await api.app.inject({ method: 'GET', url: evil })).statusCode).toBe(404);
    expect(w.ctx.db.get('SELECT open_count, click_count FROM email_messages WHERE id = ?', [row.id])).toEqual({ open_count: 2, click_count: 1 });
    expect(w.ctx.db.all("SELECT type FROM activity WHERE type IN ('email_open', 'email_click') ORDER BY id").map((r: any) => r.type)).toEqual(['email_open', 'email_click']);
  });
});

describe('reply and bounce detection', () => {
  async function sentToFour() {
    const w = makeWorld();
    const mb = addMailbox(w, { provider: 'smtp', imap_enc: 'set-below' });
    w.ctx.db.run('UPDATE mailboxes SET imap_enc = ? WHERE id = ?', [w.ctx.sealer.seal(JSON.stringify({ host: 'imap.sender.dev', port: 993, secure: true, user: 'sara@sender.dev', pass: 'app-password-1234' })), mb]);
    const leads = emailLeads(w, 4);
    const c = emailCampaign(w, twoEmails, leads, [mb]);
    await runFor(w, 2 * HOUR);
    expect(sentRows(w, c.id)).toHaveLength(4);
    return { w, mb, leads, campaignId: c.id, sent: (l: number) => sentRows(w, c.id).find((r) => r.lead_id === l)! };
  }

  it('matches replies by In-Reply-To, References and sender address, ignores the rest, and stops the sequence', async () => {
    const { w, mb, leads, campaignId, sent } = await sentToFour();
    const now = w.ctx.clock.now();
    const mail = [
      inbound({ uid: 1, from: 'person0@acme.dev', inReplyTo: sent(leads[0]).message_id, date: now, text: 'Sounds good, call me.\n\nOn Mon, Sara wrote:\n> Hi' }),
      inbound({ uid: 2, from: 'someone-else@acme.dev', references: ['<unknown@x.dev>', sent(leads[1]).message_id], date: now }),
      inbound({ uid: 3, from: 'PERSON2@acme.dev'.toLowerCase(), subject: 'question', date: now }),
      inbound({ uid: 4, from: 'stranger@elsewhere.dev', date: now }),
    ];
    let calls = 0;
    w.ctx.imap = () => fakeImap(() => (calls++, mail));
    w.ctx.jobs.enqueue('email.sync', { mailboxId: mb }, { workspaceId: w.workspaceId, dedupeKey: syncJobKey(mb) });
    await w.ctx.jobs.drain();
    expect(calls).toBe(1);
    for (const l of leads.slice(0, 3)) expect(cl(w, campaignId, l).state).toBe('replied');
    expect(cl(w, campaignId, leads[3]).state).toBe('active');
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM email_messages WHERE direction = 'in'")!.n).toBe(3);
    expect(mailbox(w, mb).imap_last_uid).toBe(4);
    // The reply joins the email's conversation, with quoted text dropped.
    const conv = w.ctx.db.get<{ id: number; channel: string; mailbox_id: number; subject: string }>('SELECT id, channel, mailbox_id, subject FROM conversations WHERE id = ?', [sent(leads[0]).conversation_id])!;
    expect(conv).toMatchObject({ channel: 'email', mailbox_id: mb, subject: 'Quick idea for Acme' });
    expect(w.ctx.db.all<{ direction: string; body: string }>('SELECT direction, body FROM messages WHERE conversation_id = ? ORDER BY id', [conv.id]).map((m) => m.direction + ':' + m.body)).toEqual([
      'out:Hi First0',
      'in:Sounds good, call me.',
    ]);
    // Synced again: nothing is stored twice.
    w.ctx.jobs.enqueue('email.sync', { mailboxId: mb }, { workspaceId: w.workspaceId, dedupeKey: syncJobKey(mb) });
    await w.ctx.jobs.drain();
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM email_messages WHERE direction = 'in'")!.n).toBe(3);
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE type = 'replied' AND mailbox_id = ?", [mb])!.n).toBe(3);
  });

  it('ignores mail from a lead this mailbox never emailed', async () => {
    const { w, mb } = await sentToFour();
    const [colleague] = addLeads(w, 1, 'colleague');
    w.ctx.db.run("UPDATE leads SET email = 'pat@partner.dev' WHERE id = ?", [colleague]);
    const events: string[] = [];
    w.ctx.webhooks.subscribe((_ws, e) => events.push(e));
    w.ctx.imap = () => fakeImap(() => [inbound({ uid: 1, from: 'pat@partner.dev', subject: 'Lunch on Friday?', date: w.ctx.clock.now() })]);
    w.ctx.jobs.enqueue('email.sync', { mailboxId: mb }, { workspaceId: w.workspaceId, dedupeKey: syncJobKey(mb) });
    await w.ctx.jobs.drain();
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM email_messages WHERE direction = 'in'")!.n).toBe(0);
    expect(lead(w, colleague).replied_at).toBeNull();
    expect(events).not.toContain('lead.replied');
  });

  it('marks a bounced address invalid and skips the lead’s later email steps', async () => {
    const { w, mb, leads, campaignId, sent } = await sentToFour();
    const events: string[] = [];
    w.ctx.webhooks.subscribe((_ws, e) => events.push(e));
    const dsn = inbound({
      uid: 7,
      from: 'mailer-daemon@sender.dev',
      subject: 'Undelivered Mail Returned to Sender',
      date: w.ctx.clock.now(),
      report: { recipients: ['person3@acme.dev'], originalMessageId: sent(leads[3]).message_id, status: '5.1.1', diagnostic: '550 5.1.1 User unknown' },
    });
    w.ctx.imap = () => fakeImap(() => [dsn]);
    w.ctx.jobs.enqueue('email.sync', { mailboxId: mb }, { workspaceId: w.workspaceId });
    await w.ctx.jobs.drain();
    expect(lead(w, leads[3])).toMatchObject({ email_status: 'invalid', email_status_reason: 'Bounced: 550 5.1.1 User unknown' });
    expect(sent(leads[3]).status).toBe('bounced');
    expect(events).toContain('lead.email_bounced');
    // No reply: a bounce isn't one.
    expect(cl(w, campaignId, leads[3]).state).toBe('active');
    w.ctx.imap = () => fakeImap(() => []);
    await runFor(w, 2 * DAY);
    expect(w.ctx.db.get<{ status: string; detail: string }>("SELECT status, detail FROM activity WHERE type = 'email' AND lead_id = ? AND node_id = 'e2'", [leads[3]])).toMatchObject({
      status: 'skipped',
      detail: expect.stringMatching(/invalid/),
    });
  });

  it('simulated mailboxes answer some emails and bounce "bounce" addresses', async () => {
    const w = makeWorld();
    const mb = addMailbox(w);
    const leads = emailLeads(w, 12);
    w.ctx.db.run("UPDATE leads SET email = 'bounce-me@acme.dev' WHERE id = ?", [leads[0]]);
    const { id } = emailCampaign(w, oneEmail, leads, [mb]);
    await runFor(w, 2 * DAY);
    expect(lead(w, leads[0]).email_status).toBe('invalid');
    // One email each, so the sequence is already over; the reply still lands on the lead and in the inbox.
    const replied = w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM leads WHERE replied_at IS NOT NULL')!.n;
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM email_messages WHERE direction = 'in' AND status = 'received' AND campaign_id = ?", [id])!.n).toBe(replied);
    expect(replied).toBeGreaterThan(0);
    expect(replied).toBeLessThan(12);
  });

  it('treats an IMAP server without TLS as a settings problem, never a plain-text login', () => {
    expect(imapError(Object.assign(new Error('STARTTLS not supported'), { tlsFailed: true }))).toMatchObject({ code: 'AUTH', message: expect.stringMatching(/did not offer TLS/) });
    expect(imapError(Object.assign(new Error('x'), { authenticationFailed: true, responseText: 'bad' }))).toMatchObject({ code: 'AUTH', message: 'IMAP login refused: bad' });
    expect(imapError(new Error('ECONNRESET'))).toMatchObject({ code: 'TRANSIENT' });
  });

  it('parses delivery status notifications', () => {
    expect(
      parseDeliveryStatus('Reporting-MTA: dns; mx.sender.dev\n\nFinal-Recipient: rfc822; Ann@Acme.dev\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1\n  user unknown'),
    ).toEqual({ recipients: ['ann@acme.dev'], status: '5.1.1', diagnostic: '550 5.1.1 user unknown' });
    expect(
      findParts({
        type: 'multipart/report',
        childNodes: [
          { part: '1', type: 'text/plain' },
          { part: '2', type: 'message/delivery-status' },
          { part: '3', type: 'text/rfc822-headers' },
        ],
      }),
    ).toEqual({ text: '1', deliveryStatus: '2', originalHeaders: '3' });
  });
});

describe('legacy SMTP settings', () => {
  it('turns an account’s SMTP settings into a mailbox once, keeping its limit, schedule and pauses', async () => {
    const w = makeWorld({}, {
      smtp_enc: null,
      timezone: 'Europe/London',
      work_days: '[1,2,3,4,5,6]',
      work_start: '07:30',
      work_end: '19:00',
      delay_min_sec: 90,
      delay_max_sec: 200,
      limits: JSON.stringify({ email: 25 }),
    });
    w.ctx.db.run('UPDATE accounts SET smtp_enc = ? WHERE id = ?', [
      w.ctx.sealer.seal(JSON.stringify({ host: 'smtp.sender.dev', port: 587, secure: false, user: 'sara@sender.dev', pass: 'pw-123456789', from: 'Sara <Sara@Sender.dev>' })),
      w.accountId,
    ]);
    const withEmail = makeCampaign(w, oneEmail, {}, emailLeads(w, 1));
    const withoutEmail = makeCampaign(w, { start: 'f', nodes: { f: { id: 'f', type: 'follow', next: null } } });
    // The account sent without PUBLIC_URL before mailboxes existed; its mailbox keeps doing so after the upgrade.
    w.ctx.config.publicUrl = undefined;
    ensureLegacyMailboxes(w.ctx);
    ensureLegacyMailboxes(w.ctx);
    const rows = w.ctx.db.all<MailboxRow>('SELECT * FROM mailboxes');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      legacy_account_id: w.accountId,
      provider: 'smtp',
      from_name: 'Sara',
      from_email: 'sara@sender.dev',
      warmup: 0,
      daily_limit: 25,
      timezone: 'Europe/London',
      work_days: '[1,2,3,4,5,6]',
      work_start: '07:30',
      work_end: '19:00',
      gap_min_sec: 90,
      gap_max_sec: 200,
    });
    expect(w.ctx.db.all('SELECT campaign_id FROM campaign_mailboxes').map((r: any) => r.campaign_id)).toEqual([withEmail.id]);
    expect(withoutEmail.id).toBeGreaterThan(0);
    await runFor(w, 3 * HOUR);
    expect(mailerOf(w).sent[0].transport).toMatchObject({ host: 'smtp.sender.dev', port: 587, user: 'sara@sender.dev', pass: 'pw-123456789' });
    expect(mailerOf(w).sent[0].msg.headers!['List-Unsubscribe']).toBe('<mailto:sara@sender.dev?subject=unsubscribe>');
    expect(mailbox(w, rows[0].id).status).toBe('active');
  });
});

describe('deliverability check', () => {
  const resolver = (txt: Record<string, string[][]>, mx: Record<string, { exchange: string; priority: number }[]> = {}): DnsResolver => ({
    async resolveMx(d) {
      if (mx[d]) return mx[d];
      throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    },
    async resolveTxt(d) {
      if (txt[d]) return txt[d];
      throw Object.assign(new Error('nodata'), { code: 'ENODATA' });
    },
  });
  const status = (r: Awaited<ReturnType<typeof checkDomain>>) => Object.fromEntries(r.checks.map((c) => [c.id, c.status]));

  it('passes a well set up domain', async () => {
    const r = await checkDomain(
      resolver(
        {
          'sender.dev': [['v=spf1 include:_spf.google.com ~all'], ['google-site-verification=abc']],
          'google._domainkey.sender.dev': [['v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA']],
          '_dmarc.sender.dev': [['v=DMARC1; p=reject; rua=mailto:d@sender.dev']],
        },
        { 'sender.dev': [{ exchange: 'aspmx.l.google.com', priority: 1 }] },
      ),
      'Sender.dev',
      { preset: 'gmail' },
    );
    expect(r.domain).toBe('sender.dev');
    expect(status(r)).toEqual({ mx: 'pass', spf: 'pass', dkim: 'pass', dmarc: 'pass' });
  });

  it('warns and fails with guidance', async () => {
    const missing = await checkDomain(resolver({}), 'nothing.dev');
    expect(status(missing)).toEqual({ mx: 'fail', spf: 'fail', dkim: 'warn', dmarc: 'fail' });
    expect(missing.checks.every((c) => c.status === 'pass' || c.fix)).toBe(true);

    const weak = await checkDomain(
      resolver(
        { 'weak.dev': [['v=spf1 +all']], 'sel9._domainkey.weak.dev': [['v=DKIM1; p=']], '_dmarc.weak.dev': [['v=DMARC1; p=none']] },
        { 'weak.dev': [{ exchange: 'mx.weak.dev', priority: 10 }] },
      ),
      'weak.dev',
      { dkimSelector: 'sel9' },
    );
    expect(status(weak)).toEqual({ mx: 'pass', spf: 'warn', dkim: 'fail', dmarc: 'warn' });

    const twoSpf = await checkDomain(resolver({ 'two.dev': [['v=spf1 -all'], ['v=spf1 include:x.dev -all']] }), 'two.dev');
    expect(twoSpf.checks.find((c) => c.id === 'spf')!.message).toMatch(/More than one/);

    const noInclude = await checkDomain(resolver({ 'ms.dev': [['v=spf1 include:_spf.google.com -all']] }), 'ms.dev', { preset: 'outlook' });
    expect(noInclude.checks.find((c) => c.id === 'spf')).toMatchObject({ status: 'warn', fix: 'Add include:spf.protection.outlook.com to the record.' });
  });

  it('reports lookup errors as warnings, not as missing records', async () => {
    const broken: DnsResolver = {
      resolveMx: async () => {
        throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
      },
      resolveTxt: async () => {
        throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
      },
    };
    const r = await checkDomain(broken, 'slow.dev');
    expect(status(r)).toEqual({ mx: 'warn', spf: 'warn', dkim: 'warn', dmarc: 'warn' });
  });
});

describe('mailbox API', () => {
  const body = {
    name: 'Sales inbox',
    provider: 'smtp',
    preset: 'gmail',
    fromName: 'Sara',
    fromEmail: 'Sara@Sender.dev',
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'sara@sender.dev', pass: 'abcd-efgh-ijkl-mnop' },
    imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'sara@sender.dev', pass: 'abcd-efgh-ijkl-mnop' },
    dailyLimit: 30,
  };

  it('creates mailboxes with masked passwords, keeps a blank password and checks roles', async () => {
    const api = await makeApi();
    const owner = await api.register();
    const created = await api.call('POST', '/api/mailboxes', body);
    expect(created.status).toBe(200);
    expect(created.raw).not.toContain('abcd-efgh-ijkl-mnop');
    expect(created.body).toMatchObject({ fromEmail: 'sara@sender.dev', hasSmtp: true, hasImap: true, smtp: { pass: '••••mnop' }, effectiveLimit: 5, warmup: true, status: 'active' });
    const row = api.w.ctx.db.get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', [created.body.id])!;
    expect(row.smtp_enc).not.toContain('abcd');

    const patched = await api.call('PATCH', `/api/mailboxes/${created.body.id}`, { smtp: { ...body.smtp, pass: '' }, dailyLimit: 50 });
    expect(patched.body.dailyLimit).toBe(50);
    const savedSmtp = () => JSON.parse(api.w.ctx.sealer.open(api.w.ctx.db.get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', [created.body.id])!.smtp_enc)!);
    expect(savedSmtp().pass).toBe('abcd-efgh-ijkl-mnop');
    // A blank password is never carried over to another server or user: it would hand the secret to that host.
    for (const change of [{ host: 'smtp.elsewhere.dev' }, { port: 587, secure: false }, { user: 'other@sender.dev' }]) {
      const res = await api.call('PATCH', `/api/mailboxes/${created.body.id}`, { smtp: { ...body.smtp, ...change, pass: '' } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/smtp: Enter the password again/);
    }
    expect((await api.call('PATCH', `/api/mailboxes/${created.body.id}`, { imap: { ...body.imap, host: 'imap.elsewhere.dev', pass: undefined } })).status).toBe(400);
    expect(savedSmtp()).toMatchObject({ host: 'smtp.gmail.com', pass: 'abcd-efgh-ijkl-mnop' });
    expect((await api.call('PATCH', `/api/mailboxes/${created.body.id}`, { smtp: { ...body.smtp, host: 'smtp.elsewhere.dev', pass: 'new-password-99' } })).status).toBe(200);
    expect(savedSmtp()).toMatchObject({ host: 'smtp.elsewhere.dev', pass: 'new-password-99' });
    expect((await api.call('PATCH', `/api/mailboxes/${created.body.id}`, { smtp: body.smtp })).status).toBe(200);

    expect((await api.call('POST', `/api/mailboxes/${created.body.id}/test`, {})).body).toEqual({
      smtp: { ok: true, message: 'The SMTP server accepted the login' },
      imap: { ok: true, message: 'The IMAP server accepted the login' },
    });
    expect((await api.call('GET', '/api/mailboxes/presets')).body.map((p: any) => p.id)).toEqual(['gmail', 'outlook', 'custom']);

    const member = await api.addUser('member');
    api.as(member);
    expect((await api.call('GET', '/api/mailboxes')).body).toHaveLength(1);
    expect((await api.call('POST', '/api/mailboxes', body)).status).toBe(403);
    expect((await api.call('PATCH', `/api/mailboxes/${created.body.id}`, { name: 'x' })).status).toBe(403);
    expect((await api.call('POST', `/api/mailboxes/${created.body.id}/pause`, {})).status).toBe(403);
    expect((await api.call('POST', `/api/mailboxes/${created.body.id}/test`, {})).status).toBe(403);
    expect((await api.call('DELETE', `/api/mailboxes/${created.body.id}`)).status).toBe(403);
    expect((await api.call('POST', `/api/mailboxes/${created.body.id}/sync`, {})).status).toBe(200);
    api.as(owner);
    expect((await api.call('POST', '/api/mailboxes', { ...body, fromEmail: 'not an email' })).status).toBe(400);
    expect((await api.call('POST', '/api/mailboxes', { ...body, smtp: { ...body.smtp, host: 'http://evil.dev/x' } })).status).toBe(400);
  });

  it('keeps workspaces apart', async () => {
    const api = await makeApi();
    const first = await api.register('One');
    const mb = (await api.call('POST', '/api/mailboxes', body)).body;
    const campaign = (await api.call('POST', '/api/campaigns', { name: 'C', mailboxIds: [mb.id], sequence: oneEmail })).body;
    expect(campaign.mailboxIds).toEqual([mb.id]);
    await api.register('Two');
    expect((await api.call('GET', '/api/mailboxes')).body).toEqual([]);
    expect((await api.call('GET', `/api/mailboxes/${mb.id}`)).status).toBe(404);
    expect((await api.call('PATCH', `/api/mailboxes/${mb.id}`, { name: 'mine' })).status).toBe(404);
    expect((await api.call('POST', '/api/deliverability/check', { mailboxId: mb.id })).status).toBe(404);
    expect((await api.call('POST', '/api/campaigns', { name: 'X', mailboxIds: [mb.id] })).status).toBe(404);
    api.as(first);
    expect((await api.call('GET', `/api/mailboxes/${mb.id}`)).status).toBe(200);
  });

  it('lets an email-only campaign start from a mailbox, and refuses LinkedIn steps without an account', async () => {
    const api = await makeApi();
    await api.register();
    const mb = (await api.call('POST', '/api/mailboxes', { ...body, provider: 'simulated', smtp: null, imap: null })).body;
    const none = (await api.call('POST', '/api/campaigns', { name: 'Nothing', sequence: oneEmail })).body;
    expect((await api.call('POST', `/api/campaigns/${none.id}/start`, {})).body.error).toMatch(/LinkedIn account or a mailbox/);
    const linkedIn = (await api.call('POST', '/api/campaigns', { name: 'LI', mailboxIds: [mb.id] })).body;
    expect((await api.call('POST', `/api/campaigns/${linkedIn.id}/start`, {})).body.error).toMatch(/LinkedIn steps/);
    const email = (await api.call('POST', '/api/campaigns', { name: 'Email', mailboxIds: [mb.id], sequence: twoEmails, settings: { trackOpens: true } })).body;
    expect(email.settings).toMatchObject({ trackOpens: true, trackClicks: false });
    expect((await api.call('POST', `/api/campaigns/${email.id}/start`, {})).body.status).toBe('active');
    expect((await api.call('PATCH', `/api/campaigns/${email.id}`, { mailboxIds: [] })).status).toBe(409);
  });

  it('runs the deliverability check through the injected resolver', async () => {
    const api = await makeApi();
    await api.register();
    api.w.ctx.dns = {
      resolveMx: async () => [{ exchange: 'mx.sender.dev', priority: 5 }],
      resolveTxt: async (d) => (d === 'sender.dev' ? [['v=spf1 -all']] : d === '_dmarc.sender.dev' ? [['v=DMARC1; p=quarantine']] : []),
    };
    const r = await api.call('POST', '/api/deliverability/check', { domain: 'sender.dev', dkimSelector: 'abc' });
    expect(r.body.checks.map((c: any) => c.status)).toEqual(['pass', 'pass', 'warn', 'pass']);
    expect((await api.call('POST', '/api/deliverability/check', { domain: 'not a domain' })).status).toBe(400);
  });

  it('shows email threads in the inbox and replies through the mailbox, in the thread', async () => {
    const w = makeWorld();
    const api = await makeApi(w);
    const owner = await api.register();
    // Move the world's data into the registered workspace so the API can see it.
    const ws = owner.workspaceId;
    w.workspaceId = ws;
    w.ctx.db.run('UPDATE lead_lists SET workspace_id = ?', [ws]);
    w.ctx.db.run('UPDATE accounts SET workspace_id = ?', [ws]);
    const mb = addMailbox(w);
    const leads = emailLeads(w, 1);
    emailCampaign(w, oneEmail, leads, [mb]);
    await runFor(w, 20 * MINUTE);
    const first = sentRows(w)[0];
    const list = await api.call('GET', `/api/inbox?channel=email&mailboxId=${mb}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ channel: 'email', mailboxName: 'Box', subject: 'Hello First0', participantAddress: 'person0@acme.dev' });
    const before = mailerOf(w).sent.length;
    expect((await api.call('POST', `/api/inbox/${list.body[0].id}/reply`, { text: 'One more thing' })).status).toBe(200);
    const reply = mailerOf(w).sent[before].msg;
    expect(reply).toMatchObject({ to: 'person0@acme.dev', subject: 'Re: Hello First0', inReplyTo: first.message_id, references: [first.message_id] });
    expect(reply.headers).toEqual({});
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE type = 'email' AND status = 'ok' AND mailbox_id = ?", [mb])!.n).toBe(2);
    const thread = await api.call('GET', `/api/inbox/${list.body[0].id}`);
    expect(thread.body.messages.map((m: any) => m.body)).toEqual(['Hi First0, see https://acme.dev/offer?x=1 for details.', 'One more thing']);
  });
});
