import { DAY, MINUTE } from '../clock.js';
import type { Ctx } from '../context.js';
import { PermanentError, type JobHelpers, type JobInfo } from '../jobs/queue.js';
import { logActivity } from '../services/activity.js';
import { MailError } from '../services/email.js';
import { publicLead } from '../services/leads.js';
import { handleInboundReply } from '../services/replies.js';
import type { EmailMessageRow, LeadRow, MailboxRow } from '../types.js';
import { imapFor, normalizeMessageId, type InboundEmail } from './imap.js';
import { mailboxNeedsAttention, WENT_OUT } from './mailboxes.js';

// Replies and bounces read from a mailbox's INBOX (email.sync job). Mail is matched to our own outbound
// emails by In-Reply-To/References, else by sender address to a lead this mailbox emailed; anything else
// is ignored, since OpenReach never imports the rest of the user's mailbox.

export const EMAIL_SYNC_JOB_OPTIONS = { concurrency: 2, maxAttempts: 3, timeoutMs: 5 * MINUTE };
export const syncJobKey = (mailboxId: number) => `email.sync:${mailboxId}`;

export interface InboundStats {
  replies: number;
  bounces: number;
  ignored: number;
}

const isDaemon = (from: string) => /^(mailer-daemon|postmaster|mail-daemon)@/i.test(from);

// Drops quoted history ("> ..." lines and everything after "On ... wrote:") so the inbox and the
// classifier see what the person actually wrote.
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .{4,200}wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  const s = out.join('\n').trim();
  return s || text.trim();
}

function ourMessage(ctx: Ctx, mb: MailboxRow, ids: (string | null)[]): EmailMessageRow | undefined {
  for (const id of ids) {
    if (!id) continue;
    const row = ctx.db.get<EmailMessageRow>("SELECT * FROM email_messages WHERE mailbox_id = ? AND message_id = ? AND direction = 'out'", [mb.id, id]);
    if (row) return row;
  }
  return undefined;
}

export function processInbound(ctx: Ctx, mb: MailboxRow, emails: InboundEmail[]): InboundStats {
  const stats: InboundStats = { replies: 0, bounces: 0, ignored: 0 };
  const now = ctx.clock.now();
  // The newest reply per lead: one handleInboundReply each, like a LinkedIn thread sync.
  const newest = new Map<number, { lead: LeadRow; conversationId: number; messageId: number; body: string; date: number }>();
  for (const e of [...emails].sort((a, b) => a.date - b.date || a.uid - b.uid)) {
    const messageId = normalizeMessageId(e.messageId);
    // Mail from before the mailbox was added here is not a reply to us.
    if (!messageId || e.date < mb.created_at - DAY || e.from === mb.from_email.toLowerCase()) {
      stats.ignored++;
      continue;
    }
    if (ctx.db.get('SELECT 1 FROM email_messages WHERE mailbox_id = ? AND message_id = ?', [mb.id, messageId])) continue;
    const refs = [...e.references].reverse();

    if (e.report || isDaemon(e.from)) {
      const original =
        ourMessage(ctx, mb, [normalizeMessageId(e.report?.originalMessageId), normalizeMessageId(e.inReplyTo), ...refs]) ??
        (e.report?.recipients.length
          ? ctx.db.get<EmailMessageRow>(
              "SELECT * FROM email_messages WHERE mailbox_id = ? AND direction = 'out' AND lower(to_email) = ? ORDER BY sent_at DESC, id DESC LIMIT 1",
              [mb.id, e.report.recipients[0].toLowerCase()],
            )
          : undefined);
      if (!original) {
        stats.ignored++;
        continue;
      }
      recordBounce(ctx, mb, e, messageId, original);
      stats.bounces++;
      continue;
    }

    const original = ourMessage(ctx, mb, [normalizeMessageId(e.inReplyTo), ...refs]);
    const lead = original?.lead_id
      ? ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [original.lead_id, mb.workspace_id])
      : e.from
        ? // Only people this mailbox has emailed: other mail from someone who happens to be a lead is private.
          ctx.db.get<LeadRow>(
            `SELECT l.* FROM leads l WHERE l.workspace_id = ? AND lower(l.email) = ?
               AND EXISTS (SELECT 1 FROM email_messages e WHERE e.mailbox_id = ? AND e.lead_id = l.id AND ${WENT_OUT})
             ORDER BY l.id DESC LIMIT 1`,
            [mb.workspace_id, e.from, mb.id],
          )
        : undefined;
    if (!lead) {
      stats.ignored++;
      continue;
    }
    const body = stripQuoted(e.text).slice(0, 8000) || '(no text)';
    const sentAt = Math.min(e.date, now);
    const conversationId = ctx.db.tx(() => {
      const conv = conversationFor(ctx, mb, lead, original, e, messageId);
      const msgId = ctx.db.insert('messages', { conversation_id: conv, external_id: messageId, direction: 'in', body, sent_at: sentAt });
      ctx.db.insert('email_messages', {
        workspace_id: mb.workspace_id,
        mailbox_id: mb.id,
        campaign_id: original?.campaign_id ?? null,
        lead_id: lead.id,
        conversation_id: conv,
        direction: 'in',
        message_id: messageId,
        in_reply_to: normalizeMessageId(e.inReplyTo),
        refs: e.references.join(' ') || null,
        subject: e.subject.slice(0, 500),
        from_email: e.from,
        to_email: mb.from_email,
        status: 'received',
        sent_at: sentAt,
      });
      ctx.db.run('UPDATE conversations SET unread = 1, last_message_at = CASE WHEN last_message_at > ? THEN last_message_at ELSE ? END WHERE id = ?', [sentAt, sentAt, conv]);
      const prev = newest.get(lead.id);
      if (!prev || sentAt >= prev.date) newest.set(lead.id, { lead, conversationId: conv, messageId: msgId, body, date: sentAt });
      return conv;
    });
    if (conversationId) stats.replies++;
  }
  for (const r of newest.values()) {
    handleInboundReply(ctx, { lead: r.lead, channel: 'email', conversationId: r.conversationId, messageId: r.messageId, body: r.body, mailbox: { id: mb.id, name: mb.name, timezone: mb.timezone } });
  }
  return stats;
}

// The reply's thread: the conversation of the email it answers, else the lead's latest thread in this
// mailbox, else a new one rooted at the reply.
function conversationFor(ctx: Ctx, mb: MailboxRow, lead: LeadRow, original: EmailMessageRow | undefined, e: InboundEmail, messageId: string): number {
  if (original?.conversation_id && ctx.db.get('SELECT 1 FROM conversations WHERE id = ?', [original.conversation_id])) return original.conversation_id;
  const latest = ctx.db.get<{ id: number }>('SELECT id FROM conversations WHERE mailbox_id = ? AND lead_id = ? ORDER BY last_message_at DESC, id DESC LIMIT 1', [mb.id, lead.id]);
  if (latest) return latest.id;
  const root = e.references[0] ?? normalizeMessageId(e.inReplyTo) ?? messageId;
  const existing = ctx.db.get<{ id: number }>('SELECT id FROM conversations WHERE mailbox_id = ? AND thread_id = ?', [mb.id, root]);
  if (existing) return existing.id;
  return ctx.db.insert('conversations', {
    workspace_id: mb.workspace_id,
    channel: 'email',
    account_id: null,
    mailbox_id: mb.id,
    lead_id: lead.id,
    thread_id: root,
    participant_name: `${lead.first_name} ${lead.last_name}`.trim() || e.fromName || e.from,
    participant_url: lead.profile_url,
    participant_address: e.from,
    subject: e.subject.replace(/^(re|aw|sv):\s*/i, '').slice(0, 300),
    last_message_at: Math.min(e.date, ctx.clock.now()),
  });
}

// A bounce marks the address invalid so the lead's later email steps skip it. It doesn't suppress the
// person: they may still be reached on LinkedIn, and a corrected address works again.
function recordBounce(ctx: Ctx, mb: MailboxRow, e: InboundEmail, messageId: string, original: EmailMessageRow) {
  const now = ctx.clock.now();
  const reason = (e.report?.diagnostic || (e.report?.status ? `Status ${e.report.status}` : '') || e.subject || 'Delivery failed').slice(0, 300);
  let lead: LeadRow | undefined;
  ctx.db.tx(() => {
    ctx.db.run("UPDATE email_messages SET status = 'bounced', error = ? WHERE id = ?", [reason, original.id]);
    ctx.db.insert('email_messages', {
      workspace_id: mb.workspace_id,
      mailbox_id: mb.id,
      campaign_id: original.campaign_id,
      lead_id: original.lead_id,
      direction: 'in',
      message_id: messageId,
      in_reply_to: original.message_id,
      subject: e.subject.slice(0, 500),
      from_email: e.from,
      to_email: mb.from_email,
      status: 'bounced',
      error: reason,
      sent_at: Math.min(e.date, now),
    });
    lead = original.lead_id ? ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [original.lead_id, mb.workspace_id]) : undefined;
    // Only while the lead still has the address that bounced (it may have been corrected since).
    if (lead && lead.email?.trim().toLowerCase() === original.to_email.toLowerCase()) {
      ctx.db.update('leads', lead.id, { email_status: 'invalid', email_status_reason: `Bounced: ${reason}`, email_status_at: now });
    }
    logActivity(ctx, { workspaceId: mb.workspace_id, mailboxId: mb.id, campaignId: original.campaign_id, leadId: original.lead_id, type: 'email_bounce', status: 'failed', detail: `${original.to_email}: ${reason}`, timezone: mb.timezone, nodeId: original.node_id, variant: original.variant });
  });
  if (lead) ctx.webhooks.emit(mb.workspace_id, 'lead.email_bounced', { lead: publicLead(ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [lead.id])!, ctx), email: original.to_email, reason });
}

// Job handler: reads new INBOX mail for one mailbox. Idempotent (messages are deduplicated by Message-ID).
export async function emailSyncJob(job: JobInfo<{ mailboxId: number }>, h: JobHelpers) {
  const { ctx } = h;
  const mb = ctx.db.get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ? AND workspace_id = ?', [job.payload.mailboxId, job.workspaceId]);
  if (!mb) return { note: 'Mailbox no longer exists' };
  const client = imapFor(ctx, mb);
  if (!client) return { note: 'No IMAP settings: replies are not detected for this mailbox' };
  const now = ctx.clock.now();
  let result;
  try {
    result = await client.fetchSince(mb.imap_last_uid, mb.imap_uid_validity, { since: Math.max(mb.created_at, now - 14 * DAY), signal: h.signal });
  } catch (e) {
    if (e instanceof MailError && e.code === 'AUTH') {
      mailboxNeedsAttention(ctx, mb, e.message);
      throw new PermanentError(e.message);
    }
    throw e;
  }
  h.progress(result.messages.length);
  const stats = processInbound(ctx, mb, result.messages);
  ctx.db.run('UPDATE mailboxes SET imap_uid_validity = ?, imap_last_uid = ?, last_sync_at = ? WHERE id = ?', [result.uidValidity, result.lastUid, ctx.clock.now(), mb.id]);
  return stats;
}
