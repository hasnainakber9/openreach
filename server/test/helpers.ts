import { ManualClock, MINUTE } from '../src/clock.js';
import type { Config } from '../src/config.js';
import { buildContext, type Ctx } from '../src/context.js';
import { DB } from '../src/db/db.js';
import { Engine } from '../src/engine/engine.js';
import type { Sequence } from '../src/engine/sequence.js';
import type { SimulatorOptions } from '../src/drivers/simulator.js';
import { importLeads, addLeadsToCampaign } from '../src/services/leads.js';
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

export function addLeads(w: World, n: number, prefix = 'lead') {
  importLeads(
    w.ctx,
    w.workspaceId,
    w.listId,
    Array.from({ length: n }, (_, i) => ({ profileUrl: `https://www.linkedin.com/in/${prefix}-${i}/`, firstName: `First${i}`, lastName: 'Last', company: 'Acme' })),
  );
  return w.ctx.db.all<{ id: number }>('SELECT id FROM leads WHERE public_id LIKE ? ORDER BY id', [`${prefix}-%`]).map((r) => r.id);
}

export function makeCampaign(w: World, sequence: Sequence, settings: Record<string, unknown> = {}, leadIds: number[] = []) {
  const id = w.ctx.db.insert('campaigns', {
    workspace_id: w.workspaceId,
    account_id: w.accountId,
    name: 'Campaign',
    status: 'active',
    sequence: JSON.stringify(sequence),
    settings: JSON.stringify(settings),
    created_at: w.ctx.clock.now(),
    started_at: w.ctx.clock.now(),
  });
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
