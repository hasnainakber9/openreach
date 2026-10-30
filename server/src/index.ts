import { acceleratedClock, realClock } from './clock.js';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { buildContext } from './context.js';
import { DB } from './db/db.js';
import { Engine } from './engine/engine.js';

const config = loadConfig();
const db = new DB(config.dbPath);
// A sped-up demo clock resumes after the last recorded activity, so restarts never move time backwards.
const lastSeen = db.get<{ t: number | null }>('SELECT MAX(created_at) AS t FROM activity')?.t ?? 0;
const clock = config.demoSpeed > 1 ? acceleratedClock(config.demoSpeed, Math.max(Date.now(), lastSeen + 1)) : realClock;
const ctx = buildContext(config, clock, { db });
const app = await buildApp(ctx, { logger: process.env.LOG_REQUESTS === 'true' });
const engine = new Engine(ctx);

await app.listen({ port: config.port, host: config.host });
console.log(`OpenReach listening on http://localhost:${config.port}`);
if (config.demoSpeed > 1) console.log(`Demo mode: time runs ${config.demoSpeed}x faster for campaign scheduling.`);

if (config.runWorker) {
  engine.start();
  ctx.drivers.startIdleReaper();
  console.log('Campaign engine running.');
}

const shutdown = async () => {
  engine.stop();
  await app.close();
  await ctx.drivers.closeAll();
  ctx.db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
