import { describe, expect, it } from 'vitest';
import { HOUR, MINUTE } from '../src/clock.js';
import { JobQueue, PermanentError, RetryLater, type JobRow } from '../src/jobs/queue.js';
import { ProviderError } from '../src/providers/http.js';
import { drainJobs, makeApi, makeWorld, type World } from './helpers.js';

declare module '../src/jobs/types.js' {
  interface JobPayloads {
    'test.echo': { value: number };
    'test.fail': Record<string, never>;
    'test.block': { n: number };
    'test.other': { n: number };
  }
}

const job = (w: World, id: number) => w.ctx.db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id])!;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// Lets claimed handlers start running before the test looks at them.
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('job queue', () => {
  it('runs a handler and stores its result', async () => {
    const w = makeWorld();
    const seen: unknown[] = [];
    w.ctx.jobs.register('test.echo', async (j) => (seen.push(j), { doubled: j.payload.value * 2 }));
    const id = w.ctx.jobs.enqueue('test.echo', { value: 21 }, { workspaceId: w.workspaceId });
    await drainJobs(w);
    expect(seen).toEqual([{ id, workspaceId: w.workspaceId, payload: { value: 21 }, attempts: 1 }]);
    expect(job(w, id)).toMatchObject({ status: 'done', attempts: 1, result: '{"doubled":42}', last_error: null });
    expect(job(w, id).finished_at).toBe(w.ctx.clock.now());
  });

  it('runs inside the engine tick', async () => {
    const w = makeWorld();
    let ran = 0;
    w.ctx.jobs.register('test.echo', async () => void ran++);
    w.ctx.jobs.enqueue('test.echo', { value: 1 }, { workspaceId: w.workspaceId, runAt: w.ctx.clock.now() + 10 * MINUTE });
    await w.engine.tick();
    expect(ran).toBe(0);
    w.ctx.clock.advance(10 * MINUTE);
    await w.engine.tick();
    expect(ran).toBe(1);
  });

  it('retries failures with exponential backoff, then fails', async () => {
    const w = makeWorld();
    w.ctx.jobs.register('test.fail', async () => {
      throw new Error('boom');
    });
    const id = w.ctx.jobs.enqueue('test.fail', {}, { workspaceId: w.workspaceId, maxAttempts: 4 });
    const gaps: number[] = [];
    for (let i = 0; i < 3; i++) {
      await w.ctx.jobs.tick();
      const j = job(w, id);
      expect(j).toMatchObject({ status: 'queued', attempts: i + 1, last_error: 'boom' });
      gaps.push(j.run_at - w.ctx.clock.now());
      // Not due yet: nothing happens.
      await w.ctx.jobs.tick();
      expect(job(w, id).attempts).toBe(i + 1);
      w.ctx.clock.t = j.run_at;
    }
    // 30 s, 2 min, 8 min, each with ±20% jitter.
    [30_000, 120_000, 480_000].forEach((base, i) => {
      expect(gaps[i]).toBeGreaterThanOrEqual(base * 0.8);
      expect(gaps[i]).toBeLessThanOrEqual(base * 1.2);
    });
    await w.ctx.jobs.tick();
    expect(job(w, id)).toMatchObject({ status: 'failed', attempts: 4, last_error: 'boom' });
    expect(w.ctx.jobs.backoffMs(20)).toBeLessThanOrEqual(6 * HOUR * 1.2);
  });

  it('reschedules on RetryLater without using up an attempt', async () => {
    const w = makeWorld();
    let calls = 0;
    w.ctx.jobs.register('test.echo', async () => {
      if (++calls < 3) throw new RetryLater(5 * MINUTE, 'waiting for the provider');
      return 'ok';
    });
    const id = w.ctx.jobs.enqueue('test.echo', { value: 1 }, { workspaceId: w.workspaceId, maxAttempts: 1 });
    await w.ctx.jobs.tick();
    expect(job(w, id)).toMatchObject({ status: 'queued', attempts: 0, last_error: 'waiting for the provider', run_at: w.ctx.clock.now() + 5 * MINUTE });
    w.ctx.clock.advance(5 * MINUTE);
    await w.ctx.jobs.tick();
    w.ctx.clock.advance(5 * MINUTE);
    await w.ctx.jobs.tick();
    expect(job(w, id)).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('fails at once on PermanentError and on provider auth errors, which also flag the integration', async () => {
    const w = makeWorld();
    const integ = w.ctx.db.insert('integrations', { workspace_id: w.workspaceId, kind: 'ai', provider: 'simulated', created_at: 0, updated_at: 0 });
    w.ctx.jobs.register('test.fail', async () => {
      throw new PermanentError('lead was deleted');
    });
    w.ctx.jobs.register('test.echo', async () => {
      throw new ProviderError('AUTH', 'api.example.com rejected the credentials (401)', { integrationId: integ });
    });
    w.ctx.jobs.register('test.other', async (j) => {
      if (j.attempts === 1) throw new ProviderError('RATE_LIMIT', 'slow down', { retryAfterMs: 90_000 });
    });
    const a = w.ctx.jobs.enqueue('test.fail', {}, { workspaceId: w.workspaceId });
    const b = w.ctx.jobs.enqueue('test.echo', { value: 1 }, { workspaceId: w.workspaceId });
    const c = w.ctx.jobs.enqueue('test.other', { n: 1 }, { workspaceId: w.workspaceId });
    await w.ctx.jobs.tick();
    expect(job(w, a)).toMatchObject({ status: 'failed', attempts: 1, last_error: 'lead was deleted' });
    expect(job(w, b)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(w.ctx.db.get('SELECT last_status, last_message FROM integrations WHERE id = ?', [integ])).toEqual({ last_status: 'error', last_message: 'api.example.com rejected the credentials (401)' });
    // Rate limits wait for Retry-After and keep their attempt.
    expect(job(w, c)).toMatchObject({ status: 'queued', attempts: 0, run_at: w.ctx.clock.now() + 90_000 });
  });

  it('dedupes live jobs by key and allows a new one once the old one is done', async () => {
    const w = makeWorld();
    w.ctx.jobs.register('test.echo', async () => {});
    const opts = { workspaceId: w.workspaceId, dedupeKey: 'test.echo:lead:5' };
    const first = w.ctx.jobs.enqueue('test.echo', { value: 1 }, opts);
    expect(w.ctx.jobs.enqueue('test.echo', { value: 2 }, opts)).toBe(first);
    expect(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')!.n).toBe(1);
    await drainJobs(w);
    const second = w.ctx.jobs.enqueue('test.echo', { value: 3 }, opts);
    expect(second).not.toBe(first);
    expect(job(w, second).status).toBe('queued');
  });

  it('re-queues orphaned running jobs on the first tick after a restart', async () => {
    const w = makeWorld();
    const now = w.ctx.clock.now();
    const orphan = w.ctx.db.insert('jobs', { workspace_id: w.workspaceId, type: 'test.echo', payload: '{"value":1}', status: 'running', attempts: 1, run_at: now, locked_until: now + HOUR, created_at: now, updated_at: now });
    const spent = w.ctx.db.insert('jobs', { workspace_id: w.workspaceId, type: 'test.echo', payload: '{"value":2}', status: 'running', attempts: 5, max_attempts: 5, run_at: now, locked_until: now + HOUR, created_at: now, updated_at: now });
    const restarted = new JobQueue(w.ctx);
    let ran = 0;
    restarted.register('test.echo', async () => void ran++);
    await restarted.tick();
    expect(ran).toBe(1);
    expect(job(w, orphan)).toMatchObject({ status: 'done', attempts: 2 });
    expect(job(w, spent)).toMatchObject({ status: 'failed', last_error: 'Interrupted before it finished' });
  });

  it('never re-queues a job still running here when its lock expires, and progress() extends the lock', async () => {
    const w = makeWorld();
    const gate = deferred();
    let runs = 0;
    let report!: (done: number, total?: number) => void;
    w.ctx.jobs.register(
      'test.block',
      async (_j, h) => {
        runs++;
        report = h.progress;
        await gate.promise;
      },
      { timeoutMs: 5 * MINUTE },
    );
    const id = w.ctx.jobs.enqueue('test.block', { n: 1 }, { workspaceId: w.workspaceId });
    const first = w.ctx.jobs.tick();
    await settle();
    expect(job(w, id)).toMatchObject({ status: 'running', locked_until: w.ctx.clock.now() + 5 * MINUTE });

    w.ctx.clock.advance(4 * MINUTE);
    report(10, 100);
    expect(job(w, id)).toMatchObject({ progress: '{"done":10,"total":100}', locked_until: w.ctx.clock.now() + 5 * MINUTE });

    w.ctx.clock.advance(30 * MINUTE); // lock long expired
    await w.ctx.jobs.tick();
    expect(runs).toBe(1);
    expect(job(w, id)).toMatchObject({ status: 'running', attempts: 1 });

    gate.resolve();
    await first;
    expect(job(w, id).status).toBe('done');
  });

  it('times out a hung run, frees its slots and retries it, and the abandoned run cannot touch the job', async () => {
    const w = makeWorld();
    w.ctx.config.jobConcurrency = 1;
    const hung = deferred();
    const second = deferred();
    const signals: AbortSignal[] = [];
    let lateProgress!: (done: number, total?: number) => void;
    w.ctx.jobs.register(
      'test.block',
      async (j, h) => {
        signals.push(h.signal);
        if (j.attempts === 1) {
          lateProgress = h.progress;
          await hung.promise; // never settles until the test says so
          return 'late';
        }
        await second.promise;
        return 'second';
      },
      { timeoutMs: 150, concurrency: 1 },
    );
    let other = 0;
    w.ctx.jobs.register('test.other', async () => void other++);
    const id = w.ctx.jobs.enqueue('test.block', { n: 1 }, { workspaceId: w.workspaceId });
    w.ctx.jobs.enqueue('test.other', { n: 1 }, { workspaceId: w.workspaceId });

    await w.ctx.jobs.tick(); // settles at the timeout, not never
    expect(job(w, id)).toMatchObject({ status: 'queued', attempts: 1, locked_until: null });
    expect(job(w, id).last_error).toMatch(/^Timed out/);
    expect(signals[0].aborted).toBe(true);
    expect(other).toBe(0);
    await w.ctx.jobs.tick(); // the only slot is free again
    expect(other).toBe(1);

    w.ctx.clock.t = job(w, id).run_at;
    const retry = w.ctx.jobs.tick();
    await settle();
    expect(job(w, id)).toMatchObject({ status: 'running', attempts: 2, progress: null });
    const lock = job(w, id).locked_until;
    // The first run wakes up late: its progress and result are ignored.
    lateProgress(5, 10);
    hung.resolve();
    await settle();
    expect(job(w, id)).toMatchObject({ status: 'running', attempts: 2, progress: null, locked_until: lock, result: null });
    second.resolve();
    await retry;
    expect(job(w, id)).toMatchObject({ status: 'done', result: '"second"' });
    expect(signals[1].aborted).toBe(true); // finished runs release their signal too
  });

  it('never runs more than JOB_CONCURRENCY jobs, even when ticks overlap', async () => {
    const w = makeWorld();
    w.ctx.config.jobConcurrency = 2;
    const gate = deferred();
    let running = 0;
    let peak = 0;
    w.ctx.jobs.register('test.block', async () => {
      peak = Math.max(peak, ++running);
      await gate.promise;
      running--;
    });
    for (let n = 0; n < 5; n++) w.ctx.jobs.enqueue('test.block', { n }, { workspaceId: w.workspaceId });
    const ticks = [w.ctx.jobs.tick(), w.ctx.jobs.tick(), w.ctx.jobs.tick()];
    await settle();
    expect(running).toBe(2);
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'")!.n).toBe(2);
    gate.resolve();
    await Promise.all(ticks);
    await drainJobs(w);
    expect(peak).toBe(2);
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'done'")!.n).toBe(5);
  });

  it('respects a per-type concurrency limit', async () => {
    const w = makeWorld();
    const gate = deferred();
    let running = 0;
    w.ctx.jobs.register(
      'test.block',
      async () => {
        running++;
        await gate.promise;
      },
      { concurrency: 1 },
    );
    let other = 0;
    w.ctx.jobs.register('test.other', async () => void other++);
    for (let n = 0; n < 3; n++) w.ctx.jobs.enqueue('test.block', { n }, { workspaceId: w.workspaceId });
    w.ctx.jobs.enqueue('test.other', { n: 1 }, { workspaceId: w.workspaceId });
    const t = w.ctx.jobs.tick();
    await settle();
    expect(running).toBe(1);
    expect(other).toBe(1); // other types are not held up
    gate.resolve();
    await t;
  });

  it('cleans up old finished jobs', async () => {
    const w = makeWorld();
    const old = w.ctx.clock.now() - 8 * 24 * HOUR;
    const base = { workspace_id: w.workspaceId, type: 'test.echo', run_at: old, created_at: old, updated_at: old };
    const done = w.ctx.db.insert('jobs', { ...base, status: 'done' });
    const failed = w.ctx.db.insert('jobs', { ...base, status: 'failed' });
    await w.ctx.jobs.tick();
    expect(w.ctx.db.get('SELECT 1 FROM jobs WHERE id = ?', [done])).toBeUndefined();
    expect(w.ctx.db.get('SELECT 1 FROM jobs WHERE id = ?', [failed])).toBeDefined(); // failed jobs stay 30 days
  });
});

describe('jobs API', () => {
  it('shows only the workspace’s own jobs, without payloads or system jobs', async () => {
    const api = await makeApi();
    const { ctx } = api.w;
    const a = await api.register('A');
    const mine = ctx.jobs.enqueue('test.echo', { value: 7 }, { workspaceId: a.workspaceId });
    ctx.jobs.enqueue('test.echo', { value: 8 }, { workspaceId: null });
    const b = await api.register('B');
    const theirs = ctx.jobs.enqueue('test.echo', { value: 9 }, { workspaceId: b.workspaceId });

    api.as(a);
    const list = await api.call('GET', '/api/jobs');
    expect(list.body.map((j: any) => j.id)).toEqual([mine]);
    expect(list.body[0]).not.toHaveProperty('payload');
    expect(list.raw).not.toContain('"value"');
    expect((await api.call('GET', `/api/jobs/${mine}`)).body).toMatchObject({ id: mine, type: 'test.echo', status: 'queued', result: null });
    expect((await api.call('GET', `/api/jobs/${theirs}`)).status).toBe(404);
    expect((await api.call('POST', `/api/jobs/${theirs}/cancel`)).status).toBe(404);
    expect((await api.call('GET', '/api/jobs?status=bogus')).status).toBe(400);
  });

  it('lets admins retry and cancel, refuses members, and refuses a retry that would duplicate live work', async () => {
    const api = await makeApi();
    const { ctx } = api.w;
    const owner = await api.register();
    const member = await api.addUser('member');
    ctx.jobs.register('test.fail', async () => {
      throw new PermanentError('nope');
    });
    const failed = ctx.jobs.enqueue('test.fail', {}, { workspaceId: owner.workspaceId, dedupeKey: 'test.fail:1' });
    await ctx.jobs.drain();
    const queued = ctx.jobs.enqueue('test.echo', { value: 1 }, { workspaceId: owner.workspaceId });

    api.as(member);
    expect((await api.call('GET', '/api/jobs')).body).toHaveLength(2);
    expect((await api.call('POST', `/api/jobs/${failed}/retry`)).status).toBe(403);
    expect((await api.call('POST', `/api/jobs/${queued}/cancel`)).status).toBe(403);

    api.as(owner);
    expect((await api.call('POST', `/api/jobs/${queued}/retry`)).status).toBe(409); // not failed
    const live = ctx.jobs.enqueue('test.fail', {}, { workspaceId: owner.workspaceId, dedupeKey: 'test.fail:1' });
    expect(live).not.toBe(failed);
    expect((await api.call('POST', `/api/jobs/${failed}/retry`)).status).toBe(409);
    expect((await api.call('POST', `/api/jobs/${live}/cancel`)).body.status).toBe('cancelled');
    const retried = await api.call('POST', `/api/jobs/${failed}/retry`);
    expect(retried.body).toMatchObject({ status: 'queued', attempts: 0 });
    expect((await api.call('POST', `/api/jobs/${queued}/cancel`)).body.status).toBe('cancelled');
  });
});
