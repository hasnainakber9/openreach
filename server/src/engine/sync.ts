import { HOUR } from '../clock.js';
import type { Ctx } from '../context.js';
import type { InboxThread } from '../drivers/types.js';
import { logActivity } from '../services/activity.js';
import { campaignSettings, publicLead } from '../services/leads.js';
import type { AccountRow, CampaignRow, LeadRow } from '../types.js';

// Pulls what happened on LinkedIn since the last sync: accepted invitations and new messages.
// Acceptances wake leads waiting on an "accepted invite" condition; replies stop campaigns.
export async function syncAccount(ctx: Ctx, a: AccountRow) {
  const since = Math.max(0, a.last_sync_at - 2 * HOUR);
  const { connections, threads } = await ctx.drivers.use(a, async (d) => ({
    connections: await d.recentConnections(50),
    threads: await d.inbox(since),
  }));

  let accepted = 0;
  for (const p of connections) {
    const lead = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE workspace_id = ? AND public_id = ?', [a.workspace_id, p.publicId]);
    if (!lead || lead.connection_status === 'connected') continue;
    markConnected(ctx, a, lead);
    accepted++;
  }

  let replies = 0;
  for (const t of threads) replies += storeThread(ctx, a, t);
  return { accepted, replies };
}

export function markConnected(ctx: Ctx, a: AccountRow, lead: LeadRow) {
  const now = ctx.clock.now();
  const wasPending = lead.connection_status === 'pending';
  ctx.db.update('leads', lead.id, { connection_status: 'connected', connected_at: now });
  const active = ctx.db.get<{ campaign_id: number }>("SELECT campaign_id FROM campaign_leads WHERE lead_id = ? AND state = 'active'", [lead.id]);
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
  ctx.webhooks.emit(a.workspace_id, 'lead.connected', { lead: publicLead({ ...lead, connection_status: 'connected' }) });
}

// Returns the number of new inbound messages.
export function storeThread(ctx: Ctx, a: AccountRow, t: InboxThread): number {
  const now = ctx.clock.now();
  const lead = t.participant.publicId
    ? ctx.db.get<LeadRow>('SELECT * FROM leads WHERE workspace_id = ? AND public_id = ?', [a.workspace_id, t.participant.publicId])
    : undefined;

  let conv =
    ctx.db.get<{ id: number }>('SELECT id FROM conversations WHERE account_id = ? AND thread_id = ?', [a.id, t.threadId]) ??
    (lead ? ctx.db.get<{ id: number }>('SELECT id FROM conversations WHERE account_id = ? AND lead_id = ?', [a.id, lead.id]) : undefined);
  if (conv) {
    ctx.db.run('UPDATE conversations SET thread_id = ?, participant_name = COALESCE(NULLIF(?, \'\'), participant_name) WHERE id = ?', [t.threadId, t.participant.name, conv.id]);
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
    ctx.db.insert('messages', { conversation_id: conv.id, external_id: m.externalId, direction: m.direction, body: m.body, sent_at: m.sentAt });
    latest = Math.max(latest, m.sentAt);
    if (m.direction === 'in') inbound++;
  }
  if (latest) ctx.db.run('UPDATE conversations SET last_message_at = MAX(last_message_at, ?) WHERE id = ?', [latest, conv.id]);
  if (inbound) ctx.db.run('UPDATE conversations SET unread = 1 WHERE id = ?', [conv.id]);

  if (inbound && lead) {
    ctx.db.update('leads', lead.id, { replied_at: now });
    if (lead.connection_status !== 'connected') markConnected(ctx, a, lead);
    const active = ctx.db.all<{ id: number; campaign_id: number }>("SELECT id, campaign_id FROM campaign_leads WHERE lead_id = ? AND state = 'active'", [lead.id]);
    for (const cl of active) {
      const c = ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [cl.campaign_id])!;
      if (campaignSettings(c).stopOnReply) ctx.db.update('campaign_leads', cl.id, { state: 'replied', finished_at: now });
      else ctx.db.run("UPDATE campaign_leads SET next_run_at = ? WHERE id = ? AND node_type = 'condition'", [now, cl.id]);
    }
    const last = [...t.messages].reverse().find((m) => m.direction === 'in');
    logActivity(ctx, { workspaceId: a.workspace_id, accountId: a.id, campaignId: active[0]?.campaign_id, leadId: lead.id, type: 'replied', detail: last?.body.slice(0, 500), timezone: a.timezone });
    ctx.webhooks.emit(a.workspace_id, 'lead.replied', { lead: publicLead(lead), message: last?.body });
  }
  return inbound;
}
