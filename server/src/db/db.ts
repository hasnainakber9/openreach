import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.js';

export type Params = Record<string, SQLInputValue> | SQLInputValue[];
export type Row = Record<string, any>;

export class DB {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate() {
    this.raw.exec('CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY)');
    const done = new Set(this.raw.prepare('SELECT id FROM migrations').all().map((r: any) => r.id as number));
    MIGRATIONS.forEach((sql, i) => {
      if (done.has(i)) return;
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
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

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
