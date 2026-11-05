import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
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
}

export function loadConfig(env = process.env): Config {
  const dataDir = resolve(env.DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true });
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',
    dataDir,
    dbPath: env.DB_PATH ?? join(dataDir, 'openreach.db'),
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
    webDist: resolve(env.WEB_DIST ?? new URL('../../web/dist', import.meta.url).pathname),
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
  };
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
