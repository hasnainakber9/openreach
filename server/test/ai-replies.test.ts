import { describe, expect, it } from 'vitest';
import { keywordCategory } from '../src/ai/categories.js';
import { applyCategory } from '../src/ai/classify.js';
import { DAY, HOUR, MINUTE } from '../src/clock.js';
import type { Sequence } from '../src/engine/sequence.js';
import { RetryLater } from '../src/jobs/queue.js';
import { importLeads } from '../src/services/leads.js';
import { handleInboundReply, latestCategory, replyDecision } from '../src/services/replies.js';
import type { CampaignLeadRow, LeadRow } from '../src/types.js';
import { addLeads, counts, makeApi, makeCampaign, makeWorld, runFor, states, type World } from './helpers.js';

const OOO = 'Thanks for your message. I am out of the office until Monday with limited access to email.';
const QUESTION = 'Interesting, can you send over a few more details?';
const NO = 'Not interested, thanks.';

// Invite, then a message; a day later the sequence branches on what the reply was.
const branching = (categories: string[]): Sequence =>
  ({
    start: 'n1',
    nodes: {
      n1: { id: 'n1', type: 'connect', note: '', next: 'n2' },
      n2: { id: 'n2', type: 'condition', kind: 'accepted_within', withinDays: 7, yes: 'n3', no: null },
      n3: { id: 'n3', type: 'message', text: 'Hi {{firstName}}, thanks for connecting!', next: 'n4' },
      n4: { id: 'n4', type: 'wait', days: 1, hours: 0, next: 'n5' },
      n5: { id: 'n5', type: 'condition', kind: 'reply_sentiment', withinDays: 7, categories, yes: 'n6', no: 'n8' },
      n6: { id: 'n6', type: 'wait', days: 2, hours: 0, next: 'n7' },
      n7: { id: 'n7', type: 'message', text: 'Welcome back, {{firstName}}!', next: null },
      n8: { id: 'n8', type: 'message', text: 'Here are the details, {{firstName}}.', next: null },
    },
  }) as Sequence;

// Invite, a message, then a long wait: leads that reply are still on the wait when the reply lands.
const inviteThenMessage: Sequence = {
  start: 'n1',
  nodes: {
    n1: { id: 'n1', type: 'connect', note: '', next: 'n2' },
    n2: { id: 'n2', type: 'condition', kind: 'accepted_within', withinDays: 7, yes: 'n3', no: null },
    n3: { id: 'n3', type: 'message', text: 'Hi {{firstName}}!', next: 'n4' },
    n4: { id: 'n4', type: 'wait', days: 5, hours: 0, next: 'n5' },
    n5: { id: 'n5', type: 'message', text: 'Following up', next: null },
  },
} as Sequence;

const fast = { acceptRate: 1, replyRate: 1, acceptHours: [1, 2] as [number, number], replyHours: [1, 2] as [number, number] };

const lead = (w: World, id: number) => w.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id])!;
const cl = (w: World, campaignId: number, leadId: number) => w.ctx.db.get<CampaignLeadRow>('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?', [campaignId, leadId])!;
const replyOf = (w: World, leadId: number) =>
  w.ctx.db.get<{ body: string; category: string; confidence: number }>("SELECT m.body, m.category, m.confidence FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.lead_id = ? AND m.direction = 'in'", [leadId]);
const sentAt = (w: World, leadId: number, nodeId: string) =>
  w.ctx.db.get<{ created_at: number }>("SELECT created_at FROM activity WHERE lead_id = ? AND node_id = ? AND status = 'ok'", [leadId, nodeId])?.created_at;

describe('keyword classifier (simulated AI)', () => {
  it('labels common replies, and stays unsure about qualified opt-outs', () => {
    const cases: [string, string, number][] = [
      [OOO, 'out_of_office', 0.9],
      ['Automatic reply: I am on parental leave until March.', 'out_of_office', 0.9],
      ['Please remove me from your list.', 'unsubscribe', 0.9],
      ['STOP', 'unsubscribe', 0.9],
      [NO, 'not_interested', 0.9],
      ['No thanks, we are all set.', 'not_interested', 0.9],
      ["I'm not interested in a webinar, but happy to look at a trial.", 'not_interested', 0.55],
      ['Not interested at the moment.', 'not_now', 0.65],
      ["I'm no longer at Acme, try Sam instead.", 'wrong_person', 0.9],
      ['Booked a slot for Tuesday, see you then!', 'meeting_booked', 0.9],
      // "We're all set" confirms when something follows it; it only declines on its own.
      ["We're all set for Tuesday, see you then!", 'meeting_booked', 0.9],
      ["Great, we're good for Thursday at 3pm. Looking forward to our call.", 'meeting_booked', 0.9],
      ["Yes! We're all set up to start a trial, let's talk.", 'interested', 0.9],
      ["We're all set, thanks!", 'not_interested', 0.9],
      ['Not interested in the webinar. Happy to chat about pricing.', 'not_interested', 0.55],
      // A polite opt-out is still an opt-out; a negated one is not.
      ['Please stop messaging me, but thanks for reaching out.', 'unsubscribe', 0.9],
      ['Unsubscribe me please, though I appreciate it.', 'unsubscribe', 0.9],
      ["I'm not saying unsubscribe me, just slow down.", 'unsubscribe', 0.4],
      ['Hi, appreciate the note. Not a priority for us right now, maybe next quarter.', 'not_now', 0.9],
      ["Thanks! We're actually looking at this now. Let's talk.", 'interested', 0.9],
      ['Thanks for reaching out! Happy to chat, what does your calendar look like next week?', 'interested', 0.9],
      [QUESTION, 'question', 0.6],
      ['Ok.', 'other', 0.5],
    ];
    for (const [text, category, confidence] of cases) expect(keywordCategory(text), text).toEqual({ category, confidence });
  });
});

describe('reply classification', () => {
  it('classifies a reply, suppresses a confident "not interested" and stops the lead in every campaign', async () => {
    const w = makeWorld({ ...fast, replies: [NO] });
    w.ctx.db.insert('webhooks', { workspace_id: w.workspaceId, url: 'https://hooks.example/x', events: JSON.stringify(['lead.classified']), secret: 's', created_at: 0 });
    const [id] = addLeads(w, 1);
    const a = makeCampaign(w, inviteThenMessage, {}, [id]);
    // The same person waits in a second campaign, one that would keep going after a reply.
    const later = { start: 'w1', nodes: { w1: { id: 'w1', type: 'wait', days: 30, hours: 0, next: 'w2' }, w2: { id: 'w2', type: 'view_profile', next: null } } } as Sequence;
    const b = makeCampaign(w, later, { skipIfInOtherCampaign: false, stopOnReply: false }, [id]);
    expect(b.added.added).toBe(1);

    await runFor(w, 2 * DAY, 5 * MINUTE);
    expect(replyOf(w, id)).toEqual({ body: NO, category: 'not_interested', confidence: 0.9 });
    expect(cl(w, a.id, id).state).toBe('replied');
    expect(cl(w, b.id, id)).toMatchObject({ state: 'skipped', last_error: 'Suppressed: not_interested', hold_reason: null });
    expect(lead(w, id)).toMatchObject({ reply_category: 'not_interested' });
    expect(w.ctx.db.get('SELECT kind, value, reason, source FROM suppressions')).toEqual({ kind: 'linkedin', value: 'lead-0', reason: 'not_interested', source: 'reply classification' });
    expect(w.ctx.db.get('SELECT category, category_confidence AS c, category_source AS s FROM conversations')).toEqual({ category: 'not_interested', c: 0.9, s: 'ai' });
    expect(w.ctx.db.get("SELECT detail FROM activity WHERE lead_id = ? AND type = 'classified'", [id])).toEqual({ detail: 'Not interested (90% sure)' });

    const sent = w.ctx.webhooks.sent.filter((s) => s.event === 'lead.classified');
    expect(sent).toHaveLength(1);
    expect((sent[0].body as any).data).toMatchObject({ lead: { id, replyCategory: 'not_interested' }, category: 'not_interested', confidence: 0.9, source: 'ai', message: NO, conversationId: expect.any(Number) });
    // One classify job per reply; the job is idempotent when run again.
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = 'ai.classify'")!.n).toBe(1);
  });

  it('does not suppress on an unsure opt-out', async () => {
    const w = makeWorld({ ...fast, replies: ["I'm not interested in a webinar, but happy to look at a trial."] });
    const [id] = addLeads(w, 1);
    makeCampaign(w, inviteThenMessage, {}, [id]);
    await runFor(w, 2 * DAY, 5 * MINUTE);
    expect(replyOf(w, id)).toMatchObject({ category: 'not_interested', confidence: 0.55 });
    expect(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM suppressions')!.n).toBe(0);
  });

  it('suppresses a polite unsubscribe', async () => {
    const w = makeWorld({ ...fast, replies: ['Please stop messaging me, but thanks for reaching out.'] });
    const [id] = addLeads(w, 1);
    makeCampaign(w, inviteThenMessage, {}, [id]);
    await runFor(w, 2 * DAY, 5 * MINUTE);
    expect(w.ctx.db.get('SELECT reason, source FROM suppressions')).toEqual({ reason: 'unsubscribe', source: 'reply classification' });
  });

  it('ignores a late opt-out about an older reply', () => {
    const w = makeWorld();
    const [id] = addLeads(w, 1);
    const { id: campaignId } = makeCampaign(w, inviteThenMessage, { stopOnReply: false }, [id]);
    const conv = w.ctx.db.insert('conversations', { workspace_id: w.workspaceId, account_id: w.accountId, lead_id: id, thread_id: 't-1', participant_name: 'Lead', participant_url: lead(w, id).profile_url, last_message_at: 2 });
    const older = w.ctx.db.insert('messages', { conversation_id: conv, external_id: 'in-1', direction: 'in', body: NO, sent_at: 1 });
    const newer = w.ctx.db.insert('messages', { conversation_id: conv, external_id: 'in-2', direction: 'in', body: "Actually, let's talk next week.", sent_at: 2 });
    // The newer reply's job finishes first; the older one's lands after a retry.
    applyCategory(w.ctx, { workspaceId: w.workspaceId, conversationId: conv, messageId: newer, category: 'interested', confidence: 0.9, source: 'ai' });
    applyCategory(w.ctx, { workspaceId: w.workspaceId, conversationId: conv, messageId: older, category: 'not_interested', confidence: 0.9, source: 'ai' });
    expect(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM suppressions')!.n).toBe(0);
    expect(cl(w, campaignId, id).state).toBe('active');
    expect(lead(w, id).reply_category).toBe('interested');
    expect(w.ctx.db.get('SELECT category FROM messages WHERE id = ?', [older])).toEqual({ category: 'not_interested' });
  });

  it('keeps the plain stop-on-reply behaviour when no categories are chosen', async () => {
    const w = makeWorld({ ...fast, replies: [OOO] });
    const ids = addLeads(w, 3);
    const { id } = makeCampaign(w, inviteThenMessage, {}, ids);
    await runFor(w, 8 * DAY, 5 * MINUTE);
    expect(states(w, id)).toEqual({ replied: 3 });
    expect(counts(w, id)['message:ok']).toBe(3);
  });
});

describe('reply holds and the reply_sentiment condition', () => {
  it('resumes after an out-of-office reply and branches on the category; other replies stop', async () => {
    const w = makeWorld({ ...fast, replies: [OOO, QUESTION, NO] });
    const ids = addLeads(w, 9);
    const { id } = makeCampaign(w, branching(['out_of_office']), { continueOnCategories: ['out_of_office', 'question'] }, ids);
    await runFor(w, 6 * DAY, 5 * MINUTE);

    const seen = new Set<string>();
    for (const leadId of ids) {
      const reply = replyOf(w, leadId)!;
      seen.add(reply.category);
      const row = cl(w, id, leadId);
      if (reply.category === 'out_of_office') {
        // Held while classified, released, then the wait and the "welcome back" follow-up.
        expect(row.state).toBe('done');
        expect(sentAt(w, leadId, 'n7')! - sentAt(w, leadId, 'n3')!).toBeGreaterThanOrEqual(3 * DAY);
        expect(sentAt(w, leadId, 'n8')).toBeUndefined();
      } else if (reply.category === 'question') {
        expect(row.state).toBe('done');
        expect(sentAt(w, leadId, 'n8')).toBeDefined();
        expect(sentAt(w, leadId, 'n7')).toBeUndefined();
      } else {
        expect(reply.category).toBe('not_interested');
        expect(row.state).toBe('replied');
        expect(sentAt(w, leadId, 'n7') ?? sentAt(w, leadId, 'n8')).toBeUndefined();
      }
      expect(row.hold_reason).toBeNull();
    }
    expect(seen).toEqual(new Set(['out_of_office', 'question', 'not_interested']));
  });

  it('never continues after an opt-out, even an unsure one', () => {
    const settings = { stopOnReply: true, continueOnCategories: ['not_interested', 'interested'] as any };
    const at = { replied_at: 10, reply_category_at: 11 };
    expect(replyDecision(settings, { ...at, reply_category: 'not_interested' })).toBe('stop');
    expect(replyDecision(settings, { ...at, reply_category: 'unsubscribe' })).toBe('stop');
    expect(replyDecision(settings, { ...at, reply_category: 'interested' })).toBe('continue');
  });

  it('releases a held lead when an older reply from another sender is classified after its latest one', () => {
    const w = makeWorld();
    const [id] = addLeads(w, 1);
    const { id: campaignId } = makeCampaign(w, inviteThenMessage, { continueOnCategories: ['out_of_office', 'question'] }, [id]);
    const other = w.ctx.db.insert('accounts', { workspace_id: w.workspaceId, name: 'Seat B', driver: 'simulator', timezone: 'UTC', warmup: 0, created_at: 0 });
    const thread = (accountId: number, sentAt: number, body: string) => {
      const conv = w.ctx.db.insert('conversations', { workspace_id: w.workspaceId, account_id: accountId, lead_id: id, thread_id: `t-${accountId}`, participant_name: 'Lead', participant_url: lead(w, id).profile_url, last_message_at: sentAt });
      const msg = w.ctx.db.insert('messages', { conversation_id: conv, external_id: `in-${accountId}`, direction: 'in', body, sent_at: sentAt });
      handleInboundReply(w.ctx, { lead: lead(w, id), channel: 'linkedin', conversationId: conv, messageId: msg, body });
      return { conv, msg };
    };
    const start = w.ctx.clock.now();
    // Account A syncs the newest reply, which is classified and releases the hold.
    const a = thread(w.accountId, start - 10 * MINUTE, OOO);
    w.ctx.clock.advance(MINUTE);
    applyCategory(w.ctx, { workspaceId: w.workspaceId, conversationId: a.conv, messageId: a.msg, category: 'out_of_office', confidence: 0.9, source: 'ai' });
    expect(cl(w, campaignId, id).hold_reason).toBeNull();
    // Account B then syncs an older reply: the lead is held again, and its classification must release it.
    w.ctx.clock.advance(MINUTE);
    const b = thread(other, start - 20 * MINUTE, QUESTION);
    expect(cl(w, campaignId, id).hold_reason).toBe('reply');
    w.ctx.clock.advance(MINUTE);
    applyCategory(w.ctx, { workspaceId: w.workspaceId, conversationId: b.conv, messageId: b.msg, category: 'question', confidence: 0.6, source: 'ai' });
    expect(cl(w, campaignId, id)).toMatchObject({ state: 'active', hold_reason: null });
    expect(latestCategory(lead(w, id))).toBe('out_of_office');
  });

  it('stops a held lead as replied when its reply is not classified in time, and re-holds on spurious wake-ups', async () => {
    const w = makeWorld({ ...fast, replies: [OOO] });
    // A provider that never answers in time.
    w.ctx.jobs.register('ai.classify', async () => {
      throw new RetryLater(DAY, 'slow provider');
    });
    const [id] = addLeads(w, 1);
    const { id: campaignId } = makeCampaign(w, inviteThenMessage, { continueOnCategories: ['out_of_office'] }, [id]);
    // Run until the reply is seen.
    for (let i = 0; i < 1000 && !lead(w, id).replied_at; i++) await runFor(w, 5 * MINUTE, 5 * MINUTE);
    const repliedAt = lead(w, id).replied_at!;
    const deadline = repliedAt + w.ctx.config.replyHoldMin * MINUTE;
    expect(cl(w, campaignId, id)).toMatchObject({ state: 'active', hold_reason: 'reply', next_run_at: deadline });

    // A sequence edit wakes every active lead; the hold comes back with the same deadline.
    w.ctx.db.run('UPDATE campaign_leads SET next_run_at = ? WHERE id = ?', [w.ctx.clock.now(), cl(w, campaignId, id).id]);
    w.engine.advanceFreeSteps();
    expect(cl(w, campaignId, id)).toMatchObject({ state: 'active', hold_reason: 'reply', next_run_at: deadline });

    await runFor(w, HOUR, 5 * MINUTE);
    expect(cl(w, campaignId, id)).toMatchObject({ state: 'replied', hold_reason: null });
    expect(counts(w, campaignId)['message:ok']).toBe(1);
  });

  it('waits for the category with stop-on-reply off, then treats an unclassified reply as "other"', () => {
    const w = makeWorld();
    const [id] = addLeads(w, 1);
    const seq = {
      start: 'c',
      nodes: {
        c: { id: 'c', type: 'condition', kind: 'reply_sentiment', withinDays: 7, categories: ['other'], yes: 'y', no: 'n' },
        y: { id: 'y', type: 'wait', days: 1, hours: 0, next: null },
        n: { id: 'n', type: 'wait', days: 2, hours: 0, next: null },
      },
    } as Sequence;
    // No reply yet: No.
    const first = makeCampaign(w, seq, { stopOnReply: false }, [id]);
    w.engine.advanceFreeSteps();
    expect(cl(w, first.id, id).node_id).toBe('n');

    // A reply that is never classified: the condition waits, then counts it as "other".
    w.ctx.clock.advance(MINUTE);
    const second = makeCampaign(w, seq, { stopOnReply: false, skipIfInOtherCampaign: false }, [id]);
    w.ctx.db.update('leads', id, { replied_at: w.ctx.clock.now() });
    w.engine.advanceFreeSteps();
    expect(cl(w, second.id, id)).toMatchObject({ node_id: 'c', state: 'active' });
    w.ctx.clock.advance(31 * MINUTE);
    w.engine.advanceFreeSteps();
    expect(cl(w, second.id, id).node_id).toBe('y');
  });
});

// A conversation with one inbound reply in the API user's workspace.
function seedReply(w: World, workspaceId: number, text: string, slug = 'zoe') {
  const accountId = w.ctx.db.insert('accounts', { workspace_id: workspaceId, name: 'Seat', driver: 'simulator', timezone: 'UTC', warmup: 0, created_at: 0 });
  const list = w.ctx.db.insert('lead_lists', { workspace_id: workspaceId, name: 'L', created_at: 0 });
  importLeads(w.ctx, workspaceId, list, [{ profileUrl: `https://www.linkedin.com/in/${slug}/`, firstName: 'Zoe', company: 'Initech' }]);
  const l = w.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE workspace_id = ? AND public_id = ?', [workspaceId, slug])!;
  const conv = w.ctx.db.insert('conversations', { workspace_id: workspaceId, account_id: accountId, lead_id: l.id, thread_id: `t-${slug}`, participant_name: 'Zoe', participant_url: l.profile_url, last_message_at: 1 });
  w.ctx.db.insert('messages', { conversation_id: conv, external_id: 'out-1', direction: 'out', body: 'Hi Zoe, quick question about Initech.', sent_at: 0 });
  const msg = w.ctx.db.insert('messages', { conversation_id: conv, external_id: 'in-1', direction: 'in', body: text, sent_at: 1 });
  handleInboundReply(w.ctx, { lead: l, channel: 'linkedin', conversationId: conv, messageId: msg, body: text });
  return { conv, lead: l, accountId };
}

describe('inbox and suppression routes', () => {
  it('filters by category, shows the suggested stage and lets writers override the category', async () => {
    const api = await makeApi();
    const owner = await api.register('Acme');
    const { conv, lead: l } = seedReply(api.w, owner.workspaceId, QUESTION);
    seedReply(api.w, owner.workspaceId, "Thanks! We're actually looking at this now. Let's talk.", 'max');
    await api.w.ctx.jobs.drain();

    const all = await api.call('GET', '/api/inbox');
    expect(all.body).toHaveLength(2);
    expect(all.body[0]).toMatchObject({ channel: 'linkedin', category: expect.any(String), categoryConfidence: expect.any(Number) });
    const questions = await api.call('GET', '/api/inbox?category=question');
    expect(questions.body.map((c: any) => c.id)).toEqual([conv]);
    expect((await api.call('GET', '/api/inbox?category=nope')).status).toBe(400);

    const detail = await api.call('GET', `/api/inbox/${conv}`);
    expect(detail.body).toMatchObject({ category: 'question', categorySource: 'ai', suggestedStage: null });
    expect(detail.body.messages.find((m: any) => m.direction === 'in')).toMatchObject({ category: 'question', confidence: 0.6 });

    const member = await api.addUser('member');
    api.as(member);
    const set = await api.call('PATCH', `/api/inbox/${conv}/category`, { category: 'interested' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ category: 'interested', categoryConfidence: 1, categorySource: 'manual', suggestedStage: 'interested' });
    expect(lead(api.w, l.id).reply_category).toBe('interested');
    expect((await api.call('PATCH', `/api/inbox/${conv}/category`, { category: 'maybe' })).status).toBe(400);

    // Marking an opt-out by hand suppresses the person.
    await api.call('PATCH', `/api/inbox/${conv}/category`, { category: 'unsubscribe' });
    expect(api.w.ctx.db.get('SELECT reason, source FROM suppressions WHERE lead_id = ?', [l.id])).toEqual({ reason: 'unsubscribe', source: 'inbox' });

    // Another workspace sees nothing and can't change it.
    await api.register('Other');
    expect((await api.call('GET', '/api/inbox')).body).toEqual([]);
    expect((await api.call('GET', `/api/inbox/${conv}`)).status).toBe(404);
    expect((await api.call('PATCH', `/api/inbox/${conv}/category`, { category: 'other' })).status).toBe(404);
    expect((await api.call('POST', `/api/inbox/${conv}/suggest`, {})).status).toBe(404);
  });

  it('suggests 1–3 replies without sending or storing anything', async () => {
    const api = await makeApi();
    const owner = await api.register('Acme');
    const { conv } = seedReply(api.w, owner.workspaceId, OOO);
    await api.w.ctx.jobs.drain();
    const before = api.w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')!.n;

    const three = await api.call('POST', `/api/inbox/${conv}/suggest`, {});
    expect(three.status).toBe(200);
    expect(three.body.simulated).toBe(true);
    expect(three.body.suggestions).toHaveLength(3);
    for (const s of three.body.suggestions) expect(s).toMatch(/Zoe/);
    const one = await api.call('POST', `/api/inbox/${conv}/suggest`, { count: 1, instruction: 'Keep it short' });
    expect(one.body.suggestions).toHaveLength(1);
    expect((await api.call('POST', `/api/inbox/${conv}/suggest`, { count: 4 })).status).toBe(400);

    expect(api.w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')!.n).toBe(before);
    expect(api.w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE type = 'message'")!.n).toBe(0);
    expect(api.w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM usage_events WHERE operation = 'ai.reply'")!.n).toBe(2);
  });

  it('lists, adds and removes do-not-contact entries with role checks and workspace isolation', async () => {
    const api = await makeApi();
    const owner = await api.register('Acme');
    const { lead: l } = seedReply(api.w, owner.workspaceId, NO);
    await api.w.ctx.jobs.drain();

    const list = await api.call('GET', '/api/suppressions');
    expect(list.body).toMatchObject({ total: 1, items: [{ kind: 'linkedin', value: 'zoe', reason: 'not_interested', leadId: l.id, leadName: 'Zoe ' }] });

    const member = await api.addUser('member');
    api.as(member);
    expect((await api.call('POST', '/api/suppressions', { kind: 'email', value: 'Bob@Example.com' })).body).toEqual({ added: true, stopped: 0 });
    expect((await api.call('POST', '/api/suppressions', { kind: 'email', value: 'not-an-email' })).status).toBe(400);
    expect((await api.call('POST', '/api/suppressions', { kind: 'phone', value: '020 7946 0958' })).status).toBe(400);
    expect((await api.call('GET', '/api/suppressions?kind=email')).body.items.map((s: any) => s.value)).toEqual(['bob@example.com']);
    expect((await api.call('GET', '/api/suppressions?q=zo')).body.total).toBe(1);
    // Only admins take people off the list.
    const id = list.body.items[0].id;
    expect((await api.call('DELETE', `/api/suppressions/${id}`)).status).toBe(403);

    api.as(owner);
    // A manual entry stops the matching lead's running campaigns right away.
    const campaign = api.w.ctx.db.insert('campaigns', { workspace_id: owner.workspaceId, name: 'C', status: 'active', sequence: JSON.stringify({ start: null, nodes: {} }), settings: '{}', created_at: 0 });
    api.w.ctx.db.update('leads', l.id, { email: 'zoe@initech.example' });
    api.w.ctx.db.insert('campaign_leads', { campaign_id: campaign, lead_id: l.id, state: 'active', node_entered_at: 0, next_run_at: 0, added_at: 0 });
    expect((await api.call('POST', '/api/suppressions', { kind: 'email', value: 'ZOE@initech.example' })).body).toEqual({ added: true, stopped: 1 });

    const other = await api.register('Other');
    expect((await api.call('GET', '/api/suppressions')).body.total).toBe(0);
    expect((await api.call('DELETE', `/api/suppressions/${id}`)).status).toBe(404);
    api.as(owner);
    expect((await api.call('DELETE', `/api/suppressions/${id}`)).status).toBe(200);
    expect((await api.call('GET', '/api/suppressions')).body.total).toBe(2);
    expect(other.workspaceId).not.toBe(owner.workspaceId);
  });

  it('warns about reply conditions that can never see a reply', async () => {
    const api = await makeApi();
    await api.register('Acme');
    const created = await api.call('POST', '/api/campaigns', { name: 'C', sequence: branching(['out_of_office']) });
    expect(created.body.warnings.join(' ')).toMatch(/never sees a reply/);
    const patched = await api.call('PATCH', `/api/campaigns/${created.body.id}`, { settings: { continueOnCategories: ['out_of_office'] } });
    // Opt-outs can't be kept going.
    expect((await api.call('PATCH', `/api/campaigns/${created.body.id}`, { settings: { continueOnCategories: ['not_interested'] } })).status).toBe(400);
    expect((await api.call('POST', '/api/campaigns', { name: 'D', settings: { continueOnCategories: ['unsubscribe'] } })).status).toBe(400);
    expect(patched.body.warnings.join(' ')).not.toMatch(/reply is/);
    const empty = await api.call('PATCH', `/api/campaigns/${created.body.id}`, { sequence: branching([]) });
    expect(empty.body.problems).toContain('A "reply is" condition needs at least one reply category');
  });
});
