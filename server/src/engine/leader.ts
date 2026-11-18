import type { Database } from '../db/database.js';

// Postgres advisory lock key of the instance that runs the engine and the job worker.
export const LEADER_LOCK = 0x4f52_454e;
const RETRY_MS = 30_000;

// Several app instances may share one Postgres database. Only the one holding the leader lock runs the
// engine and jobs; the others serve the API and enqueue jobs, and take over within RETRY_MS when the
// leader goes away (its lock dies with its connection). SQLite always grants the lock.
export class Leadership {
  private timer: NodeJS.Timeout | null = null;
  private leading = false;
  private standbyLogged = false;

  constructor(
    private db: Database,
    private hooks: { onLead(): void; onLose(): void },
    private key = LEADER_LOCK,
  ) {}

  // Cheap (no query): false as soon as the connection that took the lock has been replaced.
  get isLeader() {
    return this.leading && this.db.holdsLock(this.key);
  }

  start(retryMs = RETRY_MS) {
    this.check();
    this.timer = setInterval(() => this.check(), retryMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  check() {
    try {
      if (this.leading) {
        // A dropped connection is only noticed on the next statement, and reopening it loses the lock.
        this.db.get('SELECT 1 AS ok');
        if (this.db.holdsLock(this.key)) return;
        this.leading = false;
        this.standbyLogged = false;
        console.warn('[leader] Lost the database connection that held the engine lock; standing by.');
        this.hooks.onLose();
      }
      if (this.db.tryLock(this.key)) {
        this.leading = true;
        this.hooks.onLead();
      } else if (!this.standbyLogged) {
        this.standbyLogged = true;
        console.log('[leader] Another instance runs the campaign engine; this one serves the API (standby).');
      }
    } catch (e) {
      console.error('[leader] check failed', e);
    }
  }
}
