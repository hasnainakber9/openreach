import { isReplyCategory, SUPPRESS_CATEGORIES, type ReplyCategory } from '../ai/categories.js';
import { MINUTE } from '../clock.js';
import type { Ctx } from '../context.js';
import type { CampaignSettings } from '../engine/sequence.js';
import type { CampaignLeadRow, CampaignLeadState, CampaignRow, LeadRow } from '../types.js';
import { logActivity } from './activity.js';
import { campaignSettings, publicLead } from './leads.js';

// Every inbound reply (LinkedIn today; email and SMS later) goes through handleInboundReply, and every
// path that stops a lead goes through stopCampaignLead, so stop-on-reply, holds and later hooks
// (closing tasks, pipeline stages) live in one place.

export type Channel = 'linkedin' | 'email' | 'sms' | 'whatsapp';

// Ends a campaign lead (only while it is still active). Returns whether it stopped.
export function stopCampaignLead(ctx: Ctx, cl: Pick<CampaignLeadRow, 'id'>, state: Exclude<CampaignLeadState, 'active'>, reason?: string): boolean {
  const now = ctx.clock.now();
  const r = ctx.db.run(
    `UPDATE campaign_leads SET state = ?, finished_at = ?, next_run_at = ?, hold_reason = NULL${reason ? ', last_error = ?' : ''} WHERE id = ? AND state = 'active'`,
    reason ? [state, now, now, reason, cl.id] : [state, now, now, cl.id],
  );
  return r.changes > 0;
}

// Stops the lead in every campaign it is running in. Returns how many stopped.
export function stopLeadEverywhere(ctx: Ctx, leadId: number, state: Exclude<CampaignLeadState, 'active'>, reason?: string): number {
  const active = ctx.db.all<{ id: number }>("SELECT id FROM campaign_leads WHERE lead_id = ? AND state = 'active'", [leadId]);
  let n = 0;
  ctx.db.tx(() => {
    for (const cl of active) if (stopCampaignLead(ctx, cl, state, reason)) n++;
  });
  return n;
}

// When a reply that is still waiting for its category stops holding the lead.
export const replyHoldDeadline = (ctx: Ctx, lead: Pick<LeadRow, 'replied_at'>) => (lead.replied_at ?? 0) + ctx.config.replyHoldMin * MINUTE;

// The category of the lead's latest reply, or null while that reply is not classified yet. A
// classification older than the reply belongs to an earlier message.
export function latestCategory(lead: Pick<LeadRow, 'replied_at' | 'reply_category' | 'reply_category_at'>): ReplyCategory | null {
  if (lead.replied_at == null || lead.reply_category_at == null || lead.reply_category_at < lead.replied_at) return null;
  return isReplyCategory(lead.reply_category) ? lead.reply_category : null;
}

export type ReplyDecision = 'none' | 'continue' | 'stop' | 'pending';

// What a campaign does with a lead that has replied:
// - stopOnReply off: nothing ('none'), the sequence goes on.
// - stopOnReply on, continueOnCategories empty: 'stop' on any reply (the original behaviour).
// - stopOnReply on with categories: 'pending' until the latest reply is classified, then 'continue' for
//   a listed category and 'stop' for anything else. An opt-out always stops, even one too unsure to suppress.
export function replyDecision(settings: Pick<CampaignSettings, 'stopOnReply' | 'continueOnCategories'>, lead: Pick<LeadRow, 'replied_at' | 'reply_category' | 'reply_category_at'>): ReplyDecision {
  if (!settings.stopOnReply || lead.replied_at == null) return 'none';
  if (!settings.continueOnCategories.length) return 'stop';
  const category = latestCategory(lead);
  if (!category) return 'pending';
  return settings.continueOnCategories.includes(category) && !SUPPRESS_CATEGORIES.includes(category) ? 'continue' : 'stop';
}

// For the reply_sentiment condition: the category of the lead's latest reply since it joined the
// campaign; null when it hasn't replied since; { until } while that reply waits for its category. Once
// the hold time is over an unclassified reply counts as 'other'.
export function replySince(ctx: Ctx, lead: LeadRow, since: number): ReplyCategory | null | { until: number } {
  if (lead.replied_at == null || lead.replied_at < since) return null;
  const category = latestCategory(lead);
  if (category) return category;
  const until = replyHoldDeadline(ctx, lead);
  return ctx.clock.now() < until ? { until } : 'other';
}

export interface InboundReply {
  lead: LeadRow;
  channel: Channel;
  conversationId: number;
  // The newest inbound message: it is classified, and its text goes into the replied event.
  messageId: number | null;
  body: string;
  account?: { id: number; name: string; timezone?: string } | null;
}

export const classifyJobKey = (messageId: number) => `ai.classify:msg:${messageId}`;

// A lead replied: record it, stop or hold its campaigns, and have the reply classified.
export function handleInboundReply(ctx: Ctx, r: InboundReply) {
  const now = ctx.clock.now();
  const { lead } = r;
  ctx.db.update('leads', lead.id, { replied_at: now });
  const active = ctx.db.all<CampaignLeadRow & { c_settings: string }>(
    "SELECT cl.*, c.settings AS c_settings FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.lead_id = ? AND cl.state = 'active' AND c.workspace_id = ?",
    [lead.id, lead.workspace_id],
  );
  ctx.db.tx(() => {
    for (const cl of active) {
      const settings = campaignSettings({ settings: cl.c_settings } as CampaignRow);
      if (!settings.stopOnReply) {
        // Conditions such as "has replied" or "reply is" look again now.
        ctx.db.run("UPDATE campaign_leads SET next_run_at = ? WHERE id = ? AND node_type = 'condition' AND hold_reason IS NULL", [now, cl.id]);
      } else if (!settings.continueOnCategories.length) {
        stopCampaignLead(ctx, cl, 'replied');
      } else {
        // Held until the reply is classified (the classify job releases or stops it) or the hold runs out.
        ctx.db.update('campaign_leads', cl.id, { hold_reason: 'reply', next_run_at: now + ctx.config.replyHoldMin * MINUTE });
      }
    }
    logActivity(ctx, {
      workspaceId: lead.workspace_id,
      accountId: r.account?.id,
      campaignId: active[0]?.campaign_id,
      leadId: lead.id,
      type: 'replied',
      detail: r.body.slice(0, 500),
      timezone: r.account?.timezone,
    });
  });
  ctx.webhooks.emit(lead.workspace_id, 'lead.replied', {
    lead: publicLead({ ...lead, replied_at: now }),
    message: r.body,
    ...(r.account ? { account: { id: r.account.id, name: r.account.name } } : {}),
    channel: r.channel,
  });
  if (r.messageId) ctx.jobs.enqueue('ai.classify', { messageId: r.messageId }, { workspaceId: lead.workspace_id, dedupeKey: classifyJobKey(r.messageId) });
}

// A reply was classified (or its category set by hand): held campaign leads go on or stop, and
// conditions waiting on the category look again.
export function resolveReplyHolds(ctx: Ctx, leadId: number) {
  const now = ctx.clock.now();
  const lead = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [leadId]);
  if (!lead) return;
  const held = ctx.db.all<CampaignLeadRow & { c_settings: string }>(
    "SELECT cl.*, c.settings AS c_settings FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.lead_id = ? AND cl.state = 'active' AND cl.hold_reason = 'reply'",
    [leadId],
  );
  ctx.db.tx(() => {
    for (const cl of held) {
      const decision = replyDecision(campaignSettings({ settings: cl.c_settings } as CampaignRow), lead);
      if (decision === 'stop') stopCampaignLead(ctx, cl, 'replied');
      else if (decision !== 'pending') ctx.db.update('campaign_leads', cl.id, { hold_reason: null, next_run_at: now });
    }
    ctx.db.run("UPDATE campaign_leads SET next_run_at = ? WHERE lead_id = ? AND state = 'active' AND node_type = 'condition' AND hold_reason IS NULL", [now, leadId]);
  });
}
