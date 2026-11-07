import { DAY } from '../clock.js';
import type { Ctx } from '../context.js';
import { discardAccountBrowser } from '../drivers/browser-login.js';
import { contactTypesSql } from './activity.js';
import type { WorkspaceRow } from './memberships.js';
import { ensureStages } from './pipeline.js';

// Client workspaces of an agency. No memberships are copied: the agency's owners and admins reach
// them through parent_id (see memberships.ts).
export function createClientWorkspace(ctx: Ctx, agencyId: number, name: string): number {
  return ctx.db.tx(() => {
    const id = ctx.db.insert('workspaces', { name, kind: 'client', parent_id: agencyId, created_at: ctx.clock.now() });
    ensureStages(ctx, id);
    return id;
  });
}

export const clientsOf = (ctx: Ctx, agencyId: number) =>
  ctx.db.all<WorkspaceRow>("SELECT * FROM workspaces WHERE parent_id = ? AND kind = 'client' ORDER BY name, id", [agencyId]);

// Deletes a workspace and everything in it, in one transaction. Members whose home it was move to
// another workspace of theirs; users with no other membership are deleted with it.
export async function deleteWorkspace(ctx: Ctx, id: number) {
  const accounts = ctx.db.all<{ id: number }>('SELECT id FROM accounts WHERE workspace_id = ?', [id]).map((a) => a.id);
  ctx.db.tx(() => {
    for (const u of ctx.db.all<{ id: number }>('SELECT id FROM users WHERE workspace_id = ?', [id])) {
      const other = ctx.db.get<{ workspace_id: number }>('SELECT workspace_id FROM memberships WHERE user_id = ? AND workspace_id <> ? ORDER BY workspace_id LIMIT 1', [u.id, id]);
      if (other) ctx.db.run('UPDATE users SET workspace_id = ? WHERE id = ?', [other.workspace_id, u.id]);
    }
    // Sessions inside it go back to their home workspace instead of being signed out.
    ctx.db.run('UPDATE sessions SET workspace_id = NULL WHERE workspace_id = ?', [id]);
    // Tables that carry workspace_id (or an account id) without a foreign key don't cascade.
    ctx.db.run('DELETE FROM sim_people WHERE account_id IN (SELECT id FROM accounts WHERE workspace_id = ?)', [id]);
    ctx.db.run('DELETE FROM activity WHERE workspace_id = ?', [id]);
    ctx.db.run('DELETE FROM conversations WHERE workspace_id = ?', [id]);
    ctx.db.run('DELETE FROM imports WHERE workspace_id = ?', [id]);
    ctx.db.run('DELETE FROM workspaces WHERE id = ?', [id]);
  });
  // Close any browser or sign-in window the deleted accounts had open, and remove their browser profiles.
  await Promise.all(accounts.map((a) => discardAccountBrowser(ctx, a)));
}

export interface ClientOverview {
  id: number;
  name: string;
  createdAt: number;
  accounts: number;
  accountsNeedingAttention: number;
  mailboxesNeedingAttention: number;
  activeCampaigns: number;
  contacted: number;
  replies: number;
  meetings: number;
  replyRate: number;
  lastActivityAt: number | null;
}

// Per client over the last `days`: leads contacted, leads that replied, meetings booked (a
// meeting_booked reply or a move to the "meeting" stage), plus what needs a look.
export function agencyOverview(ctx: Ctx, agencyId: number, days: number): ClientOverview[] {
  const since = ctx.clock.now() - days * DAY;
  return clientsOf(ctx, agencyId).map((c) => {
    const one = (sql: string, params: (string | number)[] = [c.id]) => ctx.db.get<{ n: number | null }>(sql, params)?.n ?? 0;
    const accounts = ctx.db.get<{ total: number; attention: number | null }>(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status NOT IN ('active', 'paused') THEN 1 ELSE 0 END) AS attention FROM accounts WHERE workspace_id = ?",
      [c.id],
    )!;
    const contacted = one(`SELECT COUNT(DISTINCT lead_id) AS n FROM activity WHERE workspace_id = ? AND status = 'ok' AND created_at >= ? AND type IN (${contactTypesSql()})`, [c.id, since]);
    const replies = one("SELECT COUNT(DISTINCT lead_id) AS n FROM activity WHERE workspace_id = ? AND status = 'ok' AND created_at >= ? AND type = 'replied'", [c.id, since]);
    const meetings = one(
      `SELECT COUNT(*) AS n FROM leads l WHERE l.workspace_id = ? AND (
         (l.reply_category = 'meeting_booked' AND l.reply_category_at >= ?)
         OR (l.stage_changed_at >= ? AND l.stage_id IN (SELECT s.id FROM pipeline_stages s WHERE s.workspace_id = l.workspace_id AND s.slug = 'meeting')))`,
      [c.id, since, since],
    );
    return {
      id: c.id,
      name: c.name,
      createdAt: c.created_at,
      accounts: accounts.total,
      accountsNeedingAttention: accounts.attention ?? 0,
      mailboxesNeedingAttention: one("SELECT COUNT(*) AS n FROM mailboxes WHERE workspace_id = ? AND status = 'needs_attention'"),
      activeCampaigns: one("SELECT COUNT(*) AS n FROM campaigns WHERE workspace_id = ? AND status = 'active'"),
      contacted,
      replies,
      meetings,
      replyRate: contacted ? Math.round((replies / contacted) * 1000) / 10 : 0,
      lastActivityAt: ctx.db.get<{ t: number | null }>('SELECT MAX(created_at) AS t FROM activity WHERE workspace_id = ?', [c.id])?.t ?? null,
    };
  });
}
