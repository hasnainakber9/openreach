import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { SUGGESTED_STAGE, type ReplyCategory } from '../ai/categories.js';
import type { Ctx } from '../context.js';
import type { SqlValue } from '../db/database.js';
import type { LeadRow, StageKind, StageRow } from '../types.js';
import { CONTACT_ACTIVITY_TYPES } from './activity.js';
import { publicLead } from './leads.js';
import { getSetting } from './settings.js';

// Pipeline stages per workspace. A lead's stage_id NULL means the first stage, so new leads need no
// write. Automation finds stages by slug (renaming keeps the slug) and only ever moves a lead forward.
// The first stage is always an open one: new leads start there, and automation can't move them out
// of a won/lost stage.

export const STAGE_KINDS = ['open', 'won', 'lost'] as const;
export type StageSource = 'manual' | 'auto' | 'api';

export const DEFAULT_STAGES: { slug: string; name: string; color: string; kind: StageKind }[] = [
  { slug: 'new', name: 'New', color: '#64748b', kind: 'open' },
  { slug: 'contacted', name: 'Contacted', color: '#3b82f6', kind: 'open' },
  { slug: 'replied', name: 'Replied', color: '#8b5cf6', kind: 'open' },
  { slug: 'interested', name: 'Interested', color: '#f59e0b', kind: 'open' },
  { slug: 'meeting', name: 'Meeting booked', color: '#10b981', kind: 'open' },
  { slug: 'won', name: 'Won', color: '#16a34a', kind: 'won' },
  { slug: 'lost', name: 'Lost', color: '#ef4444', kind: 'lost' },
];

export const PipelineSettingsSchema = z
  .object({
    // A "not interested" reply moves the lead to Lost. Off by default: a polite "not now" is easy to misread.
    autoLost: z.boolean().default(false),
  })
  .default({});
export type PipelineSettings = z.infer<typeof PipelineSettingsSchema>;
export const pipelineSettings = (ctx: Ctx, ws: number) => getSetting(ctx, ws, 'pipeline', PipelineSettingsSchema);

// Workspaces made by direct inserts (seed, tests, older code paths) have no stages yet, so every pipeline
// read and write calls this first. A workspace with any stage is left alone (the last stage can't be deleted).
export function ensureStages(ctx: Ctx, ws: number) {
  if (ctx.db.get('SELECT 1 FROM pipeline_stages WHERE workspace_id = ? LIMIT 1', [ws])) return;
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    DEFAULT_STAGES.forEach((s, i) =>
      ctx.db.run(
        'INSERT INTO pipeline_stages (workspace_id, slug, name, color, position, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, slug) DO NOTHING',
        [ws, s.slug, s.name, s.color, i, s.kind, now],
      ),
    );
  });
}

export function listStages(ctx: Ctx, ws: number): StageRow[] {
  ensureStages(ctx, ws);
  return ctx.db.all<StageRow>('SELECT * FROM pipeline_stages WHERE workspace_id = ? ORDER BY position, id', [ws]);
}

export const findStage = (ctx: Ctx, ws: number, id: number) => ctx.db.get<StageRow>('SELECT * FROM pipeline_stages WHERE id = ? AND workspace_id = ?', [id, ws]);

// The stage a lead is in: its own, or the first stage when it has none (or its stage was deleted).
export function effectiveStage(stages: StageRow[], stageId: number | null): StageRow | undefined {
  return stages.find((s) => s.id === stageId) ?? stages[0];
}

export function stageOf(ctx: Ctx, lead: Pick<LeadRow, 'workspace_id' | 'stage_id'>): StageRow | undefined {
  return effectiveStage(listStages(ctx, lead.workspace_id), lead.stage_id);
}

export function serializeStage(s: StageRow) {
  return { id: s.id, slug: s.slug, name: s.name, color: s.color, position: s.position, kind: s.kind };
}

export const stageRef = (s: StageRow | undefined) => (s ? { id: s.id, slug: s.slug, name: s.name } : null);

export interface StageChange {
  source: StageSource;
  userId?: number | null;
  reason?: string | null;
}

// Moves a lead to a stage: history row, manual flag, lead.stage_changed. Returns false when it is already there.
export function setStage(ctx: Ctx, lead: LeadRow, stageId: number, o: StageChange): boolean {
  const stages = listStages(ctx, lead.workspace_id);
  const to = stages.find((s) => s.id === stageId);
  if (!to) return false;
  const from = effectiveStage(stages, lead.stage_id);
  if (from?.id === to.id && lead.stage_id === to.id) return false;
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    ctx.db.update('leads', lead.id, { stage_id: to.id, stage_changed_at: now, stage_manual: o.source === 'manual' ? 1 : 0 });
    // A lead on the first stage by default that is "moved" there only gets the explicit id, not a history row.
    if (from?.id !== to.id) {
      ctx.db.insert('lead_stage_history', {
        workspace_id: lead.workspace_id,
        lead_id: lead.id,
        from_stage_id: from?.id ?? null,
        to_stage_id: to.id,
        source: o.source,
        reason: o.reason?.slice(0, 300) ?? null,
        user_id: o.userId ?? null,
        created_at: now,
      });
    }
  });
  if (from?.id === to.id) return false;
  const updated = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [lead.id])!;
  const data = { lead: publicLead(updated, ctx), from: stageRef(from), to: stageRef(to), source: o.source, reason: o.reason ?? null };
  // Often called inside a caller's transaction (an engine step, a bulk edit): announce only once it commits.
  ctx.db.afterCommit(() => ctx.webhooks.emit(lead.workspace_id, 'lead.stage_changed', data));
  return true;
}

// How many lead ids a leads.stage_changed event lists; `count` always has the full number.
export const BULK_EVENT_MAX_IDS = 1000;

// Moves many leads at once (deleting a stage, the bulk edit) with one history INSERT and one UPDATE instead
// of setStage per lead, which on a big stage held the server for minutes, and announces it with a single
// leads.stage_changed event. Same rules as setStage: a lead's current stage is its own or the first one;
// leads already there get the explicit id but no history row. `where` picks leads by plain column names
// (the caller has made it safe: its numbers are ids, never user text). Returns the lead ids that moved.
export function moveLeadsToStage(ctx: Ctx, ws: number, to: StageRow, where: { sql: string; params: SqlValue[] }, o: StageChange & { from?: StageRow }): number[] {
  const stages = listStages(ctx, ws);
  if (!stages.some((s) => s.id === to.id)) return [];
  const ids = stages.map((s) => Number(s.id)).join(',');
  const current = `CASE WHEN stage_id IN (${ids}) THEN stage_id ELSE ${Number(stages[0].id)} END`;
  const now = ctx.clock.now();
  const moved = ctx.db.tx(() => {
    // Typed parameters: Postgres can't infer a type for a bare parameter in an INSERT's SELECT list.
    const rows = ctx.db.all<{ id: number; lead_id: number }>(
      `INSERT INTO lead_stage_history (workspace_id, lead_id, from_stage_id, to_stage_id, source, reason, user_id, created_at)
       SELECT workspace_id, id, ${current}, CAST(? AS BIGINT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS BIGINT), CAST(? AS BIGINT)
       FROM leads WHERE workspace_id = ? AND (${where.sql}) AND ${current} <> ? RETURNING id, lead_id`,
      [to.id, o.source, o.reason?.slice(0, 300) ?? null, o.userId ?? null, now, ws, ...where.params, to.id],
    );
    ctx.db.run(`UPDATE leads SET stage_id = ?, stage_changed_at = ?, stage_manual = ? WHERE workspace_id = ? AND (${where.sql}) AND (stage_id IS NULL OR stage_id <> ?)`, [
      to.id,
      now,
      o.source === 'manual' ? 1 : 0,
      ws,
      ...where.params,
      to.id,
    ]);
    return rows;
  });
  if (!moved.length) return [];
  const leadIds = moved.map((r) => r.lead_id).sort((a, b) => a - b);
  const data = { count: leadIds.length, leadIds: leadIds.slice(0, BULK_EVENT_MAX_IDS), from: stageRef(o.from), to: stageRef(to), source: o.source, reason: o.reason ?? null };
  // Webhooks get the summary; in-process subscribers (CRM sync) also get every history row.
  const changes = moved.map((r) => ({ leadId: r.lead_id, historyId: r.id }));
  ctx.db.afterCommit(() => ctx.webhooks.emit(ws, 'leads.stage_changed', data, { changes }));
  return leadIds;
}

// Automation: moves a lead to the stage with `slug`, but only forward (by position), never out of a
// won/lost stage, and not at all when the workspace deleted that stage. A manual stage is kept unless
// the automatic one is further along.
export function autoAdvance(ctx: Ctx, leadOrId: LeadRow | number, slug: string, reason: string): boolean {
  const lead = typeof leadOrId === 'number' ? ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [leadOrId]) : leadOrId;
  if (!lead) return false;
  const stages = listStages(ctx, lead.workspace_id);
  const target = stages.find((s) => s.slug === slug);
  const current = effectiveStage(stages, lead.stage_id);
  if (!target || !current) return false;
  if (current.kind !== 'open') return false;
  if (target.position <= current.position) return false;
  return setStage(ctx, lead, target.id, { source: 'auto', reason });
}

// Hook for logActivity: the first successful outreach moves the lead to Contacted.
export function advanceOnActivity(ctx: Ctx, a: { leadId?: number | null; type: string; status?: string }) {
  if (a.leadId == null || (a.status ?? 'ok') !== 'ok') return;
  if (!(CONTACT_ACTIVITY_TYPES as readonly string[]).includes(a.type)) return;
  const lead = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [a.leadId]);
  if (!lead) return;
  autoAdvance(ctx, lead, 'contacted', `First ${a.type === 'connect' ? 'invitation' : a.type} sent`);
}

// The stage a reply category moves the lead to, if any (Lost only when the workspace turned that on).
export function stageForCategory(ctx: Ctx, ws: number, category: ReplyCategory): string | null {
  const slug = SUGGESTED_STAGE[category];
  if (!slug) return null;
  if (slug === 'lost' && !pipelineSettings(ctx, ws).autoLost) return null;
  return slug;
}

export function newStageSlug() {
  return `custom-${randomBytes(4).toString('hex')}`;
}

// Gives leads that are in the first stage only by default (no stage, or a deleted one) that stage
// explicitly. Run before another stage becomes first, so a reorder never moves leads behind their backs.
export function pinUnstaged(ctx: Ctx, ws: number, stages: StageRow[]): number {
  const first = stages[0];
  if (!first) return 0;
  return ctx.db.run(`UPDATE leads SET stage_id = ? WHERE workspace_id = ? AND (stage_id IS NULL OR stage_id NOT IN (${stages.map((s) => Number(s.id)).join(',')}))`, [first.id, ws]).changes;
}

export const FIRST_STAGE_OPEN = 'The first stage must be an in-progress stage: new leads start there';

// Renumbers positions 0..n-1 in the given order.
export function writeOrder(ctx: Ctx, ws: number, ids: number[]) {
  ctx.db.tx(() => ids.forEach((id, i) => ctx.db.run('UPDATE pipeline_stages SET position = ? WHERE id = ? AND workspace_id = ?', [i, id, ws])));
}

// Deletes a stage after moving its leads (history rows and one leads.stage_changed event) to another one.
export function deleteStage(ctx: Ctx, ws: number, stage: StageRow, moveTo: StageRow, userId: number | null): number {
  const stages = listStages(ctx, ws);
  const first = stages[0];
  // The first stage also holds leads without one (or with a deleted one).
  const sql = `stage_id = ?${first.id === stage.id ? ' OR stage_id IS NULL OR stage_id NOT IN (SELECT id FROM pipeline_stages WHERE workspace_id = leads.workspace_id)' : ''}`;
  return ctx.db.tx(() => {
    const moved = moveLeadsToStage(ctx, ws, moveTo, { sql, params: [stage.id] }, { source: 'manual', userId, reason: `Stage "${stage.name}" was deleted`, from: stage });
    ctx.db.run('DELETE FROM pipeline_stages WHERE id = ? AND workspace_id = ?', [stage.id, ws]);
    writeOrder(
      ctx,
      ws,
      stages.filter((s) => s.id !== stage.id).map((s) => s.id),
    );
    return moved.length;
  });
}

// SQL for "the lead is in this stage" (the first stage also holds leads without one).
export function stageWhere(stages: StageRow[], stageId: number, col = 'l.stage_id'): string {
  const first = stages[0];
  const id = Number(stageId);
  if (first && first.id === id) return `(${col} = ${id} OR ${col} IS NULL OR ${col} NOT IN (${stages.map((s) => s.id).join(',')}))`;
  return `${col} = ${id}`;
}
