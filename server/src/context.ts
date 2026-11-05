import { stripeClient, type StripeLike } from './billing/stripe.js';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import { registerCrmTriggers } from './crm/triggers.js';
import { DB } from './db/db.js';
import { DriverPool } from './drivers/pool.js';
import { registerHandlers } from './jobs/handlers.js';
import { JobQueue } from './jobs/queue.js';
import { systemResolver, type DnsResolver } from './mail/deliverability.js';
import { imapflowFactory, type ImapFactory } from './mail/imap.js';
import { ensureLegacyMailboxes } from './mail/mailboxes.js';
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
  // DNS lookups for the deliverability check, and the IMAP client factory; tests inject fakes.
  dns: DnsResolver;
  imap: ImapFactory;
  // Hosted billing; null (billing off, nothing limited) unless STRIPE_SECRET_KEY is set. Tests pass a stub.
  stripe: StripeLike | null;
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
    dns: systemResolver(),
    imap: imapflowFactory,
    ...overrides,
  } as Ctx;
  // The queue and resolver read ctx lazily, so later overrides (tests) still apply.
  ctx.jobs ??= new JobQueue(ctx);
  ctx.providers ??= new ProviderResolver(ctx);
  if (!('stripe' in overrides)) ctx.stripe = config.stripeSecretKey ? stripeClient(ctx, config.stripeSecretKey) : null;
  registerProviders();
  registerHandlers(ctx);
  // CRM sync listens to outgoing events and queues crm.sync jobs.
  registerCrmTriggers(ctx);
  // Accounts' SMTP settings from before mailboxes become mailboxes (once; needs APP_SECRET, so not a migration).
  ensureLegacyMailboxes(ctx);
  return ctx;
}
