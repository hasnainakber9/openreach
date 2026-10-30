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

export interface SessionUser {
  id: number;
  workspace_id: number;
  role: 'owner' | 'admin' | 'member';
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

export function requireAdmin(req: FastifyRequest) {
  const u = user(req);
  if (u.role === 'member') throw new HttpError(403, 'Only admins can do this');
  return u;
}

export function notFound(what: string): never {
  throw new HttpError(404, `${what} not found`);
}

export function csv(reply: FastifyReply, filename: string, rows: Record<string, unknown>[]) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
  return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${filename}"`).send(body);
}
