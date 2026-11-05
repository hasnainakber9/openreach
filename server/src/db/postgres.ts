import { createRequire } from 'node:module';
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads';
import type { Database, Params, Row, SqlValue } from './database.js';
import { MIGRATIONS } from './schema.js';
import { bindValues, translateDdl, translateSql } from './translate.js';

const CALL_TIMEOUT_MS = 30_000;

// Runs in a worker thread with one pg connection. The main thread blocks on `flag` until the reply is
// posted, so the app keeps its synchronous DB API and statements never interleave, just like SQLite.
// Kept as source text (eval worker), so neither tsc nor the build has to know about a second entry file.
const WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const pg = require(workerData.pgPath);
const { url, schema, createSchema, signal, port } = workerData;
const flag = new Int32Array(signal);
const types = { getTypeParser(oid, format) {
  // int8 (COUNT, ids, times) and numeric (SUM) come back as numbers; booleans as 0/1 like SQLite.
  if (oid === 20) return (v) => Number(v);
  if (oid === 1700) return (v) => Number(v);
  if (oid === 16) return (v) => (v === 't' ? 1 : 0);
  return pg.types.getTypeParser(oid, format);
} };
let client = null;
let epoch = 0;
// Named prepared statements skip parsing and planning on repeat (they live as long as the connection).
let prepared = new Map();
const PREPARED_MAX = 2000;
const quote = (s) => '"' + String(s).replace(/"/g, '""') + '"';
async function connect() {
  const c = new pg.Client({ connectionString: url, types });
  const drop = () => { if (client === c) client = null; };
  c.on('error', drop);
  c.on('end', drop);
  await c.connect();
  if (schema) {
    if (createSchema) await c.query('CREATE SCHEMA IF NOT EXISTS ' + quote(schema));
    await c.query('SET search_path TO ' + quote(schema));
  }
  client = c;
  prepared = new Map();
  epoch++;
}
parentPort.on('message', async (m) => {
  let reply;
  try {
    if (m.op === 'ping') reply = {};
    else if (m.op === 'close') {
      const c = client;
      client = null;
      if (c && m.dropSchema && schema) await c.query('DROP SCHEMA IF EXISTS ' + quote(schema) + ' CASCADE').catch(() => {});
      if (c) await c.end().catch(() => {});
      reply = {};
    } else {
      if (!client) {
        // A new connection has none of the old one's transaction or locks: never continue a transaction on it.
        if (m.inTx && epoch > 0) throw Object.assign(new Error('Lost the database connection during a transaction'), { code: 'CONNECTION_LOST' });
        await connect();
      }
      if (m.op === 'exec') {
        await client.query(m.sql);
        reply = { rows: [], rowCount: 0 };
      } else {
        let name = prepared.get(m.sql);
        if (!name && prepared.size < PREPARED_MAX) prepared.set(m.sql, (name = 'q' + prepared.size));
        const r = await client.query({ name, text: m.sql, values: m.values });
        reply = { rows: r.rows, rowCount: r.rowCount ?? 0 };
      }
    }
  } catch (e) {
    reply = { error: { message: e && e.message ? e.message : String(e), code: e && e.code, detail: e && e.detail } };
  }
  reply.id = m.id;
  reply.epoch = epoch;
  port.postMessage(reply);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
`;

interface Reply {
  id: number;
  epoch: number;
  rows?: Row[];
  rowCount?: number;
  error?: { message: string; code?: string; detail?: string };
}

export interface PgOptions {
  // Use (and with createSchema, create) this schema instead of the connection's default search_path.
  schema?: string;
  createSchema?: boolean;
  // Tests: drop the schema on close().
  dropSchemaOnClose?: boolean;
  // Tests: stop after the migrations with index < migrateTo.
  migrateTo?: number;
  // How long one call may take before it fails (default 30 s).
  callTimeoutMs?: number;
  // Skip migrations (a second connection to a schema another PgDatabase already migrated).
  migrate?: boolean;
}

export class PgError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

// Postgres behind the synchronous Database API. Each call blocks the event loop for one round trip
// (about a millisecond on a nearby server): the trade-off for keeping every transaction exactly as it
// runs on SQLite. Async conversion stays possible later, since all SQL goes through Database.
export class PgDatabase implements Database {
  readonly dialect = 'postgres' as const;
  private worker!: Worker;
  private port!: MessagePort;
  private flag!: Int32Array;
  private seq = 0;
  private depth = 0;
  private pending: (() => void)[] = [];
  // Which connection answered last (worker generation and its reconnect count): a lock is held only by the connection that took it.
  private epoch = 0;
  private generation = 0;
  private answered = false;
  private locks = new Map<number, number>();
  private idTables: Set<string> | null = null;
  private closed = false;
  // Set when a call timed out inside a transaction: its connection (and transaction) is gone.
  private txLost = false;

  constructor(
    private url: string,
    private opts: PgOptions = {},
  ) {
    this.spawn();
    this.call({ op: 'exec', sql: 'SELECT 1' });
    if (opts.migrate !== false) this.migrate(opts.migrateTo);
  }

  private spawn() {
    this.generation++;
    this.answered = false;
    const { port1, port2 } = new MessageChannel();
    const signal = new SharedArrayBuffer(4);
    this.flag = new Int32Array(signal);
    this.port = port1;
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { pgPath: createRequire(import.meta.url).resolve('pg'), url: this.url, schema: this.opts.schema, createSchema: this.opts.createSchema, signal, port: port2 },
      transferList: [port2],
    });
    // Neither keeps the process alive: close() ends the connection, and an idle app may exit.
    this.worker.unref();
    this.port.unref();
  }

  private call(msg: { op: 'query' | 'exec' | 'close' | 'ping'; sql?: string; values?: unknown[]; dropSchema?: boolean }): Reply {
    if (this.closed) throw new Error('The database is closed');
    if (this.txLost && this.depth > 0) throw new PgError('Lost the database connection during a transaction', 'CONNECTION_LOST');
    const id = ++this.seq;
    Atomics.store(this.flag, 0, 0);
    this.worker.postMessage({ ...msg, id, inTx: this.depth > 0 });
    // A new worker first starts a thread and connects: give that the default time at least.
    const timeoutMs = this.answered ? (this.opts.callTimeoutMs ?? CALL_TIMEOUT_MS) : Math.max(this.opts.callTimeoutMs ?? 0, CALL_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0 || Atomics.wait(this.flag, 0, 0, left) === 'timed-out') {
        // The worker may still be busy with it: start over with a new one (and a new connection).
        void this.worker.terminate();
        this.spawn();
        if (this.depth > 0) this.txLost = true;
        throw new PgError(`Database call timed out after ${timeoutMs / 1000} s`, 'TIMEOUT');
      }
      const got = receiveMessageOnPort(this.port)?.message as Reply | undefined;
      if (!got) continue;
      if (got.id !== id) {
        Atomics.store(this.flag, 0, 0);
        continue;
      }
      this.answered = true;
      this.epoch = this.generation * 1_000_000 + got.epoch;
      if (got.error) throw new PgError(got.error.message, got.error.code, got.error.detail);
      return got;
    }
  }

  ping() {
    this.call({ op: 'ping' });
  }

  private query(sql: string, params: Params): Reply {
    const stmt = translateSql(sql);
    return this.call({ op: 'query', sql: stmt.text, values: bindValues(stmt, params as any) });
  }

  migrate(upTo = MIGRATIONS.length) {
    this.call({ op: 'exec', sql: 'CREATE TABLE IF NOT EXISTS migrations (id BIGINT PRIMARY KEY)' });
    // Two instances starting together must not both run a migration.
    this.tx(() => {
      this.call({ op: 'exec', sql: 'LOCK TABLE migrations IN EXCLUSIVE MODE' });
      const done = new Set(this.all<{ id: number }>('SELECT id FROM migrations').map((r) => r.id));
      MIGRATIONS.forEach((sql, i) => {
        if (done.has(i) || i >= upTo) return;
        this.call({ op: 'exec', sql: translateDdl(sql) });
        this.run('INSERT INTO migrations (id) VALUES (?)', [i]);
      });
    });
    this.idTables = null;
  }

  get<T = Row>(sql: string, params: Params = []): T | undefined {
    return this.query(sql, params).rows![0] as T | undefined;
  }

  all<T = Row>(sql: string, params: Params = []): T[] {
    return this.query(sql, params).rows as T[];
  }

  run(sql: string, params: Params = []): { changes: number; id: number } {
    return { changes: this.query(sql, params).rowCount ?? 0, id: 0 };
  }

  insert(table: string, values: Record<string, SqlValue>): number {
    const keys = Object.keys(values);
    const returning = this.hasId(table) ? ' RETURNING id' : '';
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((k) => '$' + k).join(',')})${returning}`;
    const row = this.get<{ id: number }>(sql, values);
    return row?.id ?? 0;
  }

  update(table: string, id: number, values: Record<string, SqlValue>) {
    const keys = Object.keys(values);
    if (!keys.length) return;
    this.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = $${k}`).join(', ')} WHERE id = $__id`, { ...values, __id: id });
  }

  // Tables keyed otherwise (sessions, memberships, ...) have no id to return.
  private hasId(table: string) {
    this.idTables ??= new Set(
      this.all<{ table_name: string }>("SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'id'").map((r) => r.table_name),
    );
    return this.idTables.has(table.toLowerCase());
  }

  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.call({ op: 'exec', sql: 'BEGIN' });
    this.depth++;
    let out: T;
    try {
      out = fn();
      this.call({ op: 'exec', sql: 'COMMIT' });
    } catch (e) {
      this.pending = [];
      if (!this.txLost) {
        try {
          this.call({ op: 'exec', sql: 'ROLLBACK' });
        } catch {
          // The connection is gone, and its transaction with it.
        }
      }
      throw e;
    } finally {
      this.depth--;
      this.txLost = false;
    }
    const due = this.pending;
    this.pending = [];
    let failed: { e: unknown } | null = null;
    for (const f of due) {
      try {
        f();
      } catch (e) {
        failed ??= { e };
      }
    }
    if (failed) throw failed.e;
    return out;
  }

  afterCommit(fn: () => void) {
    if (this.depth > 0) this.pending.push(fn);
    else fn();
  }

  // Session-level advisory lock: released when this connection ends, so a crashed leader frees it.
  // Locks are re-entrant per session, so a lock this connection already holds is not taken twice.
  tryLock(key: number): boolean {
    if (this.holdsLock(key)) return true;
    const ok = this.get<{ ok: number }>('SELECT pg_try_advisory_lock(CAST(? AS BIGINT)) AS ok', [key])?.ok === 1;
    if (ok) this.locks.set(key, this.epoch);
    return ok;
  }

  // Cheap: true while the connection that took the lock is the one in use.
  holdsLock(key: number): boolean {
    return this.locks.get(key) === this.epoch && this.epoch > 0;
  }

  // Transaction-level advisory lock: released by COMMIT or ROLLBACK. Outside a transaction it would be
  // released at once, so that is a bug.
  txLock(key: number) {
    if (this.depth === 0) throw new Error('txLock() needs a transaction');
    this.run('SELECT pg_advisory_xact_lock(CAST(? AS BIGINT))', [key]);
  }

  close() {
    if (this.closed) return;
    try {
      this.call({ op: 'close', dropSchema: this.opts.dropSchemaOnClose });
    } finally {
      this.closed = true;
      void this.worker.terminate();
    }
  }
}
