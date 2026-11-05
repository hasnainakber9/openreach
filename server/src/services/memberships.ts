import type { Ctx } from '../context.js';
import type { Role, SessionUser } from '../http.js';

// A user belongs to workspaces through memberships, each with its own role. users.workspace_id is the
// "home" workspace (where a session starts); a session can switch to any workspace the user can reach.
// Owners and admins of an agency reach its client workspaces with the same role. That right is
// inherited at request time, never copied, so removing someone from the agency removes it everywhere.

export const ROLES = ['owner', 'admin', 'member', 'client'] as const satisfies readonly Role[];
export type WorkspaceKind = 'standard' | 'agency' | 'client';

export interface WorkspaceRow {
  id: number;
  name: string;
  kind: WorkspaceKind;
  parent_id: number | null;
  created_at: number;
}

export const workspaceRow = (ctx: Ctx, id: number) => ctx.db.get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', [id]);
const adminRole = (r: string | null | undefined): r is 'owner' | 'admin' => r === 'owner' || r === 'admin';

export function directRole(ctx: Ctx, userId: number, workspaceId: number): Role | null {
  return ctx.db.get<{ role: Role }>('SELECT role FROM memberships WHERE user_id = ? AND workspace_id = ?', [userId, workspaceId])?.role ?? null;
}

// Higher wins when a user has both a membership of their own and a role inherited from the agency.
const RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, client: 0 };
export const higherRole = (a: Role | null, b: Role | null): Role | null => (!a ? b : !b ? a : RANK[a] >= RANK[b] ? a : b);

// Owner/admin inherited from the agency that runs this client workspace, if any.
export function inheritedRole(ctx: Ctx, userId: number, workspaceId: number): 'owner' | 'admin' | null {
  const w = workspaceRow(ctx, workspaceId);
  if (!w || w.kind !== 'client' || !w.parent_id) return null;
  const parent = workspaceRow(ctx, w.parent_id);
  if (parent?.kind !== 'agency') return null;
  const r = directRole(ctx, userId, parent.id);
  return adminRole(r) ? r : null;
}

// The user's role in a workspace: the higher of their own membership and what the agency gives them,
// so a direct 'member' row (an invite accepted by an agency admin) never demotes them.
export function roleIn(ctx: Ctx, userId: number, workspaceId: number): Role | null {
  return higherRole(directRole(ctx, userId, workspaceId), inheritedRole(ctx, userId, workspaceId));
}

export function addMembership(ctx: Ctx, userId: number, workspaceId: number, role: Role) {
  ctx.db.run('INSERT INTO memberships (user_id, workspace_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, workspace_id) DO NOTHING', [
    userId,
    workspaceId,
    role,
    ctx.clock.now(),
  ]);
}

// Users written straight into the table (older seed scripts, tests) have no membership yet; their
// home workspace and legacy role become one the first time they sign in.
export function ensureLegacyMembership(ctx: Ctx, userId: number) {
  ctx.db.run(
    `INSERT INTO memberships (user_id, workspace_id, role, created_at)
     SELECT id, workspace_id, role, created_at FROM users
     WHERE id = ? AND workspace_id IN (SELECT id FROM workspaces) AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = ?)
     ON CONFLICT (user_id, workspace_id) DO NOTHING`,
    [userId, userId],
  );
}

// The signed-in user for a session token, acting in the session's active workspace. If that workspace
// is no longer reachable (membership removed, client deleted), the session falls back to the home
// workspace, then to any membership; with none left it is signed out.
export function resolveSession(ctx: Ctx, token: string | undefined): SessionUser | null {
  if (!token) return null;
  const s = ctx.db.get<{ active: number | null; id: number; home: number; name: string; email: string }>(
    'SELECT s.workspace_id AS active, u.id, u.workspace_id AS home, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?',
    [token, Date.now()],
  );
  if (!s) return null;
  const wanted = s.active ?? s.home;
  let ws = wanted;
  let role = roleIn(ctx, s.id, ws);
  if (!role && ws !== s.home) role = roleIn(ctx, s.id, (ws = s.home));
  if (!role) {
    const first = ctx.db.get<{ workspace_id: number; role: Role }>('SELECT workspace_id, role FROM memberships WHERE user_id = ? ORDER BY workspace_id LIMIT 1', [s.id]);
    if (!first) return null;
    ({ workspace_id: ws, role } = first);
  }
  if (ws !== wanted) ctx.db.run('UPDATE sessions SET workspace_id = ? WHERE token = ?', [ws === s.home ? null : ws, token]);
  return { id: s.id, workspace_id: ws, role: role!, name: s.name, email: s.email };
}

export interface WorkspaceListItem {
  id: number;
  name: string;
  kind: WorkspaceKind;
  role: Role;
  parentId: number | null;
  parentName: string | null;
  // Reached through the agency rather than a membership of its own.
  inherited: boolean;
}

// Direct memberships plus the clients of agencies the user runs; agencies are followed by their clients.
export function listWorkspaces(ctx: Ctx, userId: number): WorkspaceListItem[] {
  const direct = ctx.db.all<WorkspaceRow & { role: Role; parent_name: string | null }>(
    'SELECT w.*, m.role, p.name AS parent_name FROM memberships m JOIN workspaces w ON w.id = m.workspace_id LEFT JOIN workspaces p ON p.id = w.parent_id WHERE m.user_id = ?',
    [userId],
  );
  const out = new Map<number, WorkspaceListItem>();
  const item = (w: WorkspaceRow, role: Role, parentName: string | null, inherited: boolean): WorkspaceListItem => ({
    id: w.id,
    name: w.name,
    kind: w.kind,
    role,
    parentId: w.parent_id,
    parentName,
    inherited,
  });
  for (const w of direct) out.set(w.id, item(w, w.role, w.parent_name, false));
  for (const a of direct.filter((w) => w.kind === 'agency' && adminRole(w.role))) {
    for (const c of ctx.db.all<WorkspaceRow>("SELECT * FROM workspaces WHERE parent_id = ? AND kind = 'client'", [a.id])) {
      const own = out.get(c.id);
      // Same rule as roleIn: a lower membership of its own doesn't hide the agency role.
      if (!own) out.set(c.id, item(c, a.role, a.name, true));
      else own.role = higherRole(own.role, a.role)!;
    }
  }
  const groupOf = (w: WorkspaceListItem) => (w.kind === 'client' && w.parentId && out.has(w.parentId) ? w.parentId : w.id);
  return [...out.values()].sort((a, b) => {
    const ga = out.get(groupOf(a))!.name;
    const gb = out.get(groupOf(b))!.name;
    if (groupOf(a) !== groupOf(b)) return ga.localeCompare(gb) || groupOf(a) - groupOf(b);
    if (groupOf(a) === a.id) return -1;
    if (groupOf(b) === b.id) return 1;
    return a.name.localeCompare(b.name) || a.id - b.id;
  });
}

// The agency the user runs from the active workspace: the agency itself, or the parent of a client.
export function agencyOf(ctx: Ctx, u: SessionUser): WorkspaceRow | null {
  const w = workspaceRow(ctx, u.workspace_id);
  if (!w) return null;
  const agency = w.kind === 'agency' ? w : w.kind === 'client' && w.parent_id ? workspaceRow(ctx, w.parent_id) : undefined;
  if (!agency || agency.kind !== 'agency') return null;
  return adminRole(directRole(ctx, u.id, agency.id)) ? agency : null;
}

// Number of direct owners; a workspace always keeps at least one.
export const ownerCount = (ctx: Ctx, workspaceId: number) =>
  ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND role = 'owner'", [workspaceId])!.n;
