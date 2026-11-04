import type { Clock } from './clock.js';
import type { Config } from './config.js';
import { DB } from './db/db.js';
import { DriverPool } from './drivers/pool.js';
import { registerHandlers } from './jobs/handlers.js';
import { JobQueue } from './jobs/queue.js';
import { registerProviders } from './providers/index.js';
import { ProviderResolver } from './providers/store.js';
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
  // All provider HTTP goes through this, so tests can swap in a fake and never touch the network.
  fetch: typeof fetch;
  jobs: JobQueue;
  providers: ProviderResolver;
}

export function buildContext(config: Config, clock: Clock, overrides: Partial<Ctx> = {}): Ctx {
  const db = overrides.db ?? new DB(config.dbPath);
  const sealer = new Sealer(config.appSecret);
  const ctx = {
    db,
    clock,
    config,
    sealer,
    drivers: new DriverPool(db, clock, config, sealer),
    webhooks: new Webhooks(db),
    mailer: smtpMailer,
    random: Math.random,
    fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => globalThis.fetch(input, init),
    ...overrides,
  } as Ctx;
  // The queue and resolver read ctx lazily, so later overrides (tests) still apply.
  ctx.jobs ??= new JobQueue(ctx);
  ctx.providers ??= new ProviderResolver(ctx);
  registerProviders();
  registerHandlers(ctx);
  return ctx;
}
