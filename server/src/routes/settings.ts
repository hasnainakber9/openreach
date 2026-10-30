import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DAY } from '../clock.js';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { publicIdFromUrl } from '../drivers/types.js';
import { localParts } from '../engine/limits.js';
import { idParam, notFound, parse, requireAdmin, user } from '../http.js';
import { token } from '../services/crypto.js';
import { WEBHOOK_EVENTS } from '../services/webhooks.js';

export function settingsRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---- Analytics -------------------------------------------------------------
  app.get('/api/analytics', async (req) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30), campaignId: z.coerce.number().int().optional(), accountId: z.coerce.number().int().optional() }), req.query);
    const ws = user(req).workspace_id;
    const now = ctx.clock.now();
    const since = now - q.days * DAY;
    const where = ["workspace_id = $ws", 'created_at >= $since', "status = 'ok'"];
    const p: Record<string, any> = { ws, since };
    if (q.campaignId) (where.push('campaign_id = $camp'), (p.camp = q.campaignId));
    if (q.accountId) (where.push('account_id = $acc'), (p.acc = q.accountId));
    const w = where.join(' AND ');
    const rows = ctx.db.all<{ day: string; type: string; n: number }>(`SELECT day, type, COUNT(*) AS n FROM activity WHERE ${w} GROUP BY day, type`, p);
    const days: string[] = [];
    for (let t = since + DAY; t <= now + 1; t += DAY) days.push(localParts(t, 'UTC').date);
    const series = days.map((day) => ({ day, ...Object.fromEntries(rows.filter((r) => r.day === day).map((r) => [r.type, r.n])) }));
    const totals: Record<string, number> = {};
    for (const r of rows) totals[r.type] = (totals[r.type] ?? 0) + r.n;
    const distinct = (type: string) => ctx.db.get<{ n: number }>(`SELECT COUNT(DISTINCT lead_id) AS n FROM activity WHERE ${w} AND type = '${type}'`, p)!.n;
    const contacted = ctx.db.get<{ n: number }>(`SELECT COUNT(DISTINCT lead_id) AS n FROM activity WHERE ${w} AND type IN ('connect', 'message', 'email')`, p)!.n;
    const invited = distinct('connect');
    const accepted = distinct('accepted');
    const replied = distinct('replied');
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    return {
      days: q.days,
      totals,
      series,
      funnel: { contacted, invited, accepted, messaged: distinct('message'), replied },
      acceptanceRate: pct(accepted, invited),
      replyRate: pct(replied, contacted),
    };
  });

  app.get('/api/activity', async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(50), campaignId: z.coerce.number().int().optional() }), req.query);
    const p: Record<string, any> = { ws: user(req).workspace_id };
    const extra = q.campaignId ? 'AND a.campaign_id = $camp' : '';
    if (q.campaignId) p.camp = q.campaignId;
    return ctx.db.all(
      `SELECT a.id, a.type, a.status, a.detail, a.created_at AS createdAt, a.lead_id AS leadId, a.campaign_id AS campaignId,
              l.first_name || ' ' || l.last_name AS leadName, l.profile_url AS profileUrl, c.name AS campaignName, ac.name AS accountName
       FROM activity a LEFT JOIN leads l ON l.id = a.lead_id LEFT JOIN campaigns c ON c.id = a.campaign_id LEFT JOIN accounts ac ON ac.id = a.account_id
       WHERE a.workspace_id = $ws ${extra} ORDER BY a.id DESC LIMIT ${q.limit}`,
      p,
    );
  });

  // ---- Blacklist -------------------------------------------------------------
  const blacklistBody = z.object({ kind: z.enum(['profile', 'company', 'keyword', 'email_domain']), values: z.array(z.string().trim().min(1).max(300)).min(1).max(5000) });

  app.get('/api/blacklist', async (req) => {
    return ctx.db.all('SELECT id, kind, value, created_at AS createdAt FROM blacklist WHERE workspace_id = ? ORDER BY id DESC', [user(req).workspace_id]);
  });

  app.post('/api/blacklist', async (req) => {
    const body = parse(blacklistBody, req.body);
    let added = 0;
    ctx.db.tx(() => {
      for (const raw of body.values) {
        const value = body.kind === 'profile' ? (publicIdFromUrl(raw) ?? raw) : raw.toLowerCase();
        added += ctx.db.run('INSERT OR IGNORE INTO blacklist (workspace_id, kind, value, created_at) VALUES (?, ?, ?, ?)', [user(req).workspace_id, body.kind, value, ctx.clock.now()]).changes;
      }
    });
    return { added };
  });

  app.delete('/api/blacklist/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    ctx.db.run('DELETE FROM blacklist WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]);
    return { ok: true };
  });

  // ---- Webhooks --------------------------------------------------------------
  app.get('/api/webhooks', async (req) => {
    return ctx.db
      .all<any>('SELECT id, url, events, secret, active, last_status AS lastStatus, created_at AS createdAt FROM webhooks WHERE workspace_id = ? ORDER BY id', [user(req).workspace_id])
      // Only admins can see signing secrets.
      .map((h) => ({ ...h, secret: user(req).role === 'member' ? null : h.secret, events: json(h.events, []), active: !!h.active }));
  });

  app.get('/api/webhooks/events', async () => WEBHOOK_EVENTS);

  app.post('/api/webhooks', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(z.object({ url: z.string().url(), events: z.array(z.enum([...WEBHOOK_EVENTS, '*'])).min(1) }), req.body);
    const id = ctx.db.insert('webhooks', { workspace_id: admin.workspace_id, url: body.url, events: JSON.stringify(body.events), secret: token(24), created_at: ctx.clock.now() });
    return { id };
  });

  app.patch('/api/webhooks/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ active: z.boolean().optional(), events: z.array(z.enum([...WEBHOOK_EVENTS, '*'])).min(1).optional() }), req.body);
    if (!ctx.db.get('SELECT 1 FROM webhooks WHERE id = ? AND workspace_id = ?', [id, admin.workspace_id])) notFound('Webhook');
    if (body.active !== undefined) ctx.db.update('webhooks', id, { active: body.active ? 1 : 0 });
    if (body.events) ctx.db.update('webhooks', id, { events: JSON.stringify(body.events) });
    return { ok: true };
  });

  app.delete('/api/webhooks/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    ctx.db.run('DELETE FROM webhooks WHERE id = ? AND workspace_id = ?', [id, admin.workspace_id]);
    return { ok: true };
  });

  app.post('/api/webhooks/:id/test', async (req) => {
    const { id } = parse(idParam, req.params);
    const h = ctx.db.get<any>('SELECT id, url, events, secret FROM webhooks WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]) ?? notFound('Webhook');
    const status = await ctx.webhooks.send(h, { event: 'test', occurredAt: new Date().toISOString(), data: { message: 'Hello from OpenReach' } });
    return { status };
  });
}
