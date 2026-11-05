import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError, idParam, notFound, parse, requireAdmin } from '../http.js';
import { resolveBranding } from '../services/branding.js';
import { hashPassword, verifyPassword } from '../services/crypto.js';
import { canEmailInvites, createInvite, findInvite, INVITE_ROLES, serializeInvite, type InviteRow } from '../services/invites.js';
import { addMembership, resolveSession, roleIn, workspaceRow } from '../services/memberships.js';
import { checkThrottle, clearFailures, meOf, recordFailure, SESSION_COOKIE, startSession, throttleKey } from './auth.js';

const tokenParam = z.object({ token: z.string().min(10).max(200) });

export function inviteRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---- Admins: invite people to the active workspace ----

  app.get('/api/invites', async (req) => {
    const u = requireAdmin(req);
    const rows = ctx.db.all<InviteRow & { invited_by_name: string | null }>(
      'SELECT i.*, u.name AS invited_by_name FROM invites i LEFT JOIN users u ON u.id = i.invited_by WHERE i.workspace_id = ? AND i.accepted_at IS NULL ORDER BY i.created_at DESC, i.id DESC',
      [u.workspace_id],
    );
    return { items: rows.map((r) => serializeInvite(ctx, r)), emailEnabled: canEmailInvites(ctx) };
  });

  // The link is returned once (only its hash is kept); inviting the same address again makes a new one.
  app.post('/api/invites', async (req) => {
    const u = requireAdmin(req);
    const body = parse(z.object({ email: z.string().trim().email().max(200), role: z.enum(INVITE_ROLES).default('member') }), req.body);
    // Members, and agency admins who already reach this client through the agency.
    const existing = ctx.db.get<{ id: number }>('SELECT id FROM users WHERE lower(email) = lower(?)', [body.email]);
    if (existing && roleIn(ctx, existing.id, u.workspace_id)) throw new HttpError(409, 'That person is already a member of this workspace');
    const inv = createInvite(ctx, { workspaceId: u.workspace_id, email: body.email, role: body.role, invitedBy: u.id });
    return { id: inv.id, link: inv.link, emailed: inv.emailed };
  });

  app.delete('/api/invites/:id', async (req) => {
    const u = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    if (!ctx.db.run('DELETE FROM invites WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL', [id, u.workspace_id]).changes) notFound('Invite');
    return { ok: true };
  });

  // ---- Public: the invite page (identified by the token alone) ----

  const load = (params: unknown) => {
    const { token } = parse(tokenParam, params);
    return findInvite(ctx, token) ?? notFound('Invite (it may have expired or been used already)');
  };
  const existingUser = (email: string) => ctx.db.get<{ id: number; password_hash: string }>('SELECT id, password_hash FROM users WHERE lower(email) = lower(?)', [email]);

  app.get('/api/public/invites/:token', async (req) => {
    const inv = load(req.params);
    const session = resolveSession(ctx, req.cookies[SESSION_COOKIE]);
    const existing = existingUser(inv.email);
    return {
      workspaceName: workspaceRow(ctx, inv.workspace_id)?.name ?? '',
      email: inv.email,
      role: inv.role,
      existingUser: !!existing,
      // Signed in as the invited person already: accepting needs no password.
      signedIn: !!existing && session?.id === existing.id,
      expiresAt: inv.expires_at,
      branding: resolveBranding(ctx, inv.workspace_id),
    };
  });

  // Joins the workspace (creating the user if needed) and signs in straight into it. Single use.
  app.post('/api/public/invites/:token/accept', async (req, reply) => {
    const inv = load(req.params);
    const body = parse(z.object({ name: z.string().trim().max(100).optional(), password: z.string().max(200).optional() }), req.body);
    const session = resolveSession(ctx, req.cookies[SESSION_COOKIE]);
    const existing = existingUser(inv.email);
    if (existing && session?.id !== existing.id) {
      // Same brake as sign-in: the invite link must not become a way to guess someone's password.
      const key = throttleKey(inv.email, req.ip);
      checkThrottle(key);
      if (!body.password || !verifyPassword(body.password, existing.password_hash)) {
        recordFailure(key);
        throw new HttpError(401, 'Wrong password for that account');
      }
      clearFailures(key);
    }
    if (!existing) {
      if (!body.name) throw new HttpError(400, 'Enter your name');
      if (!body.password || body.password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    }
    const userId = ctx.db.tx(() => {
      let uid = existing?.id;
      if (!uid) {
        if (existingUser(inv.email)) throw new HttpError(409, 'That email was registered meanwhile. Open the link again.');
        uid = ctx.db.insert('users', { workspace_id: inv.workspace_id, email: inv.email, name: body.name!, password_hash: hashPassword(body.password!), role: inv.role, created_at: Date.now() });
      }
      // Single use: a second accept (double click, replay) finds it taken.
      const claimed = ctx.db.run('UPDATE invites SET accepted_at = ?, accepted_user_id = ? WHERE id = ? AND accepted_at IS NULL', [Date.now(), uid, inv.id]).changes;
      if (!claimed) throw new HttpError(409, 'This invite was used already');
      addMembership(ctx, uid, inv.workspace_id, inv.role);
      return uid;
    });
    if (session?.id === userId) {
      const t = req.cookies[SESSION_COOKIE]!;
      ctx.db.run('UPDATE sessions SET workspace_id = ? WHERE token = ?', [inv.workspace_id, t]);
      return meOf(ctx, resolveSession(ctx, t)!);
    }
    return meOf(ctx, startSession(ctx, reply, userId, inv.workspace_id)!);
  });
}
