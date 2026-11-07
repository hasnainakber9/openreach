import { describe, expect, it, vi } from 'vitest';
import { DAY, HOUR, MINUTE } from '../src/clock.js';
import { SimulatorDriver, simOpenProfile } from '../src/drivers/simulator.js';
import { DriverError } from '../src/drivers/types.js';
import { usage } from '../src/engine/engine.js';
import { precededBy, SequenceSchema, type Sequence } from '../src/engine/sequence.js';
import { logActivity } from '../src/services/activity.js';
import { startImport } from '../src/services/imports.js';
import { setConnection } from '../src/services/rotation.js';
import { suppressIdentity } from '../src/services/suppression.js';
import type { ImportRow } from '../src/types.js';
import { addLeads, counts, makeApi, makeCampaign, makeWorld, runFor, states, type World } from './helpers.js';

const POST = 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/';
const EVENT = 'https://www.linkedin.com/events/7123456789/';
const GROUP = 'https://www.linkedin.com/groups/12345/';
const SEARCH = 'https://www.linkedin.com/search/results/people/?keywords=founder';

const inmailOnly = (extra: Record<string, unknown> = {}): Sequence => ({
  start: 'n1',
  nodes: { n1: { id: 'n1', type: 'inmail', subject: 'Hi {{firstName}}', body: 'Quick question about {{company}}.', via: 'profile', next: null, ...extra } as any },
});

// Runs queued imports to the end, letting simulated time pass while they wait (working hours, the
// pause after an action, the next day's budget).
async function finishImports(w: World, maxMs = 3 * DAY) {
  const end = w.ctx.clock.now() + maxMs;
  while (w.ctx.clock.now() < end) {
    await w.ctx.jobs.drain();
    if (!w.ctx.db.get("SELECT 1 FROM jobs WHERE type = 'leads.import' AND status IN ('queued', 'running')")) return;
    w.ctx.clock.advance(5 * MINUTE);
  }
}

const imp = (w: World, id: number) => w.ctx.db.get<ImportRow>('SELECT * FROM imports WHERE id = ?', [id])!;
const listLeads = (w: World, listId = w.listId) => w.ctx.db.all<{ public_id: string }>('SELECT public_id FROM leads WHERE list_id = ? ORDER BY id', [listId]).map((r) => r.public_id);

// Keeps the account's browser busy (as a running action would) until release() is called.
async function holdBrowser(w: World) {
  let release!: () => void;
  let busy!: Promise<void>;
  await new Promise<void>((started) => {
    busy = w.ctx.drivers.use(w.account(), () => new Promise<void>((r) => (started(), (release = r))));
  });
  return { busy, release };
}

// Working hours start at 09:00; the world starts at 08:00.
function workingWorld(sim = {}, account: Record<string, unknown> = {}) {
  const w = makeWorld(sim, account);
  w.ctx.clock.advance(2 * HOUR);
  return w;
}

describe('lead sources', () => {
  it('imports deterministic people from each source through the job queue', async () => {
    const results: Record<string, string[]> = {};
    for (const [kind, url, opts] of [
      ['search', SEARCH, {}],
      ['post', POST, { likers: true, commenters: true }],
      ['event', EVENT, {}],
      ['group', GROUP, {}],
    ] as const) {
      const w = workingWorld();
      const id = startImport(w.ctx, w.workspaceId, w.listId, w.account(), kind, url, { limit: 15, ...opts });
      expect(w.ctx.db.get<{ type: string }>('SELECT type FROM jobs WHERE id = ?', [imp(w, id).job_id])!.type).toBe('leads.import');
      await finishImports(w);
      const row = imp(w, id);
      expect(row).toMatchObject({ status: 'done', kind, found: 15, added: 15, duplicates: 0, blacklisted: 0, note: null });
      expect(row.day).toBe('2026-01-05');
      results[kind] = listLeads(w);
      expect(results[kind]).toHaveLength(15);
      // The scrape counts as browser use: the account pauses before its next action.
      expect(w.account().next_action_at).toBeGreaterThan(w.ctx.clock.now());

      // Same URL in a fresh world: the same people.
      const again = workingWorld();
      startImport(again.ctx, again.workspaceId, again.listId, again.account(), kind, url, { limit: 15, ...opts });
      await finishImports(again);
      expect(listLeads(again)).toEqual(results[kind]);
    }
    expect(new Set(Object.values(results).flat()).size).toBeGreaterThan(55);
  });

  it('splits post engagers into reactions and comments', async () => {
    const w = workingWorld();
    const d = new SimulatorDriver(w.ctx.db, w.accountId, 'Sim', w.ctx.clock);
    const likers = await d.postEngagers(POST, { likers: true, commenters: false }, 1000);
    const commenters = await d.postEngagers(POST, { likers: false, commenters: true }, 1000);
    const both = await d.postEngagers(POST, { likers: true, commenters: true }, 1000);
    expect(likers.length).toBeGreaterThan(commenters.length);
    expect(commenters.length).toBeGreaterThan(0);
    const union = new Set([...likers, ...commenters].map((p) => p.publicId));
    expect(both.map((p) => p.publicId).sort()).toEqual([...union].sort());
    // Some people both reacted and commented.
    expect(likers.length + commenters.length).toBeGreaterThan(union.size);
  });

  it('adds nothing on a second run of the same post and counts the duplicates', async () => {
    const w = workingWorld();
    const first = startImport(w.ctx, w.workspaceId, w.listId, w.account(), 'post', POST, { limit: 1000, likers: true, commenters: true });
    await finishImports(w);
    const found = imp(w, first).found;
    expect(found).toBeGreaterThan(19);
    const second = startImport(w.ctx, w.workspaceId, w.listId, w.account(), 'post', POST, { limit: 1000, likers: true, commenters: true });
    await finishImports(w);
    expect(imp(w, second)).toMatchObject({ status: 'done', found, added: 0, duplicates: found });
  });

  it('leaves out blacklisted and suppressed people and counts them', async () => {
    const w = workingWorld();
    const people = await new SimulatorDriver(w.ctx.db, w.accountId, 'Sim', w.ctx.clock).groupMembers(GROUP, 20);
    w.ctx.db.insert('blacklist', { workspace_id: w.workspaceId, kind: 'profile', value: people[0].profileUrl, created_at: w.ctx.clock.now() });
    suppressIdentity(w.ctx, w.workspaceId, 'linkedin', people[1].publicId, 'manual', 'test');
    const id = startImport(w.ctx, w.workspaceId, w.listId, w.account(), 'group', GROUP, { limit: 20 });
    await finishImports(w);
    expect(imp(w, id)).toMatchObject({ status: 'done', found: 20, added: 18, blacklisted: 2 });
    expect(listLeads(w)).not.toContain(people[0].publicId);
    expect(listLeads(w)).not.toContain(people[1].publicId);
  });

  it('stops at the daily scrape budget, says so, and continues the next working day', async () => {
    const w = workingWorld({}, { limits: JSON.stringify({ scrape: 30 }) });
    const first = startImport(w.ctx, w.workspaceId, w.listId, w.account(), 'group', GROUP, { limit: 100 });
    await finishImports(w, HOUR);
    expect(imp(w, first)).toMatchObject({ status: 'done', found: 30, added: 30 });
    expect(imp(w, first).note).toMatch(/daily limit of 30 profiles/);

    // The budget is spent: the next import waits for tomorrow's working hours.
    const second = startImport(w.ctx, w.workspaceId, w.listId, w.account(), 'event', EVENT, { limit: 10 });
    await finishImports(w, 2 * HOUR);
    expect(imp(w, second)).toMatchObject({ status: 'running', found: 0 });
    expect(imp(w, second).note).toMatch(/collected its 30 profiles for today/);
    const job = w.ctx.db.get<{ run_at: number; status: string }>('SELECT run_at, status FROM jobs WHERE id = ?', [imp(w, second).job_id])!;
    expect(job.status).toBe('queued');
    expect(job.run_at).toBe(Date.UTC(2026, 0, 6, 9, 0));

    await finishImports(w, DAY);
    expect(imp(w, second)).toMatchObject({ status: 'done', found: 10, day: '2026-01-06' });
  });

  it('keeps profiles an earlier attempt loaded in the daily budget when the import is retried', async () => {
    const w = workingWorld({}, { limits: JSON.stringify({ scrape: 30 }) });
    // The first attempt loads 20 profiles, then the page fails.
    const spy = vi.spyOn(SimulatorDriver.prototype, 'groupMembers').mockImplementationOnce(async (_url, _limit, onPage) => {
      onPage?.(20);
      throw new DriverError('TRANSIENT', 'Page did not load');
    });
    try {
      const id = startImport(w.ctx, w.workspaceId, w.listId, w.account(), 'group', GROUP, { limit: 100 });
      await w.ctx.jobs.drain();
      expect(imp(w, id)).toMatchObject({ status: 'running', found: 20, scraped: 20 });
      expect(imp(w, id).note).toMatch(/Retrying after an error/);
      await finishImports(w, HOUR);
      // The retry may only load what is left of today's 30.
      expect(imp(w, id)).toMatchObject({ status: 'done', found: 10, scraped: 30 });
      expect(usage(w.ctx, w.account()).scrape).toBe(30);
    } finally {
      spy.mockRestore();
    }
  });

  it('never scrapes for an import that finished while it waited for the browser', async () => {
    const w = workingWorld();
    const id = startImport(w.ctx, w.workspaceId, w.listId, w.account(), 'group', GROUP, { limit: 10 });
    const { busy, release } = await holdBrowser(w);
    const run = w.ctx.jobs.tick();
    // E.g. an earlier run of the same job, which timed out while waiting, finished it in the meantime.
    w.ctx.db.update('imports', id, { status: 'done', found: 7 });
    release();
    await busy;
    await run;
    expect(imp(w, id)).toMatchObject({ status: 'done', found: 7 });
    expect(listLeads(w)).toEqual([]);
  });

  it('runs one import per account at a time', async () => {
    const w = workingWorld();
    const first = startImport(w.ctx, w.workspaceId, w.listId, w.account(), 'group', GROUP, { limit: 10 });
    const second = startImport(w.ctx, w.workspaceId, w.listId, w.account(), 'event', EVENT, { limit: 10 });
    const { busy, release } = await holdBrowser(w);
    // Both jobs start; the second sees the first one running and steps back instead of queueing on the browser.
    const run = w.ctx.jobs.tick();
    release();
    await busy;
    await run;
    expect(imp(w, first)).toMatchObject({ status: 'done', found: 10 });
    expect(imp(w, second)).toMatchObject({ status: 'running', found: 0 });
    expect(imp(w, second).note).toMatch(/another import/);
    expect(w.ctx.db.get<{ status: string }>('SELECT status FROM jobs WHERE id = ?', [imp(w, second).job_id])!.status).toBe('queued');
    await finishImports(w, HOUR);
    expect(imp(w, second)).toMatchObject({ status: 'done', found: 10 });
  });

  it('scales the scrape budget with warm-up', async () => {
    const w = workingWorld({}, { warmup: 1, limits: JSON.stringify({ scrape: 100 }) });
    const id = startImport(w.ctx, w.workspaceId, w.listId, w.account(), 'group', GROUP, { limit: 100 });
    await finishImports(w, HOUR);
    // Day one of warm-up: 30% of 100.
    expect(imp(w, id)).toMatchObject({ status: 'done', found: 30 });
  });

  it('waits for working hours and for the pause after an action', async () => {
    const w = makeWorld(); // 08:00, before the 09:00 start
    const id = startImport(w.ctx, w.workspaceId, w.listId, w.account(), 'event', EVENT, { limit: 10 });
    await w.ctx.jobs.drain();
    expect(imp(w, id)).toMatchObject({ status: 'running', found: 0 });
    expect(imp(w, id).note).toMatch(/working hours/);
    expect(w.ctx.db.get<{ run_at: number }>('SELECT run_at FROM jobs WHERE id = ?', [imp(w, id).job_id])!.run_at).toBe(Date.UTC(2026, 0, 5, 9, 0));

    w.ctx.clock.advance(HOUR + MINUTE);
    w.ctx.db.run('UPDATE accounts SET next_action_at = ? WHERE id = ?', [w.ctx.clock.now() + 10 * MINUTE, w.accountId]);
    await w.ctx.jobs.drain();
    expect(imp(w, id).status).toBe('running');
    w.ctx.clock.advance(10 * MINUTE);
    await w.ctx.jobs.drain();
    expect(imp(w, id)).toMatchObject({ status: 'done', found: 10 });
  });

  it('waits while the account is logged out and fails when the account is gone', async () => {
    const w = workingWorld();
    w.ctx.db.run("UPDATE accounts SET status = 'needs_login' WHERE id = ?", [w.accountId]);
    const id = startImport(w.ctx, w.workspaceId, w.listId, w.account(), 'event', EVENT, { limit: 10 });
    await w.ctx.jobs.drain();
    expect(imp(w, id).note).toMatch(/to be active again/);
    w.ctx.db.run("UPDATE accounts SET status = 'active' WHERE id = ?", [w.accountId]);
    await finishImports(w, HOUR);
    expect(imp(w, id).status).toBe('done');

    const gone = startImport(w.ctx, w.workspaceId, w.listId, w.account(), 'group', GROUP, { limit: 10 });
    w.ctx.db.run('DELETE FROM accounts WHERE id = ?', [w.accountId]);
    await w.ctx.jobs.drain();
    expect(imp(w, gone)).toMatchObject({ status: 'failed', error: 'The LinkedIn account for this import was removed' });
  });
});

describe('InMail', () => {
  it('respects the daily InMail limit', async () => {
    const w = makeWorld({}, { limits: JSON.stringify({ inmail: 2 }) });
    const { id } = makeCampaign(w, inmailOnly(), {}, addLeads(w, 6));
    await runFor(w, 12 * HOUR);
    expect(counts(w, id)['inmail:ok']).toBe(2);
    await runFor(w, DAY);
    expect(counts(w, id)['inmail:ok']).toBe(4);
    // Each InMail shows up in the inbox like a message.
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'")!.n).toBe(4);
    expect(w.ctx.db.get<{ detail: string }>("SELECT detail FROM activity WHERE type = 'inmail' AND status = 'ok' LIMIT 1")!.detail).toBe('Hi First0');
  });

  it('applies warm-up to the InMail limit', async () => {
    const w = makeWorld({}, { warmup: 1 });
    const { id } = makeCampaign(w, inmailOnly(), {}, addLeads(w, 8));
    await runFor(w, 12 * HOUR);
    // Default 10 a day, 30% on day one.
    expect(counts(w, id)['inmail:ok']).toBe(3);
  });

  it('skips people it cannot InMail and backs off when the credits run out', async () => {
    const w = makeWorld({ inmailCredits: 0 });
    const leads = addLeads(w, 9);
    const open = w.ctx.db.all<{ id: number; public_id: string }>('SELECT id, public_id FROM leads ORDER BY id').filter((l) => simOpenProfile(l.public_id));
    expect(open.length).toBeGreaterThan(0);
    expect(open.length).toBeLessThan(9);
    const { id } = makeCampaign(w, inmailOnly(), {}, leads);
    await runFor(w, 12 * HOUR);
    // Open profiles take InMail for free; the rest are skipped with the reason.
    expect(counts(w, id)['inmail:ok']).toBe(open.length);
    expect(counts(w, id)['inmail:skipped']).toBe(9 - open.length);
    expect(w.ctx.db.get<{ detail: string }>("SELECT detail FROM activity WHERE type = 'inmail' AND status = 'skipped' LIMIT 1")!.detail).toBe('No InMail credits and the profile is not open');
    expect(states(w, id)).toEqual({ done: 9 });

    const w2 = makeWorld({ inmailCredits: 1 });
    const closed = addLeads(w2, 12).filter((lid) => !simOpenProfile(w2.ctx.db.get<{ public_id: string }>('SELECT public_id FROM leads WHERE id = ?', [lid])!.public_id));
    const c2 = makeCampaign(w2, inmailOnly(), {}, closed.slice(0, 3));
    await runFor(w2, 12 * HOUR);
    expect(counts(w2, c2.id)['inmail:ok']).toBe(1);
    expect(counts(w2, c2.id)['inmail:failed']).toBe(1);
    expect(JSON.parse(w2.account().cooldowns).inmail).toBeGreaterThan(w2.ctx.clock.now());
    expect(states(w2, c2.id)).toEqual({ done: 1, active: 2 });
  });

  it('messages a lead who is already connected instead of spending a credit', async () => {
    const w = makeWorld({ inmailCredits: 0 });
    const [lead] = addLeads(w, 1);
    const pid = w.ctx.db.get<{ public_id: string }>('SELECT public_id FROM leads WHERE id = ?', [lead])!.public_id;
    w.ctx.db.run('INSERT INTO sim_people (account_id, public_id, connected) VALUES (?, ?, 1)', [w.accountId, pid]);
    setConnection(w.ctx, lead, w.accountId, 'connected');
    const { id } = makeCampaign(w, inmailOnly(), {}, [lead]);
    await runFor(w, 3 * HOUR);
    // It is a message as far as limits and stats go.
    expect(counts(w, id)).toEqual({ 'message:ok': 1 });
    expect(w.ctx.db.get<{ detail: string; node_id: string }>("SELECT detail, node_id FROM activity WHERE type = 'message'")).toMatchObject({ detail: expect.stringMatching(/sent as a message/), node_id: 'n1' });
  });

  it('holds an InMail to a connection when the account has used up its messages for the day', async () => {
    const w = makeWorld({}, { limits: JSON.stringify({ message: 1, inmail: 50 }) });
    const [lead] = addLeads(w, 1);
    const pid = w.ctx.db.get<{ public_id: string }>('SELECT public_id FROM leads WHERE id = ?', [lead])!.public_id;
    w.ctx.db.run('INSERT INTO sim_people (account_id, public_id, connected) VALUES (?, ?, 1)', [w.accountId, pid]);
    setConnection(w.ctx, lead, w.accountId, 'connected');
    logActivity(w.ctx, { workspaceId: w.workspaceId, accountId: w.accountId, type: 'message', timezone: w.account().timezone });
    const { id } = makeCampaign(w, inmailOnly(), {}, [lead]);
    await runFor(w, 12 * HOUR);
    expect(counts(w, id)).toEqual({});
    expect(states(w, id)).toEqual({ active: 1 });
    // Tried again on the next working day, when the message budget is back.
    await runFor(w, DAY);
    expect(counts(w, id)).toEqual({ 'message:ok': 1 });
    expect(usage(w.ctx, w.account()).message).toBe(1);
  });

  it('sends each lead its A/B variant', async () => {
    const w = makeWorld();
    const seq = inmailOnly({
      variants: [
        { id: 'A', subject: 'Subject A', body: 'Body A' },
        { id: 'B', subject: 'Subject B', body: 'Body B' },
      ],
    });
    expect(SequenceSchema.safeParse(seq).success).toBe(true);
    const { id } = makeCampaign(w, seq, {}, addLeads(w, 8));
    await runFor(w, 12 * HOUR);
    const rows = w.ctx.db.all<{ variant: string; detail: string }>("SELECT variant, detail FROM activity WHERE campaign_id = ? AND type = 'inmail' AND status = 'ok'", [id]);
    expect(rows).toHaveLength(8);
    for (const r of rows) expect(r.detail).toBe(`Subject ${r.variant}`);
    expect(new Set(rows.map((r) => r.variant)).size).toBe(2);
  });

  it('branches on open profiles after a profile view', async () => {
    const w = makeWorld();
    const leads = addLeads(w, 9);
    const seq: Sequence = {
      start: 'n1',
      nodes: {
        n1: { id: 'n1', type: 'view_profile', next: 'n2' },
        n2: { id: 'n2', type: 'condition', kind: 'is_open_profile', withinDays: 7, yes: 'n3', no: 'n4' },
        n3: { id: 'n3', type: 'inmail', subject: 'Hi', body: 'Hello', via: 'profile', next: null },
        n4: { id: 'n4', type: 'follow', next: null },
      },
    };
    expect(precededBy(seq, 'n2', 'view_profile')).toBe(true);
    const { id } = makeCampaign(w, seq, {}, leads);
    await runFor(w, 12 * HOUR);
    const rows = w.ctx.db.all<{ public_id: string; open_profile: number }>('SELECT public_id, open_profile FROM leads ORDER BY id');
    for (const r of rows) expect(r.open_profile).toBe(simOpenProfile(r.public_id) ? 1 : 0);
    const open = rows.filter((r) => r.open_profile === 1).length;
    expect(counts(w, id)['inmail:ok']).toBe(open);
    expect(counts(w, id)['follow:ok']).toBe(9 - open);
  });

  it('validates InMail steps and warns about an open-profile check with no view before it', async () => {
    expect(SequenceSchema.safeParse(inmailOnly({ subject: 'x'.repeat(201) })).success).toBe(false);
    expect(SequenceSchema.safeParse(inmailOnly({ body: 'x'.repeat(1901) })).success).toBe(false);
    expect(SequenceSchema.safeParse(inmailOnly({ via: 'sales_navigator' })).success).toBe(true);
    expect(SequenceSchema.parse(inmailOnly({ via: undefined })).nodes.n1).toMatchObject({ via: 'profile' });

    const api = await makeApi();
    await api.register();
    const acc = await api.call('POST', '/api/accounts', { name: 'Seat', driver: 'simulator', timezone: 'UTC' });
    const camp = await api.call('POST', '/api/campaigns', { name: 'C', accountId: acc.body.id });
    const sequence = { start: 'n1', nodes: { n1: { id: 'n1', type: 'condition', kind: 'is_open_profile', withinDays: 7, yes: null, no: null } } };
    const saved = await api.call('PATCH', `/api/campaigns/${camp.body.id}`, { sequence });
    expect(saved.status).toBe(200);
    const full = await api.call('GET', `/api/campaigns/${camp.body.id}`);
    expect(full.body.warnings.join(' ')).toMatch(/open profile/);

    // A draft may loop; the warning check must still finish at once.
    const loop = {
      start: 'c1',
      nodes: {
        c1: { id: 'c1', type: 'condition', kind: 'has_email', withinDays: 7, yes: 'c1', no: 'c1' },
        n2: { id: 'n2', type: 'condition', kind: 'is_open_profile', withinDays: 7, yes: null, no: null },
      },
    };
    expect(precededBy(loop as Sequence, 'n2', 'view_profile')).toBe(false);
    const started = Date.now();
    expect((await api.call('PATCH', `/api/campaigns/${camp.body.id}`, { sequence: loop })).status).toBe(200);
    const looped = await api.call('GET', `/api/campaigns/${camp.body.id}`);
    expect(looped.body.problems.join(' ')).toMatch(/loops back/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('LinkedIn import routes', () => {
  async function setup() {
    const api = await makeApi(workingWorld());
    const owner = await api.register('Acme');
    const acc = await api.call('POST', '/api/accounts', { name: 'Seat', driver: 'simulator', timezone: 'UTC', warmup: false });
    const list = await api.call('POST', '/api/lists', { name: 'Imported' });
    return { ...api, owner, accountId: acc.body.id as number, listId: list.body.id as number };
  }

  it('starts each kind of import, reports progress fields, and runs on the queue', async () => {
    const { w, call, accountId, listId } = await setup();
    const post = await call('POST', '/api/leads/import/linkedin', { listId, accountId, source: 'post', url: POST, limit: 15, likers: false, commenters: true });
    expect(post.status).toBe(200);
    const legacy = await call('POST', '/api/leads/import/search', { listId, accountId, url: SEARCH, limit: 12 });
    expect(legacy.status).toBe(200);
    let rows = (await call('GET', '/api/imports')).body;
    expect(rows[0]).toMatchObject({ id: legacy.body.importId, kind: 'search', status: 'running', progress: { done: 0, total: 12 } });
    await finishImports(w);
    rows = (await call('GET', '/api/imports')).body;
    const p = rows.find((r: any) => r.id === post.body.importId);
    expect(p).toMatchObject({ kind: 'post', status: 'done', source: POST, accountName: 'Seat', options: { limit: 15, likers: false, commenters: true }, duplicates: 0, blacklisted: 0, note: null });
    expect(p.found).toBeGreaterThan(0);
    expect(p.finishedAt).toBeGreaterThan(0);
    expect(rows.find((r: any) => r.id === legacy.body.importId)).toMatchObject({ status: 'done', found: 12, added: 12 });
  });

  it('checks the URL against the source and needs reactions or comments for a post', async () => {
    const { call, accountId, listId } = await setup();
    const bad = await call('POST', '/api/leads/import/linkedin', { listId, accountId, source: 'event', url: GROUP, limit: 10 });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/events/);
    expect((await call('POST', '/api/leads/import/linkedin', { listId, accountId, source: 'group', url: 'https://example.com/groups/1/', limit: 10 })).status).toBe(400);
    expect((await call('POST', '/api/leads/import/linkedin', { listId, accountId, source: 'post', url: POST, limit: 10, likers: false, commenters: false })).status).toBe(400);
    expect((await call('POST', '/api/leads/import/linkedin', { listId, accountId, source: 'group', url: GROUP, limit: 1001 })).status).toBe(400);
    // The older search route checks the host the same way: other hosts never reach the account's browser.
    for (const url of ['https://attacker.example/linkedin.com/search/results/people/', 'http://127.0.0.1:8080/linkedin.com/search/', 'file:///linkedin.com/search/']) {
      expect((await call('POST', '/api/leads/import/search', { listId, accountId, url, limit: 10 })).status).toBe(400);
    }
    for (const [source, url] of [['search', SEARCH], ['search', 'https://www.linkedin.com/sales/search/people?query=x'], ['post', 'https://www.linkedin.com/posts/jane-doe_growth-activity-7100-abc'], ['event', EVENT], ['group', GROUP]]) {
      expect((await call('POST', '/api/leads/import/linkedin', { listId, accountId, source, url, limit: 5 })).status).toBe(200);
    }
  });

  it('cancels a queued import, and one cancelled mid-scrape adds nobody', async () => {
    const { w, call, accountId, listId, addUser, as, register, owner } = await setup();
    const queued = (await call('POST', '/api/leads/import/linkedin', { listId, accountId, source: 'group', url: GROUP, limit: 10 })).body.importId;
    expect((await call('POST', `/api/imports/${queued}/cancel`)).status).toBe(200);
    const job = w.ctx.db.get<{ status: string }>('SELECT status FROM jobs WHERE id = ?', [imp(w, queued).job_id])!;
    expect(job.status).toBe('cancelled');
    expect((await call('GET', '/api/imports')).body[0]).toMatchObject({ id: queued, status: 'failed', error: 'Cancelled' });
    expect((await call('POST', `/api/imports/${queued}/cancel`)).status).toBe(409);

    // Cancelled while the browser is collecting: the job finishes its page, then adds nobody.
    const running = (await call('POST', '/api/leads/import/linkedin', { listId, accountId, source: 'group', url: GROUP, limit: 10 })).body.importId;
    const real = SimulatorDriver.prototype.groupMembers;
    let scraped = 0;
    const spy = vi.spyOn(SimulatorDriver.prototype, 'groupMembers').mockImplementationOnce(async function (this: SimulatorDriver, url, limit, onPage) {
      scraped++;
      expect((await call('POST', `/api/imports/${running}/cancel`)).status).toBe(200);
      return real.call(this, url, limit, onPage);
    });
    try {
      await finishImports(w);
    } finally {
      spy.mockRestore();
    }
    expect(scraped).toBe(1);
    expect(imp(w, running)).toMatchObject({ status: 'failed', error: 'Cancelled', added: 0 });
    expect(listLeads(w, listId)).toEqual([]);

    // Read-only clients can't cancel, and other workspaces can't see the import.
    const later = (await call('POST', '/api/leads/import/linkedin', { listId, accountId, source: 'group', url: GROUP, limit: 5 })).body.importId;
    as(await addUser('client'));
    expect((await call('POST', `/api/imports/${later}/cancel`)).status).toBe(403);
    await register('Other');
    expect((await call('POST', `/api/imports/${later}/cancel`)).status).toBe(404);
    as(owner);
    expect(imp(w, later).status).toBe('running');
  });

  it('lets members import and keeps other workspaces out', async () => {
    const { call, accountId, listId, addUser, as, register, owner } = await setup();
    const member = await addUser('member');
    as(member);
    expect((await call('POST', '/api/leads/import/linkedin', { listId, accountId, source: 'group', url: GROUP, limit: 5 })).status).toBe(200);

    await register('Other');
    const otherList = (await call('POST', '/api/lists', { name: 'Mine' })).body.id;
    const otherAcc = (await call('POST', '/api/accounts', { name: 'Mine', driver: 'simulator', timezone: 'UTC' })).body.id;
    expect((await call('POST', '/api/leads/import/linkedin', { listId, accountId: otherAcc, source: 'group', url: GROUP, limit: 5 })).status).toBe(404);
    expect((await call('POST', '/api/leads/import/linkedin', { listId: otherList, accountId, source: 'group', url: GROUP, limit: 5 })).status).toBe(404);
    expect((await call('GET', '/api/imports')).body).toEqual([]);
    as(owner);
    expect((await call('GET', '/api/imports')).body).toHaveLength(1);
  });
});
