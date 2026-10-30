import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DAY } from '../clock.js';
import type { Ctx } from '../context.js';
import { hashPassword, token, verifyPassword } from '../services/crypto.js';
import { HttpError, idParam, parse, requireAdmin, user, type SessionUser } from '../http.js';

export const SESSION_COOKIE = 'or_session';
const SESSION_DAYS = 30;

// Simple in-memory brake on password guessing: 10 failures per email+IP per 15 minutes.
const failures = new Map<string, { n: number; until: number }>();
const FAIL_WINDOW = 15 * 60_000;

const credentials = z.object({ email: z.string().email(), password: z.string().min(8, 'Password must be at least 8 characters') });

export function sessionUser(ctx: Ctx, tokenValue: string | undefined): SessionUser | null {
  if (!tokenValue) return null;
  return (
    ctx.db.get<SessionUser>(
      'SELECT u.id, u.workspace_id, u.role, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?',
      [tokenValue, Date.now()],
    ) ?? null
  );
}

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const startSession = (userId: number, reply: any) => {
    const t = token();
    ctx.db.insert('sessions', { token: t, user_id: userId, expires_at: Date.now() + SESSION_DAYS * DAY });
    reply.setCookie(SESSION_COOKIE, t, { path: '/', httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: SESSION_DAYS * 86400 });
  };
  const me = (id: number) => {
    const u = ctx.db.get('SELECT u.id, u.name, u.email, u.role, w.id AS workspace_id, w.name AS workspace_name FROM users u JOIN workspaces w ON w.id = u.workspace_id WHERE u.id = ?', [id]);
    return { user: u };
  };

  app.get('/api/auth/status', async () => {
    const users = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
    return { needsSetup: users === 0, allowSignup: users === 0 || ctx.config.allowSignup };
  });

  app.post('/api/auth/register', async (req, reply) => {
    const body = parse(credentials.extend({ name: z.string().min(1).max(100), workspace: z.string().min(1).max(100).default('My workspace') }), req.body);
    const users = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
    if (users > 0 && !ctx.config.allowSignup) throw new HttpError(403, 'Sign-up is closed. Ask an admin to add you to their workspace.');
    if (ctx.db.get('SELECT 1 FROM users WHERE email = ?', [body.email])) throw new HttpError(409, 'That email is already registered');
    const id = ctx.db.tx(() => {
      const ws = ctx.db.insert('workspaces', { name: body.workspace, created_at: Date.now() });
      return ctx.db.insert('users', { workspace_id: ws, email: body.email, name: body.name, password_hash: hashPassword(body.password), role: 'owner', created_at: Date.now() });
    });
    startSession(id, reply);
    return me(id);
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(z.object({ email: z.string(), password: z.string() }), req.body);
    const key = `${body.email.toLowerCase()}|${req.ip}`;
    const f = failures.get(key);
    if (f && f.n >= 10 && f.until > Date.now()) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    const u = ctx.db.get<{ id: number; password_hash: string }>('SELECT id, password_hash FROM users WHERE email = ?', [body.email]);
    if (!u || !verifyPassword(body.password, u.password_hash)) {
      failures.set(key, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + FAIL_WINDOW });
      throw new HttpError(401, 'Wrong email or password');
    }
    failures.delete(key);
    startSession(u.id, reply);
    return me(u.id);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const t = req.cookies[SESSION_COOKIE];
    if (t) ctx.db.run('DELETE FROM sessions WHERE token = ?', [t]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => me(user(req).id));

  app.get('/api/team', async (req) => {
    return ctx.db.all('SELECT id, name, email, role, created_at FROM users WHERE workspace_id = ? ORDER BY id', [user(req).workspace_id]);
  });

  app.post('/api/team', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(credentials.extend({ name: z.string().min(1).max(100), role: z.enum(['admin', 'member']).default('member') }), req.body);
    if (ctx.db.get('SELECT 1 FROM users WHERE email = ?', [body.email])) throw new HttpError(409, 'That email is already registered');
    const id = ctx.db.insert('users', { workspace_id: admin.workspace_id, email: body.email, name: body.name, password_hash: hashPassword(body.password), role: body.role, created_at: Date.now() });
    return { id };
  });

  app.delete('/api/team/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    if (id === admin.id) throw new HttpError(400, "You can't remove yourself");
    const target = ctx.db.get<{ role: string }>('SELECT role FROM users WHERE id = ? AND workspace_id = ?', [id, admin.workspace_id]);
    if (!target) throw new HttpError(404, 'User not found');
    if (target.role === 'owner') throw new HttpError(403, 'The workspace owner cannot be removed');
    ctx.db.run('DELETE FROM users WHERE id = ?', [id]);
    return { ok: true };
  });

  app.post('/api/auth/password', async (req) => {
    const u = user(req);
    const body = parse(z.object({ current: z.string(), next: z.string().min(8) }), req.body);
    const row = ctx.db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [u.id])!;
    if (!verifyPassword(body.current, row.password_hash)) throw new HttpError(400, 'Current password is wrong');
    ctx.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(body.next), u.id]);
    return { ok: true };
  });
}
