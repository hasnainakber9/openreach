import { AI_RECHECK, aiNamesIn, nodeTexts, resolveAiVars } from '../ai/personalize.js';
import { MINUTE } from '../clock.js';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { isWorkingTime, randomDelay } from '../engine/limits.js';
import { campaignSequence, campaignSettings, blacklistReason, publicLead } from '../services/leads.js';
import { withVariant, type SeqNode } from '../engine/sequence.js';
import { leadVars, render } from '../engine/template.js';
import { assignVariant } from '../engine/variants.js';
import { logActivity, type ActivityInput } from '../services/activity.js';
import { mailError } from '../services/email.js';
import { pinMailServer } from '../services/hosts.js';
import { suppressionReason } from '../services/suppression.js';
import type { CampaignLeadRow, CampaignLeadState, CampaignRow, EmailMessageRow, LeadRow, MailboxRow } from '../types.js';
import { composeEmail, newMessageId, replySubject, type ThreadRef } from './compose.js';
import { splitReferences } from './imap.js';
import { syncJobKey } from './inbound.js';
import {
  chooseMailbox,
  fromLine,
  isReservedAddress,
  isSimulated,
  mailboxNeedsAttention,
  mailboxSchedule,
  needsPublicUrl,
  pinMailbox,
  remainingToday,
  smtpTransport,
  type MailboxCapacityCache,
} from './mailboxes.js';
import { mailLinks, signToken } from './tracking.js';

// Sends the email steps of campaigns that have mailboxes. Each active mailbox, inside its sending
// window, past its random gap and under its (warm-up) daily limit, sends at most one email per tick.
// Campaigns without mailboxes keep the old path: email steps run in the LinkedIn account loop.

// What the engine lends the runner: the same sequence moves the LinkedIn loop uses.
export interface StepHost {
  replyGate(campaign: CampaignRow, job: CampaignLeadRow, lead: LeadRow): boolean;
  finish(campaign: CampaignRow, job: CampaignLeadRow, state: CampaignLeadState, error?: string): void;
  moveTo(campaign: CampaignRow, job: CampaignLeadRow, nextId: string | null): CampaignLeadRow;
  walk(campaign: CampaignRow, job: CampaignLeadRow): void;
  retry(campaign: CampaignRow, job: CampaignLeadRow, base: ActivityInput, message: string): void;
}

type EmailNode = Extract<SeqNode, { type: 'email' }>;
type Outcome = 'sent' | 'next' | 'stop';

const CANDIDATES = 20;
const LEASE = 10 * MINUTE;
const SUBJECT_MAX = 300;

export class MailRunner {
  // Ticks overlap (setInterval) while SMTP is slow; a mailbox already sending is skipped.
  private busy = new Set<number>();
  private capacity: MailboxCapacityCache = new Map();

  constructor(
    private ctx: Ctx,
    private host: StepHost,
  ) {}

  async tick(): Promise<void> {
    this.capacity = new Map();
    const boxes = this.ctx.db.all<MailboxRow>("SELECT * FROM mailboxes WHERE status IN ('active', 'paused')");
    this.scheduleSyncs(boxes);
    await Promise.all(
      boxes
        .filter((mb) => mb.status === 'active' && !this.busy.has(mb.id))
        .map(async (mb) => {
          this.busy.add(mb.id);
          try {
            await this.runMailbox(mb);
          } catch (e) {
            console.error(`[mail] mailbox ${mb.id}`, e);
          } finally {
            this.busy.delete(mb.id);
          }
        }),
    );
  }

  // Replies and bounces arrive at any hour, so syncs ignore the sending window (paused mailboxes too).
  private scheduleSyncs(boxes: MailboxRow[]) {
    const now = this.ctx.clock.now();
    for (const mb of boxes) {
      if (!isSimulated(mb) && !mb.imap_enc) continue;
      if (now - mb.last_sync_at < this.ctx.config.mailSyncIntervalMin * MINUTE) continue;
      this.ctx.db.run('UPDATE mailboxes SET last_sync_at = ? WHERE id = ?', [now, mb.id]);
      this.ctx.jobs.enqueue('email.sync', { mailboxId: mb.id }, { workspaceId: mb.workspace_id, dedupeKey: syncJobKey(mb.id) });
    }
  }

  async runMailbox(mb: MailboxRow) {
    const { ctx } = this;
    const now = ctx.clock.now();
    if (!isWorkingTime(now, mailboxSchedule(mb)) || mb.next_send_at > now || remainingToday(ctx, mb) <= 0) return;
    for (let tries = 0; tries < CANDIDATES; tries++) {
      const job = this.nextJob(mb);
      if (!job) return;
      // Campaign email needs a working unsubscribe link; a real mailbox can't send without it.
      if (!ctx.config.publicUrl && needsPublicUrl(mb)) return mailboxNeedsAttention(ctx, mb, 'Set PUBLIC_URL so emails can carry an unsubscribe link');
      if (!isSimulated(mb) && !smtpTransport(ctx, mb)) return mailboxNeedsAttention(ctx, mb, 'Add SMTP settings to send from this mailbox');
      const outcome = await this.send(mb, job);
      if (outcome === 'next') continue;
      if (outcome === 'sent') ctx.db.run('UPDATE mailboxes SET next_send_at = ? WHERE id = ?', [now + randomDelay(mb.gap_min_sec, mb.gap_max_sec, ctx.random), mb.id]);
      return;
    }
  }

  // The next due email step this mailbox should send: leads pinned to it first, then unassigned leads of
  // its campaigns, offered to the campaign's best mailbox (pinned there; another mailbox's loop sends it).
  private nextJob(mb: MailboxRow): CampaignLeadRow | null {
    const { ctx } = this;
    const rows = ctx.db.all<CampaignLeadRow>(
      `SELECT cl.* FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
       WHERE c.status = 'active' AND c.workspace_id = ? AND cl.state = 'active' AND cl.node_type = 'email' AND cl.next_run_at <= ?
         AND EXISTS (SELECT 1 FROM campaign_mailboxes cm WHERE cm.campaign_id = c.id)
         AND (cl.mailbox_id = ? OR (cl.mailbox_id IS NULL AND EXISTS (SELECT 1 FROM campaign_mailboxes cm WHERE cm.campaign_id = c.id AND cm.mailbox_id = ?)))
       ORDER BY CASE WHEN cl.mailbox_id IS NULL THEN 1 ELSE 0 END, cl.next_run_at, cl.id LIMIT ${CANDIDATES}`,
      [mb.workspace_id, ctx.clock.now(), mb.id, mb.id],
    );
    for (const job of rows) {
      if (job.mailbox_id === mb.id) return job;
      const campaign = ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [job.campaign_id])!;
      const chosen = chooseMailbox(ctx, campaign, { id: job.lead_id }, this.capacity, job.account_id);
      if (chosen == null || !pinMailbox(ctx, job.id, chosen)) continue;
      if (chosen === mb.id) return { ...job, mailbox_id: mb.id };
    }
    return null;
  }

  private async send(mb: MailboxRow, job: CampaignLeadRow): Promise<Outcome> {
    const { ctx, host } = this;
    const campaign = ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [job.campaign_id])!;
    const step = campaignSequence(campaign).nodes[job.node_id ?? ''];
    if (!step || step.type !== 'email') return 'next';
    const settings = campaignSettings(campaign);
    const lead = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [job.lead_id])!;
    const base: ActivityInput = { workspaceId: mb.workspace_id, accountId: null, mailboxId: mb.id, campaignId: campaign.id, leadId: lead.id, type: 'email', timezone: mb.timezone, nodeId: step.id };

    if (settings.stopOnReply && lead.replied_at && !host.replyGate(campaign, job, lead)) return 'next';
    const blocked = blacklistReason(ctx, lead) ?? suppressionReason(ctx, lead);
    if (blocked) {
      logActivity(ctx, { ...base, status: 'skipped', detail: blocked });
      host.finish(campaign, job, 'skipped', blocked);
      return 'next';
    }

    let aiSkipNotes: string[] = [];
    let variant: string | null = null;
    const advance = (status: 'ok' | 'skipped', detail?: string) => {
      ctx.db.tx(() => {
        // Queued first, so receivers hear about the send before the stage change it causes (both after commit).
        if (status === 'ok') {
          ctx.db.afterCommit(() =>
            ctx.webhooks.emit(mb.workspace_id, 'action.performed', {
              type: 'email',
              detail,
              ...(variant ? { nodeId: step.id, variant } : {}),
              campaign: { id: campaign.id, name: campaign.name },
              lead: publicLead(ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [lead.id])!, ctx),
              mailbox: { id: mb.id, name: mb.name },
            }),
          );
        }
        for (const d of aiSkipNotes) logActivity(ctx, { ...base, type: 'ai_personalize', status: 'skipped', detail: d });
        logActivity(ctx, { ...base, status, detail });
        const moved = host.moveTo(campaign, job, step.next);
        if (moved.state === 'active') host.walk(campaign, moved);
      });
    };

    if (!lead.email) return advance('skipped', 'no email address'), 'next';
    if (lead.email_status === 'invalid') return advance('skipped', `email address is invalid${lead.email_status_reason ? ` (${lead.email_status_reason})` : ''}`), 'next';
    if (!isSimulated(mb) && isReservedAddress(lead.email)) return advance('skipped', 'reserved test address (.example, .test, ...): never sent from a real mailbox'), 'next';
    if (!isSimulated(mb) && lead.email_source === 'simulated') return advance('skipped', 'address made up by the simulated email finder: never sent from a real mailbox'), 'next';

    // Lease the lead while it sends, so no other tick or mailbox sees it as due meanwhile.
    if (ctx.db.run("UPDATE campaign_leads SET next_run_at = ? WHERE id = ? AND mailbox_id = ? AND state = 'active'", [ctx.clock.now() + LEASE, job.id, mb.id]).changes === 0) return 'next';

    variant = ctx.db.tx(() => assignVariant(ctx, campaign, job, step));
    const node = withVariant(step, variant as any) as EmailNode;
    if (variant) base.variant = variant;

    const vars = leadVars({ ...lead, custom: json(lead.custom, {}) });
    const aiNames = aiNamesIn(nodeTexts(node));
    if (aiNames.length) {
      // Simulated AI text only ever goes out through a simulated mailbox.
      const ai = resolveAiVars(ctx, campaign, job, aiNames, !isSimulated(mb));
      if ('wait' in ai) {
        ctx.db.update('campaign_leads', job.id, { next_run_at: Math.min(ai.wait, ctx.clock.now() + AI_RECHECK) });
        return 'next';
      }
      for (const n of ai.notes) if (n.status === 'failed') logActivity(ctx, { ...base, type: 'ai_personalize', status: n.status, detail: n.detail });
      aiSkipNotes = ai.notes.filter((n) => n.status === 'skipped').map((n) => n.detail);
      Object.assign(vars, ai.values);
    }

    const thread = node.replyInThread ? threadFor(ctx, mb, campaign.id, lead.id) : null;
    let subject = render(node.subject, vars, ctx.random).trim();
    let note = '';
    if (subject.length > SUBJECT_MAX) {
      note = ` (shortened from ${subject.length} to ${SUBJECT_MAX} characters)`;
      subject = subject.slice(0, SUBJECT_MAX).trim();
    }
    if (thread) subject = replySubject(thread.subject);
    const body = render(node.body, vars, ctx.random);
    const messageId = newMessageId(mb.from_email, ctx.random);
    const now = ctx.clock.now();
    const rowId = ctx.db.insert('email_messages', {
      workspace_id: mb.workspace_id,
      mailbox_id: mb.id,
      campaign_id: campaign.id,
      lead_id: lead.id,
      node_id: node.id,
      variant,
      direction: 'out',
      message_id: messageId,
      in_reply_to: thread?.inReplyTo ?? null,
      refs: thread?.references.join(' ') || null,
      subject,
      from_email: mb.from_email,
      to_email: lead.email.trim(),
      status: 'sending',
      sent_at: now,
    });
    const links = mailLinks(ctx, { workspaceId: mb.workspace_id, leadId: lead.id, emailMessageId: rowId });
    const msg = composeEmail({
      from: fromLine(mb),
      fromEmail: mb.from_email,
      replyTo: mb.reply_to,
      to: lead.email.trim(),
      subject,
      body,
      signature: mb.signature,
      messageId,
      thread,
      links: links && {
        unsubscribe: links.unsubscribe,
        openPixel: settings.trackOpens ? links.openPixel : null,
        click: settings.trackClicks ? links.click : null,
      },
    });

    try {
      const transport = smtpTransport(ctx, mb);
      const r = await ctx.mailer.send(transport && (await pinMailServer(ctx, transport)), msg);
      ctx.db.tx(() => {
        const conv = recordConversation(ctx, mb, lead, thread, msg.subject, messageId, body);
        ctx.db.update('email_messages', rowId, {
          status: r.status,
          conversation_id: conv,
          tracking_token: settings.trackOpens || settings.trackClicks ? signToken(ctx, 'o', { workspaceId: mb.workspace_id, leadId: lead.id, emailMessageId: rowId }) : null,
        });
        advance('ok', (r.status === 'simulated' ? `${subject} (simulated mailbox: not delivered)` : subject) + note);
      });
      return 'sent';
    } catch (e) {
      const err = mailError(e);
      ctx.db.update('email_messages', rowId, { status: 'failed', error: err.message });
      if (err.code === 'AUTH') {
        // Nothing was sent: drop the lease so another mailbox can take the lead if it hasn't been emailed yet.
        ctx.db.update('campaign_leads', job.id, { next_run_at: job.next_run_at });
        mailboxNeedsAttention(ctx, mb, `SMTP login refused: ${err.message}`);
        return 'stop';
      }
      if (err.code === 'RECIPIENT') {
        ctx.db.update('leads', lead.id, { email_status: 'invalid', email_status_reason: `Refused by the mail server: ${err.message}`.slice(0, 300), email_status_at: ctx.clock.now() });
        advance('skipped', `address refused: ${err.message}`);
        return 'sent';
      }
      host.retry(campaign, job, base, err.message);
      return 'sent';
    }
  }
}

// The thread a "reply in the same thread" step continues: the lead's latest email from this mailbox in
// this campaign. Without one (first email, or it went from elsewhere) the step starts a new thread.
export function threadFor(ctx: Ctx, mb: MailboxRow, campaignId: number, leadId: number): ThreadRef | null {
  const prev = ctx.db.get<EmailMessageRow>(
    "SELECT * FROM email_messages WHERE campaign_id = ? AND lead_id = ? AND mailbox_id = ? AND direction = 'out' AND status IN ('sent', 'simulated', 'bounced') ORDER BY sent_at DESC, id DESC LIMIT 1",
    [campaignId, leadId, mb.id],
  );
  if (!prev) return null;
  const conv = prev.conversation_id ? ctx.db.get<{ subject: string | null }>('SELECT subject FROM conversations WHERE id = ?', [prev.conversation_id]) : undefined;
  return { inReplyTo: prev.message_id, references: [...splitReferences(prev.refs), prev.message_id], subject: conv?.subject || prev.subject.replace(/^re:\s*/i, '') };
}

// Outgoing email shows in the unified inbox as an email conversation, one per thread.
export function recordConversation(ctx: Ctx, mb: MailboxRow, lead: LeadRow, thread: ThreadRef | null, subject: string, messageId: string, body: string): number {
  const now = ctx.clock.now();
  const root = thread?.references[0] ?? messageId;
  let conv = ctx.db.get<{ id: number }>('SELECT id FROM conversations WHERE mailbox_id = ? AND thread_id = ?', [mb.id, root])?.id;
  if (!conv) {
    conv = ctx.db.insert('conversations', {
      workspace_id: mb.workspace_id,
      channel: 'email',
      account_id: null,
      mailbox_id: mb.id,
      lead_id: lead.id,
      thread_id: root,
      participant_name: `${lead.first_name} ${lead.last_name}`.trim(),
      participant_url: lead.profile_url,
      participant_address: (lead.email ?? '').trim().toLowerCase(),
      subject: subject.replace(/^re:\s*/i, '').slice(0, 300),
      last_message_at: now,
    });
  }
  ctx.db.insert('messages', { conversation_id: conv, external_id: messageId, direction: 'out', body, sent_at: now });
  ctx.db.run('UPDATE conversations SET last_message_at = ? WHERE id = ?', [now, conv]);
  return conv;
}
