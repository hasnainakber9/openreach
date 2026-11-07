import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { HttpError, idParam, notFound, parse, requireAdmin, user } from '../http.js';
import type { JobRow } from '../jobs/queue.js';
import { JOB_STATUSES } from '../jobs/types.js';

// Payloads stay server-side: they can hold internal ids and are no use to the UI.
export function serializeJob(j: JobRow, full = false) {
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.max_attempts,
    progress: json<{ done: number; total: number | null } | null>(j.progress, null),
    lastError: j.last_error,
    runAt: j.run_at,
    createdAt: j.created_at,
    finishedAt: j.finished_at,
    ...(full ? { result: json<unknown>(j.result, null) } : {}),
  };
}

export function jobRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/jobs', async (req) => {
    const q = parse(
      z.object({ type: z.string().max(60).optional(), status: z.enum(JOB_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(500).default(50) }),
      req.query,
    );
    return ctx.jobs.list(user(req).workspace_id, q).map((j) => serializeJob(j));
  });

  app.get('/api/jobs/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return serializeJob(ctx.jobs.get(id, user(req).workspace_id) ?? notFound('Job'), true);
  });

  app.post('/api/jobs/:id/retry', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const r = ctx.jobs.retry(id, admin.workspace_id);
    if (r === 'not_found') notFound('Job');
    if (r === 'conflict') throw new HttpError(409, 'The same work is already queued or running');
    if (r === 'bad_state') throw new HttpError(409, 'Only failed or cancelled jobs can be retried');
    return serializeJob(ctx.jobs.get(id, admin.workspace_id)!);
  });

  app.post('/api/jobs/:id/cancel', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const r = ctx.jobs.cancel(id, admin.workspace_id);
    if (r === 'not_found') notFound('Job');
    if (r === 'bad_state') throw new HttpError(409, 'Only queued jobs can be cancelled');
    return serializeJob(ctx.jobs.get(id, admin.workspace_id)!);
  });
}
