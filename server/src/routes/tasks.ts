import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MINUTE } from '../clock.js';
import type { Ctx } from '../context.js';
import { isValidTimezone, localParts } from '../engine/limits.js';
import { TASK_KINDS } from '../engine/sequence.js';
import { HttpError, idParam, notFound, parse, requireWriter, user } from '../http.js';
import { CALL_OUTCOMES, completeTask, createTask, isWorkspaceMember, serializeTask, skipTask } from '../services/tasks.js';
import type { TaskRow } from '../types.js';

const TASK_FILTERS = ['open', 'overdue', 'done', 'skipped', 'all'] as const;

// End of the caller's current day (minute resolution), for "due today".
function endOfDay(now: number, tz: string) {
  const p = localParts(now, tz);
  return now - (now % MINUTE) + (24 * 60 - p.minutes) * MINUTE;
}

export function taskRoutes(app: FastifyInstance, ctx: Ctx) {
  const load = (req: any): TaskRow => {
    const { id } = parse(idParam, req.params);
    return ctx.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]) ?? notFound('Task');
  };
  // Assignees must belong to the workspace; another workspace's user is a 404 like any other row.
  const checkAssignee = (ws: number, id: number | null | undefined) => {
    if (id != null && !isWorkspaceMember(ctx, ws, id)) notFound('User');
  };

  app.get('/api/tasks', async (req) => {
    const u = user(req);
    const q = parse(
      z.object({
        status: z.enum(TASK_FILTERS).default('open'),
        assignee: z.union([z.enum(['me', 'all', 'unassigned']), z.coerce.number().int().positive()]).default('all'),
        campaignId: z.coerce.number().int().positive().optional(),
        leadId: z.coerce.number().int().positive().optional(),
        kind: z.enum(TASK_KINDS).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const where = ['workspace_id = $ws'];
    const p: Record<string, any> = { ws: u.workspace_id };
    if (q.status === 'overdue') (where.push("status = 'open' AND due_at < $now"), (p.now = ctx.clock.now()));
    else if (q.status !== 'all') (where.push('status = $status'), (p.status = q.status));
    if (q.assignee === 'me') (where.push('assignee_id = $assignee'), (p.assignee = u.id));
    else if (q.assignee === 'unassigned') where.push('assignee_id IS NULL');
    else if (typeof q.assignee === 'number') (where.push('assignee_id = $assignee'), (p.assignee = q.assignee));
    if (q.campaignId) (where.push('campaign_id = $camp'), (p.camp = q.campaignId));
    if (q.leadId) (where.push('lead_id = $lead'), (p.lead = q.leadId));
    if (q.kind) (where.push('kind = $kind'), (p.kind = q.kind));
    const w = where.join(' AND ');
    // Open work by due date; finished work newest first.
    const order = q.status === 'open' || q.status === 'overdue' ? 'due_at, id' : "CASE WHEN status = 'open' THEN 0 ELSE 1 END, CASE WHEN status = 'open' THEN due_at ELSE -completed_at END, id DESC";
    const total = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE ${w}`, p)!.n;
    const rows = ctx.db.all<TaskRow>(`SELECT * FROM tasks WHERE ${w} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p);
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((t) => serializeTask(ctx, t)) };
  });

  app.get('/api/tasks/counts', async (req) => {
    const u = user(req);
    const { tz } = parse(z.object({ tz: z.string().max(64).refine(isValidTimezone, 'Unknown time zone').default('UTC') }), req.query);
    const now = ctx.clock.now();
    const r = ctx.db.get<{ open: number; dueToday: number; overdue: number; mine: number }>(
      `SELECT COUNT(*) AS open,
              SUM(CASE WHEN due_at < $end THEN 1 ELSE 0 END) AS "dueToday",
              SUM(CASE WHEN due_at < $now THEN 1 ELSE 0 END) AS overdue,
              SUM(CASE WHEN assignee_id = $me THEN 1 ELSE 0 END) AS mine
       FROM tasks WHERE workspace_id = $ws AND status = 'open'`,
      { ws: u.workspace_id, end: endOfDay(now, tz), now, me: u.id },
    )!;
    return { open: r.open, dueToday: r.dueToday ?? 0, overdue: r.overdue ?? 0, mine: r.mine ?? 0 };
  });

  // A one-off task for a lead, outside any campaign (it holds nothing).
  app.post('/api/tasks', async (req) => {
    const u = requireWriter(req);
    const body = parse(
      z.object({
        leadId: z.number().int().positive(),
        kind: z.enum(TASK_KINDS).default('custom'),
        title: z.string().trim().min(1).max(200),
        instructions: z.string().max(4000).default(''),
        dueAt: z.number().int().positive(),
        assigneeId: z.number().int().positive().nullable().optional(),
      }),
      req.body,
    );
    if (!ctx.db.get('SELECT 1 FROM leads WHERE id = ? AND workspace_id = ?', [body.leadId, u.workspace_id])) notFound('Lead');
    checkAssignee(u.workspace_id, body.assigneeId);
    const row = ctx.db.tx(() =>
      createTask(ctx, { workspaceId: u.workspace_id, leadId: body.leadId, kind: body.kind, title: body.title, instructions: body.instructions, dueAt: body.dueAt, assigneeId: body.assigneeId ?? null }),
    );
    return serializeTask(ctx, row);
  });

  app.patch('/api/tasks/:id', async (req) => {
    const u = requireWriter(req);
    const t = load(req);
    const body = parse(
      z.object({ title: z.string().trim().min(1).max(200), instructions: z.string().max(4000), dueAt: z.number().int().positive(), assigneeId: z.number().int().positive().nullable() }).partial(),
      req.body,
    );
    checkAssignee(u.workspace_id, body.assigneeId);
    const cols: Record<string, any> = {};
    if (body.title !== undefined) cols.title = body.title;
    if (body.instructions !== undefined) cols.instructions = body.instructions;
    if (body.assigneeId !== undefined) cols.assignee_id = body.assigneeId;
    if (body.dueAt !== undefined && t.status === 'open') {
      cols.due_at = body.dueAt;
      // Auto-skip counts from the due date, so it moves with it (and so does the held lead's deadline).
      if (t.auto_skip_at != null) cols.auto_skip_at = t.auto_skip_at + (body.dueAt - t.due_at);
    }
    ctx.db.tx(() => {
      ctx.db.update('tasks', t.id, cols);
      if (cols.auto_skip_at != null && t.campaign_lead_id != null) {
        ctx.db.run("UPDATE campaign_leads SET next_run_at = ? WHERE id = ? AND state = 'active' AND hold_reason = 'task' AND node_id = ?", [cols.auto_skip_at, t.campaign_lead_id, t.node_id]);
      }
    });
    return serializeTask(ctx, ctx.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', [t.id])!);
  });

  app.post('/api/tasks/:id/complete', async (req) => {
    const u = requireWriter(req);
    const t = load(req);
    const body = parse(z.object({ outcome: z.enum(CALL_OUTCOMES).nullable().optional(), notes: z.string().trim().max(4000).optional() }), req.body);
    if (t.status !== 'open') throw new HttpError(409, `This task is already ${t.status}`);
    return serializeTask(ctx, completeTask(ctx, t, u.id, { outcome: body.outcome ?? null, notes: body.notes || null }));
  });

  app.post('/api/tasks/:id/skip', async (req) => {
    const u = requireWriter(req);
    const t = load(req);
    const body = parse(z.object({ notes: z.string().trim().max(4000).optional() }), req.body);
    if (t.status !== 'open') throw new HttpError(409, `This task is already ${t.status}`);
    return serializeTask(ctx, skipTask(ctx, t, u.id, body.notes || null));
  });
}
