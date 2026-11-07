import { HOUR } from '../clock.js';
import type { Ctx } from '../context.js';
import type { InboxThread } from '../drivers/types.js';
import { logActivity } from '../services/activity.js';
import { publicLead } from '../services/leads.js';
import { classifyJobKey, handleInboundReply } from '../services/replies.js';
import { connectionWith, setConnection } from '../services/rotation.js';
import type { AccountRow, LeadRow } from '../types.js';

// Pulls what happened on LinkedIn since the last sync: accepted invitations and new messages.
// Acceptances wake leads waiting on an "accepted invite" condition; replies go through handleInboundReply.
export async function syncAccount(ctx: Ctx, a: AccountRow) {
  const since = Math.max(0, a.last_sync_at - 2 * HOUR);
  const { connections, threads } = await ctx.drivers.use(a, async (d) => ({
    connections: await d.recentConnections(50),
    threads: await d.inbox(since),
  }));

  let accepted = 0;
  for (const p of connections) {
    const lead = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE workspace_id = ? AND public_id = ?', [a.workspace_id, p.publicId]);
    // Skip only people this account already knows it is connected to: with several senders, a lead
    // connected through account A can still accept B's invite, and B needs to record that.
    if (!lead || connectionWith(ctx, lead, a.id) === 'connected') continue;
    markConnected(ctx, a, lead);
    accepted++;
  }

  let replies = 0;
  for (const t of threads) replies += storeThread(ctx, a, t);
  return { accepted, replies };
}

export function markConnected(ctx: Ctx, a: AccountRow, lead: LeadRow) {
  const now = ctx.clock.now();
  const wasPending = connectionWith(ctx, lead, a.id) === 'pending';
  const wasConnected = ctx.db.get<{ connection_status: string }>('SELECT connection_status FROM leads WHERE id = ?', [lead.id])?.connection_status === 'connected';
  setConnection(ctx, lead.id, a.id, 'connected');
  // Attribute the acceptance to the campaign only when this account is (or may become) the lead's sender.
  const active = ctx.db.get<{ campaign_id: number }>(
    "SELECT campaign_id FROM campaign_leads WHERE lead_id = ? AND state = 'active' AND (account_id IS NULL OR account_id = ?)",
    [lead.id, a.id],
  );
  logActivity(ctx, {
    workspaceId: a.workspace_id,
    accountId: a.id,
    campaignId: active?.campaign_id,
    leadId: lead.id,
    type: 'accepted',
    detail: wasPending ? 'invitation accepted' : 'already a connection',
    timezone: a.timezone,
  });
  ctx.db.run("UPDATE campaign_leads SET next_run_at = ? WHERE lead_id = ? AND state = 'active' AND node_type = 'condition'", [now, lead.id]);
  // The event means "now connected to us"; a second sender connecting too doesn't fire it again.
  if (!wasConnected) ctx.webhooks.emit(a.workspace_id, 'lead.connected', { lead: publicLead({ ...lead, connection_status: 'connected' }, ctx), account: { id: a.id, name: a.name } });
}

// The lead behind a thread whose participant link LinkedIn didn't show (2026 inbox threads may have none).
// A thread already tied to a lead keeps it. Otherwise the match is by name, and only to a lead this
// account has written to whose conversation isn't tied to a LinkedIn thread yet, whose message also
// appears in this thread, and only when exactly one lead fits: a wrong match would run reply handling
// (and stop a campaign) for the wrong person.
function participantByName(ctx: Ctx, a: AccountRow, t: InboxThread, knownLeadId: number | null): LeadRow | undefined {
  if (knownLeadId) return ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [knownLeadId]);
  const name = t.participant.name.replace(/\s+/g, ' ').trim().toLowerCase();
  const ours = [...new Set(t.messages.filter((m) => m.direction === 'out').map((m) => m.body))];
  if (!name || !ours.length) return undefined;
  const rows = ctx.db.all<{ lead_id: number }>(
    `SELECT DISTINCT c.lead_id FROM conversations c JOIN messages m ON m.conversation_id = c.id
     WHERE c.account_id = ? AND c.lead_id IS NOT NULL AND c.thread_id LIKE 'local-%' AND LOWER(TRIM(c.participant_name)) = ?
       AND m.direction = 'out' AND m.body IN (${ours.map(() => '?').join(', ')})`,
    [a.id, name, ...ours],
  );
  return rows.length === 1 ? ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [rows[0].lead_id]) : undefined;
}

// Returns the number of new inbound messages.
export function storeThread(ctx: Ctx, a: AccountRow, t: InboxThread): number {
  const known = ctx.db.get<{ id: number; lead_id: number | null }>('SELECT id, lead_id FROM conversations WHERE account_id = ? AND thread_id = ?', [a.id, t.threadId]);
  const lead = t.participant.publicId
    ? ctx.db.get<LeadRow>('SELECT * FROM leads WHERE workspace_id = ? AND public_id = ?', [a.workspace_id, t.participant.publicId])
    : participantByName(ctx, a, t, known?.lead_id ?? null);

  let conv: { id: number } | undefined =
    known ?? (lead ? ctx.db.get<{ id: number }>('SELECT id FROM conversations WHERE account_id = ? AND lead_id = ?', [a.id, lead.id]) : undefined);
  if (conv) {
    ctx.db.run('UPDATE conversations SET thread_id = ?, participant_name = COALESCE(NULLIF(?, \'\'), participant_name), lead_id = COALESCE(lead_id, ?) WHERE id = ?', [
      t.threadId,
      t.participant.name,
      lead?.id ?? null,
      conv.id,
    ]);
  } else {
    conv = {
      id: ctx.db.insert('conversations', {
        workspace_id: a.workspace_id,
        account_id: a.id,
        lead_id: lead?.id ?? null,
        thread_id: t.threadId,
        participant_name: t.participant.name,
        participant_url: t.participant.profileUrl,
        last_message_at: t.lastMessageAt,
      }),
    };
  }

  let inbound = 0;
  let latest = 0;
  // The newest new reply: it is the one classified.
  let newest: { id: number; body: string; sentAt: number } | null = null;
  for (const m of t.messages) {
    if (ctx.db.get('SELECT 1 FROM messages WHERE conversation_id = ? AND external_id = ?', [conv.id, m.externalId])) continue;
    if (m.direction === 'out') {
      // Adopt the local copy written when the campaign sent it, if there is one.
      const local = ctx.db.get<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND direction = 'out' AND external_id LIKE 'local:%' AND body = ?", [conv.id, m.body]);
      if (local) {
        ctx.db.run('UPDATE messages SET external_id = ? WHERE id = ?', [m.externalId, local.id]);
        continue;
      }
    }
    const id = ctx.db.insert('messages', { conversation_id: conv.id, external_id: m.externalId, direction: m.direction, body: m.body, sent_at: m.sentAt });
    latest = Math.max(latest, m.sentAt);
    if (m.direction === 'in') {
      inbound++;
      if (!newest || m.sentAt >= newest.sentAt) newest = { id, body: m.body, sentAt: m.sentAt };
    }
  }
  if (latest) ctx.db.run('UPDATE conversations SET last_message_at = CASE WHEN last_message_at > ? THEN last_message_at ELSE ? END WHERE id = ?', [latest, latest, conv.id]);
  if (inbound) ctx.db.run('UPDATE conversations SET unread = 1 WHERE id = ?', [conv.id]);

  if (inbound && lead) {
    if (connectionWith(ctx, lead, a.id) !== 'connected') markConnected(ctx, a, lead);
    const last = [...t.messages].reverse().find((m) => m.direction === 'in');
    handleInboundReply(ctx, { lead, channel: 'linkedin', conversationId: conv.id, messageId: newest?.id ?? null, body: last?.body ?? newest?.body ?? '', account: a });
  } else if (newest) {
    // Someone who isn't a lead: the category still helps sort the inbox.
    ctx.jobs.enqueue('ai.classify', { messageId: newest.id }, { workspaceId: a.workspace_id, dedupeKey: classifyJobKey(newest.id) });
  }
  return inbound;
}
