import { describe, expect, it, vi } from 'vitest';
import { DAY, HOUR, MINUTE } from '../src/clock.js';
import type { Sequence } from '../src/engine/sequence.js';
import { twilioSignature, verifyTwilioSignature } from '../src/providers/sms/twilio.js';
import { handleInboundReply } from '../src/services/replies.js';
import { normalizePhone, suppressionReason } from '../src/services/suppression.js';
import { completeTask } from '../src/services/tasks.js';
import type { CampaignLeadRow, LeadRow, TaskRow } from '../src/types.js';
import { addLeads, fakeFetch, makeApi, makeCampaign, makeWorld, runFor, type World } from './helpers.js';

const SID = 'AC' + 'a'.repeat(32);
const TOKEN = 'twilio-test-auth-token-1234';

const taskThenSms = (task: Record<string, unknown> = {}): Sequence => ({
  start: 't',
  nodes: {
    t: { id: 't', type: 'task', kind: 'call', title: 'Call {{firstName}}', instructions: 'Ask how {{company}} books demos.', dueAfterHours: 2, assigneeId: null, autoSkipAfterDays: null, next: 's', ...task } as any,
    s: { id: 's', type: 'sms', text: 'Hi {{firstName}}, thanks for the chat!', next: null },
  },
});
const oneSms: Sequence = { start: 's', nodes: { s: { id: 's', type: 'sms', text: 'Hi {{firstName}}, quick question about {{company}}.', next: null } } };

const tasks = (w: World) => w.ctx.db.all<TaskRow>('SELECT * FROM tasks ORDER BY id');
const cl = (w: World, campaignId: number, leadId: number) => w.ctx.db.get<CampaignLeadRow>('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?', [campaignId, leadId])!;
const lead = (w: World, id: number) => w.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id])!;
const smsActivity = (w: World, status = 'ok') => w.ctx.db.all<{ lead_id: number; detail: string; day: string }>("SELECT lead_id, detail, day FROM activity WHERE type = 'sms' AND status = ? ORDER BY id", [status]);

function phoneLeads(w: World, n: number, prefix = 'lead') {
  const ids = addLeads(w, n, prefix);
  ids.forEach((id, i) => w.ctx.db.run('UPDATE leads SET phone = ? WHERE id = ?', [`+1 415 555 ${String(1000 + i)}`, id]));
  return ids;
}

// A Twilio integration for the world's workspace (created like the API does), with the fake HTTP it talks to.
async function withTwilio(w: World, settings: Record<string, unknown> = {}) {
  const api = await makeApi(w);
  // makeApi's register creates its own workspace; the engine tests work in the world's, so insert directly.
  const { createIntegration } = await import('../src/providers/store.js');
  const row = createIntegration(w.ctx, w.workspaceId, { kind: 'sms', provider: 'twilio', credentials: { accountSid: SID, authToken: TOKEN }, settings: { fromNumber: '+15550001111', ...settings } });
  let n = 0;
  const fetch = fakeFetch([{ method: 'POST', url: /api\.twilio\.com\/2010-04-01\/Accounts\/AC[a]{32}\/Messages\.json$/, reply: () => ({ status: 201, json: { sid: `SM${String(++n).padStart(32, '0')}` } }) }]);
  w.ctx.fetch = fetch;
  return { api, row, fetch };
}

// The world's workspace has no user yet: add an owner there to use its API.
async function ownerCookie(w: World, api: Awaited<ReturnType<typeof makeApi>>) {
  const { hashPassword } = await import('../src/services/crypto.js');
  w.ctx.db.insert('users', { workspace_id: w.workspaceId, email: 'boss@acme.dev', name: 'Boss', password_hash: hashPassword('correct-horse'), role: 'owner', created_at: 0 });
  const login = await api.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'boss@acme.dev', password: 'correct-horse' } });
  return String(login.headers['set-cookie']).split(';')[0];
}

function inbound(api: Awaited<ReturnType<typeof makeApi>>, integrationId: number, params: Record<string, string>, opts: { url?: string; signature?: string } = {}) {
  const path = `/api/public/twilio/${integrationId}/inbound`;
  const signature = opts.signature ?? twilioSignature(TOKEN, opts.url ?? `http://localhost:8787${path}`, params);
  return api.app.inject({ method: 'POST', url: path, payload: new URLSearchParams(params).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature } });
}

describe('task steps', () => {
  it('creates one task, holds the lead until it is completed, then moves on', async () => {
    const w = makeWorld();
    const [a, b] = phoneLeads(w, 2);
    const events: string[] = [];
    w.ctx.webhooks.subscribe((_ws, e) => void events.push(e));
    const c = makeCampaign(w, taskThenSms(), {}, [a, b], []);

    await runFor(w, 10 * MINUTE);
    expect(tasks(w)).toHaveLength(2);
    const t = tasks(w).find((x) => x.lead_id === a)!;
    expect(t).toMatchObject({ kind: 'call', status: 'open', title: 'Call First0', instructions: 'Ask how Acme books demos.', campaign_id: c.id, node_id: 't' });
    expect(t.due_at - t.created_at).toBe(2 * HOUR);
    expect(cl(w, c.id, a)).toMatchObject({ node_id: 't', hold_reason: 'task', state: 'active' });
    expect(events.filter((e) => e === 'task.created')).toHaveLength(2);

    // Spurious wake-ups (a sequence edit runs reconcile, which wakes every active lead) re-hold without a second task.
    const deadline = cl(w, c.id, a).next_run_at;
    w.ctx.db.run("UPDATE campaign_leads SET next_run_at = ? WHERE campaign_id = ? AND state = 'active'", [w.ctx.clock.now(), c.id]);
    await runFor(w, 10 * MINUTE);
    expect(tasks(w)).toHaveLength(2);
    expect(cl(w, c.id, a).hold_reason).toBe('task');
    expect(cl(w, c.id, a).next_run_at).toBeGreaterThanOrEqual(deadline);

    completeTask(w.ctx, t, null, { outcome: 'connected', notes: 'Good call' });
    expect(events).toContain('task.completed');
    // After 09:00 the SMS step sends straight away.
    await runFor(w, 2 * HOUR);
    expect(cl(w, c.id, a).state).toBe('done');
    expect(cl(w, c.id, b)).toMatchObject({ node_id: 't', hold_reason: 'task' });
    expect(w.ctx.db.get("SELECT detail FROM activity WHERE type = 'task_done' AND lead_id = ?", [a])).toEqual({ detail: 'Call First0 · connected · Good call' });
    expect(smsActivity(w).map((r) => r.lead_id)).toEqual([a]);
  });

  it('skips a task automatically N days after it is due', async () => {
    const w = makeWorld();
    const [a] = phoneLeads(w, 1);
    const c = makeCampaign(w, taskThenSms({ dueAfterHours: 0, autoSkipAfterDays: 1, next: null }), {}, [a], []);
    await runFor(w, 10 * MINUTE);
    expect(tasks(w)[0].auto_skip_at).toBe(tasks(w)[0].due_at + DAY);
    await runFor(w, 23 * HOUR);
    expect(tasks(w)[0].status).toBe('open');
    await runFor(w, 2 * HOUR, 10 * MINUTE);
    expect(tasks(w)[0]).toMatchObject({ status: 'skipped', notes: 'Skipped automatically after 1 day' });
    expect(cl(w, c.id, a).state).toBe('done');
  });

  it('skips the open task when the lead replies and leaves the campaign', async () => {
    const w = makeWorld();
    const [a] = phoneLeads(w, 1);
    const c = makeCampaign(w, taskThenSms(), {}, [a], []);
    await runFor(w, 5 * MINUTE);
    handleInboundReply(w.ctx, { lead: lead(w, a), channel: 'linkedin', conversationId: 0, messageId: null, body: 'Not now, thanks' });
    expect(cl(w, c.id, a).state).toBe('replied');
    expect(tasks(w)[0]).toMatchObject({ status: 'skipped', notes: 'Lead left the campaign (replied)' });
  });

  it('leaves a task unassigned when its assignee is no longer a member', async () => {
    const w = makeWorld();
    const [a] = phoneLeads(w, 1);
    const other = w.ctx.db.insert('workspaces', { name: 'Other', created_at: 0 });
    const stranger = w.ctx.db.insert('users', { workspace_id: other, email: 'x@other.dev', name: 'X', password_hash: 'x', role: 'owner', created_at: 0 });
    makeCampaign(w, taskThenSms({ assigneeId: stranger }), {}, [a], []);
    await runFor(w, 5 * MINUTE);
    expect(tasks(w)[0].assignee_id).toBeNull();
  });
});

describe('SMS and WhatsApp steps', () => {
  it('sends through the simulated provider inside its window and records the thread', async () => {
    const w = makeWorld();
    const [a, noPhone, national] = phoneLeads(w, 3);
    w.ctx.db.run('UPDATE leads SET phone = NULL WHERE id = ?', [noPhone]);
    w.ctx.db.run("UPDATE leads SET phone = '07700 900123' WHERE id = ?", [national]);
    const c = makeCampaign(w, oneSms, {}, [a, noPhone, national], []);

    // 08:00 UTC: the simulator's window opens at 09:00.
    await runFor(w, 50 * MINUTE);
    expect(smsActivity(w)).toHaveLength(0);
    await runFor(w, 30 * MINUTE);
    expect(smsActivity(w)).toEqual([{ lead_id: a, detail: 'Hi First0, quick question about Acme. (simulated: not delivered)', day: '2026-01-05' }]);
    expect(cl(w, c.id, a).state).toBe('done');
    expect(Object.fromEntries(w.ctx.db.all<{ lead_id: number; detail: string }>("SELECT lead_id, detail FROM activity WHERE type = 'sms' AND status = 'skipped'").map((r) => [r.lead_id, r.detail]))).toEqual({
      [noPhone]: 'No phone number',
      [national]: 'No phone number in international format',
    });
    const conv = w.ctx.db.get<any>("SELECT * FROM conversations WHERE channel = 'sms'")!;
    expect(conv).toMatchObject({ thread_id: 'sms:+14155551000', participant_address: '+14155551000', lead_id: a, account_id: null, mailbox_id: null });
    expect(w.ctx.db.get('SELECT direction, body FROM messages WHERE conversation_id = ?', [conv.id])).toEqual({ direction: 'out', body: 'Hi First0, quick question about Acme.' });
  });

  it('keeps to the daily limit and sends once when ticks overlap', async () => {
    const w = makeWorld();
    const { fetch } = await withTwilio(w, { smsDailyLimit: 2, sendStart: '09:00', sendEnd: '17:00' });
    const ids = phoneLeads(w, 3);
    makeCampaign(w, oneSms, {}, ids, []);
    w.ctx.clock.advance(1.5 * HOUR);
    w.ctx.db.run('UPDATE campaign_leads SET next_run_at = 0');
    await Promise.all([w.engine.messaging.tick(), w.engine.messaging.tick()]);
    expect(fetch.calls).toHaveLength(1);

    await runFor(w, 10 * HOUR);
    expect(fetch.calls).toHaveLength(2);
    expect(smsActivity(w).map((r) => r.day)).toEqual(['2026-01-05', '2026-01-05']);
    // The next day's window lets the third one out.
    await runFor(w, 14 * HOUR, 10 * MINUTE);
    expect(fetch.calls).toHaveLength(3);
    expect(smsActivity(w).at(-1)!.day).toBe('2026-01-06');
  });

  it('sends the same text to the same number twice, from a campaign and from the inbox', async () => {
    const w = makeWorld();
    const [a, b] = phoneLeads(w, 2);
    w.ctx.db.run("UPDATE leads SET phone = '+1 415 555 1000' WHERE id = ?", [b]);
    const hello: Sequence = { start: 's', nodes: { s: { id: 's', type: 'sms', text: 'Hello!', next: null } } };
    const c = makeCampaign(w, hello, { skipIfInOtherCampaign: false }, [a, b], []);
    await runFor(w, 3 * HOUR);
    expect(cl(w, c.id, a).state).toBe('done');
    expect(cl(w, c.id, b).state).toBe('done');
    expect(smsActivity(w, 'failed')).toEqual([]);
    expect(w.ctx.db.all("SELECT body FROM messages WHERE direction = 'out'")).toEqual([{ body: 'Hello!' }, { body: 'Hello!' }]);

    const api = await makeApi(w);
    const cookie = await ownerCookie(w, api);
    const conv = w.ctx.db.get<{ id: number }>("SELECT id FROM conversations WHERE channel = 'sms'")!;
    for (let i = 0; i < 2; i++) expect((await api.call('POST', `/api/inbox/${conv.id}/reply`, { text: 'Thanks!' }, { cookie })).status).toBe(200);
    expect(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', [conv.id])!.n).toBe(4);
  });

  it('normalizes national numbers with the default country code', () => {
    expect(normalizePhone('07700 900123')).toBeNull();
    expect(normalizePhone('07700 900123', '44')).toBe('+447700900123');
    expect(normalizePhone('0044 7700 900123')).toBe('+447700900123');
    expect(normalizePhone('whatsapp:+14155550123')).toBe('+14155550123');
    expect(normalizePhone('(415) 555-0123', '+1')).toBe('+14155550123');
  });
});

describe('Twilio provider', () => {
  it('posts SMS and WhatsApp messages in the documented shape', async () => {
    const w = makeWorld();
    const { fetch } = await withTwilio(w, { whatsappFrom: '+15550002222' });
    const sms = w.ctx.providers.get(w.workspaceId, 'sms')!;
    expect(sms.providerId).toBe('twilio');
    expect(await sms.send({ channel: 'sms', to: '+14155550123', body: 'Hello there' })).toEqual({ externalId: 'SM' + '1'.padStart(32, '0') });
    await sms.send({ channel: 'whatsapp', to: '+14155550123', body: 'ignored', contentSid: 'HX' + 'b'.repeat(32), contentVariables: { '1': 'Ava' } });

    const [first, second] = fetch.calls;
    expect(first.method).toBe('POST');
    expect(first.headers.authorization).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
    expect(first.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(first.body!))).toEqual({ To: '+14155550123', From: '+15550001111', Body: 'Hello there' });
    expect(Object.fromEntries(new URLSearchParams(second.body!))).toEqual({
      To: 'whatsapp:+14155550123',
      From: 'whatsapp:+15550002222',
      ContentSid: 'HX' + 'b'.repeat(32),
      ContentVariables: '{"1":"Ava"}',
    });
  });

  it('maps a refused number to a skipped step and bad credentials to an integration error', async () => {
    const w = makeWorld();
    const { row } = await withTwilio(w);
    const [a, b] = phoneLeads(w, 2);
    let calls = 0;
    w.ctx.fetch = fakeFetch([
      {
        method: 'POST',
        url: /Messages\.json$/,
        reply: () => (++calls === 1 ? { status: 400, json: { code: 21211, message: "The 'To' number is not a valid phone number." } } : { status: 401, json: { code: 20003, message: 'Authenticate' } }),
      },
    ]);
    const c = makeCampaign(w, oneSms, {}, [a, b], []);
    await runFor(w, 1.5 * HOUR);
    expect(cl(w, c.id, a).state).toBe('done');
    expect(smsActivity(w, 'skipped')[0].detail).toContain('not a valid phone number');
    // 401: the lead keeps its place and the integration shows the problem; the token never appears in it.
    expect(cl(w, c.id, b)).toMatchObject({ state: 'active', node_id: 's' });
    const status = w.ctx.db.get<{ last_status: string; last_message: string }>('SELECT last_status, last_message FROM integrations WHERE id = ?', [row.id])!;
    expect(status.last_status).toBe('error');
    expect(status.last_message).not.toContain(TOKEN);
  });

  it('never sends again when a message went out but could not be stored', async () => {
    const w = makeWorld();
    await withTwilio(w);
    const [a, b] = phoneLeads(w, 2);
    w.ctx.db.run("UPDATE leads SET phone = '+1 415 555 1000' WHERE id = ?", [b]);
    // The same message id twice makes the second inbox insert fail, after Twilio has accepted the message.
    const fetch = fakeFetch([{ method: 'POST', url: /Messages\.json$/, reply: () => ({ status: 201, json: { sid: 'SM' + 'd'.repeat(32) } }) }]);
    w.ctx.fetch = fetch;
    const hello: Sequence = { start: 's', nodes: { s: { id: 's', type: 'sms', text: 'Hello!', next: null } } };
    const c = makeCampaign(w, hello, {}, [a, b], []);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runFor(w, 6 * HOUR);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
    expect(fetch.calls).toHaveLength(2);
    expect(cl(w, c.id, a).state).toBe('done');
    expect(cl(w, c.id, b).state).toBe('done');
    expect(smsActivity(w)).toHaveLength(2);
    expect(smsActivity(w, 'failed')).toEqual([]);
  });

  it('skips SMS steps when only WhatsApp is set up, without holding up WhatsApp steps', async () => {
    const w = makeWorld();
    const { api, fetch } = await withTwilio(w, { fromNumber: '', whatsappFrom: '+15550002222' });
    expect(w.ctx.providers.get(w.workspaceId, 'sms')!.policy).toMatchObject({ sms: false, whatsapp: true });
    const [a, b] = phoneLeads(w, 2);
    const sms = makeCampaign(w, oneSms, { skipIfInOtherCampaign: false }, [a], []);
    const wa = makeCampaign(w, { start: 'x', nodes: { x: { id: 'x', type: 'whatsapp', text: 'Hi {{firstName}}', next: null } } as any }, { skipIfInOtherCampaign: false }, [b], []);
    await runFor(w, 3 * HOUR);
    expect(cl(w, sms.id, a).state).toBe('done');
    expect(smsActivity(w, 'skipped').map((r) => r.detail)).toEqual(['SMS is not set up in the SMS integration']);
    expect(cl(w, wa.id, b).state).toBe('done');
    expect(fetch.calls).toHaveLength(1);
    expect(new URLSearchParams(fetch.calls[0].body!).get('From')).toBe('whatsapp:+15550002222');

    const cookie = await ownerCookie(w, api);
    const detail = await api.call('GET', `/api/campaigns/${sms.id}`, undefined, { cookie });
    expect(detail.body.warnings.join(' ')).toContain('no SMS from number or Messaging Service');
    const convId = w.ctx.db.insert('conversations', { workspace_id: w.workspaceId, channel: 'sms', account_id: null, mailbox_id: null, lead_id: a, thread_id: 'sms:+14155551000', participant_name: 'First0', participant_url: '', participant_address: '+14155551000', last_message_at: 0 });
    expect((await api.call('POST', `/api/inbox/${convId}/reply`, { text: 'Hi' }, { cookie })).status).toBe(409);
  });

  it('keeps the auth token sealed and masked, and shows the webhook URL to paste into Twilio', async () => {
    const api = await makeApi();
    await api.register();
    const r = await api.call('POST', '/api/integrations', { kind: 'sms', provider: 'twilio', credentials: { accountSid: SID, authToken: TOKEN }, settings: { fromNumber: '+1 (555) 000-1111', smsDailyLimit: 50 } });
    expect(r.status).toBe(200);
    expect(r.raw).not.toContain(TOKEN);
    expect(r.raw).not.toContain(SID);
    expect(r.body).toMatchObject({ hasCredentials: true, webhookUrl: `http://localhost:8787/api/public/twilio/${r.body.id}/inbound`, settings: { fromNumber: '+15550001111', smsDailyLimit: 50 } });
    expect(api.w.ctx.db.get<{ credentials_enc: string }>('SELECT credentials_enc FROM integrations WHERE id = ?', [r.body.id])!.credentials_enc).not.toContain(TOKEN);
    expect((await api.call('POST', '/api/integrations', { kind: 'sms', provider: 'twilio', credentials: { accountSid: 'AC123', authToken: TOKEN } })).status).toBe(400);
    const member = await api.addUser('member');
    api.as(member);
    expect((await api.call('PATCH', `/api/integrations/${r.body.id}`, { settings: { smsDailyLimit: 5000 } })).status).toBe(403);
  });

  it('verifies webhook signatures', () => {
    // Twilio's documented example.
    const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
    const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
    expect(twilioSignature('12345', url, params)).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
    expect(verifyTwilioSignature('12345', url, params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=')).toBe(true);
    expect(verifyTwilioSignature('12345', url, { ...params, Digits: '9999' }, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=')).toBe(false);
    expect(verifyTwilioSignature('12345', 'https://evil.example/myapp.php?foo=1&bar=2', params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=')).toBe(false);
    expect(verifyTwilioSignature('other-token', url, params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=')).toBe(false);
    expect(verifyTwilioSignature('12345', url, params, '')).toBe(false);
  });
});

describe('inbound SMS webhook', () => {
  it('suppresses on STOP everywhere, allows texting again after START, and ignores duplicates', async () => {
    const w = makeWorld();
    const { api, row, fetch } = await withTwilio(w);
    const [a] = phoneLeads(w, 1);
    const linkedin = makeCampaign(w, { start: 'v', nodes: { v: { id: 'v', type: 'view_profile', next: null } } }, { skipIfInOtherCampaign: false }, [a]);
    const sms = makeCampaign(w, { start: 'w', nodes: { w: { id: 'w', type: 'wait', days: 2, hours: 0, next: 's' }, s: oneSms.nodes.s } }, { skipIfInOtherCampaign: false }, [a], []);

    const stop = { MessageSid: 'SM' + 'f'.repeat(32), From: '+14155551000', To: '+15550001111', Body: ' Stop ' };
    const res = await inbound(api, row.id, stop);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.body).toContain('<Response>');
    expect(cl(w, linkedin.id, a).state).toBe('skipped');
    expect(cl(w, sms.id, a)).toMatchObject({ state: 'skipped', last_error: 'Suppressed: sms_stop' });
    expect(suppressionReason(w.ctx, lead(w, a))).toBe('Suppressed: sms_stop');
    expect(w.ctx.db.all("SELECT kind FROM suppressions WHERE reason = 'sms_stop' ORDER BY kind").map((r: any) => r.kind)).toEqual(['linkedin', 'phone']);
    // Twilio retrying the same message changes nothing.
    await inbound(api, row.id, stop);
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in'")!.n).toBe(1);

    await inbound(api, row.id, { ...stop, MessageSid: 'SM' + 'e'.repeat(32), Body: 'START' });
    expect(suppressionReason(w.ctx, lead(w, a))).toBeNull();
    // Stopped campaign leads stay stopped; a new campaign may text the number again.
    expect(cl(w, sms.id, a).state).toBe('skipped');
    const again = makeCampaign(w, oneSms, { skipIfInOtherCampaign: false }, [a], []);
    await runFor(w, 1.5 * HOUR);
    expect(cl(w, again.id, a).state).toBe('done');
    expect(fetch.calls).toHaveLength(1);
  });

  it('shows a reply in the inbox and stops the sequence', async () => {
    const w = makeWorld();
    const { api, row } = await withTwilio(w);
    const [a] = phoneLeads(w, 1);
    const seq: Sequence = { start: 's', nodes: { s: oneSms.nodes.s, w: { id: 'w', type: 'wait', days: 2, hours: 0, next: 's2' }, s2: { id: 's2', type: 'sms', text: 'Following up', next: null } } };
    (seq.nodes.s as any).next = 'w';
    const c = makeCampaign(w, seq, {}, [a], []);
    await runFor(w, 1.5 * HOUR);
    expect(cl(w, c.id, a).node_id).toBe('w');

    const res = await inbound(api, row.id, { MessageSid: 'SM' + '9'.repeat(32), From: '+14155551000', To: '+15550001111', Body: 'Sounds good, call me tomorrow' });
    expect(res.statusCode).toBe(200);
    expect(cl(w, c.id, a).state).toBe('replied');
    expect(lead(w, a).replied_at).not.toBeNull();

    const cookie = await ownerCookie(w, api);
    const list = await api.call('GET', '/api/inbox?channel=sms', undefined, { cookie });
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ channel: 'sms', participantAddress: '+14155551000', lastMessage: 'Sounds good, call me tomorrow', lastDirection: 'in', unread: 1 });
    // Replying texts back through Twilio.
    const reply = await api.call('POST', `/api/inbox/${list.body[0].id}/reply`, { text: 'Great, talk then!' }, { cookie });
    expect(reply.status).toBe(200);
    expect(Object.fromEntries(new URLSearchParams((w.ctx.fetch as any).calls.at(-1).body)).Body).toBe('Great, talk then!');
  });

  it('refuses bad signatures, unknown or non-Twilio integrations, and runs only with PUBLIC_URL', async () => {
    const w = makeWorld();
    const { api, row } = await withTwilio(w);
    const msg = { MessageSid: 'SM' + '1'.repeat(32), From: '+14155551000', To: '+15550001111', Body: 'hi' };
    expect((await inbound(api, row.id, msg, { signature: 'bm90IGEgc2lnbmF0dXJl' })).statusCode).toBe(403);
    // Signed for another host: the signature base is PUBLIC_URL, never the request's Host header.
    expect((await inbound(api, row.id, msg, { url: `https://evil.example/api/public/twilio/${row.id}/inbound` })).statusCode).toBe(403);
    expect((await inbound(api, 9999, msg)).statusCode).toBe(404);
    const { createIntegration } = await import('../src/providers/store.js');
    const sim = createIntegration(w.ctx, w.workspaceId, { kind: 'sms', provider: 'simulated' });
    expect((await inbound(api, sim.id, msg)).statusCode).toBe(404);
    expect(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')!.n).toBe(0);

    w.ctx.config.publicUrl = undefined;
    expect((await inbound(api, row.id, msg)).statusCode).toBe(503);
    expect(w.ctx.db.get<{ last_message: string }>('SELECT last_message FROM integrations WHERE id = ?', [row.id])!.last_message).toContain('PUBLIC_URL');
  });
});

describe('tasks API', () => {
  it('lists, counts, completes and skips tasks, with roles and workspace isolation', async () => {
    const api = await makeApi();
    const owner = await api.register('Acme');
    const member = await api.addUser('member');
    const ws = owner.workspaceId;
    const { ctx } = api.w;
    const listId = ctx.db.insert('lead_lists', { workspace_id: ws, name: 'L', created_at: 0 });
    const leadId = ctx.db.insert('leads', { workspace_id: ws, list_id: listId, public_id: 'ava', profile_url: 'https://www.linkedin.com/in/ava/', first_name: 'Ava', last_name: 'Stone', phone: '+14155550000', created_at: 0 });

    api.as(owner);
    const now = ctx.clock.now();
    const created = await api.call('POST', '/api/tasks', { leadId, kind: 'call', title: 'Call Ava', dueAt: now - HOUR, assigneeId: member.id });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ title: 'Call Ava', status: 'open', overdue: true, assignee: { id: member.id }, lead: { id: leadId, phone: '+14155550000' } });
    await api.call('POST', '/api/tasks', { leadId, kind: 'manual_email', title: 'Email Ava', dueAt: now + 3 * DAY });

    expect((await api.call('GET', '/api/tasks/counts')).body).toEqual({ open: 2, dueToday: 1, overdue: 1, mine: 0 });
    expect((await api.call('GET', '/api/tasks?status=overdue')).body.items.map((t: any) => t.title)).toEqual(['Call Ava']);
    expect((await api.call('GET', '/api/tasks?kind=manual_email')).body.total).toBe(1);

    // Assignees must be members of this workspace.
    const other = await api.register('Other');
    api.as(owner);
    expect((await api.call('POST', '/api/tasks', { leadId, kind: 'call', title: 'x', dueAt: now, assigneeId: other.id })).status).toBe(404);
    const camp = await api.call('POST', '/api/campaigns', { name: 'C', sequence: taskThenSms({ assigneeId: other.id }) });
    expect(camp.status).toBe(404);
    expect((await api.call('POST', '/api/campaigns', { name: 'C', sequence: taskThenSms({ assigneeId: member.id }) })).status).toBe(200);

    // Another workspace sees nothing and can't touch the task.
    api.as(other);
    expect((await api.call('GET', '/api/tasks?status=all')).body.total).toBe(0);
    expect((await api.call('POST', `/api/tasks/${created.body.id}/complete`, {})).status).toBe(404);
    expect((await api.call('POST', '/api/tasks', { leadId, kind: 'call', title: 'x', dueAt: now })).status).toBe(404);

    api.as(member);
    expect((await api.call('GET', '/api/tasks?assignee=me')).body.items.map((t: any) => t.title)).toEqual(['Call Ava']);
    const done = await api.call('POST', `/api/tasks/${created.body.id}/complete`, { outcome: 'meeting_booked', notes: 'Tuesday 10:00' });
    expect(done.body).toMatchObject({ status: 'done', outcome: 'meeting_booked', notes: 'Tuesday 10:00' });
    expect((await api.call('POST', `/api/tasks/${created.body.id}/skip`, {})).status).toBe(409);
    expect((await api.call('POST', `/api/tasks/${created.body.id}/complete`, { outcome: 'great' })).status).toBe(400);

    // A read-only role can look but not act.
    ctx.db.run("UPDATE users SET role = 'client' WHERE id = ?", [member.id]);
    expect((await api.call('GET', '/api/tasks')).status).toBe(200);
    const open = (await api.call('GET', '/api/tasks')).body.items[0];
    expect((await api.call('POST', `/api/tasks/${open.id}/skip`, {})).status).toBe(403);
    expect((await api.call('PATCH', `/api/tasks/${open.id}`, { title: 'x' })).status).toBe(403);
  });
});
