import { join } from 'node:path';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import type { Sealer } from '../services/crypto.js';
import type { AccountRow } from '../types.js';
import type { LoginLauncher, SignInState } from './browser-login.js';
import { PlaywrightLinkedInDriver, type ContextLauncher } from './playwright/linkedin.js';
import { SimulatorDriver, type SimulatorOptions } from './simulator.js';
import { DriverError, SignInOpen, type LinkedInDriver } from './types.js';

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
  // Accounts whose browser profile a sign-in window has open (browser-login.ts), or that are being deleted:
  // no driver starts for them. A count, since a sign-in and a delete can both hold one.
  private held = new Map<number, number>();
  // Browsers still shutting down, per account. drop() forgets an entry before its close finishes, and the
  // next browser or sign-in window on that profile folder must wait for it.
  private closing = new Map<number, Promise<void>>();
  simOptions: Partial<SimulatorOptions> = {};
  // Tests can swap in their own driver.
  factory: ((a: AccountRow) => LinkedInDriver) | null = null;
  // Tests: a fake browser context for real accounts, so the Playwright driver runs without a browser.
  launch: ContextLauncher | null = null;
  // The sign-in window per account (browser-login.ts). It lives here because it shares the pool's profiles
  // and, like the browsers, only this process knows about it. Tests swap the window and its timing.
  signIns = new Map<number, SignInState>();
  loginWindow: LoginLauncher | null = null;
  loginTiming = { pollMs: 2000, timeoutMs: 10 * 60_000 };

  constructor(
    private db: Database,
    private clock: Clock,
    private config: Config,
    private sealer: Sealer,
  ) {}

  userDataDir(accountId: number) {
    return join(this.config.dataDir, 'browsers', String(accountId));
  }

  private create(a: AccountRow): LinkedInDriver {
    if (this.factory) return this.factory(a);
    if (a.driver === 'simulator') {
      return new SimulatorDriver(this.db, a.id, a.name, this.clock, { latencyMs: this.config.simLatencyMs, ...this.simOptions });
    }
    const liAt = this.sealer.open(a.session_enc);
    if (!liAt) throw new DriverError('SESSION_EXPIRED', 'No LinkedIn session saved for this account. Sign in first.');
    return new PlaywrightLinkedInDriver({
      liAt,
      userDataDir: this.userDataDir(a.id),
      proxyUrl: a.proxy_url,
      headless: this.config.headless,
      executablePath: this.config.executablePath,
      timezone: a.timezone,
      sessionOrigin: a.session_origin,
      launch: this.launch ?? undefined,
      onSessionCookie: (value, previous) => this.storeRotated(a.id, value, previous),
    });
  }

  // LinkedIn rotated a browser-owned session: store the new value, but only over the one the driver last
  // knew, so a cookie pasted (or a sign-in finished) in the meantime is never overwritten. Compared as
  // plain text: another driver on the same profile (one closing as this one starts) may have stored the
  // same rotation already, under a different sealed value.
  private storeRotated(accountId: number, value: string, previous: string) {
    const row = this.db.get<Pick<AccountRow, 'session_enc' | 'session_origin'>>('SELECT session_enc, session_origin FROM accounts WHERE id = ?', [accountId]);
    if (row?.session_origin !== 'browser' || this.sealer.open(row.session_enc) !== previous) return;
    this.db.run("UPDATE accounts SET session_enc = ? WHERE id = ? AND session_origin = 'browser' AND session_enc = ?", [this.sealer.seal(value), accountId, row.session_enc]);
  }

  // Remembers a close under way until it (and any earlier one) has finished.
  private track(accountId: number, close: Promise<unknown>) {
    const all = Promise.all([this.closing.get(accountId), close]).then(() => {});
    this.closing.set(accountId, all);
    void all.then(() => {
      if (this.closing.get(accountId) === all) this.closing.delete(accountId);
    });
  }

  async use<T>(row: AccountRow, fn: (d: LinkedInDriver) => Promise<T>): Promise<T> {
    if (this.held.has(row.id)) throw new SignInOpen();
    // The session as stored now: callers may hold a row read before a sign-in or a rotation was saved.
    const s = this.db.get<Pick<AccountRow, 'session_enc' | 'session_origin'>>('SELECT session_enc, session_origin FROM accounts WHERE id = ?', [row.id]);
    const a = s ? { ...row, ...s } : row;
    // A browser-owned session is kept current by the profile itself (and re-sealed by the pool when LinkedIn
    // rotates it), so its stored value changing is no reason to restart the browser.
    const session = a.session_origin === 'browser' ? 'browser' : a.session_enc;
    const key = [a.driver, session, a.proxy_url, a.timezone].join('|');
    let e = this.entries.get(a.id);
    if (e && e.key !== key) {
      const old = e;
      this.track(a.id, old.lock.then(() => old.driver.close()).catch(() => {}));
      e = undefined;
    }
    if (!e) {
      // The new browser opens the same profile folder, so it waits for any old one to close.
      e = { driver: this.create(a), key, lock: this.closing.get(a.id) ?? Promise.resolve(), lastUsed: Date.now() };
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

  // Closes the account's browser after the call it is busy with; resolves once no browser of the account is
  // left running, including one another caller had already started closing.
  async drop(accountId: number) {
    const e = this.entries.get(accountId);
    this.entries.delete(accountId);
    if (e) this.track(accountId, e.lock.then(() => e.driver.close()).catch(() => {}));
    await this.closing.get(accountId);
  }

  // Closes the account's browser once the call it is busy with has finished, and keeps any new one from
  // starting until the returned release is called: two browsers must never share a profile folder.
  async hold(accountId: number): Promise<() => void> {
    this.held.set(accountId, (this.held.get(accountId) ?? 0) + 1);
    await this.drop(accountId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.held.get(accountId) ?? 1) - 1;
      if (n > 0) this.held.set(accountId, n);
      else this.held.delete(accountId);
    };
  }

  isHeld(accountId: number) {
    return this.held.has(accountId);
  }

  startIdleReaper() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      for (const [id, e] of this.entries) {
        if (Date.now() - e.lastUsed > IDLE_CLOSE_MS) void this.drop(id);
      }
    }, 60_000);
    this.timer.unref();
  }

  // Closes every browser (each after the call it is busy with) and any sign-in window; the idle reaper keeps running.
  async closeSessions() {
    for (const s of this.signIns.values()) s.cancel();
    await Promise.all([...this.entries.keys()].map((id) => this.drop(id)));
  }

  async closeAll() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.closeSessions();
  }
}
