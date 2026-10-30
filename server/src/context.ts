import type { Clock } from './clock.js';
import type { Config } from './config.js';
import { DB } from './db/db.js';
import { DriverPool } from './drivers/pool.js';
import { Sealer } from './services/crypto.js';
import { smtpMailer, type Mailer } from './services/email.js';
import { Webhooks } from './services/webhooks.js';

export interface Ctx {
  db: DB;
  clock: Clock;
  config: Config;
  sealer: Sealer;
  drivers: DriverPool;
  webhooks: Webhooks;
  mailer: Mailer;
  random: () => number;
}

export function buildContext(config: Config, clock: Clock, overrides: Partial<Ctx> = {}): Ctx {
  const db = overrides.db ?? new DB(config.dbPath);
  const sealer = new Sealer(config.appSecret);
  return {
    db,
    clock,
    config,
    sealer,
    drivers: new DriverPool(db, clock, config, sealer),
    webhooks: new Webhooks(db),
    mailer: smtpMailer,
    random: Math.random,
    ...overrides,
  };
}
