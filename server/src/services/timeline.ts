import type { Ctx } from '../context.js';

// One newest-first timeline per lead, merged from activity, inbound messages (every channel), notes,
// stage changes and tasks. Outbound messages are left out because each send already has an activity
// row, and so are the activity rows that only repeat a reply or a task shown here.
//
// Paging uses a cursor "at.rank.id": items sort by time, then by kind rank, then by id, all descending,
// so items logged in the same millisecond are neither repeated nor skipped across pages.

const RANK = { stage: 5, note: 4, task: 3, message: 2, activity: 1 } as const;
export type TimelineKind = keyof typeof RANK;

interface Cursor {
  at: number;
  rank: number;
  id: number;
}

export function parseCursor(s: string | undefined): Cursor | null {
  const m = /^(\d+)\.(\d)\.(\d+)$/.exec(s ?? '');
  return m ? { at: Number(m[1]), rank: Number(m[2]), id: Number(m[3]) } : null;
}

// "Older than the cursor" for one source, whose items all share `rank`.
function older(c: Cursor | null, rank: number, at: string, id: string): string {
  if (!c) return '1 = 1';
  if (rank < c.rank) return `${at} <= ${c.at}`;
  if (rank > c.rank) return `${at} < ${c.at}`;
  return `(${at} < ${c.at} OR (${at} = ${c.at} AND ${id} < ${c.id}))`;
}

export interface TimelineItem {
  kind: TimelineKind;
  id: number;
  at: number;
  [k: string]: unknown;
}

export function leadTimeline(ctx: Ctx, ws: number, leadId: number, opts: { before?: string; limit: number }) {
  const c = parseCursor(opts.before);
  const n = opts.limit + 1;
  const p = [leadId, ws, n];
  const items: TimelineItem[] = [
    ...ctx.db
      .all(
        `SELECT a.id, a.created_at AS at, a.type, a.status, a.detail, a.variant, a.campaign_id AS "campaignId", c.name AS "campaignName"
         FROM activity a LEFT JOIN campaigns c ON c.id = a.campaign_id
         WHERE a.lead_id = ? AND a.workspace_id = ? AND a.type NOT IN ('replied', 'task_created') AND ${older(c, RANK.activity, 'a.created_at', 'a.id')}
         ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
        p,
      )
      .map((r) => ({ kind: 'activity' as const, ...r }) as TimelineItem),
    ...ctx.db
      .all(
        `SELECT m.id, m.sent_at AS at, m.body, m.category, c.channel, c.id AS "conversationId"
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.lead_id = ? AND c.workspace_id = ? AND m.direction = 'in' AND ${older(c, RANK.message, 'm.sent_at', 'm.id')}
         ORDER BY m.sent_at DESC, m.id DESC LIMIT ?`,
        p,
      )
      .map((r) => ({ kind: 'message' as const, ...r }) as TimelineItem),
    ...ctx.db
      .all(
        `SELECT n.id, n.created_at AS at, n.body, n.user_id AS "userId", u.name AS "authorName", n.updated_at AS "updatedAt"
         FROM lead_notes n LEFT JOIN users u ON u.id = n.user_id
         WHERE n.lead_id = ? AND n.workspace_id = ? AND ${older(c, RANK.note, 'n.created_at', 'n.id')}
         ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
        p,
      )
      .map((r) => ({ kind: 'note' as const, ...r }) as TimelineItem),
    ...ctx.db
      .all(
        `SELECT h.id, h.created_at AS at, h.source, h.reason, fs.name AS "fromName", ts.name AS "toName", ts.color AS "toColor", u.name AS "userName"
         FROM lead_stage_history h LEFT JOIN pipeline_stages fs ON fs.id = h.from_stage_id LEFT JOIN pipeline_stages ts ON ts.id = h.to_stage_id LEFT JOIN users u ON u.id = h.user_id
         WHERE h.lead_id = ? AND h.workspace_id = ? AND ${older(c, RANK.stage, 'h.created_at', 'h.id')}
         ORDER BY h.created_at DESC, h.id DESC LIMIT ?`,
        p,
      )
      .map((r) => ({ kind: 'stage' as const, ...r }) as TimelineItem),
    ...ctx.db
      .all(
        `SELECT t.id, t.created_at AS at, t.kind AS "taskKind", t.title, t.status, t.outcome, t.due_at AS "dueAt", t.completed_at AS "completedAt", u.name AS "assigneeName"
         FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
         WHERE t.lead_id = ? AND t.workspace_id = ? AND ${older(c, RANK.task, 't.created_at', 't.id')}
         ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
        p,
      )
      .map((r) => ({ kind: 'task' as const, ...r }) as TimelineItem),
  ];
  items.sort((a, b) => b.at - a.at || RANK[b.kind] - RANK[a.kind] || b.id - a.id);
  const page = items.slice(0, opts.limit);
  const last = page[page.length - 1];
  return { items: page, nextBefore: items.length > opts.limit && last ? `${last.at}.${RANK[last.kind]}.${last.id}` : null };
}
