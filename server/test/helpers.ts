import { buildApp } from '../src/app.js';
import { ManualClock, MINUTE } from '../src/clock.js';
import type { Config } from '../src/config.js';
import { buildContext, type Ctx } from '../src/context.js';
import { DB } from '../src/db/db.js';
import { Engine } from '../src/engine/engine.js';
import type { Sequence } from '../src/engine/sequence.js';
import type { SimulatorOptions } from '../src/drivers/simulator.js';
import type { ImapClient, InboundEmail } from '../src/mail/imap.js';
import { MailError, type Mailer, type OutgoingEmail, type SmtpTransport } from '../src/services/email.js';
import { importLeads, addLeadsToCampaign } from '../src/services/leads.js';
import { setCampaignAccounts } from '../src/services/rotation.js';
import type { AccountRow, CampaignRow } from '../src/types.js';

// Monday 2026-01-05 08:00 UTC: an hour before the default working day starts.
export const MONDAY_8AM = Date.UTC(2026, 0, 5, 8, 0);

export function seededRandom(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function testConfig(): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir: '/tmp/openreach-test',
    dbPath: ':memory:',
    appSecret: 'test-secret',
    demoSpeed: 1,
    allowSignup: true,
    tickMs: 1000,
    syncIntervalMin: 30,
    simLatencyMs: 0,
    headless: true,
    webDist: '/nonexistent',
    runWorker: false,
    publicUrl: 'http://localhost:8787',
    jobConcurrency: 4,
    aiWaitMaxMin: 30,
    replyHoldMin: 30,
    mailSyncIntervalMin: 5,
    trustProxy: false,
  };
}

export interface World {
  ctx: Ctx & { clock: ManualClock };
  engine: Engine;
  workspaceId: number;
  account: () => AccountRow;
  accountId: number;
  listId: number;
}

export function makeWorld(sim: Partial<SimulatorOptions> = {}, account: Record<string, any> = {}): World {
  const clock = new ManualClock(MONDAY_8AM);
  const random = seededRandom(7);
  const ctx = buildContext(testConfig(), clock, { db: new DB(':memory:'), random }) as World['ctx'];
  ctx.webhooks.deliver = false;
  // Tests never touch the network; a test that needs HTTP passes fakeFetch().
  ctx.fetch = async () => {
    throw new Error('Network access in tests');
  };
  // Nor SMTP, IMAP or DNS: the mailer records, and tests that need inbox or DNS data pass fakes.
  ctx.mailer = fakeMailer();
  ctx.dns = {
    resolveMx: async () => {
      throw Object.assign(new Error('DNS lookups in tests'), { code: 'ETEST' });
    },
    resolveTxt: async () => {
      throw Object.assign(new Error('DNS lookups in tests'), { code: 'ETEST' });
    },
    lookup: async () => {
      throw Object.assign(new Error('DNS lookups in tests'), { code: 'ETEST' });
    },
  };
  ctx.imap = () => fakeImap(() => {
    throw new MailError('TRANSIENT', 'IMAP in tests');
  });
  ctx.drivers.simOptions = { random: seededRandom(99), latencyMs: 0, ...sim };
  const workspaceId = ctx.db.insert('workspaces', { name: 'Test', created_at: clock.now() });
  const accountId = ctx.db.insert('accounts', {
    workspace_id: workspaceId,
    name: 'Sim Seat',
    driver: 'simulator',
    timezone: 'UTC',
    warmup: 0,
    delay_min_sec: 60,
    delay_max_sec: 120,
    created_at: clock.now(),
    ...account,
  });
  const listId = ctx.db.insert('lead_lists', { workspace_id: workspaceId, name: 'List', created_at: clock.now() });
  return {
    ctx,
    engine: new Engine(ctx),
    workspaceId,
    accountId,
    listId,
    account: () => ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [accountId])!,
  };
}

// Adds another simulated LinkedIn account to the world's workspace (same defaults as the first).
export function addAccount(w: World, overrides: Record<string, any> = {}) {
  const id = w.ctx.db.insert('accounts', {
    workspace_id: w.workspaceId,
    name: 'Sim Seat 2',
    driver: 'simulator',
    timezone: 'UTC',
    warmup: 0,
    delay_min_sec: 60,
    delay_max_sec: 120,
    created_at: w.ctx.clock.now(),
    ...overrides,
  });
  return { id, row: () => w.ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [id])! };
}

export function addLeads(w: World, n: number, prefix = 'lead') {
  importLeads(
    w.ctx,
    w.workspaceId,
    w.listId,
    Array.from({ length: n }, (_, i) => ({ profileUrl: `https://www.linkedin.com/in/${prefix}-${i}/`, firstName: `First${i}`, lastName: 'Last', company: 'Acme' })),
  );
  return w.ctx.db.all<{ id: number }>('SELECT id FROM leads WHERE public_id LIKE ? ORDER BY id', [`${prefix}-%`]).map((r) => r.id);
}

export function makeCampaign(w: World, sequence: Sequence, settings: Record<string, unknown> = {}, leadIds: number[] = [], accountIds: number[] = [w.accountId]) {
  const id = w.ctx.db.insert('campaigns', {
    workspace_id: w.workspaceId,
    account_id: accountIds[0] ?? null,
    name: 'Campaign',
    status: 'active',
    sequence: JSON.stringify(sequence),
    settings: JSON.stringify(settings),
    created_at: w.ctx.clock.now(),
    started_at: w.ctx.clock.now(),
  });
  setCampaignAccounts(w.ctx, id, accountIds);
  const campaign = w.ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [id])!;
  const added = addLeadsToCampaign(w.ctx, campaign, leadIds);
  return { id, added };
}

// Advances simulated time in small steps, letting the engine run after each one.
export async function runFor(w: World, ms: number, step = 2 * MINUTE) {
  const end = w.ctx.clock.now() + ms;
  while (w.ctx.clock.now() < end) {
    w.ctx.clock.advance(step);
    await w.engine.tick();
  }
}

export function counts(w: World, campaignId: number) {
  const rows = w.ctx.db.all<{ type: string; status: string; n: number }>('SELECT type, status, COUNT(*) AS n FROM activity WHERE campaign_id = ? GROUP BY type, status', [campaignId]);
  return Object.fromEntries(rows.map((r) => [`${r.type}:${r.status}`, r.n]));
}

export function states(w: World, campaignId: number) {
  const rows = w.ctx.db.all<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? GROUP BY state', [campaignId]);
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}

export interface FakeMailer extends Mailer {
  sent: { transport: SmtpTransport | null; msg: OutgoingEmail }[];
  // Errors the next sends throw, in order (MailError('AUTH' | 'RECIPIENT' | 'TRANSIENT', ...)).
  failures: Error[];
  verifyResult: { ok: boolean; message: string };
}

// Records every email instead of sending it. It never opens a connection, so no test can reach an SMTP server.
export function fakeMailer(): FakeMailer {
  const m: FakeMailer = {
    sent: [],
    failures: [],
    verifyResult: { ok: true, message: 'The SMTP server accepted the login' },
    async send(transport, msg) {
      const fail = m.failures.shift();
      if (fail) throw fail;
      m.sent.push({ transport, msg });
      return { status: transport ? 'sent' : 'simulated', messageId: msg.messageId };
    },
    async verify() {
      return m.verifyResult;
    },
  };
  return m;
}

export const mailerOf = (w: World) => w.ctx.mailer as FakeMailer;

// An IMAP client answering from `inbox` (called with the last UID read): UIDs above it are new.
export function fakeImap(inbox: (lastUid: number) => InboundEmail[], validity = 'v1'): ImapClient {
  return {
    async fetchSince(lastUid, uidValidity) {
      const from = uidValidity === validity ? lastUid : 0;
      const messages = inbox(from).filter((m) => m.uid > from);
      return { uidValidity: validity, lastUid: Math.max(from, ...messages.map((m) => m.uid)), messages };
    },
    async test() {
      return { ok: true, message: 'The IMAP server accepted the login' };
    },
  };
}

// Runs every due background job (and jobs they make due) until none are left.
export async function drainJobs(w: World) {
  await w.ctx.jobs.drain();
}

export interface FakeRoute {
  method?: string;
  url: RegExp;
  reply: (req: { url: string; method: string; headers: Record<string, string>; body: string | null }) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
}

// A stand-in for ctx.fetch that answers from `routes` and records every call. Unmatched calls fail like a network error.
export function fakeFetch(routes: FakeRoute[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string | null }[] = [];
  const fn = (async (input: any, init: any = {}) => {
    const url = String(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    // SDKs (Anthropic's) pass a Headers instance; httpJson passes a plain object.
    const raw: [string, string][] = init.headers instanceof Headers ? [...init.headers.entries()] : Object.entries((init.headers ?? {}) as Record<string, string>);
    const headers = Object.fromEntries(raw.map(([k, v]) => [k.toLowerCase(), String(v)]));
    const req = { url, method, headers, body: init.body == null ? null : String(init.body) };
    calls.push(req);
    const route = routes.find((r) => (!r.method || r.method.toUpperCase() === method) && r.url.test(url));
    if (!route) throw new TypeError(`fetch failed: no fake route for ${method} ${url}`);
    const out = route.reply(req);
    const body = out.json !== undefined ? JSON.stringify(out.json) : (out.text ?? '');
    return new Response(body, { status: out.status ?? 200, headers: { 'content-type': out.json !== undefined ? 'application/json' : 'text/plain', ...out.headers } });
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}

// HTTP API harness: register the first user (owner), add teammates and switch between them.
export async function makeApi(w: World = makeWorld()) {
  const app = await buildApp(w.ctx);
  let current = '';
  const call = async (method: string, url: string, payload?: unknown, as?: { cookie: string }) => {
    const res = await app.inject({ method: method as any, url, payload: payload as any, headers: (as?.cookie ?? current) ? { cookie: as?.cookie ?? current } : {} });
    const set = res.headers['set-cookie'];
    if (set && !as) current = (Array.isArray(set) ? set[0] : set).split(';')[0];
    return { status: res.statusCode, body: res.headers['content-type']?.includes('json') ? res.json() : res.body, raw: res.body };
  };
  const signIn = async (email: string, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    const set = res.headers['set-cookie'];
    return { id: res.json().user.id as number, cookie: (Array.isArray(set) ? set[0] : set!).split(';')[0] };
  };
  let n = 0;
  // Registers a new workspace and signs in as its owner.
  const register = async (workspace = 'Acme') => {
    const email = `owner${++n}@example.com`;
    current = '';
    const r = await call('POST', '/api/auth/register', { name: `Owner ${n}`, email, password: 'correct-horse', workspace });
    if (r.status !== 200) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
    const owner = { id: r.body.user.id as number, workspaceId: r.body.user.workspace_id as number, cookie: current };
    return owner;
  };
  // Adds a user to the current user's workspace (the current user must be an admin).
  const addUser = async (role: 'admin' | 'member' | 'client') => {
    const email = `${role}${++n}@example.com`;
    const r = await call('POST', '/api/team', { name: `${role} ${n}`, email, password: 'correct-horse', role });
    if (r.status !== 200) throw new Error(`addUser failed: ${JSON.stringify(r.body)}`);
    return signIn(email, 'correct-horse');
  };
  const as = (u: { cookie: string }) => {
    current = u.cookie;
  };
  return { w, app, call, register, addUser, as };
}
