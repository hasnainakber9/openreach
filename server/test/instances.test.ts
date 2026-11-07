import { describe, expect, it } from 'vitest';
import { HOUR, MINUTE } from '../src/clock.js';
import type { JobRow } from '../src/jobs/queue.js';
import { addLeads, drainJobs, makeApi, makeCampaign, makeWorld, runFor, type World } from './helpers.js';

// Several app instances sharing one Postgres database: one leader runs the engine, jobs and LinkedIn sessions.
// These tests play the other instance by writing what it would have written; they run on SQLite too.

const views = (w: World) => w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE type = 'view_profile'")!.n;
const viewOnly = { start: 'v', nodes: { v: { id: 'v', type: 'view_profile' as const, next: null } } };

// Lets the leader (this world's job queue) answer a request a standby is waiting on.
async function leaderAnswers<T>(w: World, pending: Promise<T>): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const done = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), 50))]);
    if (done) return done;
    await drainJobs(w);
  }
  throw new Error('The request never finished');
}

describe('engine handover between instances', () => {
  it('leaves an account alone while another instance runs it, then reads it as that run left it', async () => {
    const w = makeWorld({ acceptRate: 0 });
    makeCampaign(w, viewOnly, {}, addLeads(w, 3));
    w.ctx.clock.advance(2 * HOUR); // inside working hours
    // A leader that lost its lock is still finishing a run on this account.
    w.ctx.db.run('UPDATE accounts SET busy_until = ? WHERE id = ?', [Date.now() + 60_000, w.accountId]);
    const stale = w.account();
    await runFor(w, 10 * MINUTE, MINUTE);
    expect(views(w)).toBe(0);
    expect(w.account().last_sync_at).toBe(0); // no sync either

    // Its action ends: it pushes the account's next action out and lets go. A tick that read the account
    // before that must not act on its old next_action_at.
    const next = w.ctx.clock.now() + 30 * MINUTE;
    w.ctx.db.run('UPDATE accounts SET busy_until = NULL, next_action_at = ?, last_sync_at = ? WHERE id = ?', [next, w.ctx.clock.now(), w.accountId]);
    await w.engine.runAccount(stale);
    expect(views(w)).toBe(0);
    expect(w.account().busy_until).toBeNull();

    w.ctx.clock.t = next;
    await w.engine.tick();
    expect(views(w)).toBe(1);
    expect(w.account().busy_until).toBeNull(); // released after the run
  });

  it('makes no LinkedIn call once leadership is lost, even in a run that already started', async () => {
    const w = makeWorld({ acceptRate: 0 });
    makeCampaign(w, viewOnly, {}, addLeads(w, 3));
    let leader = true;
    w.engine.start(() => leader);
    w.engine.stop(); // the test ticks by hand
    leader = false;
    await runFor(w, 3 * HOUR, 5 * MINUTE);
    expect(views(w)).toBe(0);
    expect(w.account()).toMatchObject({ last_sync_at: 0, busy_until: null });
    leader = true;
    await runFor(w, 10 * MINUTE, 5 * MINUTE);
    expect(views(w)).toBeGreaterThan(0);
  });
});

describe('LinkedIn calls from a standby instance', () => {
  it('sends Check, Sync now and inbox replies to the leader as jobs and answers with its result', async () => {
    const w = makeWorld();
    const api = await makeApi(w);
    const owner = await api.register('Acme');
    const acc = (await api.call('POST', '/api/accounts', { name: 'Seat', driver: 'simulator', timezone: 'UTC' })).body;
    // This instance holds no LinkedIn sessions: the browser must never open here.
    w.ctx.isLeader = () => false;
    const opened: number[] = [];
    const use = w.ctx.drivers.use.bind(w.ctx.drivers);
    w.ctx.drivers.use = ((a, fn) => {
      opened.push(a.id);
      return use(a, fn);
    }) as typeof w.ctx.drivers.use;

    const check = await leaderAnswers(w, api.call('POST', `/api/accounts/${acc.id}/check`));
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ ok: true, name: 'Seat' });
    const sync = await leaderAnswers(w, api.call('POST', `/api/accounts/${acc.id}/sync`));
    expect(sync).toMatchObject({ status: 200, body: { accepted: 0, replies: 0 } });

    // The leader's error comes back with its status and message.
    const conv = w.ctx.db.insert('conversations', {
      workspace_id: owner.workspaceId,
      channel: 'linkedin',
      account_id: acc.id,
      thread_id: 't1',
      participant_name: 'Stranger',
      participant_url: 'https://www.linkedin.com/in/stranger/',
    });
    const reply = await leaderAnswers(w, api.call('POST', `/api/inbox/${conv}/reply`, { text: 'Hello' }));
    expect(reply.status).toBe(422);
    expect(reply.body.error).toMatch(/did not accept the message/);
    w.ctx.db.run("UPDATE accounts SET status = 'needs_login' WHERE id = ?", [acc.id]);
    expect((await leaderAnswers(w, api.call('POST', `/api/inbox/${conv}/reply`, { text: 'Hello' }))).status).toBe(409);

    // Every call ran in the job queue (the leader), one attempt each.
    const jobs = w.ctx.db.all<JobRow>("SELECT * FROM jobs WHERE type = 'linkedin.call' ORDER BY id");
    expect(jobs.map((j) => [j.status, j.max_attempts])).toEqual(Array(4).fill(['done', 1]));
    expect(opened).toEqual([acc.id, acc.id, acc.id]);
  });

  it('only reaches accounts of the job’s own workspace', async () => {
    const w = makeWorld();
    const api = await makeApi(w);
    await api.register('Acme');
    const acc = (await api.call('POST', '/api/accounts', { name: 'Seat', driver: 'simulator', timezone: 'UTC' })).body;
    // w.workspaceId is another workspace than the one the account was added to.
    const id = w.ctx.jobs.enqueue('linkedin.call', { op: 'check', accountId: acc.id }, { workspaceId: w.workspaceId });
    await drainJobs(w);
    expect(JSON.parse(w.ctx.db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id])!.result!)).toEqual({ ok: false, status: 404, message: 'Account not found' });
  });
});
