import type { Ctx } from '../context.js';

// The one place job handlers are wired, called once from buildContext. Each step registers its
// types here, e.g. ctx.jobs.register('enrich.lead', enrichLeadJob, { concurrency: 2 }).
export function registerHandlers(_ctx: Ctx) {}
