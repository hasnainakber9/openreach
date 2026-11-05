import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { REPLY_CATEGORIES, SUGGESTED_STAGE, isReplyCategory } from '../ai/categories.js';
import { applyCategory } from '../ai/classify.js';
import { suggestReplies } from '../ai/replies.js';
import type { Ctx } from '../context.js';
import { recordOutbound } from '../engine/engine.js';
import { HttpError, idParam, notFound, parse, requireWriter, user } from '../http.js';
import { ProviderError } from '../providers/http.js';
import { logActivity } from '../services/activity.js';
import type { AccountRow, LeadRow } from '../types.js';
import { aiThrottle } from './ai.js';

interface ConversationRow {
  id: number;
  workspace_id: number;
  channel: string;
  account_id: number;
  lead_id: number | null;
  participant_url: string;
  participant_name: string;
  category: string | null;
  category_confidence: number | null;
  category_source: string | null;
}

export function inboxRoutes(app: FastifyInstance, ctx: Ctx) {
  const throttle = aiThrottle(ctx);

  app.get('/api/inbox', async (req) => {
    const q = parse(
      z.object({
        accountId: z.coerce.number().int().optional(),
        unread: z.enum(['true', 'false']).optional(),
        q: z.string().optional(),
        campaignId: z.coerce.number().int().optional(),
        // A reply category, or 'none' for conversations nobody has classified yet.
        category: z.enum([...REPLY_CATEGORIES, 'none']).optional(),
      }),
      req.query,
    );
    const where = ['c.workspace_id = $ws'];
    const p: Record<string, any> = { ws: user(req).workspace_id };
    if (q.accountId) (where.push('c.account_id = $acc'), (p.acc = q.accountId));
    if (q.unread === 'true') where.push('c.unread = 1');
    if (q.campaignId) (where.push('c.lead_id IN (SELECT lead_id FROM campaign_leads WHERE campaign_id = $camp)'), (p.camp = q.campaignId));
    if (q.category === 'none') where.push('c.category IS NULL');
    else if (q.category) (where.push('c.category = $cat'), (p.cat = q.category));
    if (q.q) (where.push('(c.participant_name LIKE $q OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.body LIKE $q))'), (p.q = `%${q.q}%`));
    return ctx.db.all(
      `SELECT c.id, c.channel, c.account_id AS "accountId", a.name AS "accountName", c.lead_id AS "leadId", c.participant_name AS name, c.participant_url AS "profileUrl",
              c.last_message_at AS "lastMessageAt", c.unread, c.category, c.category_confidence AS "categoryConfidence",
              l.headline, l.company,
              (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY sent_at DESC, id DESC LIMIT 1) AS "lastMessage",
              (SELECT direction FROM messages m WHERE m.conversation_id = c.id ORDER BY sent_at DESC, id DESC LIMIT 1) AS "lastDirection",
              (SELECT cp.name FROM campaign_leads cl JOIN campaigns cp ON cp.id = cl.campaign_id WHERE cl.lead_id = c.lead_id ORDER BY cl.added_at DESC LIMIT 1) AS "campaignName"
       FROM conversations c LEFT JOIN accounts a ON a.id = c.account_id LEFT JOIN leads l ON l.id = c.lead_id
       WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC LIMIT 300`,
      p,
    );
  });

  const load = (req: any) => {
    const { id } = parse(idParam, req.params);
    return ctx.db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]) ?? notFound('Conversation');
  };

  const detail = (c: ConversationRow) => {
    const messages = ctx.db.all('SELECT id, direction, body, sent_at AS "sentAt", category, confidence FROM messages WHERE conversation_id = ? ORDER BY sent_at, id', [c.id]);
    const category = isReplyCategory(c.category) ? c.category : null;
    return {
      id: c.id,
      channel: c.channel,
      accountId: c.account_id,
      leadId: c.lead_id,
      name: c.participant_name,
      profileUrl: c.participant_url,
      category,
      categoryConfidence: c.category_confidence,
      categorySource: c.category_source,
      // A hint only: pipeline stages arrive with g5-pipeline.
      suggestedStage: (category && SUGGESTED_STAGE[category]) ?? null,
      messages,
    };
  };

  app.get('/api/inbox/:id', async (req) => {
    const c = load(req);
    ctx.db.run('UPDATE conversations SET unread = 0 WHERE id = ?', [c.id]);
    return detail(c);
  });

  // Sets the category by hand. It counts like a classification: opt-outs suppress, reply holds resolve.
  app.patch('/api/inbox/:id/category', async (req) => {
    const u = requireWriter(req);
    const c = load(req);
    const { category } = parse(z.object({ category: z.enum(REPLY_CATEGORIES) }), req.body);
    const latest = ctx.db.get<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY sent_at DESC, id DESC LIMIT 1", [c.id]);
    applyCategory(ctx, { workspaceId: u.workspace_id, conversationId: c.id, messageId: latest?.id ?? null, category, confidence: 1, source: 'manual' });
    return detail(ctx.db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [c.id])!);
  });

  // Drafts replies for the user to edit. Nothing is sent or stored.
  app.post('/api/inbox/:id/suggest', async (req) => {
    const u = requireWriter(req);
    const c = load(req);
    const body = parse(z.object({ count: z.number().int().min(1).max(3).default(3), instruction: z.string().trim().max(500).optional() }), req.body);
    throttle(u.workspace_id);
    try {
      return await suggestReplies(ctx, u.workspace_id, c.id, { count: body.count, instruction: body.instruction || undefined });
    } catch (e) {
      if (e instanceof ProviderError) throw new HttpError(422, e.message);
      throw e;
    }
  });

  app.post('/api/inbox/:id/reply', async (req) => {
    requireWriter(req);
    const c = load(req);
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(8000) }), req.body);
    const a = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [c.account_id]);
    if (!a) throw new HttpError(409, 'This conversation has no LinkedIn account to reply from');
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
