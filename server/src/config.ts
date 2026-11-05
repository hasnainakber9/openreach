import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadPlans, type Plan } from './billing/plans.js';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  // postgres://... switches from the SQLite file at dbPath to Postgres.
  databaseUrl?: string;
  appSecret: string;
  demoSpeed: number;
  allowSignup: boolean;
  setupToken?: string;
  tickMs: number;
  syncIntervalMin: number;
  simLatencyMs: number;
  headless: boolean;
  executablePath?: string;
  webDist: string;
  runWorker: boolean;
  publicUrl?: string;
  jobConcurrency: number;
  aiWaitMaxMin: number;
  replyHoldMin: number;
  mailSyncIntervalMin: number;
  smtpUrl?: string;
  mailFrom?: string;
  trustProxy: TrustProxy;
  customDomains?: string[];
  // Hosted billing: off unless the Stripe key is set (self-hosted installs stay unlimited).
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  plans?: Plan[];
}

// false: ignore X-Forwarded-*. A number: trust that many proxy hops in front of the app. A list: trust
// proxies at these addresses or CIDR ranges (or proxy-addr names such as 'loopback').
export type TrustProxy = false | number | string[];

export function loadConfig(env = process.env): Config {
  if (env.DATABASE_URL?.trim() && !/^postgres(ql)?:\/\//i.test(env.DATABASE_URL.trim())) throw new Error('DATABASE_URL must be a postgres:// or postgresql:// URL (leave it unset for SQLite).');
  const dataDir = resolve(env.DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true });
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',
    dataDir,
    dbPath: env.DB_PATH ?? join(dataDir, 'openreach.db'),
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    appSecret: env.APP_SECRET ?? localSecret(dataDir),
    demoSpeed: Number(env.DEMO_SPEED ?? 1),
    allowSignup: env.ALLOW_SIGNUP === 'true',
    // When set, creating the first (owner) account requires this token, so a public URL can't be claimed by a stranger.
    setupToken: env.SETUP_TOKEN || undefined,
    tickMs: Number(env.TICK_MS ?? 2000),
    syncIntervalMin: Number(env.SYNC_INTERVAL_MIN ?? 45),
    simLatencyMs: Number(env.SIM_LATENCY_MS ?? 150),
    headless: env.PLAYWRIGHT_HEADLESS !== 'false',
    executablePath: env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    // fileURLToPath, not URL.pathname: on Windows the pathname is /C:/..., which resolve() mangles, and the app wasn't served.
    webDist: resolve(env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url))),
    runWorker: env.RUN_WORKER !== 'false',
    // External base URL for links that leave the app (unsubscribe, tracking, invites). Never taken from the Host header.
    publicUrl: env.PUBLIC_URL?.trim().replace(/\/+$/, '') || undefined,
    jobConcurrency: Math.max(1, Number(env.JOB_CONCURRENCY ?? 4) || 4),
    // How long a step waits for its AI variables before sending with the fallbacks.
    aiWaitMaxMin: Math.max(1, Number(env.AI_WAIT_MAX_MIN ?? 30) || 30),
    // How long a replied lead waits for its reply to be classified (campaigns that keep going after some replies).
    replyHoldMin: Math.max(1, Number(env.REPLY_HOLD_MIN ?? 30) || 30),
    // Minutes between IMAP checks for replies and bounces, per mailbox.
    mailSyncIntervalMin: Math.max(1, Number(env.MAIL_SYNC_INTERVAL_MIN ?? 5) || 5),
    // The installation's own mail (invites), separate from users' mailboxes: smtp(s)://user:pass@host:port.
    smtpUrl: env.SMTP_URL?.trim() || undefined,
    mailFrom: env.MAIL_FROM?.trim() || undefined,
    // Behind a reverse proxy: take the client IP and Host (custom-domain branding) from X-Forwarded-*.
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    // Hostnames (or *.suffix patterns) workspaces may claim as custom domains. Unset: any, unless signup
    // is open, where strangers could squat domains; then none.
    customDomains: env.CUSTOM_DOMAINS?.split(',').map((d) => d.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean),
    ...billingConfig(env),
  };
}

// Plans are checked at startup, so a typo stops the server instead of locking every workspace out.
function billingConfig(env: Record<string, string | undefined>): Pick<Config, 'stripeSecretKey' | 'stripeWebhookSecret' | 'plans'> {
  const stripeSecretKey = env.STRIPE_SECRET_KEY?.trim() || undefined;
  const plans = loadPlans(env);
  if (stripeSecretKey && !plans.length) throw new Error('STRIPE_SECRET_KEY is set but no plans are defined. Set BILLING_PLANS or BILLING_PLANS_FILE.');
  return { stripeSecretKey, stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() || undefined, plans };
}

// 'true' means the one proxy in front of us. Trusting every hop would let a client pick its own IP (the
// left-most X-Forwarded-For entry is whatever it sent), and with it a fresh sign-in throttle each time.
export function parseTrustProxy(v: string | undefined): TrustProxy {
  const t = v?.trim().toLowerCase();
  if (!t || t === 'false' || t === '0') return false;
  if (t === 'true') return 1;
  if (/^\d+$/.test(t)) return Number(t);
  return t.split(',').map((s) => s.trim()).filter(Boolean);
}

// Without APP_SECRET, generate one on first boot and keep it next to the database,
// so sealed LinkedIn sessions survive restarts.
function localSecret(dataDir: string): string {
  const file = join(dataDir, 'app-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
