import { DAY, HOUR } from '../clock.js';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import type { SeqNode } from '../engine/sequence.js';
import { leadVars, render } from '../engine/template.js';
import type { CampaignLeadRow, CampaignRow, LeadRow, TaskRow } from '../types.js';
import { logActivity } from './activity.js';
import { roleIn } from './memberships.js';
import { publicLead } from './leads.js';
import { autoAdvance } from './pipeline.js';

// Tasks are to-dos for people: calls, manual LinkedIn or email touches. A `task` step creates one and holds the
// lead (hold_reason 'task') until it is completed or skipped; the lead then moves on. Manual tasks (no campaign)
// hold nothing.

export const CALL_OUTCOMES = ['connected', 'voicemail', 'no_answer', 'wrong_number', 'meeting_booked', 'not_interested', 'other'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

type TaskNode = Extract<SeqNode, { type: 'task' }>;

// Without auto-skip the hold is only a fallback wake-up; completing the task wakes the lead right away.
const NO_DEADLINE = 365 * DAY;

// Who can own leads and be assigned tasks: anyone who works in the workspace, including agency admins
// who reach a client through the agency. Clients (read-only portal users) can't.
export function isWorkspaceMember(ctx: Ctx, workspaceId: number, userId: number): boolean {
  const role = roleIn(ctx, userId, workspaceId);
  return !!role && role !== 'client';
}

// After someone loses access (removed, demoted, or no longer an agency admin), leads and tasks of the
// workspace, and of its clients when it is an agency, no longer point at them.
export function releaseAssignments(ctx: Ctx, userId: number, workspaceId: number) {
  const clients = ctx.db.all<{ id: number }>("SELECT id FROM workspaces WHERE parent_id = ? AND kind = 'client'", [workspaceId]).map((c) => c.id);
  for (const ws of [workspaceId, ...clients]) {
    if (isWorkspaceMember(ctx, ws, userId)) continue;
    ctx.db.run('UPDATE leads SET owner_id = NULL WHERE workspace_id = ? AND owner_id = ?', [ws, userId]);
    ctx.db.run('UPDATE tasks SET assignee_id = NULL WHERE workspace_id = ? AND assignee_id = ?', [ws, userId]);
  }
}

export function serializeTask(ctx: Ctx, t: TaskRow) {
  const lead = t.lead_id ? ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [t.lead_id]) : undefined;
  const assignee = t.assignee_id ? ctx.db.get<{ id: number; name: string }>('SELECT id, name FROM users WHERE id = ?', [t.assignee_id]) : undefined;
  const campaign = t.campaign_id ? ctx.db.get<{ id: number; name: string }>('SELECT id, name FROM campaigns WHERE id = ?', [t.campaign_id]) : undefined;
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    instructions: t.instructions,
    status: t.status,
    overdue: t.status === 'open' && t.due_at < ctx.clock.now(),
    dueAt: t.due_at,
    autoSkipAt: t.auto_skip_at,
    outcome: t.outcome,
    notes: t.notes,
    completedAt: t.completed_at,
    createdAt: t.created_at,
    nodeId: t.node_id,
    assignee: assignee ?? null,
    lead: lead
      ? { id: lead.id, name: `${lead.first_name} ${lead.last_name}`.trim() || 'Unnamed', profileUrl: lead.profile_url, phone: lead.phone, email: lead.email, company: lead.company, title: lead.title }
      : null,
    campaign: campaign ?? null,
  };
}

function emit(ctx: Ctx, event: 'task.created' | 'task.completed', t: TaskRow) {
  const lead = t.lead_id ? ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [t.lead_id]) : undefined;
  const { lead: _lead, ...task } = serializeTask(ctx, t);
  ctx.webhooks.emit(t.workspace_id, event, { task, lead: lead ? publicLead(lead, ctx) : null });
}

const loadTask = (ctx: Ctx, id: number) => ctx.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', [id])!;

export interface NewTask {
  workspaceId: number;
  leadId: number | null;
  kind: TaskRow['kind'];
  title: string;
  instructions?: string;
  dueAt: number;
  assigneeId?: number | null;
  autoSkipAt?: number | null;
  campaignId?: number | null;
  campaignLeadId?: number | null;
  nodeId?: string | null;
}

export function createTask(ctx: Ctx, t: NewTask): TaskRow {
  // A member removed since the step was saved can't be assigned; the task is then unassigned.
  const assignee = t.assigneeId != null && isWorkspaceMember(ctx, t.workspaceId, t.assigneeId) ? t.assigneeId : null;
  const id = ctx.db.insert('tasks', {
    workspace_id: t.workspaceId,
    campaign_id: t.campaignId ?? null,
    campaign_lead_id: t.campaignLeadId ?? null,
    lead_id: t.leadId,
    node_id: t.nodeId ?? null,
    kind: t.kind,
    title: t.title.slice(0, 200),
    instructions: (t.instructions ?? '').slice(0, 4000),
    assignee_id: assignee,
    status: 'open',
    due_at: t.dueAt,
    auto_skip_at: t.autoSkipAt ?? null,
    created_at: ctx.clock.now(),
  });
  const row = loadTask(ctx, id);
  logActivity(ctx, { workspaceId: t.workspaceId, campaignId: t.campaignId, leadId: t.leadId, type: 'task_created', detail: row.title, nodeId: t.nodeId });
  emit(ctx, 'task.created', row);
  return row;
}

// The engine's handling of a task step (see Engine.walk): 'next' when the lead may move on, 'hold' when it waits.
// Spurious wake-ups (sequence edits, syncs) land here too, so an open task is re-held, never created twice.
export function taskGate(ctx: Ctx, campaign: CampaignRow, job: CampaignLeadRow, node: TaskNode): 'next' | 'hold' {
  const now = ctx.clock.now();
  let task = ctx.db.get<TaskRow>('SELECT * FROM tasks WHERE campaign_lead_id = ? AND node_id = ?', [job.id, node.id]);
  if (!task) {
    const lead = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [job.lead_id])!;
    const vars = leadVars({ ...lead, custom: json(lead.custom, {}) });
    const dueAt = now + Math.round(node.dueAfterHours * HOUR);
    task = createTask(ctx, {
      workspaceId: campaign.workspace_id,
      leadId: lead.id,
      kind: node.kind,
      title: render(node.title, vars, ctx.random) || node.title,
      instructions: render(node.instructions, vars, ctx.random),
      dueAt,
      assigneeId: node.assigneeId,
      autoSkipAt: node.autoSkipAfterDays ? dueAt + node.autoSkipAfterDays * DAY : null,
      campaignId: campaign.id,
      campaignLeadId: job.id,
      nodeId: node.id,
    });
  }
  if (task.status !== 'open') {
    if (job.hold_reason === 'task') ctx.db.update('campaign_leads', job.id, { hold_reason: null });
    return 'next';
  }
  if (task.auto_skip_at != null && now >= task.auto_skip_at) {
    const days = node.autoSkipAfterDays ?? Math.round((task.auto_skip_at - task.due_at) / DAY);
    closeTask(ctx, task, 'skipped', { notes: `Skipped automatically after ${days} day${days === 1 ? '' : 's'}` });
    ctx.db.update('campaign_leads', job.id, { hold_reason: null });
    return 'next';
  }
  ctx.db.update('campaign_leads', job.id, { hold_reason: 'task', next_run_at: task.auto_skip_at ?? now + NO_DEADLINE });
  return 'hold';
}

function closeTask(ctx: Ctx, task: TaskRow, status: 'done' | 'skipped', o: { by?: number | null; outcome?: string | null; notes?: string | null }): TaskRow {
  const now = ctx.clock.now();
  const r = ctx.db.run("UPDATE tasks SET status = ?, outcome = ?, notes = ?, completed_by = ?, completed_at = ? WHERE id = ? AND status = 'open'", [
    status,
    o.outcome ?? null,
    o.notes ?? task.notes,
    o.by ?? null,
    now,
    task.id,
  ]);
  const row = loadTask(ctx, task.id);
  if (!r.changes) return row;
  const detail = [status === 'done' ? row.title : `${row.title} (skipped)`, o.outcome ? o.outcome.replace(/_/g, ' ') : null, o.notes].filter(Boolean).join(' · ');
  logActivity(ctx, { workspaceId: row.workspace_id, campaignId: row.campaign_id, leadId: row.lead_id, type: status === 'done' ? 'task_done' : 'task_skipped', detail: detail.slice(0, 500), nodeId: row.node_id });
  emit(ctx, 'task.completed', row);
  if (status === 'done' && row.outcome === 'meeting_booked' && row.lead_id != null) autoAdvance(ctx, row.lead_id, 'meeting', `Task "${row.title}": meeting booked`);
  return row;
}

// Completing or skipping a task wakes its lead, which then moves past the task step.
function wake(ctx: Ctx, task: TaskRow) {
  if (task.campaign_lead_id == null) return;
  ctx.db.run("UPDATE campaign_leads SET hold_reason = NULL, next_run_at = ? WHERE id = ? AND state = 'active' AND node_id = ? AND hold_reason = 'task'", [
    ctx.clock.now(),
    task.campaign_lead_id,
    task.node_id,
  ]);
}

export function completeTask(ctx: Ctx, task: TaskRow, by: number | null, o: { outcome?: CallOutcome | null; notes?: string | null } = {}): TaskRow {
  return ctx.db.tx(() => {
    const row = closeTask(ctx, task, 'done', { by, outcome: o.outcome ?? null, notes: o.notes ?? null });
    wake(ctx, row);
    return row;
  });
}

export function skipTask(ctx: Ctx, task: TaskRow, by: number | null, notes?: string | null): TaskRow {
  return ctx.db.tx(() => {
    const row = closeTask(ctx, task, 'skipped', { by, notes: notes ?? null });
    wake(ctx, row);
    return row;
  });
}

// A lead leaving its campaign (replied, suppressed, finished, removed step) leaves no task behind.
export function skipOpenTasks(ctx: Ctx, campaignLeadId: number, note: string) {
  const open = ctx.db.all<TaskRow>("SELECT * FROM tasks WHERE campaign_lead_id = ? AND status = 'open'", [campaignLeadId]);
  for (const t of open) closeTask(ctx, t, 'skipped', { notes: note });
}

// For bulk stops that update campaign leads in one statement (a removed sender account or mailbox).
export function skipTasksOfStoppedLeads(ctx: Ctx, workspaceId: number, note: string) {
  const open = ctx.db.all<TaskRow>(
    "SELECT t.* FROM tasks t JOIN campaign_leads cl ON cl.id = t.campaign_lead_id WHERE t.workspace_id = ? AND t.status = 'open' AND cl.state <> 'active'",
    [workspaceId],
  );
  for (const t of open) closeTask(ctx, t, 'skipped', { notes: note });
}
