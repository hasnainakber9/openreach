import { acceleratedClock, realClock } from './clock.js';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { buildContext } from './context.js';
import { openDatabase } from './db/database.js';
import { Engine } from './engine/engine.js';
import { Leadership } from './engine/leader.js';

const config = loadConfig();
const db = openDatabase(config);
// A sped-up demo clock resumes after the last recorded activity, so restarts never move time backwards.
const lastSeen = db.get<{ t: number | null }>('SELECT MAX(created_at) AS t FROM activity')?.t ?? 0;
const clock = config.demoSpeed > 1 ? acceleratedClock(config.demoSpeed, Math.max(Date.now(), lastSeen + 1)) : realClock;
const ctx = buildContext(config, clock, { db });
const app = await buildApp(ctx, { logger: process.env.LOG_REQUESTS === 'true' });
const engine = new Engine(ctx);

await app.listen({ port: config.port, host: config.host });
console.log(`OpenReach listening on http://localhost:${config.port}`);
if (db.dialect === 'postgres') console.log('Database: Postgres (DATABASE_URL).');
if (config.demoSpeed > 1) console.log(`Demo mode: time runs ${config.demoSpeed}x faster for campaign scheduling.`);

// With Postgres, instances sharing the database elect one engine runner; SQLite is always the leader.
const leadership = new Leadership(db, {
  onLead: () => {
    engine.start(() => leadership.isLeader);
    console.log('Campaign engine running.');
  },
  onLose: () => {
    // Runs still going stop before their next LinkedIn call (the gate); jobs stop now, keeping their leases
    // for the new leader. The browsers close once the last run has finished with them.
    engine.stop();
    ctx.jobs.stopAll();
    void engine.idle().then(() => (leadership.isLeader ? undefined : ctx.drivers.closeSessions()));
  },
});
// LinkedIn calls (check, sync, inbox replies) stay with the leader; a SQLite instance runs them itself, as before.
ctx.isLeader = () => db.dialect === 'sqlite' || leadership.isLeader;
// Every instance closes idle browsers, whoever opened them.
ctx.drivers.startIdleReaper();
if (config.runWorker) leadership.start();

const shutdown = async () => {
  leadership.stop();
  engine.stop();
  await app.close();
  await ctx.drivers.closeAll();
  ctx.db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
