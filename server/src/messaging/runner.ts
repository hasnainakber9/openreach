import { AI_RECHECK, aiNamesIn, nodeTexts, resolveAiVars } from '../ai/personalize.js';
import { MINUTE } from '../clock.js';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { isWorkingTime, localParts, randomDelay } from '../engine/limits.js';
import { CHANNEL_NODE_TYPES, SMS_MAX, withVariant, type ChannelNodeType, type SeqNode } from '../engine/sequence.js';
import { clampNote, leadVars, render } from '../engine/template.js';
import { assignVariant } from '../engine/variants.js';
import type { StepHost } from '../mail/runner.js';
import { ProviderError } from '../providers/http.js';
import type { SmsPolicy, SmsProvider } from '../providers/sms/types.js';
import { logActivity, type ActivityInput } from '../services/activity.js';
import { blacklistReason, campaignSequence, campaignSettings, publicLead } from '../services/leads.js';
import { normalizePhone, suppressionReason } from '../services/suppression.js';
import { recordUsage } from '../services/usage.js';
import type { CampaignLeadRow, CampaignRow, LeadRow } from '../types.js';

// Sends the SMS and WhatsApp steps of every workspace through its SMS provider (Twilio, or the simulator that
// transmits nothing). Per workspace: only inside the provider's sending window, under each channel's daily
// limit, one message per tick with a random 20–60 s gap between messages.

type ChannelNode = Extract<SeqNode, { type: ChannelNodeType }>;
type Outcome = 'sent' | 'next' | 'stop';

const CANDIDATES = 20;
const LEASE = 10 * MINUTE;
const GAP_MIN_SEC = 20;
const GAP_MAX_SEC = 60;
// A provider that refuses our credentials or has run out of credit is left alone for a while.
const PROVIDER_PAUSE = 30 * MINUTE;

export const phoneThreadId = (channel: ChannelNodeType, phone: string) => `${channel}:${phone}`;

// Today's sends on a channel in the policy's time zone (the daily limit counts these).
export function sentToday(ctx: Ctx, workspaceId: number, channel: ChannelNodeType, policy: SmsPolicy): number {
  const day = localParts(ctx.clock.now(), policy.timezone).date;
  return ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE workspace_id = ? AND day = ? AND type = ? AND status = 'ok'", [workspaceId, day, channel])!.n;
}

export function dailyLimit(policy: SmsPolicy, channel: ChannelNodeType) {
  return channel === 'sms' ? policy.smsDailyLimit : policy.whatsappDailyLimit;
}

export function inSendingWindow(ms: number, policy: SmsPolicy) {
  return isWorkingTime(ms, { timezone: policy.timezone, work_days: [0, 1, 2, 3, 4, 5, 6], work_start: policy.sendStart, work_end: policy.sendEnd });
}

// SMS/WhatsApp threads show in the unified inbox, one per workspace, channel and phone number.
export function recordPhoneMessage(
  ctx: Ctx,
  m: { workspaceId: number; channel: ChannelNodeType; phone: string; lead: LeadRow | null; direction: 'in' | 'out'; externalId: string; body: string },
): { conversationId: number; messageId: number } {
  const now = ctx.clock.now();
  const thread = phoneThreadId(m.channel, m.phone);
  let conv = ctx.db.get<{ id: number; lead_id: number | null }>(
    'SELECT id, lead_id FROM conversations WHERE workspace_id = ? AND channel = ? AND thread_id = ? AND account_id IS NULL AND mailbox_id IS NULL',
    [m.workspaceId, m.channel, thread],
  );
  if (!conv) {
    const id = ctx.db.insert('conversations', {
      workspace_id: m.workspaceId,
      channel: m.channel,
      account_id: null,
      mailbox_id: null,
      lead_id: m.lead?.id ?? null,
      thread_id: thread,
      participant_name: m.lead ? `${m.lead.first_name} ${m.lead.last_name}`.trim() : m.phone,
      participant_url: m.lead?.profile_url ?? '',
      participant_address: m.phone,
      last_message_at: now,
    });
    conv = { id, lead_id: m.lead?.id ?? null };
  } else if (conv.lead_id == null && m.lead) {
    ctx.db.update('conversations', conv.id, { lead_id: m.lead.id, participant_name: `${m.lead.first_name} ${m.lead.last_name}`.trim(), participant_url: m.lead.profile_url });
  }
  const messageId = ctx.db.insert('messages', { conversation_id: conv.id, external_id: m.externalId, direction: m.direction, body: m.body, sent_at: now });
  ctx.db.run(`UPDATE conversations SET last_message_at = ?${m.direction === 'in' ? ', unread = 1' : ''} WHERE id = ?`, [now, conv.id]);
  return { conversationId: conv.id, messageId };
}

export class MessagingRunner {
  // Ticks overlap (setInterval) while a provider is slow; a workspace already sending is skipped.
  private busy = new Set<number>();
  // Per workspace: the earliest next send (the gap between messages) or the end of a provider pause.
  private nextAt = new Map<number, number>();

  constructor(
    private ctx: Ctx,
    private host: StepHost,
  ) {}

  async tick(): Promise<void> {
    const { ctx } = this;
    const types = [...CHANNEL_NODE_TYPES];
    const workspaces = ctx.db.all<{ workspace_id: number }>(
      `SELECT DISTINCT c.workspace_id FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
       WHERE c.status = 'active' AND cl.state = 'active' AND cl.next_run_at <= ? AND cl.node_type IN (${types.map(() => '?').join(',')})`,
      [ctx.clock.now(), ...types],
    );
    await Promise.all(
      workspaces
        .map((w) => w.workspace_id)
        .filter((ws) => !this.busy.has(ws))
        .map(async (ws) => {
          this.busy.add(ws);
          try {
            await this.runWorkspace(ws);
          } catch (e) {
            console.error(`[messaging] workspace ${ws}`, e);
          } finally {
            this.busy.delete(ws);
          }
        }),
    );
  }

  async runWorkspace(workspaceId: number) {
    const { ctx } = this;
    const now = ctx.clock.now();
    if ((this.nextAt.get(workspaceId) ?? 0) > now) return;
    const provider = ctx.providers.get(workspaceId, 'sms');
    if (!provider || !inSendingWindow(now, provider.policy)) return;
    const full = new Set<ChannelNodeType>(CHANNEL_NODE_TYPES.filter((ch) => sentToday(ctx, workspaceId, ch, provider.policy) >= dailyLimit(provider.policy, ch)));
    if (full.size === CHANNEL_NODE_TYPES.length) return;
    const open = CHANNEL_NODE_TYPES.filter((ch) => !full.has(ch));
    const jobs = ctx.db.all<CampaignLeadRow>(
      `SELECT cl.* FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
       WHERE c.status = 'active' AND c.workspace_id = ? AND cl.state = 'active' AND cl.next_run_at <= ? AND cl.node_type IN (${open.map(() => '?').join(',')})
       ORDER BY cl.next_run_at, cl.id LIMIT ${CANDIDATES}`,
      [workspaceId, now, ...open],
    );
    for (const job of jobs) {
      const outcome = await this.send(provider, job);
      if (outcome === 'next') continue;
      if (outcome === 'sent') this.nextAt.set(workspaceId, now + randomDelay(GAP_MIN_SEC, GAP_MAX_SEC, ctx.random));
      if (outcome === 'stop') this.nextAt.set(workspaceId, now + PROVIDER_PAUSE);
      return;
    }
  }

  private async send(provider: SmsProvider, job: CampaignLeadRow): Promise<Outcome> {
    const { ctx, host } = this;
    const campaign = ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [job.campaign_id])!;
    const step = campaignSequence(campaign).nodes[job.node_id ?? ''];
    if (!step || (step.type !== 'sms' && step.type !== 'whatsapp')) return 'next';
    const channel = step.type;
    const policy = provider.policy;
    const settings = campaignSettings(campaign);
    const lead = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [job.lead_id])!;
    const base: ActivityInput = { workspaceId: campaign.workspace_id, accountId: null, campaignId: campaign.id, leadId: lead.id, type: channel, timezone: policy.timezone, nodeId: step.id };

    let aiSkipNotes: string[] = [];
    let variant: string | null = null;
    const advance = (status: 'ok' | 'skipped', detail?: string) => {
      ctx.db.tx(() => {
        for (const d of aiSkipNotes) logActivity(ctx, { ...base, type: 'ai_personalize', status: 'skipped', detail: d });
        logActivity(ctx, { ...base, status, detail });
        const moved = host.moveTo(campaign, job, step.next);
        if (moved.state === 'active') host.walk(campaign, moved);
      });
      if (status === 'ok') {
        ctx.webhooks.emit(campaign.workspace_id, 'action.performed', {
          type: channel,
          detail,
          ...(variant ? { nodeId: step.id, variant } : {}),
          campaign: { id: campaign.id, name: campaign.name },
          lead: publicLead(ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [lead.id])!),
        });
      }
    };

    if (settings.stopOnReply && lead.replied_at && !host.replyGate(campaign, job, lead)) return 'next';
    const blocked = blacklistReason(ctx, lead) ?? suppressionReason(ctx, lead);
    if (blocked) {
      logActivity(ctx, { ...base, status: 'skipped', detail: blocked });
      host.finish(campaign, job, 'skipped', blocked);
      return 'next';
    }
    const phone = normalizePhone(lead.phone, policy.defaultCountryCode);
    if (!phone) return advance('skipped', lead.phone ? 'No phone number in international format' : 'No phone number'), 'next';
    // A number that texted STOP is suppressed even when it is written differently on the lead.
    if (ctx.db.get("SELECT 1 FROM suppressions WHERE workspace_id = ? AND kind = 'phone' AND value = ?", [campaign.workspace_id, phone])) {
      const reason = 'Suppressed: this phone number opted out';
      logActivity(ctx, { ...base, status: 'skipped', detail: reason });
      host.finish(campaign, job, 'skipped', reason);
      return 'next';
    }
    // A channel without a sender is skipped, never a provider-wide pause that would hold up the other channel.
    if (channel === 'sms' && !policy.sms) return advance('skipped', 'SMS is not set up in the SMS integration'), 'next';
    if (channel === 'whatsapp' && !policy.whatsapp) return advance('skipped', 'WhatsApp is not set up in the SMS integration'), 'next';

    // Lease the lead while it sends, so an overlapping tick doesn't send it twice.
    if (ctx.db.run("UPDATE campaign_leads SET next_run_at = ? WHERE id = ? AND state = 'active' AND next_run_at <= ?", [ctx.clock.now() + LEASE, job.id, ctx.clock.now()]).changes === 0) return 'next';

    variant = step.type === 'sms' ? ctx.db.tx(() => assignVariant(ctx, campaign, job, step)) : null;
    const node = (step.type === 'sms' ? withVariant(step, variant as any) : step) as ChannelNode;
    if (variant) base.variant = variant;

    const vars = leadVars({ ...lead, custom: json(lead.custom, {}) });
    const aiNames = aiNamesIn(nodeTexts(node));
    if (aiNames.length) {
      // Simulated AI text only ever goes out through the simulated provider.
      const ai = resolveAiVars(ctx, campaign, job, aiNames, !provider.simulated);
      if ('wait' in ai) {
        ctx.db.update('campaign_leads', job.id, { next_run_at: Math.min(ai.wait, ctx.clock.now() + AI_RECHECK) });
        return 'next';
      }
      for (const n of ai.notes) if (n.status === 'failed') logActivity(ctx, { ...base, type: 'ai_personalize', status: n.status, detail: n.detail });
      aiSkipNotes = ai.notes.filter((n) => n.status === 'skipped').map((n) => n.detail);
      Object.assign(vars, ai.values);
    }

    const rendered = render(node.text, vars, ctx.random);
    const body = rendered.length > SMS_MAX ? clampNote(rendered, SMS_MAX) : rendered;
    const note = rendered.length > SMS_MAX ? ` (shortened from ${rendered.length} to ${SMS_MAX} characters)` : '';
    const template = node.type === 'whatsapp' && node.contentSid ? node : null;
    const contentVariables = template?.contentVariables ? Object.fromEntries(Object.entries(template.contentVariables).map(([k, v]) => [k, render(v, vars, ctx.random)])) : undefined;

    let externalId: string;
    try {
      externalId = (await provider.send({ channel, to: phone, body, ...(template ? { contentSid: template.contentSid, contentVariables } : {}) })).externalId;
    } catch (e) {
      const message = e instanceof ProviderError ? e.message : (e as Error).message;
      // A refusal raised before any request (no status) is the integration's setup, not this lead's number.
      const setup = e instanceof ProviderError && e.status == null && e.code === 'BAD_REQUEST';
      if (e instanceof ProviderError && (e.code === 'AUTH' || e.code === 'QUOTA' || setup)) {
        // Nothing was sent and every other message would fail the same way: keep the lead's place.
        ctx.db.update('campaign_leads', job.id, { next_run_at: job.next_run_at });
        if (e.integrationId) ctx.providers.markStatus(e.integrationId, 'error', message);
        logActivity(ctx, { ...base, status: 'failed', detail: message });
        return 'stop';
      }
      // Twilio refuses some numbers outright (invalid, landline, unsubscribed): skip the step for this lead.
      if (e instanceof ProviderError && (e.code === 'BAD_REQUEST' || e.code === 'NOT_FOUND')) {
        advance('skipped', message);
        return 'sent';
      }
      host.retry(campaign, job, base, message);
      return 'sent';
    }

    // The message is out: nothing from here on may count as a failed send, or a retry would text the lead twice.
    if (!provider.simulated) recordUsage(ctx, { workspaceId: campaign.workspace_id, kind: 'sms', provider: provider.providerId, operation: `${channel}.send` });
    try {
      const shown = template ? `[WhatsApp template ${template.contentSid}] ${body}` : body;
      ctx.db.tx(() => recordPhoneMessage(ctx, { workspaceId: campaign.workspace_id, channel, phone, lead, direction: 'out', externalId, body: shown }));
    } catch (e) {
      console.error(`[messaging] sent ${channel} to lead ${lead.id} but could not add it to the inbox`, e);
    }
    advance('ok', (provider.simulated ? `${body} (simulated: not delivered)` : body) + note);
    return 'sent';
  }
}
