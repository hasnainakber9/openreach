import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DAY } from '../clock.js';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { publicIdFromUrl } from '../drivers/types.js';
import { localParts } from '../engine/limits.js';
import { HttpError, idParam, isAdmin, notFound, parse, requireAdmin, requireWriter, user } from '../http.js';
import { contactTypesSql } from '../services/activity.js';
import { token } from '../services/crypto.js';
import { stopLeadEverywhere } from '../services/replies.js';
import { normalizePhone, suppressIdentity, type SuppressionKind } from '../services/suppression.js';
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
    const contacted = ctx.db.get<{ n: number }>(`SELECT COUNT(DISTINCT lead_id) AS n FROM activity WHERE ${w} AND type IN (${contactTypesSql()})`, p)!.n;
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
      `SELECT a.id, a.type, a.status, a.detail, a.node_id AS "nodeId", a.variant, a.created_at AS "createdAt", a.lead_id AS "leadId", a.campaign_id AS "campaignId",
              l.first_name || ' ' || l.last_name AS "leadName", l.profile_url AS "profileUrl", c.name AS "campaignName", ac.name AS "accountName"
       FROM activity a LEFT JOIN leads l ON l.id = a.lead_id LEFT JOIN campaigns c ON c.id = a.campaign_id LEFT JOIN accounts ac ON ac.id = a.account_id
       WHERE a.workspace_id = $ws ${extra} ORDER BY a.id DESC LIMIT ${q.limit}`,
      p,
    );
  });

  // ---- Blacklist -------------------------------------------------------------
  const blacklistBody = z.object({ kind: z.enum(['profile', 'company', 'keyword', 'email_domain']), values: z.array(z.string().trim().min(1).max(300)).min(1).max(5000) });

  app.get('/api/blacklist', async (req) => {
    return ctx.db.all('SELECT id, kind, value, created_at AS "createdAt" FROM blacklist WHERE workspace_id = ? ORDER BY id DESC', [user(req).workspace_id]);
  });

  app.post('/api/blacklist', async (req) => {
    const body = parse(blacklistBody, req.body);
    let added = 0;
    ctx.db.tx(() => {
      for (const raw of body.values) {
        const value = body.kind === 'profile' ? (publicIdFromUrl(raw) ?? raw) : raw.toLowerCase();
        added += ctx.db.run('INSERT INTO blacklist (workspace_id, kind, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [user(req).workspace_id, body.kind, value, ctx.clock.now()]).changes;
      }
    });
    return { added };
  });

  app.delete('/api/blacklist/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    ctx.db.run('DELETE FROM blacklist WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]);
    return { ok: true };
  });

  // ---- Do not contact (suppressions) -------------------------------------------
  // Opt-outs from replies, unsubscribe links and STOP texts land here automatically; a classifier can be
  // wrong, so people can be looked up and taken off the list again.
  const SUPPRESSION_KINDS = ['linkedin', 'email', 'phone'] as const;
  const PAGE_SIZE = 50;

  app.get('/api/suppressions', async (req) => {
    const q = parse(z.object({ q: z.string().trim().max(200).optional(), kind: z.enum(SUPPRESSION_KINDS).optional(), page: z.coerce.number().int().min(1).default(1) }), req.query);
    const where = ['s.workspace_id = $ws'];
    const p: Record<string, any> = { ws: user(req).workspace_id };
    if (q.kind) (where.push('s.kind = $kind'), (p.kind = q.kind));
    if (q.q) (where.push("(s.value LIKE $q OR (l.first_name || ' ' || l.last_name) LIKE $q)"), (p.q = `%${q.q}%`));
    const from = `FROM suppressions s LEFT JOIN leads l ON l.id = s.lead_id AND l.workspace_id = s.workspace_id WHERE ${where.join(' AND ')}`;
    const total = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n ${from}`, p)!.n;
    const items = ctx.db.all(
      `SELECT s.id, s.kind, s.value, s.reason, s.source, s.lead_id AS "leadId", l.first_name || ' ' || l.last_name AS "leadName", s.created_at AS "createdAt"
       ${from} ORDER BY s.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(q.page - 1) * PAGE_SIZE}`,
      p,
    );
    return { total, page: q.page, pageSize: PAGE_SIZE, items };
  });

  app.post('/api/suppressions', async (req) => {
    const u = requireWriter(req);
    const body = parse(z.object({ kind: z.enum(SUPPRESSION_KINDS), value: z.string().trim().min(1).max(300) }), req.body);
    const value = body.kind === 'linkedin' ? (publicIdFromUrl(body.value) ?? body.value) : body.value;
    if (body.kind === 'phone' && !normalizePhone(value)) throw new HttpError(400, 'value: Write the number in international form, like +44 20 7946 0958');
    if (body.kind === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw new HttpError(400, 'value: Not an email address');
    const added = suppressIdentity(ctx, u.workspace_id, body.kind as SuppressionKind, value, 'manual', `added by ${u.name}`);
    // Leads with this identity stop now, not only before their next action.
    const column = { linkedin: 'public_id', email: 'lower(email)', phone: 'phone' }[body.kind];
    const match = body.kind === 'email' ? value.toLowerCase() : value;
    const leads = ctx.db.all<{ id: number; phone: string | null }>(`SELECT id, phone FROM leads WHERE workspace_id = ? AND ${column} ${body.kind === 'phone' ? 'IS NOT NULL' : '= ?'}`, body.kind === 'phone' ? [u.workspace_id] : [u.workspace_id, match]);
    let stopped = 0;
    for (const l of leads) {
      if (body.kind === 'phone' && normalizePhone(l.phone) !== normalizePhone(value)) continue;
      stopped += stopLeadEverywhere(ctx, l.id, 'skipped', 'Suppressed: manual');
    }
    return { added, stopped };
  });

  // Taking someone off the list does not restart campaigns they were stopped in; add them again to contact them.
  app.delete('/api/suppressions/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    if (!ctx.db.run('DELETE FROM suppressions WHERE id = ? AND workspace_id = ?', [id, admin.workspace_id]).changes) notFound('Suppression');
    return { ok: true };
  });

  // ---- Webhooks --------------------------------------------------------------
  app.get('/api/webhooks', async (req) => {
    return ctx.db
      .all<any>('SELECT id, url, events, secret, active, last_status AS "lastStatus", created_at AS "createdAt" FROM webhooks WHERE workspace_id = ? ORDER BY id', [user(req).workspace_id])
      // Only admins can see signing secrets.
      .map((h) => ({ ...h, secret: isAdmin(user(req)) ? h.secret : null, events: json(h.events, []), active: !!h.active }));
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
