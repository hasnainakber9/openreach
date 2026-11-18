import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database, Params, Row } from './database.js';
import { MIGRATIONS } from './schema.js';

export type { Database, Params, Row } from './database.js';

// SQLite through node:sqlite: the default database.
export class DB implements Database {
  readonly dialect = 'sqlite' as const;
  readonly raw: DatabaseSync;
  private depth = 0;
  private pending: (() => void)[] = [];

  // `migrateTo` (tests only) stops after the entries with index < migrateTo; a later migrate() runs the rest.
  constructor(path: string, opts: { migrateTo?: number } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate(opts.migrateTo);
  }

  migrate(upTo = MIGRATIONS.length) {
    this.raw.exec('CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY)');
    const done = new Set(this.raw.prepare('SELECT id FROM migrations').all().map((r: any) => r.id as number));
    MIGRATIONS.forEach((sql, i) => {
      if (done.has(i) || i >= upTo) return;
      this.tx(() => {
        this.raw.exec(sql);
        this.raw.prepare('INSERT INTO migrations (id) VALUES (?)').run(i);
      });
    });
  }

  get<T = Row>(sql: string, params: Params = []): T | undefined {
    return this.raw.prepare(sql).get(...spread(params)) as T | undefined;
  }

  all<T = Row>(sql: string, params: Params = []): T[] {
    return this.raw.prepare(sql).all(...spread(params)) as T[];
  }

  run(sql: string, params: Params = []): { changes: number; id: number } {
    const r = this.raw.prepare(sql).run(...spread(params));
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  }

  insert(table: string, values: Record<string, SQLInputValue>): number {
    const keys = Object.keys(values);
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((k) => '$' + k).join(',')})`;
    return this.run(sql, values).id;
  }

  update(table: string, id: number, values: Record<string, SQLInputValue>) {
    const keys = Object.keys(values);
    if (!keys.length) return;
    this.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = $${k}`).join(', ')} WHERE id = $__id`, { ...values, __id: id });
  }

  // Nested calls join the outer transaction.
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    this.raw.exec('BEGIN IMMEDIATE');
    let out: T;
    try {
      out = fn();
      this.raw.exec('COMMIT');
    } catch (e) {
      this.pending = [];
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
    // Run outside the transaction, so a callback may start its own.
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

  // Runs fn once the current transaction commits (dropped if it rolls back), or right away outside one.
  // For effects that leave the process, like webhooks: nobody should hear about a change that was undone.
  afterCommit(fn: () => void) {
    if (this.depth > 0) this.pending.push(fn);
    else fn();
  }

  // One process owns a SQLite file, so it is always the leader.
  tryLock(_key: number) {
    return true;
  }

  holdsLock(_key: number) {
    return true;
  }

  txLock(_key: number) {}

  close() {
    this.raw.close();
  }
}

function spread(params: Params): any[] {
  return Array.isArray(params) ? params : [params];
}

export function json<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
