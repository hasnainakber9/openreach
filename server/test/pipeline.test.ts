import { describe, expect, it } from 'vitest';
import { applyCategory } from '../src/ai/classify.js';
import { DAY, MINUTE } from '../src/clock.js';
import { DB } from '../src/db/db.js';
import type { Sequence } from '../src/engine/sequence.js';
import { canonicalTags, createTag, listTags } from '../src/services/tags.js';
import { autoAdvance, BULK_EVENT_MAX_IDS, deleteStage, listStages, setStage, stageOf } from '../src/services/pipeline.js';
import { handleInboundReply } from '../src/services/replies.js';
import { setSetting } from '../src/services/settings.js';
import { PipelineSettingsSchema } from '../src/services/pipeline.js';
import { completeTask, createTask } from '../src/services/tasks.js';
import type { LeadRow, StageRow, TaskRow } from '../src/types.js';
import { addLeads, makeApi, makeCampaign, makeWorld, runFor, type World } from './helpers.js';

const inviteThenMessage: Sequence = {
  start: 'n1',
  nodes: {
    n1: { id: 'n1', type: 'connect', note: '', next: 'n2' },
    n2: { id: 'n2', type: 'condition', kind: 'accepted_within', withinDays: 7, yes: 'n3', no: null },
    n3: { id: 'n3', type: 'message', text: 'Hi {{firstName}}!', next: 'n4' },
    n4: { id: 'n4', type: 'wait', days: 5, hours: 0, next: null },
  },
} as Sequence;

const lead = (w: World, id: number) => w.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id])!;
const slugOf = (w: World, id: number) => stageOf(w.ctx, lead(w, id))!.slug;
const stage = (w: World, slug: string) => listStages(w.ctx, w.workspaceId).find((s) => s.slug === slug)!;

// Collects lead.stage_changed events (webhook rows aren't needed: subscribers see every event).
function stageEvents(w: World) {
  const events: any[] = [];
  w.ctx.webhooks.subscribe((_ws, event, data) => event === 'lead.stage_changed' && events.push(data));
  return events;
}

// A LinkedIn thread with one inbound reply for the lead, run through the normal reply path.
function reply(w: World, leadId: number, body = 'Sounds good') {
  const conv = w.ctx.db.insert('conversations', { workspace_id: w.workspaceId, account_id: w.accountId, lead_id: leadId, thread_id: `t-${leadId}-${w.ctx.clock.now()}`, participant_name: 'Lead', last_message_at: w.ctx.clock.now() });
  const msg = w.ctx.db.insert('messages', { conversation_id: conv, external_id: `in-${w.ctx.clock.now()}`, direction: 'in', body, sent_at: w.ctx.clock.now() });
  handleInboundReply(w.ctx, { lead: lead(w, leadId), channel: 'linkedin', conversationId: conv, messageId: msg, body });
  return { conv, msg };
}

describe('pipeline stages', () => {
  it('creates the default stages for existing workspaces and backfills stages from history', () => {
    const db = new DB(':memory:', { migrateTo: 10 });
    const ws = db.insert('workspaces', { name: 'W', created_at: 1 });
    const mk = (pid: string, extra: Record<string, any> = {}) => db.insert('leads', { workspace_id: ws, public_id: pid, profile_url: `https://www.linkedin.com/in/${pid}/`, created_at: 1, ...extra });
    const fresh = mk('fresh');
    const contacted = mk('contacted');
    const replied = mk('replied', { replied_at: 5 });
    const keen = mk('keen', { replied_at: 5, reply_category: 'interested', reply_category_at: 6 });
    db.insert('activity', { workspace_id: ws, lead_id: contacted, type: 'connect', status: 'ok', day: '2026-01-01', created_at: 2 });
    db.insert('activity', { workspace_id: ws, lead_id: fresh, type: 'connect', status: 'failed', day: '2026-01-01', created_at: 2 });

    db.migrate();

    expect(db.all<StageRow>('SELECT slug, name, position, kind FROM pipeline_stages WHERE workspace_id = ? ORDER BY position', [ws])).toEqual([
      { slug: 'new', name: 'New', position: 0, kind: 'open' },
      { slug: 'contacted', name: 'Contacted', position: 1, kind: 'open' },
      { slug: 'replied', name: 'Replied', position: 2, kind: 'open' },
      { slug: 'interested', name: 'Interested', position: 3, kind: 'open' },
      { slug: 'meeting', name: 'Meeting booked', position: 4, kind: 'open' },
      { slug: 'won', name: 'Won', position: 5, kind: 'won' },
      { slug: 'lost', name: 'Lost', position: 6, kind: 'lost' },
    ]);
    const slug = (id: number) => db.get<{ slug: string | null }>('SELECT s.slug FROM leads l LEFT JOIN pipeline_stages s ON s.id = l.stage_id WHERE l.id = ?', [id])!.slug;
    expect([slug(fresh), slug(contacted), slug(replied), slug(keen)]).toEqual([null, 'contacted', 'replied', 'interested']);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('adds stages lazily to workspaces created without them, and at sign-up', async () => {
    const w = makeWorld();
    expect(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pipeline_stages WHERE workspace_id = ?', [w.workspaceId])!.n).toBe(0);
    const [id] = addLeads(w, 1);
    expect(slugOf(w, id)).toBe('new');
    expect(listStages(w.ctx, w.workspaceId)).toHaveLength(7);
    // Idempotent.
    expect(listStages(w.ctx, w.workspaceId)).toHaveLength(7);

    const api = await makeApi();
    const owner = await api.register();
    expect(api.w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pipeline_stages WHERE workspace_id = ?', [owner.workspaceId])!.n).toBe(7);
  });

  it('moves leads to contacted on first contact, replied on a reply and interested on an interested reply', async () => {
    const w = makeWorld({ acceptRate: 1, replyRate: 1, acceptHours: [1, 2], replyHours: [1, 2], replies: ["Yes, I'm interested, let's talk"] });
    const events = stageEvents(w);
    const order: string[] = [];
    w.ctx.webhooks.subscribe((_ws, event) => void order.push(event));
    const [id] = addLeads(w, 1);
    makeCampaign(w, inviteThenMessage, {}, [id]);

    await runFor(w, 2 * 60 * MINUTE, 5 * MINUTE);
    expect(slugOf(w, id)).toBe('contacted');
    expect(lead(w, id).stage_manual).toBe(0);
    // The send is announced before the stage change it caused.
    expect(order.filter((e) => e === 'action.performed' || e === 'lead.stage_changed')).toEqual(['action.performed', 'lead.stage_changed']);

    await runFor(w, 2 * DAY, 5 * MINUTE);
    expect(slugOf(w, id)).toBe('interested');
    const history = w.ctx.db.all<{ from: string; to: string; source: string }>(
      'SELECT f.slug AS "from", t.slug AS "to", h.source FROM lead_stage_history h LEFT JOIN pipeline_stages f ON f.id = h.from_stage_id JOIN pipeline_stages t ON t.id = h.to_stage_id WHERE h.lead_id = ? ORDER BY h.id',
      [id],
    );
    expect(history).toEqual([
      { from: 'new', to: 'contacted', source: 'auto' },
      { from: 'contacted', to: 'replied', source: 'auto' },
      { from: 'replied', to: 'interested', source: 'auto' },
    ]);
    expect(events.map((e) => [e.from.slug, e.to.slug, e.source])).toEqual([
      ['new', 'contacted', 'auto'],
      ['contacted', 'replied', 'auto'],
      ['replied', 'interested', 'auto'],
    ]);
    // Other webhooks carry the stage too.
    expect(events[2].lead).toMatchObject({ id, stage: { slug: 'interested', name: 'Interested' } });
  });

  it('announces a stage change only once the transaction around it commits', () => {
    const w = makeWorld();
    const events = stageEvents(w);
    const [a, b] = addLeads(w, 2);
    const won = stage(w, 'won').id;
    expect(() =>
      w.ctx.db.tx(() => {
        expect(setStage(w.ctx, lead(w, a), won, { source: 'manual' })).toBe(true);
        throw new Error('later step failed');
      }),
    ).toThrow('later step failed');
    expect(slugOf(w, a)).toBe('new');
    expect(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM lead_stage_history')!.n).toBe(0);
    expect(events).toEqual([]);

    w.ctx.db.tx(() => {
      setStage(w.ctx, lead(w, b), won, { source: 'manual' });
      expect(events).toEqual([]);
    });
    expect(events.map((e) => [e.lead.id, e.to.slug])).toEqual([[b, 'won']]);
    // Outside a transaction it is announced right away.
    setStage(w.ctx, lead(w, a), won, { source: 'manual' });
    expect(events).toHaveLength(2);
  });

  it('never moves a lead backward or out of won/lost', () => {
    const w = makeWorld();
    const [a, b, c] = addLeads(w, 3);
    setStage(w.ctx, lead(w, a), stage(w, 'meeting').id, { source: 'manual' });
    setStage(w.ctx, lead(w, b), stage(w, 'won').id, { source: 'manual' });
    setStage(w.ctx, lead(w, c), stage(w, 'lost').id, { source: 'manual' });
    for (const id of [a, b, c]) {
      reply(w, id);
      expect(autoAdvance(w.ctx, id, 'contacted', 'test')).toBe(false);
      expect(autoAdvance(w.ctx, id, 'interested', 'test')).toBe(false);
    }
    // Won is before Lost, but automation never leaves a closed stage.
    expect(autoAdvance(w.ctx, b, 'lost', 'test')).toBe(false);
    expect([slugOf(w, a), slugOf(w, b), slugOf(w, c)]).toEqual(['meeting', 'won', 'lost']);
    expect(lead(w, a).stage_manual).toBe(1);
    // A manual stage that is behind still moves forward.
    const [d] = addLeads(w, 1, 'late');
    setStage(w.ctx, lead(w, d), stage(w, 'contacted').id, { source: 'manual' });
    reply(w, d);
    expect(slugOf(w, d)).toBe('replied');
  });

  it('does nothing when the target stage was deleted, and follows a custom order', async () => {
    const api = await makeApi(makeWorld());
    const owner = await api.register();
    const ws = owner.workspaceId;
    const stages = (await api.call('GET', '/api/pipeline/stages')).body as any[];
    const bySlug = (s: string) => stages.find((x) => x.slug === s);
    // Remove "Replied" (leads there go to Contacted).
    expect((await api.call('DELETE', `/api/pipeline/stages/${bySlug('replied').id}`, { moveTo: bySlug('contacted').id })).status).toBe(200);
    const list = await api.call('POST', '/api/lists', { name: 'L' });
    const created = await api.call('POST', '/api/leads', { listId: list.body.id, profileUrl: 'https://www.linkedin.com/in/jane/' });
    const l = api.w.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [created.body.id])!;
    expect(autoAdvance(api.w.ctx, l, 'replied', 'test')).toBe(false);
    expect(stageOf(api.w.ctx, l)!.slug).toBe('new');
    expect(listStages(api.w.ctx, ws).map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('moves interested/meeting from classification, lost only when the workspace turns it on', () => {
    const w = makeWorld();
    const [a, b, c] = addLeads(w, 3);
    const ra = reply(w, a);
    applyCategory(w.ctx, { workspaceId: w.workspaceId, conversationId: ra.conv, messageId: ra.msg, category: 'meeting_booked', confidence: 0.9, source: 'ai' });
    expect(slugOf(w, a)).toBe('meeting');

    const rb = reply(w, b, 'No thanks');
    applyCategory(w.ctx, { workspaceId: w.workspaceId, conversationId: rb.conv, messageId: rb.msg, category: 'not_interested', confidence: 0.5, source: 'ai' });
    expect(slugOf(w, b)).toBe('replied');

    setSetting(w.ctx, w.workspaceId, 'pipeline', PipelineSettingsSchema, { autoLost: true });
    const rc = reply(w, c, 'No thanks');
    applyCategory(w.ctx, { workspaceId: w.workspaceId, conversationId: rc.conv, messageId: rc.msg, category: 'not_interested', confidence: 0.5, source: 'ai' });
    expect(slugOf(w, c)).toBe('lost');
  });

  it('moves the lead to meeting booked when a task ends with a booked meeting', () => {
    const w = makeWorld();
    const [id] = addLeads(w, 1);
    const t = createTask(w.ctx, { workspaceId: w.workspaceId, leadId: id, kind: 'call', title: 'Call', instructions: '', dueAt: w.ctx.clock.now(), assigneeId: null, autoSkipAt: null, campaignId: null, campaignLeadId: null, nodeId: null }) as TaskRow;
    completeTask(w.ctx, t, null, { outcome: 'meeting_booked' });
    expect(slugOf(w, id)).toBe('meeting');
  });
});

describe('pipeline API', () => {
  async function setup() {
    const api = await makeApi(makeWorld());
    const owner = await api.register('Acme');
    const list = (await api.call('POST', '/api/lists', { name: 'L' })).body.id as number;
    const leadIds: number[] = [];
    for (const [i, name] of ['Ada', 'Bob', 'Cy'].entries()) {
      const r = await api.call('POST', '/api/leads', { listId: list, profileUrl: `https://www.linkedin.com/in/p${i}/`, firstName: name, company: i === 2 ? 'Initech' : 'Acme' });
      leadIds.push(r.body.id);
    }
    const stages = (await api.call('GET', '/api/pipeline/stages')).body as { id: number; slug: string; leads: number }[];
    const st = (slug: string) => stages.find((s) => s.slug === slug)!.id;
    return { api, owner, list, leadIds, st };
  }

  it('moves a lead by hand with history and a webhook, and refuses another workspace\'s stage', async () => {
    const { api, owner, leadIds, st } = await setup();
    const events = stageEvents(api.w);
    const r = await api.call('POST', `/api/leads/${leadIds[0]}/stage`, { stageId: st('won') });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ moved: true, stage: { slug: 'won' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from: { slug: 'new' }, to: { slug: 'won' }, source: 'manual' });
    expect(api.w.ctx.db.get('SELECT source, user_id AS "userId" FROM lead_stage_history WHERE lead_id = ?', [leadIds[0]])).toEqual({ source: 'manual', userId: owner.id });
    const detail = await api.call('GET', `/api/leads/${leadIds[0]}`);
    expect(detail.body).toMatchObject({ stage: { slug: 'won' }, stageManual: true });
    const counts = (await api.call('GET', '/api/pipeline/stages')).body as any[];
    expect(counts.find((s) => s.slug === 'new').leads).toBe(2);
    expect(counts.find((s) => s.slug === 'won').leads).toBe(1);

    // A second workspace can't use these stages or leads, and its own ids are 404 here.
    const other = await api.register('Globex');
    const theirs = (await api.call('GET', '/api/pipeline/stages')).body[0].id;
    expect((await api.call('POST', `/api/leads/${leadIds[1]}/stage`, { stageId: theirs })).status).toBe(404);
    expect((await api.call('GET', `/api/leads/${leadIds[1]}/timeline`)).status).toBe(404);
    expect((await api.call('GET', `/api/leads/${leadIds[1]}/notes`)).status).toBe(404);
    expect((await api.call('PATCH', `/api/pipeline/stages/${st('won')}`, { name: 'Mine' })).status).toBe(404);
    expect((await api.call('POST', '/api/leads/bulk', { leadIds, stageId: theirs })).body).toEqual({ updated: 0, matched: 0 });
    const board = (await api.call('GET', '/api/pipeline/board')).body;
    expect(board.stages.reduce((n: number, s: any) => n + s.total, 0)).toBe(0);
    api.as(owner);
    expect((await api.call('POST', `/api/leads/${leadIds[1]}/stage`, { stageId: theirs })).status).toBe(404);
    expect(other.workspaceId).not.toBe(owner.workspaceId);
  });

  it('lets admins edit, order and delete stages, and members only move leads', async () => {
    const { api, owner, list, leadIds, st } = await setup();
    const member = await api.addUser('member');
    api.as(member);
    expect((await api.call('POST', '/api/pipeline/stages', { name: 'Demo' })).status).toBe(403);
    expect((await api.call('PUT', '/api/pipeline/settings', { autoLost: true })).status).toBe(403);
    expect((await api.call('POST', `/api/leads/${leadIds[0]}/stage`, { stageId: st('replied') })).status).toBe(200);

    api.as(owner);
    const demo = await api.call('POST', '/api/pipeline/stages', { name: 'Demo', color: '#123456' });
    expect(demo.status).toBe(200);
    let stages = (await api.call('GET', '/api/pipeline/stages')).body as any[];
    // New working stages go before Won/Lost.
    expect(stages.map((s) => s.name)).toEqual(['New', 'Contacted', 'Replied', 'Interested', 'Meeting booked', 'Demo', 'Won', 'Lost']);
    expect((await api.call('PATCH', `/api/pipeline/stages/${demo.body.id}`, { name: 'Product demo', kind: 'open' })).body).toMatchObject({ name: 'Product demo' });
    expect((await api.call('PATCH', `/api/pipeline/stages/${demo.body.id}`, { color: 'red' })).status).toBe(400);

    // Deleting the first stage moves leads that never had a stage too.
    const del = await api.call('DELETE', `/api/pipeline/stages/${st('new')}`, { moveTo: st('contacted') });
    expect(del.body).toEqual({ ok: true, moved: 2 });
    stages = (await api.call('GET', '/api/pipeline/stages')).body;
    expect(stages.find((s) => s.slug === 'contacted').leads).toBe(2);
    expect((await api.call('DELETE', `/api/pipeline/stages/${st('won')}`, { moveTo: st('won') })).status).toBe(400);
    expect((await api.call('DELETE', `/api/pipeline/stages/${st('won')}`)).status).toBe(400);

    // The first stage stays an open one: new leads start there and automation never moves leads out of won/lost.
    const ids = stages.map((s) => s.id);
    expect((await api.call('PUT', '/api/pipeline/stages/order', { ids: ids.slice(1) })).status).toBe(400);
    expect((await api.call('PUT', '/api/pipeline/stages/order', { ids: [...ids].reverse() })).status).toBe(400);
    expect((await api.call('PATCH', `/api/pipeline/stages/${st('contacted')}`, { kind: 'won' })).status).toBe(400);
    expect((await api.call('PATCH', `/api/pipeline/stages/${st('replied')}`, { kind: 'won' })).status).toBe(200);
    expect((await api.call('PUT', '/api/pipeline/stages/order', { ids: [ids[1], ids[0], ...ids.slice(2)] })).status).toBe(400);
    expect((await api.call('PATCH', `/api/pipeline/stages/${st('replied')}`, { kind: 'open' })).status).toBe(200);

    // A reorder never moves leads: one added without a stage stays in Contacted when Replied goes first,
    // with no history row and no webhook. Leads added afterwards start in the new first stage.
    const events = stageEvents(api.w);
    const fresh = (await api.call('POST', '/api/leads', { listId: list, profileUrl: 'https://www.linkedin.com/in/p9/', firstName: 'Di' })).body.id as number;
    expect(api.w.ctx.db.get<{ stage_id: number | null }>('SELECT stage_id FROM leads WHERE id = ?', [fresh])!.stage_id).toBeNull();
    expect((await api.call('PUT', '/api/pipeline/stages/order', { ids: [ids[1], ids[0], ...ids.slice(2)] })).status).toBe(200);
    stages = (await api.call('GET', '/api/pipeline/stages')).body;
    expect(stages.slice(0, 2).map((s) => [s.slug, s.leads])).toEqual([
      ['replied', 1],
      ['contacted', 3],
    ]);
    expect((await api.call('GET', `/api/leads/${fresh}`)).body).toMatchObject({ stage: { slug: 'contacted' } });
    expect(events).toEqual([]);
    expect(api.w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM lead_stage_history WHERE lead_id = ?', [fresh])!.n).toBe(0);
    const later = (await api.call('POST', '/api/leads', { listId: list, profileUrl: 'https://www.linkedin.com/in/p10/', firstName: 'Ed' })).body.id as number;
    expect((await api.call('GET', `/api/leads/${later}`)).body).toMatchObject({ stage: { slug: 'replied' } });

    // Deleting the first stage can't leave a won/lost one on top either.
    await api.call('PUT', '/api/pipeline/stages/order', { ids: [ids[1], ...ids.slice(2, -2), ids[0], ...ids.slice(-2)] });
    for (const s of ((await api.call('GET', '/api/pipeline/stages')).body as any[]).slice(1, -2)) await api.call('DELETE', `/api/pipeline/stages/${s.id}`, { moveTo: st('replied') });
    stages = (await api.call('GET', '/api/pipeline/stages')).body;
    expect(stages.map((s) => s.slug)).toEqual(['replied', 'won', 'lost']);
    expect((await api.call('DELETE', `/api/pipeline/stages/${st('replied')}`, { moveTo: st('won') })).status).toBe(409);
  });

  it('manages tags: create, apply in bulk, rename, recolor and delete', async () => {
    const { api, leadIds } = await setup();
    const member = await api.addUser('member');
    const tag = await api.call('POST', '/api/tags', { name: 'VIP' });
    expect(tag.body).toMatchObject({ name: 'VIP', leads: 0 });
    expect((await api.call('POST', '/api/tags', { name: 'vip' })).status).toBe(409);

    // Bulk add uses the existing spelling and creates new tags on the fly.
    expect((await api.call('POST', '/api/leads/bulk', { leadIds, addTags: ['vip', 'Q3'] })).body).toEqual({ updated: 3, matched: 3 });
    expect((await api.call('POST', '/api/leads/bulk', { leadIds: [leadIds[0]], removeTags: ['q3'] })).body).toEqual({ updated: 1, matched: 1 });
    const tags = (await api.call('GET', '/api/tags')).body as any[];
    expect(tags.map((t) => [t.name, t.leads])).toEqual([
      ['Q3', 2],
      ['VIP', 3],
    ]);
    // Tags typed on a lead join the list too.
    await api.call('PATCH', `/api/leads/${leadIds[2]}`, { tags: ['VIP', 'Hot lead'] });
    expect(((await api.call('GET', '/api/tags')).body as any[]).map((t) => t.name)).toEqual(['Hot lead', 'Q3', 'VIP']);

    api.as(member);
    expect((await api.call('PATCH', `/api/tags/${tag.body.id}`, { name: 'Key' })).status).toBe(403);
    expect((await api.call('DELETE', `/api/tags/${tag.body.id}`)).status).toBe(403);
    api.as({ cookie: '' });

    const owner = await api.register('Other');
    expect((await api.call('PATCH', `/api/tags/${tag.body.id}`, { name: 'Key' })).status).toBe(404);
    expect(((await api.call('GET', '/api/tags')).body as any[]).length).toBe(0);
    void owner;
  });

  it('rewrites lead tags on rename and delete', async () => {
    const { api, leadIds } = await setup();
    await api.call('POST', '/api/leads/bulk', { leadIds, addTags: ['VIP', 'Q3'] });
    const vip = ((await api.call('GET', '/api/tags')).body as any[]).find((t) => t.name === 'VIP');
    expect((await api.call('PATCH', `/api/tags/${vip.id}`, { name: 'Q3' })).status).toBe(409);
    expect((await api.call('PATCH', `/api/tags/${vip.id}`, { name: 'Key account', color: '#ff0000' })).body).toEqual({ id: vip.id, name: 'Key account', color: '#ff0000' });
    const tagsOf = (id: number) => JSON.parse(api.w.ctx.db.get<{ tags: string }>('SELECT tags FROM leads WHERE id = ?', [id])!.tags);
    expect(tagsOf(leadIds[0])).toEqual(['Key account', 'Q3']);
    await api.call('DELETE', `/api/tags/${vip.id}`);
    expect(leadIds.map(tagsOf)).toEqual([['Q3'], ['Q3'], ['Q3']]);
    expect(((await api.call('GET', '/api/tags')).body as any[]).map((t) => t.name)).toEqual(['Q3']);
  });

  it('keeps notes with their author: authors and admins edit, other members cannot', async () => {
    const { api, owner, leadIds } = await setup();
    const m1 = await api.addUser('member');
    const m2 = await api.addUser('member');
    api.as(m1);
    const note = await api.call('POST', `/api/leads/${leadIds[0]}/notes`, { body: 'Met at the conference' });
    expect(note.body).toMatchObject({ body: 'Met at the conference', userId: m1.id, authorName: expect.stringContaining('member'), canEdit: true });
    expect((await api.call('POST', `/api/leads/${leadIds[0]}/notes`, { body: '   ' })).status).toBe(400);
    expect((await api.call('PATCH', `/api/notes/${note.body.id}`, { body: 'Met at SaaStr' })).body).toMatchObject({ body: 'Met at SaaStr' });

    api.as(m2);
    expect((await api.call('GET', `/api/leads/${leadIds[0]}/notes`)).body[0]).toMatchObject({ canEdit: false });
    expect((await api.call('PATCH', `/api/notes/${note.body.id}`, { body: 'Mine now' })).status).toBe(403);
    expect((await api.call('DELETE', `/api/notes/${note.body.id}`)).status).toBe(403);

    api.as(owner);
    expect((await api.call('PATCH', `/api/notes/${note.body.id}`, { body: 'Edited by the owner' })).status).toBe(200);
    await api.register('Elsewhere');
    expect((await api.call('DELETE', `/api/notes/${note.body.id}`)).status).toBe(404);
    api.as(owner);
    expect((await api.call('DELETE', `/api/notes/${note.body.id}`)).status).toBe(200);
    expect((await api.call('GET', `/api/leads/${leadIds[0]}/notes`)).body).toEqual([]);
  });

  it('filters the board by campaign, owner, tag and search, and pages a column', async () => {
    const { api, owner, leadIds, st } = await setup();
    const member = await api.addUser('member');
    const camp = await api.call('POST', '/api/campaigns', { name: 'C' });
    expect(camp.status).toBe(200);
    await api.call('POST', `/api/campaigns/${camp.body.id}/leads`, { leadIds: [leadIds[0], leadIds[1]] });
    await api.call('PATCH', `/api/leads/${leadIds[1]}`, { ownerId: member.id });
    await api.call('POST', '/api/leads/bulk', { leadIds: [leadIds[1], leadIds[2]], addTags: ['VIP'] });
    await api.call('POST', `/api/leads/${leadIds[2]}/stage`, { stageId: st('interested') });

    const board = async (qs = '') => (await api.call('GET', `/api/pipeline/board${qs}`)).body.stages as any[];
    const names = (cols: any[]) => Object.fromEntries(cols.filter((c) => c.total).map((c) => [c.slug, c.leads.map((l: any) => l.name)]));
    expect(names(await board())).toEqual({ new: ['Bob', 'Ada'], interested: ['Cy'] });
    expect(names(await board(`?campaignId=${camp.body.id}`))).toEqual({ new: ['Bob', 'Ada'] });
    expect(names(await board(`?ownerId=${member.id}`))).toEqual({ new: ['Bob'] });
    expect(names(await board('?ownerId=none'))).toEqual({ new: ['Ada'], interested: ['Cy'] });
    expect(names(await board('?tag=vip'))).toEqual({ new: ['Bob'], interested: ['Cy'] });
    expect(names(await board('?q=initech'))).toEqual({ interested: ['Cy'] });
    const card = (await board()).find((c) => c.slug === 'new').leads[0];
    expect(card).toMatchObject({ id: leadIds[1], ownerId: member.id, ownerName: expect.any(String), tags: ['VIP'] });

    // Load more: one column, from an offset.
    const more = await board(`?stageId=${st('new')}&perStage=1&offset=1`);
    expect(more).toHaveLength(1);
    expect(more[0]).toMatchObject({ total: 2, leads: [{ name: 'Ada' }] });

    // Owners must be members of the workspace.
    await api.register('Other');
    const stranger = (await api.call('GET', '/api/auth/me')).body.user.id;
    api.as(owner);
    expect((await api.call('PATCH', `/api/leads/${leadIds[0]}`, { ownerId: stranger })).status).toBe(404);
    expect((await api.call('POST', '/api/leads/bulk', { leadIds, ownerId: stranger })).status).toBe(404);
    // The leads list filters the same way.
    const filtered = await api.call('GET', `/api/leads?stageId=${st('new')}&tag=VIP`);
    expect(filtered.body.items.map((l: any) => [l.firstName, l.stage.slug])).toEqual([['Bob', 'new']]);
  });

  it('merges a lead timeline from activity, replies, notes, stages and tasks, newest first and paged', async () => {
    const { api, owner, leadIds, st } = await setup();
    const w = api.w;
    const id = leadIds[0];
    const at = w.ctx.clock.now();
    // Everything lands in the same millisecond, so paging must order ties.
    w.ctx.db.insert('activity', { workspace_id: owner.workspaceId, lead_id: id, type: 'connect', status: 'ok', day: '2026-01-05', created_at: at });
    w.ctx.db.insert('activity', { workspace_id: owner.workspaceId, lead_id: id, type: 'replied', status: 'ok', day: '2026-01-05', created_at: at });
    const conv = w.ctx.db.insert('conversations', { workspace_id: owner.workspaceId, channel: 'email', lead_id: id, thread_id: 'x', last_message_at: at });
    w.ctx.db.insert('messages', { conversation_id: conv, external_id: 'e1', direction: 'in', body: 'Tell me more', sent_at: at });
    w.ctx.db.insert('messages', { conversation_id: conv, external_id: 'e0', direction: 'out', body: 'Hello', sent_at: at });
    await api.call('POST', `/api/leads/${id}/notes`, { body: 'Warm intro' });
    await api.call('POST', `/api/leads/${id}/stage`, { stageId: st('interested') });
    createTask(w.ctx, { workspaceId: owner.workspaceId, leadId: id, kind: 'call', title: 'Call Ada', instructions: '', dueAt: at, assigneeId: null, autoSkipAt: null, campaignId: null, campaignLeadId: null, nodeId: null });

    const all = (await api.call('GET', `/api/leads/${id}/timeline?limit=50`)).body;
    expect(all.items.map((i: any) => i.kind)).toEqual(['stage', 'note', 'task', 'message', 'activity']);
    expect(all.items.find((i: any) => i.kind === 'message')).toMatchObject({ body: 'Tell me more', channel: 'email' });
    expect(all.items.find((i: any) => i.kind === 'stage')).toMatchObject({ fromName: 'New', toName: 'Interested', source: 'manual', userName: expect.any(String) });
    expect(all.nextBefore).toBeNull();

    const seen: string[] = [];
    let before: string | null = '';
    while (before !== null) {
      const page: any = (await api.call('GET', `/api/leads/${id}/timeline?limit=2${before ? `&before=${before}` : ''}`)).body;
      seen.push(...page.items.map((i: any) => `${i.kind}:${i.id}`));
      before = page.nextBefore;
    }
    expect(seen).toEqual(all.items.map((i: any) => `${i.kind}:${i.id}`));
  });
});

describe('bulk stage moves', () => {
  // Counts the statements `fn` sends: bulk moves must not cost queries per lead.
  async function countQueries(w: World, fn: () => unknown) {
    const db = w.ctx.db as any;
    const orig = { get: db.get, all: db.all, run: db.run };
    let n = 0;
    for (const k of ['get', 'all', 'run'] as const)
      db[k] = function (this: unknown, ...args: unknown[]) {
        n++;
        return (orig[k] as Function).apply(this, args);
      };
    try {
      await fn();
    } finally {
      Object.assign(db, orig);
    }
    return n;
  }

  it('deletes a big stage with a few statements, a history row per lead and one event', async () => {
    const w = makeWorld();
    const ids = addLeads(w, BULK_EVENT_MAX_IDS + 50);
    const mine = addLeads(w, 2, 'mine');
    setStage(w.ctx, lead(w, mine[0]), stage(w, 'replied').id, { source: 'auto' });
    // A lead in another stage stays; one put in the first stage explicitly moves like those without a stage.
    setStage(w.ctx, lead(w, mine[1]), stage(w, 'new').id, { source: 'manual' });
    w.ctx.db.insert('webhooks', { workspace_id: w.workspaceId, url: 'https://hooks.example/x', events: '["lead.stage_changed"]', secret: 's', created_at: 1 });
    const single = stageEvents(w);
    const bulk: any[] = [];
    w.ctx.webhooks.subscribe((_ws, event, data) => event === 'leads.stage_changed' && bulk.push(data));
    w.ctx.clock.advance(MINUTE);
    const userId = w.ctx.db.insert('users', { workspace_id: w.workspaceId, email: 'a@b.co', name: 'Ana', password_hash: 'x', created_at: 1 });

    const newId = stage(w, 'new').id;
    let moved = 0;
    const queries = await countQueries(w, () => (moved = deleteStage(w.ctx, w.workspaceId, stage(w, 'new'), stage(w, 'contacted'), userId)));
    expect(moved).toBe(ids.length + 1);
    expect(queries).toBeLessThan(40);

    const contacted = stage(w, 'contacted').id;
    expect(w.ctx.db.get('SELECT COUNT(*) AS n FROM leads WHERE stage_id = ? AND stage_manual = 1 AND stage_changed_at = ?', [contacted, w.ctx.clock.now()])).toEqual({ n: ids.length + 1 });
    expect(slugOf(w, mine[0])).toBe('replied');
    const h = w.ctx.db.all<any>('SELECT lead_id, from_stage_id, to_stage_id, source, reason, user_id FROM lead_stage_history WHERE to_stage_id = ? ORDER BY lead_id', [contacted]);
    expect(h).toHaveLength(ids.length + 1);
    expect(h[0]).toMatchObject({ to_stage_id: contacted, source: 'manual', reason: 'Stage "New" was deleted', user_id: userId });
    expect(h.find((r) => r.lead_id === ids[0]).from_stage_id).toBe(newId);
    expect(h.find((r) => r.lead_id === mine[1]).from_stage_id).toBe(newId);

    // One event for the whole move: a summary for webhooks (hooks for single moves get it too), every row for subscribers.
    expect(single).toEqual([]);
    expect(bulk).toHaveLength(1);
    expect(bulk[0]).toMatchObject({ count: ids.length + 1, from: { slug: 'new' }, to: { slug: 'contacted' }, source: 'manual' });
    expect(bulk[0].leadIds).toHaveLength(BULK_EVENT_MAX_IDS);
    expect(bulk[0].changes).toHaveLength(ids.length + 1);
    const sent = w.ctx.webhooks.sent.filter((s) => s.event === 'leads.stage_changed');
    expect(sent).toHaveLength(1);
    expect((sent[0].body as any).data.changes).toBeUndefined();
    expect((sent[0].body as any).data.count).toBe(ids.length + 1);

    // The timeline shows the move like a single one.
    const tl = w.ctx.db.get<any>("SELECT fs.name AS f, ts.name AS t FROM lead_stage_history h LEFT JOIN pipeline_stages fs ON fs.id = h.from_stage_id LEFT JOIN pipeline_stages ts ON ts.id = h.to_stage_id WHERE h.lead_id = ?", [ids[0]]);
    // The deleted stage's name is gone, as with single moves out of a stage that was later deleted.
    expect(tl).toEqual({ f: null, t: 'Contacted' });
  });

  it('moves, assigns and tags many leads in bulk with one event and no per-lead queries', async () => {
    const api = await makeApi(makeWorld());
    const owner = await api.register('Acme');
    const ws = owner.workspaceId;
    const list = api.w.ctx.db.insert('lead_lists', { workspace_id: ws, name: 'L', created_at: 1 });
    const now = api.w.ctx.clock.now();
    for (let i = 0; i < 300; i++) api.w.ctx.db.insert('leads', { workspace_id: ws, list_id: list, public_id: `b${i}`, profile_url: `https://www.linkedin.com/in/b${i}/`, created_at: now });
    const leadIds = api.w.ctx.db.all<{ id: number }>('SELECT id FROM leads WHERE workspace_id = ? ORDER BY id', [ws]).map((r) => r.id);
    const stages = (await api.call('GET', '/api/pipeline/stages')).body as any[];
    const won = stages.find((s) => s.slug === 'won').id;
    await api.call('POST', `/api/leads/${leadIds[0]}/stage`, { stageId: won });
    const bulk: any[] = [];
    api.w.ctx.webhooks.subscribe((_ws, event, data) => event === 'leads.stage_changed' && bulk.push(data));

    let r: any;
    const queries = await countQueries(api.w, async () => (r = await api.call('POST', '/api/leads/bulk', { leadIds, stageId: won, ownerId: owner.id })));
    expect(r.body).toEqual({ updated: 300, matched: 300 });
    expect(queries).toBeLessThan(60);
    expect(bulk).toHaveLength(1);
    expect(bulk[0]).toMatchObject({ count: 299, from: null, to: { slug: 'won' } });
    expect(bulk[0].leadIds).not.toContain(leadIds[0]);
    expect(api.w.ctx.db.get('SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ? AND stage_id = ? AND owner_id = ?', [ws, won, owner.id])).toEqual({ n: 300 });
    expect(api.w.ctx.db.get('SELECT COUNT(*) AS n FROM lead_stage_history WHERE workspace_id = ? AND to_stage_id = ? AND user_id = ?', [ws, won, owner.id])).toEqual({ n: 300 });

    // Repeating it changes nothing; clearing the owner and tagging only touch leads that change.
    expect((await api.call('POST', '/api/leads/bulk', { leadIds, stageId: won, ownerId: owner.id })).body).toEqual({ updated: 0, matched: 300 });
    expect((await api.call('POST', '/api/leads/bulk', { leadIds: leadIds.slice(0, 10), ownerId: null })).body).toEqual({ updated: 10, matched: 10 });
    expect((await api.call('POST', '/api/leads/bulk', { leadIds: leadIds.slice(0, 20), addTags: ['vip'] })).body).toEqual({ updated: 20, matched: 20 });
    expect((await api.call('POST', '/api/leads/bulk', { leadIds: leadIds.slice(0, 20), addTags: ['VIP'], ownerId: null })).body).toEqual({ updated: 10, matched: 20 });
    expect(bulk).toHaveLength(1);
  });
});

describe('tags', () => {
  it('reuses a tag another instance created a moment ago instead of failing', () => {
    const w = makeWorld();
    const [id] = addLeads(w, 1);
    const first = createTag(w.ctx, w.workspaceId, 'vip', '#123456');
    // Both instances read "no such tag" and insert it: the second one gets the first one's row.
    expect(createTag(w.ctx, w.workspaceId, 'vip')).toMatchObject({ id: first.id, color: '#123456' });
    w.ctx.db.update('leads', id, { tags: '["Q3"]' });
    const tx = w.ctx.db.tx(() => {
      w.ctx.db.insert('tags', { workspace_id: w.workspaceId, name: 'Q3', color: '#000000', created_at: 1 });
      return createTag(w.ctx, w.workspaceId, 'Q3');
    });
    expect(tx.color).toBe('#000000');
    expect(canonicalTags(w.ctx, w.workspaceId, ['VIP', 'q3', 'new'])).toEqual(['vip', 'Q3', 'new']);
    expect(listTags(w.ctx, w.workspaceId).map((t) => [t.name, t.leads])).toEqual([
      ['new', 0],
      ['Q3', 1],
      ['vip', 0],
    ]);
  });
});
