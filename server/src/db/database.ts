import type { SQLInputValue } from 'node:sqlite';
import type { Config } from '../config.js';
import { DB } from './db.js';
import { PgDatabase } from './postgres.js';

export type SqlValue = SQLInputValue;
export type Params = Record<string, SqlValue> | SqlValue[];
export type Row = Record<string, any>;
export type Dialect = 'sqlite' | 'postgres';

// The one way code reaches the database. SQLite (`DB`) is the default; `PgDatabase` speaks the same
// synchronous API to Postgres, so callers write one portable SQL dialect (PREMIUM_PLAN.md 2.2).
export interface Database {
  readonly dialect: Dialect;
  get<T = Row>(sql: string, params?: Params): T | undefined;
  all<T = Row>(sql: string, params?: Params): T[];
  // `id` is only meaningful on SQLite; use insert() or `RETURNING id` for new ids.
  run(sql: string, params?: Params): { changes: number; id: number };
  // The new row's id for tables with an `id` column; tables keyed otherwise return 0.
  insert(table: string, values: Record<string, SqlValue>): number;
  update(table: string, id: number, values: Record<string, SqlValue>): void;
  // Nested calls join the outer transaction.
  tx<T>(fn: () => T): T;
  // Runs fn once the current transaction commits (dropped if it rolls back), or right away outside one.
  afterCommit(fn: () => void): void;
  // A lock held by this connection for as long as it lives (Postgres advisory lock), so only one
  // instance runs the engine. SQLite has a single process: always granted.
  tryLock(key: number): boolean;
  // Whether this connection still holds the lock (false once the connection was lost and reopened).
  holdsLock(key: number): boolean;
  // Inside tx(): a lock held until the transaction ends, so instances sharing Postgres take turns on a
  // check-then-insert. SQLite runs one transaction at a time anyway: nothing to do.
  txLock(key: number): void;
  close(): void;
}

export function isPostgresUrl(url: string | undefined): url is string {
  return !!url && /^postgres(ql)?:\/\//i.test(url);
}

// DATABASE_URL=postgres://... selects Postgres; anything else keeps SQLite at DB_PATH.
export function openDatabase(config: Pick<Config, 'dbPath' | 'databaseUrl'>): Database {
  if (isPostgresUrl(config.databaseUrl)) return new PgDatabase(config.databaseUrl);
  return new DB(config.dbPath);
}
