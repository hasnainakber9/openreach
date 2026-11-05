import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { REPLY_CATEGORIES, SUGGESTED_STAGE, isReplyCategory } from '../ai/categories.js';
import { applyCategory } from '../ai/classify.js';
import { suggestReplies } from '../ai/replies.js';
import type { Ctx } from '../context.js';
import { recordOutbound } from '../engine/engine.js';
import { HttpError, idParam, notFound, parse, requireWriter, user } from '../http.js';
import { ProviderError } from '../providers/http.js';
import { composeEmail, newMessageId } from '../mail/compose.js';
import { splitReferences } from '../mail/imap.js';
import { fromLine, isReservedAddress, isSimulated, mailboxNeedsAttention, smtpTransport } from '../mail/mailboxes.js';
import { logActivity } from '../services/activity.js';
import { stageOf } from '../services/pipeline.js';
import { mailError } from '../services/email.js';
import type { AccountRow, EmailMessageRow, LeadRow, MailboxRow } from '../types.js';
import { aiThrottle } from './ai.js';
import { SMS_MAX } from '../engine/sequence.js';
import { recordPhoneMessage } from '../messaging/runner.js';

interface ConversationRow {
  id: number;
  workspace_id: number;
  channel: string;
  account_id: number | null;
  mailbox_id: number | null;
  lead_id: number | null;
  participant_url: string;
  participant_address: string | null;
  subject: string | null;
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
        mailboxId: z.coerce.number().int().optional(),
        channel: z.enum(['linkedin', 'email', 'sms', 'whatsapp']).optional(),
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
    if (q.mailboxId) (where.push('c.mailbox_id = $mb'), (p.mb = q.mailboxId));
    if (q.channel) (where.push('c.channel = $ch'), (p.ch = q.channel));
    if (q.unread === 'true') where.push('c.unread = 1');
    if (q.campaignId) (where.push('c.lead_id IN (SELECT lead_id FROM campaign_leads WHERE campaign_id = $camp)'), (p.camp = q.campaignId));
    if (q.category === 'none') where.push('c.category IS NULL');
    else if (q.category) (where.push('c.category = $cat'), (p.cat = q.category));
    if (q.q) (where.push('(c.participant_name LIKE $q OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.body LIKE $q))'), (p.q = `%${q.q}%`));
    return ctx.db.all(
      `SELECT c.id, c.channel, c.account_id AS "accountId", a.name AS "accountName", c.mailbox_id AS "mailboxId", mb.name AS "mailboxName", c.subject, c.participant_address AS "participantAddress", c.lead_id AS "leadId", c.participant_name AS name, c.participant_url AS "profileUrl",
              c.last_message_at AS "lastMessageAt", c.unread, c.category, c.category_confidence AS "categoryConfidence",
              l.headline, l.company,
              (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY sent_at DESC, id DESC LIMIT 1) AS "lastMessage",
              (SELECT direction FROM messages m WHERE m.conversation_id = c.id ORDER BY sent_at DESC, id DESC LIMIT 1) AS "lastDirection",
              (SELECT cp.name FROM campaign_leads cl JOIN campaigns cp ON cp.id = cl.campaign_id WHERE cl.lead_id = c.lead_id ORDER BY cl.added_at DESC LIMIT 1) AS "campaignName"
       FROM conversations c LEFT JOIN accounts a ON a.id = c.account_id LEFT JOIN mailboxes mb ON mb.id = c.mailbox_id LEFT JOIN leads l ON l.id = c.lead_id
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
    const lead = c.lead_id ? ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [c.lead_id, c.workspace_id]) : undefined;
    const stage = lead ? stageOf(ctx, lead) : undefined;
    return {
      id: c.id,
      channel: c.channel,
      accountId: c.account_id,
      mailboxId: c.mailbox_id,
      mailboxName: c.mailbox_id ? (ctx.db.get<{ name: string }>('SELECT name FROM mailboxes WHERE id = ?', [c.mailbox_id])?.name ?? null) : null,
      subject: c.subject,
      participantAddress: c.participant_address,
      leadId: c.lead_id,
      name: c.participant_name,
      profileUrl: c.participant_url,
      category,
      categoryConfidence: c.category_confidence,
      categorySource: c.category_source,
      // The stage slug the category points to (the automation already moved the lead if it was behind).
      suggestedStage: (category && SUGGESTED_STAGE[category]) ?? null,
      // The lead's pipeline stage; the thread header can change it.
      stage: stage ? { id: stage.id, slug: stage.slug, name: stage.name, color: stage.color } : null,
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
    if (c.channel === 'email') return replyByEmail(c, text);
    if (c.channel === 'sms' || c.channel === 'whatsapp') return replyByPhone(c, c.channel, text);
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

  // Texts back through the workspace's SMS provider, right away; it counts toward the channel's daily limit.
  // A number that opted out (STOP) can't be texted until it sends START.
  async function replyByPhone(c: ConversationRow, channel: 'sms' | 'whatsapp', text: string) {
    const phone = c.participant_address ?? '';
    if (!phone) throw new HttpError(409, 'This conversation has no phone number to reply to');
    if (ctx.db.get("SELECT 1 FROM suppressions WHERE workspace_id = ? AND kind = 'phone' AND value = ?", [c.workspace_id, phone])) {
      throw new HttpError(409, 'This number opted out (STOP). It can be texted again once it sends START.');
    }
    const provider = ctx.providers.get(c.workspace_id, 'sms');
    if (!provider) throw new HttpError(409, 'No SMS provider is set up');
    if (channel === 'sms' && !provider.policy.sms) throw new HttpError(409, 'The SMS integration has no SMS from number or Messaging Service');
    if (channel === 'whatsapp' && !provider.policy.whatsapp) throw new HttpError(409, 'The SMS integration has no WhatsApp sender');
    if (text.length > SMS_MAX) throw new HttpError(400, `Keep the message under ${SMS_MAX} characters`);
    let externalId: string;
    try {
      externalId = (await provider.send({ channel, to: phone, body: text })).externalId;
    } catch (e) {
      if (e instanceof ProviderError) throw new HttpError(422, `The message was not sent: ${e.message}`);
      throw e;
    }
    const lead = c.lead_id ? (ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [c.lead_id, c.workspace_id]) ?? null) : null;
    ctx.db.tx(() => {
      recordPhoneMessage(ctx, { workspaceId: c.workspace_id, channel, phone, lead, direction: 'out', externalId, body: text });
      logActivity(ctx, { workspaceId: c.workspace_id, leadId: c.lead_id, type: channel, detail: provider.simulated ? `${text} (simulated: not delivered)` : text, timezone: provider.policy.timezone });
    });
    return { ok: true };
  }

  // Answers in the thread from the conversation's mailbox, right away. It counts toward the mailbox's
  // daily limit like a campaign email, but a person who wrote to us gets no unsubscribe footer.
  async function replyByEmail(c: ConversationRow, text: string) {
    const mb = c.mailbox_id ? ctx.db.get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ? AND workspace_id = ?', [c.mailbox_id, c.workspace_id]) : undefined;
    if (!mb) throw new HttpError(409, 'This conversation has no mailbox to reply from');
    if (mb.status === 'needs_attention') throw new HttpError(409, `This mailbox needs attention first: ${mb.status_message ?? 'check its settings'}`);
    const to = c.participant_address ?? '';
    if (!to) throw new HttpError(409, 'This conversation has no email address to reply to');
    if (!isSimulated(mb) && isReservedAddress(to)) throw new HttpError(409, 'Reserved test addresses are never emailed from a real mailbox');
    const transport = smtpTransport(ctx, mb);
    if (!isSimulated(mb) && !transport) throw new HttpError(409, 'Add SMTP settings to this mailbox first');
    const last = ctx.db.get<EmailMessageRow>('SELECT * FROM email_messages WHERE conversation_id = ? ORDER BY sent_at DESC, id DESC LIMIT 1', [c.id]);
    const thread = last ? { inReplyTo: last.message_id, references: [...splitReferences(last.refs), last.message_id], subject: c.subject || last.subject } : null;
    const messageId = newMessageId(mb.from_email, ctx.random);
    const msg = composeEmail({ from: fromLine(mb), fromEmail: mb.from_email, replyTo: mb.reply_to, to, subject: c.subject ?? '', body: text, signature: mb.signature, messageId, thread, footer: false });
    let status: string;
    try {
      status = (await ctx.mailer.send(transport, msg)).status;
    } catch (e) {
      const err = mailError(e);
      if (err.code === 'AUTH') mailboxNeedsAttention(ctx, mb, `SMTP login refused: ${err.message}`);
      throw new HttpError(422, `The mail server did not accept the email: ${err.message}`);
    }
    const now = ctx.clock.now();
    ctx.db.tx(() => {
      ctx.db.insert('email_messages', {
        workspace_id: mb.workspace_id,
        mailbox_id: mb.id,
        lead_id: c.lead_id,
        conversation_id: c.id,
        direction: 'out',
        message_id: messageId,
        in_reply_to: thread?.inReplyTo ?? null,
        refs: thread?.references.join(' ') || null,
        subject: msg.subject,
        from_email: mb.from_email,
        to_email: to,
        status,
        sent_at: now,
      });
      ctx.db.insert('messages', { conversation_id: c.id, external_id: messageId, direction: 'out', body: text, sent_at: now });
      ctx.db.run('UPDATE conversations SET last_message_at = ? WHERE id = ?', [now, c.id]);
      logActivity(ctx, { workspaceId: mb.workspace_id, mailboxId: mb.id, leadId: c.lead_id, type: 'email', detail: msg.subject, timezone: mb.timezone });
    });
    return { ok: true };
  }
}
