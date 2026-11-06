import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { assertWithinPlan, billingEnabled, billingRoot, seatsNeeded, withPlanLock } from '../billing/limits.js';
import { DAY } from '../clock.js';
import type { Ctx } from '../context.js';
import { timingSafeEqual } from 'node:crypto';
import { hashPassword, token, verifyPassword } from '../services/crypto.js';
import { addMembership, agencyOf, directRole, ensureLegacyMembership, ownerCount, resolveSession, ROLES, workspaceRow } from '../services/memberships.js';
import { ensureStages } from '../services/pipeline.js';
import { releaseAssignments } from '../services/tasks.js';
import { HttpError, idParam, parse, requireAdmin, user, type Role, type SessionUser } from '../http.js';

export const SESSION_COOKIE = 'or_session';
const SESSION_DAYS = 30;

// A brake on password guessing: 10 failures per email+IP per 15 minutes. Shared by sign-in and invite
// acceptance (an existing user accepting with their password). Kept in the database, so instances sharing
// Postgres count the same failures.
const FAIL_WINDOW = 15 * 60_000;
const MAX_FAILURES = 10;
export const throttleKey = (email: string, ip: string) => `${email.toLowerCase()}|${ip}`;
export function checkThrottle(ctx: Ctx, key: string) {
  const f = ctx.db.get<{ failures: number }>('SELECT failures FROM login_failures WHERE throttle_key = ? AND expires_at > ?', [key, Date.now()]);
  if (f && f.failures >= MAX_FAILURES) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
}
export function recordFailure(ctx: Ctx, key: string) {
  const now = Date.now();
  // One statement, so failures recorded at the same moment by two instances both count.
  ctx.db.run(
    `INSERT INTO login_failures (throttle_key, failures, expires_at) VALUES (?, 1, ?)
     ON CONFLICT (throttle_key) DO UPDATE SET failures = CASE WHEN login_failures.expires_at > ? THEN login_failures.failures + 1 ELSE 1 END, expires_at = excluded.expires_at`,
    [key, now + FAIL_WINDOW, now],
  );
  ctx.db.run('DELETE FROM login_failures WHERE expires_at <= ?', [now]);
}
export const clearFailures = (ctx: Ctx, key: string) => void ctx.db.run('DELETE FROM login_failures WHERE throttle_key = ?', [key]);

const credentials = z.object({ email: z.string().email(), password: z.string().min(8, 'Password must be at least 8 characters') });

export const sessionUser = (ctx: Ctx, tokenValue: string | undefined): SessionUser | null => resolveSession(ctx, tokenValue);

// Signs the user in (optionally straight into a workspace) and returns the session's user.
export function startSession(ctx: Ctx, reply: FastifyReply, userId: number, workspaceId: number | null = null): SessionUser | null {
  const t = token();
  ctx.db.insert('sessions', { token: t, user_id: userId, workspace_id: workspaceId, expires_at: Date.now() + SESSION_DAYS * DAY });
  reply.setCookie(SESSION_COOKIE, t, { path: '/', httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: SESSION_DAYS * 86400 });
  return resolveSession(ctx, t);
}

// The signed-in user in their active workspace, as the web app keeps it.
export function meOf(ctx: Ctx, u: SessionUser) {
  const w = workspaceRow(ctx, u.workspace_id)!;
  const parent = w.parent_id ? workspaceRow(ctx, w.parent_id) : undefined;
  const agency = agencyOf(ctx, u);
  // Feature flags for optional areas of the UI (billing, agency); absent = off.
  const features: Record<string, boolean> = {};
  if (agency) features.agency = true;
  // Hosted installs only, and only for the owner of the workspace that pays (the agency, for its clients).
  if (billingEnabled(ctx) && directRole(ctx, u.id, billingRoot(ctx, w.id)) === 'owner') features.billing = true;
  return {
    user: {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      workspace_id: w.id,
      workspace_name: w.name,
      workspace_kind: w.kind,
      parent_name: parent?.name ?? null,
      // The agency this user runs from here (the workspace itself or a client's parent).
      agency: agency ? { id: agency.id, name: agency.name } : null,
      features,
    },
  };
}

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/auth/status', async () => {
    const users = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
    return { needsSetup: users === 0, allowSignup: users === 0 || ctx.config.allowSignup, setupTokenRequired: users === 0 && !!ctx.config.setupToken };
  });

  app.post('/api/auth/register', async (req, reply) => {
    const body = parse(credentials.extend({ name: z.string().min(1).max(100), workspace: z.string().min(1).max(100).default('My workspace'), setupToken: z.string().optional() }), req.body);
    const users = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
    if (users > 0 && !ctx.config.allowSignup) throw new HttpError(403, 'Sign-up is closed. Ask an admin to add you to their workspace.');
    if (users === 0 && ctx.config.setupToken) {
      const given = Buffer.from(body.setupToken ?? '');
      const expected = Buffer.from(ctx.config.setupToken);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(403, 'Wrong setup token. Use the SETUP_TOKEN value from your server settings.');
    }
    if (ctx.db.get('SELECT 1 FROM users WHERE lower(email) = lower(?)', [body.email])) throw new HttpError(409, 'That email is already registered');
    const id = ctx.db.tx(() => {
      const ws = ctx.db.insert('workspaces', { name: body.workspace, created_at: Date.now() });
      ensureStages(ctx, ws);
      const id = ctx.db.insert('users', { workspace_id: ws, email: body.email, name: body.name, password_hash: hashPassword(body.password), role: 'owner', created_at: Date.now() });
      addMembership(ctx, id, ws, 'owner');
      return id;
    });
    return meOf(ctx, startSession(ctx, reply, id)!);
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(z.object({ email: z.string(), password: z.string() }), req.body);
    const key = throttleKey(body.email, req.ip);
    checkThrottle(ctx, key);
    const u = ctx.db.get<{ id: number; password_hash: string }>('SELECT id, password_hash FROM users WHERE lower(email) = lower(?)', [body.email]);
    if (!u || !verifyPassword(body.password, u.password_hash)) {
      recordFailure(ctx, key);
      throw new HttpError(401, 'Wrong email or password');
    }
    clearFailures(ctx, key);
    ensureLegacyMembership(ctx, u.id);
    const me = startSession(ctx, reply, u.id);
    if (!me) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      throw new HttpError(403, "You aren't a member of any workspace any more. Ask an admin to invite you.");
    }
    return meOf(ctx, me);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const t = req.cookies[SESSION_COOKIE];
    if (t) ctx.db.run('DELETE FROM sessions WHERE token = ?', [t]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => meOf(ctx, user(req)));

  // ---- Team: the active workspace's direct members, plus the agency admins who run a client ----

  app.get('/api/team', async (req) => {
    const ws = user(req).workspace_id;
    const direct = ctx.db.all<{ id: number; name: string; email: string; role: Role; created_at: number }>(
      'SELECT u.id, u.name, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.id',
      [ws],
    );
    const w = workspaceRow(ctx, ws);
    // Listed so they can own leads and take tasks; managed in the agency, so read-only here.
    const inherited =
      w?.kind === 'client' && w.parent_id && workspaceRow(ctx, w.parent_id)?.kind === 'agency'
        ? ctx.db.all<{ id: number; name: string; email: string; role: Role; created_at: number }>(
            "SELECT u.id, u.name, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role IN ('owner', 'admin') ORDER BY u.id",
            [w.parent_id],
          )
        : [];
    const ids = new Set(direct.map((d) => d.id));
    return [...direct.map((d) => ({ ...d, inherited: false })), ...inherited.filter((i) => !ids.has(i.id)).map((i) => ({ ...i, inherited: true }))].sort((a, b) => a.id - b.id);
  });

  // Creates a user with a password the admin passes on. Invites (/api/invites) are the other way in.
  app.post('/api/team', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(credentials.extend({ name: z.string().min(1).max(100), role: z.enum(['admin', 'member', 'client']).default('member') }), req.body);
    if (ctx.db.get('SELECT 1 FROM users WHERE lower(email) = lower(?)', [body.email])) throw new HttpError(409, 'That email is already registered. Invite them instead.');
    // Clients (read-only) don't take a seat.
    const id = withPlanLock(ctx, admin.workspace_id, () => {
      if (body.role !== 'client') assertWithinPlan(ctx, admin.workspace_id, 'seats');
      const id = ctx.db.insert('users', { workspace_id: admin.workspace_id, email: body.email, name: body.name, password_hash: hashPassword(body.password), role: body.role, created_at: Date.now() });
      addMembership(ctx, id, admin.workspace_id, body.role);
      return id;
    });
    return { id };
  });

  app.patch('/api/team/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const { role } = parse(z.object({ role: z.enum(ROLES) }), req.body);
    const current = directRole(ctx, id, admin.workspace_id) ?? notFoundUser();
    if ((current === 'owner' || role === 'owner') && admin.role !== 'owner') throw new HttpError(403, 'Only owners can make or change owners');
    if (current === 'owner' && role !== 'owner' && ownerCount(ctx, admin.workspace_id) <= 1) throw new HttpError(409, 'A workspace needs at least one owner. Make someone else an owner first.');
    withPlanLock(ctx, admin.workspace_id, () => {
      if (current === 'client' && role !== 'client') assertWithinPlan(ctx, admin.workspace_id, 'seats', seatsNeeded(ctx, admin.workspace_id, { userId: id }));
      ctx.db.run('UPDATE memberships SET role = ? WHERE user_id = ? AND workspace_id = ?', [role, id, admin.workspace_id]);
      // Made a client here, or no longer an agency admin: their leads and tasks are let go.
      releaseAssignments(ctx, id, admin.workspace_id);
    });
    return { ok: true };
  });

  // Removes the membership. The person keeps their other workspaces; with none left the user is deleted.
  app.delete('/api/team/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    if (id === admin.id) throw new HttpError(400, "You can't remove yourself");
    const role = directRole(ctx, id, admin.workspace_id) ?? notFoundUser();
    if (role === 'owner' && (admin.role !== 'owner' || ownerCount(ctx, admin.workspace_id) <= 1)) throw new HttpError(403, 'The workspace owner cannot be removed');
    const ws = admin.workspace_id;
    ctx.db.tx(() => {
      ctx.db.run('DELETE FROM memberships WHERE user_id = ? AND workspace_id = ?', [id, ws]);
      // Leads and tasks of this workspace (and of its clients, for an agency) no longer point at someone outside it.
      releaseAssignments(ctx, id, ws);
      const other = ctx.db.get<{ workspace_id: number }>('SELECT workspace_id FROM memberships WHERE user_id = ? ORDER BY workspace_id LIMIT 1', [id]);
      if (!other) ctx.db.run('DELETE FROM users WHERE id = ?', [id]);
      else ctx.db.run('UPDATE users SET workspace_id = ? WHERE id = ? AND workspace_id = ?', [other.workspace_id, id, ws]);
    });
    return { ok: true };
  });

  app.post('/api/auth/password', async (req) => {
    const u = user(req);
    const body = parse(z.object({ current: z.string(), next: z.string().min(8) }), req.body);
    const row = ctx.db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [u.id])!;
    if (!verifyPassword(body.current, row.password_hash)) throw new HttpError(400, 'Current password is wrong');
    // Every other session ends, so someone who had the old password (or a stolen cookie) is signed out.
    ctx.db.tx(() => {
      ctx.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(body.next), u.id]);
      ctx.db.run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', [u.id, req.cookies[SESSION_COOKIE] ?? '']);
    });
    return { ok: true };
  });
}

function notFoundUser(): never {
  throw new HttpError(404, 'User not found');
}
