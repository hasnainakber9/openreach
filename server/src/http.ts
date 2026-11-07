import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    throw new HttpError(400, `${first.path.join('.') || 'body'}: ${first.message}`, r.error.issues);
  }
  return r.data;
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });

// `client` (read-only access for agency clients) is enforced from g5-agency on.
export type Role = 'owner' | 'admin' | 'member' | 'client';

export interface SessionUser {
  id: number;
  workspace_id: number;
  role: Role;
  name: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser;
  }
}

export function user(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  return req.user;
}

export function requireRole(req: FastifyRequest, ...roles: Role[]) {
  return checkRole(req, roles, "Your role can't do this");
}

function checkRole(req: FastifyRequest, roles: Role[], message: string) {
  const u = user(req);
  if (!roles.includes(u.role)) throw new HttpError(403, message);
  return u;
}

// Positive checks, so a role added later never slips through by default.
export const requireAdmin = (req: FastifyRequest) => checkRole(req, ['owner', 'admin'], 'Only admins can do this');
export const requireWriter = (req: FastifyRequest) => checkRole(req, ['owner', 'admin', 'member'], 'Your role is read-only');
export const requireOwner = (req: FastifyRequest) => checkRole(req, ['owner'], 'Only the workspace owner can do this');
export const isAdmin = (u: SessionUser) => u.role === 'owner' || u.role === 'admin';

export function notFound(what: string): never {
  throw new HttpError(404, `${what} not found`);
}

// One CSV cell. Lead data comes from strangers' LinkedIn profiles, so a value that a spreadsheet would read
// as a formula (= + - @, or a leading tab or CR) gets a ' in front and stays plain text.
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvBody(rows: Record<string, unknown>[]): string {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return [headers.map(csvCell).join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\n');
}

export function csv(reply: FastifyReply, filename: string, rows: Record<string, unknown>[]) {
  const body = csvBody(rows);
  return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${filename}"`).send(body);
}
