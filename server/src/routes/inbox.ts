import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { recordOutbound } from '../engine/engine.js';
import { HttpError, idParam, notFound, parse, user } from '../http.js';
import { logActivity } from '../services/activity.js';
import type { AccountRow, LeadRow } from '../types.js';

export function inboxRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/inbox', async (req) => {
    const q = parse(z.object({ accountId: z.coerce.number().int().optional(), unread: z.enum(['true', 'false']).optional(), q: z.string().optional(), campaignId: z.coerce.number().int().optional() }), req.query);
    const where = ['c.workspace_id = $ws'];
    const p: Record<string, any> = { ws: user(req).workspace_id };
    if (q.accountId) (where.push('c.account_id = $acc'), (p.acc = q.accountId));
    if (q.unread === 'true') where.push('c.unread = 1');
    if (q.campaignId) (where.push('c.lead_id IN (SELECT lead_id FROM campaign_leads WHERE campaign_id = $camp)'), (p.camp = q.campaignId));
    if (q.q) (where.push('(c.participant_name LIKE $q OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.body LIKE $q))'), (p.q = `%${q.q}%`));
    return ctx.db.all(
      `SELECT c.id, c.account_id AS accountId, a.name AS accountName, c.lead_id AS leadId, c.participant_name AS name, c.participant_url AS profileUrl,
              c.last_message_at AS lastMessageAt, c.unread,
              l.headline, l.company,
              (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY sent_at DESC, id DESC LIMIT 1) AS lastMessage,
              (SELECT direction FROM messages m WHERE m.conversation_id = c.id ORDER BY sent_at DESC, id DESC LIMIT 1) AS lastDirection,
              (SELECT cp.name FROM campaign_leads cl JOIN campaigns cp ON cp.id = cl.campaign_id WHERE cl.lead_id = c.lead_id ORDER BY cl.added_at DESC LIMIT 1) AS campaignName
       FROM conversations c JOIN accounts a ON a.id = c.account_id LEFT JOIN leads l ON l.id = c.lead_id
       WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC LIMIT 300`,
      p,
    );
  });

  const load = (req: any) => {
    const { id } = parse(idParam, req.params);
    return ctx.db.get<{ id: number; account_id: number; lead_id: number | null; participant_url: string; participant_name: string }>('SELECT * FROM conversations WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]) ?? notFound('Conversation');
  };

  app.get('/api/inbox/:id', async (req) => {
    const c = load(req);
    ctx.db.run('UPDATE conversations SET unread = 0 WHERE id = ?', [c.id]);
    const messages = ctx.db.all('SELECT id, direction, body, sent_at AS sentAt FROM messages WHERE conversation_id = ? ORDER BY sent_at, id', [c.id]);
    return { id: c.id, accountId: c.account_id, leadId: c.lead_id, name: c.participant_name, profileUrl: c.participant_url, messages };
  });

  app.post('/api/inbox/:id/reply', async (req) => {
    const c = load(req);
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(8000) }), req.body);
    const a = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [c.account_id])!;
    if (a.status === 'needs_login') throw new HttpError(409, 'This LinkedIn account needs a fresh session cookie before it can send');
    try {
      await ctx.drivers.use(a, (d) => d.sendMessage(c.participant_url, text));
    } catch (e) {
      throw new HttpError(422, `LinkedIn did not accept the message: ${(e as Error).message}`);
    }
    const lead = c.lead_id ? ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [c.lead_id]) : undefined;
    if (lead) recordOutbound(ctx, a, lead, text);
    else {
      ctx.db.insert('messages', { conversation_id: c.id, external_id: `local:${Date.now()}`, direction: 'out', body: text, sent_at: ctx.clock.now() });
      ctx.db.run('UPDATE conversations SET last_message_at = ? WHERE id = ?', [ctx.clock.now(), c.id]);
    }
    logActivity(ctx, { workspaceId: a.workspace_id, accountId: a.id, leadId: c.lead_id, type: 'message', detail: text, timezone: a.timezone });
    return { ok: true };
  });
}
