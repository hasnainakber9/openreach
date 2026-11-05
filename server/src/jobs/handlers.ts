import { classifyJob, CLASSIFY_JOB_OPTIONS } from '../ai/classify.js';
import { AI_JOB_OPTIONS, personalizeJob } from '../ai/personalize.js';
import type { Ctx } from '../context.js';
import { EMAIL_SYNC_JOB_OPTIONS, emailSyncJob } from '../mail/inbound.js';
import { IMPORT_JOB_OPTIONS, importJob } from '../services/imports.js';

// The one place job handlers are wired, called once from buildContext. Each step registers its
// types here, e.g. ctx.jobs.register('enrich.lead', enrichLeadJob, { concurrency: 2 }).
export function registerHandlers(ctx: Ctx) {
  // Long scrapes report progress every page, which keeps their lock alive.
  ctx.jobs.register('leads.import', importJob, IMPORT_JOB_OPTIONS);
  ctx.jobs.register('ai.personalize', personalizeJob, AI_JOB_OPTIONS);
  ctx.jobs.register('ai.classify', classifyJob, CLASSIFY_JOB_OPTIONS);
  ctx.jobs.register('email.sync', emailSyncJob, EMAIL_SYNC_JOB_OPTIONS);
}
