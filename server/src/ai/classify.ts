import { z } from 'zod';
import { MINUTE } from '../clock.js';
import type { Ctx } from '../context.js';
import type { JobHelpers, JobInfo } from '../jobs/queue.js';
import { AI_MAX_TIMEOUT_SECONDS } from '../providers/ai/types.js';
import { ProviderError } from '../providers/http.js';
import { logActivity } from '../services/activity.js';
import { publicLead } from '../services/leads.js';
import { autoAdvance, stageForCategory } from '../services/pipeline.js';
import { resolveReplyHolds } from '../services/replies.js';
import { suppressLead } from '../services/suppression.js';
import type { LeadRow } from '../types.js';
import { CATEGORY_LABELS, isReplyCategory, isSuppressCategory, SUPPRESS_MIN_CONFIDENCE, type ReplyCategory } from './categories.js';
import { completeAi, extractJson } from './complete.js';
import { isFinalAiError } from './personalize.js';
import { classifyRequest, type ThreadMessage } from './prompts.js';

// Inbound replies are classified by the ai.classify job (queued by handleInboundReply). The category
// shows in the inbox, drives reply holds and the reply_sentiment condition, and confident opt-outs
// suppress the person everywhere.

// Room for the slowest allowed AI request (a local model on a laptop CPU) plus the bookkeeping around it.
export const CLASSIFY_JOB_OPTIONS = { concurrency: 2, maxAttempts: 3, timeoutMs: AI_MAX_TIMEOUT_SECONDS * 1000 + MINUTE };
// How much of the thread the classifier sees.
const THREAD_MESSAGES = 10;

const answerSchema = z.object({ category: z.string(), confidence: z.number() });

interface MessageRow {
  id: number;
  conversation_id: number;
  direction: 'in' | 'out';
  body: string;
  sent_at: number;
  category: string | null;
}

interface ConversationRow {
  id: number;
  workspace_id: number;
  account_id: number | null;
  lead_id: number | null;
}

// The thread up to and including a message, oldest first.
export function threadUpTo(ctx: Ctx, conversationId: number, upTo?: Pick<MessageRow, 'id' | 'sent_at'>): ThreadMessage[] {
  const rows = upTo
    ? ctx.db.all<ThreadMessage>(
        'SELECT direction, body FROM messages WHERE conversation_id = ? AND (sent_at < ? OR (sent_at = ? AND id <= ?)) ORDER BY sent_at DESC, id DESC LIMIT ?',
        [conversationId, upTo.sent_at, upTo.sent_at, upTo.id, THREAD_MESSAGES],
      )
    : ctx.db.all<ThreadMessage>('SELECT direction, body FROM messages WHERE conversation_id = ? ORDER BY sent_at DESC, id DESC LIMIT ?', [conversationId, THREAD_MESSAGES]);
  return rows.reverse();
}

// Job handler. Idempotent: a message that already has a category (from an earlier run or set by hand) is left alone.
export async function classifyJob(job: JobInfo<{ messageId: number }>, h: JobHelpers) {
  const { ctx } = h;
  const msg = ctx.db.get<MessageRow>(
    'SELECT m.id, m.conversation_id, m.direction, m.body, m.sent_at, m.category FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND c.workspace_id = ?',
    [job.payload.messageId, job.workspaceId],
  );
  if (!msg) return { note: 'Message no longer exists' };
  if (msg.direction !== 'in') return { note: 'Not a reply' };
  if (msg.category) return { category: msg.category, note: 'Already classified' };
  const ws = job.workspaceId!;
  let text: string;
  try {
    text = (await completeAi(ctx, ws, classifyRequest(threadUpTo(ctx, msg.conversation_id, msg), msg.body))).text;
  } catch (e) {
    // The hold on the lead runs out by itself (REPLY_HOLD_MIN); the failure shows in the activity feed.
    if (isFinalAiError(e, job.attempts, CLASSIFY_JOB_OPTIONS.maxAttempts)) {
      const conv = ctx.db.get<ConversationRow>('SELECT id, workspace_id, account_id, lead_id FROM conversations WHERE id = ?', [msg.conversation_id])!;
      logActivity(ctx, {
        workspaceId: ws,
        accountId: conv.account_id,
        leadId: conv.lead_id,
        type: 'classified',
        status: 'failed',
        detail: (e instanceof ProviderError ? e.message : 'Classification failed').slice(0, 300),
      });
    }
    throw e;
  }
  // A malformed answer is not worth a retry: the reply is simply "other" with no confidence.
  const parsed = answerSchema.safeParse(extractJson(text));
  const valid = parsed.success && isReplyCategory(parsed.data.category);
  const category: ReplyCategory = valid ? (parsed.data.category as ReplyCategory) : 'other';
  const confidence = valid ? Math.round(Math.min(1, Math.max(0, parsed.data.confidence)) * 100) / 100 : 0;
  applyCategory(ctx, { workspaceId: ws, conversationId: msg.conversation_id, messageId: msg.id, category, confidence, source: 'ai' });
  return { category, confidence };
}

export interface CategoryInput {
  workspaceId: number;
  conversationId: number;
  // The reply it applies to; null for a conversation with no reply yet (manual only).
  messageId: number | null;
  category: ReplyCategory;
  confidence: number;
  source: 'ai' | 'manual';
}

// Stores a category on the message, its conversation and its lead (the last two only when it is about
// their latest reply), logs and emits it, applies suppression and releases reply holds.
export function applyCategory(ctx: Ctx, o: CategoryInput) {
  const now = ctx.clock.now();
  const conv = ctx.db.get<ConversationRow>('SELECT id, workspace_id, account_id, lead_id FROM conversations WHERE id = ? AND workspace_id = ?', [o.conversationId, o.workspaceId]);
  if (!conv) return;
  const msg = o.messageId ? ctx.db.get<MessageRow>('SELECT * FROM messages WHERE id = ? AND conversation_id = ?', [o.messageId, conv.id]) : undefined;
  // A late answer about an older message must not replace the category of a newer one.
  const newer = (where: string, id: number) =>
    !!msg && !!ctx.db.get(`SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE ${where} = ? AND m.direction = 'in' AND m.id <> ? AND (m.sent_at > ? OR (m.sent_at = ? AND m.id > ?)) LIMIT 1`, [
      id,
      msg.id,
      msg.sent_at,
      msg.sent_at,
      msg.id,
    ]);
  const latestInThread = !newer('c.id', conv.id);
  const latestForLead = conv.lead_id != null && latestInThread && !newer('c.lead_id', conv.lead_id);
  const campaign = conv.lead_id ? ctx.db.get<{ campaign_id: number }>('SELECT campaign_id FROM campaign_leads WHERE lead_id = ? ORDER BY CASE WHEN state = \'active\' THEN 0 ELSE 1 END, added_at DESC LIMIT 1', [conv.lead_id]) : undefined;

  let lead: LeadRow | undefined;
  let restamped = false;
  ctx.db.tx(() => {
    if (msg) ctx.db.run('UPDATE messages SET category = ?, confidence = ? WHERE id = ?', [o.category, o.confidence, msg.id]);
    if (latestInThread) ctx.db.update('conversations', conv.id, { category: o.category, category_confidence: o.confidence, category_source: o.source, classified_at: now });
    if (latestForLead) ctx.db.update('leads', conv.lead_id!, { reply_category: o.category, reply_category_at: now });
    else if (conv.lead_id != null) {
      // An older reply synced late (another sender's thread) moved replied_at past the stamp of the lead's
      // latest reply. Re-stamp that reply's category so holds and conditions see it is already classified.
      const latest = ctx.db.get<{ category: string | null }>(
        "SELECT m.category FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.lead_id = ? AND m.direction = 'in' ORDER BY m.sent_at DESC, m.id DESC LIMIT 1",
        [conv.lead_id],
      );
      if (latest && isReplyCategory(latest.category)) {
        ctx.db.update('leads', conv.lead_id, { reply_category: latest.category, reply_category_at: now });
        restamped = true;
      }
    }
    lead = conv.lead_id ? ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [conv.lead_id]) : undefined;
    logActivity(ctx, {
      workspaceId: o.workspaceId,
      accountId: conv.account_id,
      campaignId: campaign?.campaign_id,
      leadId: conv.lead_id,
      type: 'classified',
      detail: `${CATEGORY_LABELS[o.category]} (${o.source === 'manual' ? 'set by hand' : `${Math.round(o.confidence * 100)}% sure`})`,
    });
  });
  ctx.webhooks.emit(o.workspaceId, 'lead.classified', {
    lead: lead ? publicLead(lead, ctx) : null,
    category: o.category,
    confidence: o.confidence,
    source: o.source,
    message: msg?.body ?? null,
    conversationId: conv.id,
  });
  if (!lead) return;
  // Holds first, so a held lead ends as 'replied' like any stopped reply; suppression then stops the rest.
  if (latestForLead || restamped) resolveReplyHolds(ctx, lead.id);
  // Interested / meeting booked (and, if the workspace wants it, not interested) move the pipeline forward.
  const slug = latestForLead ? stageForCategory(ctx, o.workspaceId, o.category) : null;
  if (slug) autoAdvance(ctx, lead.id, slug, `Reply ${o.source === 'manual' ? 'marked' : 'classified'} as ${CATEGORY_LABELS[o.category].toLowerCase()}`);
  // Only a sure opt-out suppresses, and only about the lead's latest reply: a late answer about an older
  // "not interested" must not drop someone whose newer reply says "let's talk". A category set by hand counts.
  if (isSuppressCategory(o.category) && o.confidence >= SUPPRESS_MIN_CONFIDENCE[o.category] && (o.source === 'manual' || latestForLead)) {
    suppressLead(ctx, lead, o.category, o.source === 'manual' ? 'inbox' : 'reply classification');
  }
}
