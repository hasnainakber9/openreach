import { join } from 'node:path';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import type { DB } from '../db/db.js';
import type { Sealer } from '../services/crypto.js';
import type { AccountRow } from '../types.js';
import { PlaywrightLinkedInDriver } from './playwright/linkedin.js';
import { SimulatorDriver, type SimulatorOptions } from './simulator.js';
import { DriverError, type LinkedInDriver } from './types.js';

const IDLE_CLOSE_MS = 10 * 60_000;

interface Entry {
  driver: LinkedInDriver;
  key: string;
  lock: Promise<unknown>;
  lastUsed: number;
}

// One driver per account, created lazily. All calls for an account go through `use`,
// which serializes them: a browser can only do one thing at a time.
export class DriverPool {
  private entries = new Map<number, Entry>();
  private timer: NodeJS.Timeout | null = null;
  simOptions: Partial<SimulatorOptions> = {};
  // Tests can swap in their own driver.
  factory: ((a: AccountRow) => LinkedInDriver) | null = null;

  constructor(
    private db: DB,
    private clock: Clock,
    private config: Config,
    private sealer: Sealer,
  ) {}

  private create(a: AccountRow): LinkedInDriver {
    if (this.factory) return this.factory(a);
    if (a.driver === 'simulator') {
      return new SimulatorDriver(this.db, a.id, a.name, this.clock, { latencyMs: this.config.simLatencyMs, ...this.simOptions });
    }
    const liAt = this.sealer.open(a.session_enc);
    if (!liAt) throw new DriverError('SESSION_EXPIRED', 'No LinkedIn session cookie saved for this account');
    return new PlaywrightLinkedInDriver({
      liAt,
      userDataDir: join(this.config.dataDir, 'browsers', String(a.id)),
      proxyUrl: a.proxy_url,
      headless: this.config.headless,
      executablePath: this.config.executablePath,
      timezone: a.timezone,
    });
  }

  async use<T>(a: AccountRow, fn: (d: LinkedInDriver) => Promise<T>): Promise<T> {
    const key = [a.driver, a.session_enc, a.proxy_url, a.timezone].join('|');
    let e = this.entries.get(a.id);
    if (e && e.key !== key) {
      const old = e.driver;
      void e.lock.then(() => old.close()).catch(() => {});
      e = undefined;
    }
    if (!e) {
      e = { driver: this.create(a), key, lock: Promise.resolve(), lastUsed: Date.now() };
      this.entries.set(a.id, e);
    }
    const entry = e;
    const run = entry.lock.then(() => fn(entry.driver));
    entry.lock = run.catch(() => {});
    try {
      return await run;
    } finally {
      entry.lastUsed = Date.now();
    }
  }

  async drop(accountId: number) {
    const e = this.entries.get(accountId);
    this.entries.delete(accountId);
    if (e) await e.lock.then(() => e.driver.close()).catch(() => {});
  }

  startIdleReaper() {
    this.timer = setInterval(() => {
      for (const [id, e] of this.entries) {
        if (Date.now() - e.lastUsed > IDLE_CLOSE_MS) void this.drop(id);
      }
    }, 60_000);
    this.timer.unref();
  }

  async closeAll() {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.entries.keys()].map((id) => this.drop(id)));
  }
}
