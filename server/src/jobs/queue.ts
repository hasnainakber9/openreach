import { DAY, HOUR, MINUTE } from '../clock.js';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { ProviderError } from '../providers/http.js';
import type { JobPayloads, JobStatus, JobType } from './types.js';

// Throw from a handler to reschedule without using up an attempt (rate limits, waiting on something).
export class RetryLater extends Error {
  constructor(
    public readonly delayMs: number,
    reason = 'Waiting to retry',
  ) {
    super(reason);
  }
}

// Throw from a handler to fail at once, with no retry (bad config, missing row).
export class PermanentError extends Error {}

export interface JobInfo<T> {
  id: number;
  workspaceId: number | null;
  payload: T;
  attempts: number; // including this run
}

export interface JobHelpers {
  ctx: Ctx;
  // Reports progress and keeps the job alive: a run that goes timeoutMs without calling it is
  // abandoned and retried, so long handlers call it at least every few minutes.
  progress(done: number, total?: number): void;
  // Aborted when the run times out. Pass it to fetch/Playwright calls so abandoned work stops.
  signal: AbortSignal;
}

export type Handler<T> = (job: JobInfo<T>, h: JobHelpers) => Promise<unknown>;

export interface HandlerOptions {
  concurrency?: number;
  maxAttempts?: number;
  timeoutMs?: number; // longest a run may go without finishing or calling progress()
}

export interface EnqueueOptions {
  workspaceId: number | null;
  runAt?: number;
  // Unique among queued/running jobs. Start it with the type and include the entity id, e.g. 'ai.classify:msg:812'.
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface JobRow {
  id: number;
  workspace_id: number | null;
  type: string;
  payload: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_at: number;
  dedupe_key: string | null;
  locked_until: number | null;
  progress: string | null;
  result: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

interface HandlerDef {
  fn: Handler<any>;
  concurrency: number;
  maxAttempts: number;
  timeoutMs: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT = 10 * MINUTE;
const BACKOFF_BASE = 30_000;
const BACKOFF_MAX = 6 * HOUR;
const RESULT_MAX_CHARS = 4000;

// A durable queue in the `jobs` table, worked by the engine process (Engine.tick calls tick()).
// Handlers must be idempotent (a job can run twice after a crash) and re-load rows with the job's workspace id.
export class JobQueue {
  private handlers = new Map<string, HandlerDef>();
  // Jobs running in this process. This (not the tick) bounds concurrency, since production ticks overlap.
  private inFlight = new Map<number, string>();
  private recovered = false;
  private lastCleanup = 0;

  constructor(private ctx: Ctx) {}

  register<K extends JobType>(type: K, fn: Handler<JobPayloads[K]>, opts: HandlerOptions = {}) {
    this.handlers.set(type, {
      fn,
      concurrency: opts.concurrency ?? Infinity,
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT,
    });
  }

  // Returns the job id, or the live job's id when the dedupe key is already queued or running.
  enqueue<K extends JobType>(type: K, payload: JobPayloads[K], opts: EnqueueOptions): number {
    const now = this.ctx.clock.now();
    const row = this.ctx.db.get<{ id: number }>(
      `INSERT INTO jobs (workspace_id, type, payload, status, attempts, max_attempts, run_at, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
      [
        opts.workspaceId,
        type,
        JSON.stringify(payload ?? {}),
        opts.maxAttempts ?? this.handlers.get(type)?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        opts.runAt ?? now,
        opts.dedupeKey ?? null,
        now,
        now,
      ],
    );
    if (row) return row.id;
    const live = this.ctx.db.get<{ id: number }>("SELECT id FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running')", [opts.dedupeKey ?? null]);
    if (!live) throw new Error(`Could not enqueue ${type}`);
    return live.id;
  }

  // Exponential backoff with jitter: 30 s, 2 min, 8 min, ... capped at 6 h.
  backoffMs(attempts: number) {
    return Math.min(BACKOFF_BASE * 4 ** Math.max(0, attempts - 1), BACKOFF_MAX) * (0.8 + 0.4 * this.ctx.random());
  }

  // Starts due jobs up to the free concurrency and resolves when the jobs it started have settled.
  async tick(): Promise<void> {
    const now = this.ctx.clock.now();
    this.recover(now);
    this.cleanup(now);
    const started: Promise<void>[] = [];
    while (this.inFlight.size < this.ctx.config.jobConcurrency) {
      const types = this.eligibleTypes();
      if (!types.length) break;
      const row = this.claim(types, now);
      if (!row) break;
      this.inFlight.set(row.id, row.type);
      started.push(this.run(row));
    }
    await Promise.all(started);
  }

  // Runs due jobs until none are left (tests and API-only callers). Bounded, so a job that keeps
  // re-queueing itself as due can't loop forever.
  async drain(maxRounds = 100) {
    for (let i = 0; i < maxRounds; i++) {
      const types = [...this.handlers.keys()];
      if (!types.length) return;
      const due = this.ctx.db.get(`SELECT 1 FROM jobs WHERE status = 'queued' AND run_at <= ? AND type IN (${types.map(() => '?').join(',')}) LIMIT 1`, [
        this.ctx.clock.now(),
        ...types,
      ]);
      if (!due) return;
      await this.tick();
    }
  }

  get(id: number, workspaceId: number): JobRow | undefined {
    return this.ctx.db.get<JobRow>('SELECT * FROM jobs WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
  }

  // System jobs (workspace_id NULL) never show up here.
  list(workspaceId: number, filter: { type?: string; status?: JobStatus; limit?: number } = {}): JobRow[] {
    const where = ['workspace_id = ?'];
    const params: (string | number)[] = [workspaceId];
    if (filter.type) (where.push('type = ?'), params.push(filter.type));
    if (filter.status) (where.push('status = ?'), params.push(filter.status));
    return this.ctx.db.all<JobRow>(`SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${Math.min(500, filter.limit ?? 50)}`, params);
  }

  retry(id: number, workspaceId: number): 'ok' | 'not_found' | 'conflict' | 'bad_state' {
    const job = this.get(id, workspaceId);
    if (!job) return 'not_found';
    if (job.status !== 'failed' && job.status !== 'cancelled') return 'bad_state';
    // Another live job already holds the key; the partial unique index would reject the update.
    if (job.dedupe_key && this.ctx.db.get("SELECT 1 FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running') AND id <> ?", [job.dedupe_key, id])) return 'conflict';
    const now = this.ctx.clock.now();
    this.ctx.db.run("UPDATE jobs SET status = 'queued', attempts = 0, run_at = ?, finished_at = NULL, locked_until = NULL, updated_at = ? WHERE id = ?", [now, now, id]);
    return 'ok';
  }

  cancel(id: number, workspaceId: number): 'ok' | 'not_found' | 'bad_state' {
    const job = this.get(id, workspaceId);
    if (!job) return 'not_found';
    if (job.status !== 'queued') return 'bad_state';
    const now = this.ctx.clock.now();
    this.ctx.db.run("UPDATE jobs SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'", [now, now, id]);
    return 'ok';
  }

  private eligibleTypes() {
    const running = new Map<string, number>();
    for (const t of this.inFlight.values()) running.set(t, (running.get(t) ?? 0) + 1);
    return [...this.handlers].filter(([t, d]) => (running.get(t) ?? 0) < d.concurrency).map(([t]) => t);
  }

  // One statement, so two workers can never claim the same job. (Postgres adds FOR UPDATE SKIP LOCKED here.)
  private claim(types: string[], now: number): JobRow | undefined {
    const row = this.ctx.db.get<JobRow>(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_until = ?, updated_at = ?
       WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY run_at, id LIMIT 1)
       RETURNING *`,
      [now + DEFAULT_TIMEOUT, now, now, ...types],
    );
    const timeout = row && this.handlers.get(row.type)!.timeoutMs;
    if (row && timeout !== DEFAULT_TIMEOUT) {
      row.locked_until = now + timeout!;
      this.ctx.db.run('UPDATE jobs SET locked_until = ? WHERE id = ?', [row.locked_until, row.id]);
    }
    return row;
  }

  private async run(row: JobRow) {
    const def = this.handlers.get(row.type)!;
    const { ctx } = this;
    // The lease is enforced here, not only written to locked_until: recover() never reclaims a job
    // running in this process, so a hung handler would hold its slots until a restart. Wall-clock
    // timer, because the demo clock runs faster than real work does.
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expire!: (e: Error) => void;
    const timedOut = new Promise<never>((_, reject) => (expire = reject));
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        expire(new Error(`Timed out after ${Math.round(def.timeoutMs / 1000)} s without progress`));
        abort.abort();
      }, def.timeoutMs);
    };
    const helpers: JobHelpers = {
      ctx,
      signal: abort.signal,
      progress: (done, total) => {
        // A late call from an abandoned run must not extend the lock of the job's next run.
        if (abort.signal.aborted) return;
        arm();
        const now = ctx.clock.now();
        ctx.db.run("UPDATE jobs SET progress = ?, locked_until = ?, updated_at = ? WHERE id = ? AND status = 'running'", [JSON.stringify({ done, total: total ?? null }), now + def.timeoutMs, now, row.id]);
      },
    };
    arm();
    try {
      // The abandoned handler's own promise settles unobserved later (race keeps its rejection handled).
      const result = await Promise.race([def.fn({ id: row.id, workspaceId: row.workspace_id, payload: json(row.payload, {}), attempts: row.attempts }, helpers), timedOut]);
      const text = result === undefined ? null : JSON.stringify(result);
      const now = ctx.clock.now();
      ctx.db.run("UPDATE jobs SET status = 'done', result = ?, last_error = NULL, locked_until = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'", [
        text && text.length <= RESULT_MAX_CHARS ? text : null,
        now,
        now,
        row.id,
      ]);
    } catch (e) {
      this.settleFailure(row, e);
    } finally {
      clearTimeout(timer);
      abort.abort(); // the run is over either way
      this.inFlight.delete(row.id);
    }
  }

  private settleFailure(row: JobRow, thrown: unknown) {
    const { ctx } = this;
    let err = thrown instanceof Error ? thrown : new Error(String(thrown));
    if (err instanceof ProviderError) {
      if (err.code === 'AUTH' || err.code === 'QUOTA' || err.code === 'BAD_REQUEST') {
        // Retrying a bad key or an empty balance only burns attempts; flag the integration instead.
        if (err.integrationId) ctx.providers.markStatus(err.integrationId, 'error', err.message);
        err = new PermanentError(err.message);
      } else if (err.code === 'RATE_LIMIT') {
        err = new RetryLater(err.retryAfterMs ?? MINUTE, err.message);
      }
    }
    const now = ctx.clock.now();
    const message = (err.message || err.name || 'Job failed').slice(0, 500);
    if (err instanceof RetryLater) {
      ctx.db.run("UPDATE jobs SET status = 'queued', attempts = attempts - 1, run_at = ?, last_error = ?, locked_until = NULL, updated_at = ? WHERE id = ? AND status = 'running'", [
        now + Math.max(0, err.delayMs),
        message,
        now,
        row.id,
      ]);
    } else if (err instanceof PermanentError || row.attempts >= row.max_attempts) {
      ctx.db.run("UPDATE jobs SET status = 'failed', last_error = ?, locked_until = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'", [message, now, now, row.id]);
    } else {
      ctx.db.run("UPDATE jobs SET status = 'queued', run_at = ?, last_error = ?, locked_until = NULL, updated_at = ? WHERE id = ? AND status = 'running'", [
        now + Math.round(this.backoffMs(row.attempts)),
        message,
        now,
        row.id,
      ]);
    }
  }

  // The first tick after start re-queues every `running` job: with one worker process they are all
  // orphans of a crash or restart. Later ticks only re-queue expired locks of jobs not running here
  // (that only matters with several instances on Postgres).
  private recover(now: number) {
    const requeue = "status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END, last_error = 'Interrupted before it finished', locked_until = NULL, updated_at = ?, finished_at = CASE WHEN attempts >= max_attempts THEN ? ELSE NULL END";
    if (!this.recovered) {
      this.recovered = true;
      this.ctx.db.run(`UPDATE jobs SET ${requeue} WHERE status = 'running'`, [now, now]);
      return;
    }
    const mine = [...this.inFlight.keys()];
    this.ctx.db.run(`UPDATE jobs SET ${requeue} WHERE status = 'running' AND locked_until < ? ${mine.length ? `AND id NOT IN (${mine.map(() => '?').join(',')})` : ''}`, [now, now, now, ...mine]);
  }

  private cleanup(now: number) {
    if (now - this.lastCleanup < HOUR) return;
    this.lastCleanup = now;
    this.ctx.db.run("DELETE FROM jobs WHERE (status IN ('done', 'cancelled') AND updated_at < ?) OR (status = 'failed' AND updated_at < ?)", [now - 7 * DAY, now - 30 * DAY]);
  }
}
