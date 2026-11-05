import { AI_RECHECK, aiNamesIn, nodeTexts, prefetchAi, resolveAiVars } from '../ai/personalize.js';
import { DAY, HOUR, MINUTE } from '../clock.js';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { DriverError, type LinkedInDriver } from '../drivers/types.js';
import { CONTACT_ACTIVITY_TYPES, logActivity } from '../services/activity.js';
import { MailRunner } from '../mail/runner.js';
import { MessagingRunner } from '../messaging/runner.js';
import { newMessageId } from '../mail/compose.js';
import type { SmtpConfig } from '../services/email.js';
import { replyDecision, replyHoldDeadline, replySince } from '../services/replies.js';
import { suppressionReason } from '../services/suppression.js';
import { emailVerified, enrichmentSettings, findEmailGate } from '../services/enrichment.js';
import { skipOpenTasks, taskGate } from '../services/tasks.js';
import { blacklistReason, campaignSequence, campaignSettings, enrichLead, publicLead } from '../services/leads.js';
import { campaignAccountIds, chooseSender, connectedSender, connectionWith, isLegacy, pinLead, releaseUnstartedLeads, setConnection, type CapacityCache } from '../services/rotation.js';
import type { AccountRow, CampaignLeadRow, CampaignLeadState, CampaignRow, ConnectionStatus, LeadRow } from '../types.js';
import { exhaustedActions, nextWorkingDay, schedule } from './capacity.js';
import { isWorkingTime, randomDelay } from './limits.js';
import { ACTION_TYPES, FREE_NODE_TYPES, isVariantNode, withVariant, type ActionType, type SeqNode } from './sequence.js';
import { syncAccount } from './sync.js';
import { clampNote, leadVars, render } from './template.js';
import { assignVariant } from './variants.js';

// Kept here too: routes and tests import them from the engine.
export { accountLimits, exhaustedActions, schedule, usage } from './capacity.js';

const MAX_ATTEMPTS = 3;
const FREE_STEPS_PER_TICK = 2000;
// How many due leads an account looks through per tick for one it may act on.
const ACTION_CANDIDATES = 20;
// How long a lead is held for the account acting on it.
const ACTION_LEASE = 10 * MINUTE;
// What LinkedIn accepts once variables are filled in (InMail subject/body, message); longer text is shortened.
const RENDERED_MAX = { message: 8000, inmailSubject: 200, inmailBody: 1900, emailSubject: 300 };

type DueJob = CampaignLeadRow & { c_seq: string; c_settings: string; c_name: string };

class StopAccount extends Error {}

export class Engine {
  private busy = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private capacity: CapacityCache = new Map();
  // Email steps of campaigns that have mailboxes (they don't wait for a LinkedIn account).
  readonly mail: MailRunner;
  // SMS and WhatsApp steps, sent through the workspace's SMS provider.
  readonly messaging: MessagingRunner;

  constructor(private ctx: Ctx) {
    this.mail = new MailRunner(ctx, this);
    this.messaging = new MessagingRunner(ctx, this);
  }

  start() {
    this.timer = setInterval(() => void this.tick().catch((e) => console.error('[engine] tick failed', e)), this.ctx.config.tickMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Runs one pass: free steps (waits, conditions) for every campaign, then every active account
  // in parallel. Each account does at most one LinkedIn action per pass and then waits out its
  // randomized delay. Background jobs run in the same pass, so they only run where the engine runs.
  async tick(): Promise<void> {
    this.capacity = new Map();
    this.advanceFreeSteps();
    const accounts = this.ctx.db.all<AccountRow>("SELECT * FROM accounts WHERE status = 'active'");
    await Promise.all([
      this.ctx.jobs.tick().catch((e) => console.error('[jobs] tick failed', e)),
      this.mail.tick().catch((e) => console.error('[mail] tick failed', e)),
      this.messaging.tick().catch((e) => console.error('[messaging] tick failed', e)),
      ...accounts
        .filter((a) => !this.busy.has(a.id))
        .map(async (a) => {
          this.busy.add(a.id);
          try {
            await this.runAccount(a);
          } catch (e) {
            if (!(e instanceof StopAccount)) console.error(`[engine] account ${a.id}`, e);
          } finally {
            this.busy.delete(a.id);
          }
        }),
    ]);
  }

  async runAccount(a: AccountRow) {
    const { ctx } = this;
    const now = ctx.clock.now();
    const working = isWorkingTime(now, schedule(a));

    if (working && now - a.last_sync_at >= ctx.config.syncIntervalMin * MINUTE) {
      ctx.db.run('UPDATE accounts SET last_sync_at = ? WHERE id = ?', [now, a.id]);
      await this.guarded(a, () => syncAccount(ctx, a));
      // Accepted invites wake their leads; move them on before picking this pass's action.
      this.advanceFreeSteps();
    }

    if (!working || a.next_action_at > now) return;
    // A lead still waiting for its AI text is parked for a moment and the next candidate gets the
    // turn, so a slow AI provider never idles the sender.
    for (let tries = 0; tries < ACTION_CANDIDATES; tries++) {
      const job = this.nextActionJob(a);
      if (!job) return;
      const acted = await this.guarded(a, () => this.runAction(a, job));
      if (acted === 'ai_wait') continue;
      if (acted) {
        ctx.db.run('UPDATE accounts SET next_action_at = ? WHERE id = ?', [now + randomDelay(a.delay_min_sec, a.delay_max_sec, ctx.random), a.id]);
      }
      return;
    }
  }

  // Session problems stop the account until the user reconnects it. Leads it hasn't contacted
  // yet go back to the pool so the campaign's other senders can take them.
  private async guarded<T>(a: AccountRow, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isSessionError(e)) {
        await accountNeedsLogin(this.ctx, a, e.message);
        throw new StopAccount();
      }
      throw e;
    }
  }

  // Due leads this account may work on: pinned to it (even in campaigns it was since removed from,
  // so conversations finish from the same sender), then unassigned leads of its campaigns.
  private dueJobs(a: AccountRow, where: string, params: unknown[], limit: number): DueJob[] {
    return this.ctx.db.all<DueJob>(
      `SELECT cl.*, c.sequence AS c_seq, c.settings AS c_settings, c.name AS c_name
       FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
       WHERE c.status = 'active' AND c.workspace_id = ? AND cl.state = 'active' AND cl.next_run_at <= ? AND ${where}
         AND (cl.account_id = ? OR (cl.account_id IS NULL AND EXISTS (SELECT 1 FROM campaign_accounts ca WHERE ca.campaign_id = c.id AND ca.account_id = ?)))
       ORDER BY CASE WHEN cl.account_id IS NULL THEN 1 ELSE 0 END, cl.next_run_at, cl.id LIMIT ${limit}`,
      [a.workspace_id, this.ctx.clock.now(), ...(params as any[]), a.id, a.id],
    );
  }

  // Waits and conditions only read the database, so they advance immediately, any time of day.
  // A lead whose sender is paused or logged out stays frozen (its sync isn't running, so an
  // "accepted within" deadline must not run out); unassigned leads move while any sender is active.
  advanceFreeSteps() {
    const types = [...FREE_NODE_TYPES];
    const jobs = this.ctx.db.all<CampaignLeadRow>(
      `SELECT cl.* FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
       WHERE c.status = 'active' AND cl.state = 'active' AND cl.next_run_at <= ?
         AND (cl.node_type IN (${types.map(() => '?').join(',')}) OR cl.node_type IS NULL)
         AND ((cl.account_id IS NOT NULL AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = cl.account_id AND a.status = 'active'))
           OR (cl.account_id IS NULL AND EXISTS (SELECT 1 FROM campaign_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.campaign_id = c.id AND a.status = 'active'))
           OR (cl.account_id IS NULL AND EXISTS (SELECT 1 FROM campaign_mailboxes cm JOIN mailboxes m ON m.id = cm.mailbox_id WHERE cm.campaign_id = c.id AND m.status = 'active'))
           OR NOT EXISTS (SELECT 1 FROM campaign_accounts ca WHERE ca.campaign_id = c.id))
       ORDER BY cl.next_run_at, cl.id LIMIT ${FREE_STEPS_PER_TICK}`,
      [this.ctx.clock.now(), ...types],
    );
    for (const job of jobs) {
      const campaign = this.campaign(job.campaign_id);
      this.ctx.db.tx(() => this.walk(campaign, job));
    }
  }

  // The next lead this account should act on. Unassigned leads are offered to the campaign's best
  // sender; when that is another account the lead is pinned there and its own loop picks it up.
  private nextActionJob(a: AccountRow): DueJob | null {
    const blocked = exhaustedActions(this.ctx, a);
    const allowed = ACTION_TYPES.filter((t) => !blocked.includes(t));
    if (!allowed.length) return null;
    // Email steps of campaigns with mailboxes belong to the mail runner, not to the LinkedIn account.
    const candidates = this.dueJobs(
      a,
      `cl.node_type IN (${allowed.map(() => '?').join(',')}) AND NOT (cl.node_type = 'email' AND EXISTS (SELECT 1 FROM campaign_mailboxes cm WHERE cm.campaign_id = c.id))`,
      allowed,
      ACTION_CANDIDATES,
    );
    for (const job of candidates) {
      if (job.account_id === a.id) return job;
      const sender = chooseSender(this.ctx, this.campaign(job.campaign_id), this.lead(job.lead_id), job.node_type as ActionType, this.capacity);
      if (sender == null || !pinLead(this.ctx, job.id, sender)) continue;
      if (sender === a.id) return { ...job, account_id: a.id };
    }
    return null;
  }

  private campaign(id: number) {
    return this.ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [id])!;
  }

  private lead(id: number) {
    return this.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id])!;
  }

  // Connection as the lead's sender sees it. An unassigned lead connected to any of the campaign's
  // senders counts as connected and is pinned to that sender, which will message them.
  private connected(campaign: CampaignRow, job: CampaignLeadRow, lead: LeadRow): { connected: boolean; job: CampaignLeadRow } {
    if (job.account_id != null) return { connected: connectionWith(this.ctx, lead, job.account_id, campaign.account_id) === 'connected', job };
    const ids = campaignAccountIds(this.ctx, campaign.id);
    const via = connectedSender(this.ctx, lead.id, ids);
    if (via != null && pinLead(this.ctx, job.id, via)) return { connected: true, job: { ...job, account_id: via } };
    // Legacy leads without per-account rows only have the aggregate, credited to the first sender.
    const first = campaign.account_id;
    if (first != null && ids.includes(first) && isLegacy(this.ctx, lead) && lead.connection_status === 'connected' && pinLead(this.ctx, job.id, first)) {
      return { connected: true, job: { ...job, account_id: first } };
    }
    return { connected: false, job };
  }

  // Follows free nodes from the job's current position until it reaches an action, a wait
  // that isn't over yet, or the end of the sequence.
  walk(campaign: CampaignRow, job: CampaignLeadRow) {
    const seq = campaignSequence(campaign);
    const now = this.ctx.clock.now();
    let cur = job;
    // A lead held for its reply's category goes no further until the reply is classified (or the hold ends).
    if (cur.hold_reason === 'reply' && !this.replyGate(campaign, cur, this.lead(cur.lead_id))) return;
    for (let guard = 0; guard < 100; guard++) {
      const node = cur.node_id ? seq.nodes[cur.node_id] : undefined;
      if (!node) return this.finish(campaign, cur, 'done');
      if (node.type === 'wait') {
        const due = cur.node_entered_at + node.days * DAY + node.hours * HOUR;
        if (now < due) return this.ctx.db.update('campaign_leads', cur.id, { next_run_at: due });
        cur = this.moveTo(campaign, cur, node.next);
        continue;
      }
      if (node.type === 'condition') {
        const lead = this.lead(cur.lead_id);
        let branch: boolean;
        if (node.kind === 'is_connected') ({ connected: branch, job: cur } = this.connected(campaign, cur, lead));
        else if (node.kind === 'has_email') branch = !!lead.email;
        else if (node.kind === 'replied') branch = lead.replied_at != null;
        else if (node.kind === 'is_open_profile') branch = lead.open_profile === 1;
        else if (node.kind === 'email_verified') branch = emailVerified(lead, enrichmentSettings(this.ctx, campaign.workspace_id));
        else if (node.kind === 'reply_sentiment') {
          const reply = replySince(this.ctx, lead, cur.added_at);
          // Classification wakes this job; the recheck is a fallback.
          if (reply && typeof reply === 'object') return this.ctx.db.update('campaign_leads', cur.id, { next_run_at: Math.min(reply.until, now + AI_RECHECK) });
          branch = reply != null && (node.categories ?? []).includes(reply);
        } else {
          const deadline = cur.node_entered_at + node.withinDays * DAY;
          const c = this.connected(campaign, cur, lead);
          cur = c.job;
          if (c.connected) branch = true;
          else if (now >= deadline) branch = false;
          // Connection sync wakes this job as soon as the invite is accepted.
          else return this.ctx.db.update('campaign_leads', cur.id, { next_run_at: Math.min(deadline, now + 6 * HOUR) });
        }
        cur = this.moveTo(campaign, cur, branch ? node.yes : node.no);
        continue;
      }
      if (node.type === 'task') {
        if (taskGate(this.ctx, campaign, cur, node) === 'hold') return;
        cur = this.moveTo(campaign, { ...cur, hold_reason: null }, node.next);
        continue;
      }
      if (node.type === 'find_email') {
        if (findEmailGate(this.ctx, campaign, cur, node) === 'hold') return;
        cur = this.moveTo(campaign, { ...cur, hold_reason: null }, node.next);
        continue;
      }
      return; // an action: the scheduler picks it up when an account has capacity
    }
  }

  moveTo(campaign: CampaignRow, job: CampaignLeadRow, nextId: string | null): CampaignLeadRow {
    const seq = campaignSequence(campaign);
    const now = this.ctx.clock.now();
    const next = nextId ? seq.nodes[nextId] : undefined;
    if (!next) {
      this.finish(campaign, job, 'done');
      return { ...job, node_id: null, state: 'done' };
    }
    const patch = { node_id: next.id, node_type: next.type, node_entered_at: now, next_run_at: now, attempts: 0, last_error: null };
    this.ctx.db.update('campaign_leads', job.id, patch);
    // Start writing the step's AI variables now, so they are usually ready when it runs.
    prefetchAi(this.ctx, campaign, job, next);
    return { ...job, ...patch };
  }

  // Whether a lead that replied may go on in this campaign (see replyDecision). Stops it, or (re)holds it
  // until its reply is classified; the hold's deadline comes from replied_at, so spurious wake-ups
  // (sequence edits, syncs) re-hold it without moving the deadline.
  replyGate(campaign: CampaignRow, job: CampaignLeadRow, lead: LeadRow): boolean {
    const decision = replyDecision(campaignSettings(campaign), lead);
    if (decision === 'stop') return this.finish(campaign, job, 'replied'), false;
    if (decision === 'pending') {
      const deadline = replyHoldDeadline(this.ctx, lead);
      // Not classified in time: it counts as a reply like any other.
      if (this.ctx.clock.now() >= deadline) return this.finish(campaign, job, 'replied'), false;
      this.ctx.db.update('campaign_leads', job.id, { hold_reason: 'reply', next_run_at: deadline });
      return false;
    }
    if (job.hold_reason === 'reply') this.ctx.db.update('campaign_leads', job.id, { hold_reason: null });
    return true;
  }

  finish(campaign: CampaignRow, job: CampaignLeadRow, state: CampaignLeadState, error?: string) {
    const now = this.ctx.clock.now();
    this.ctx.db.update('campaign_leads', job.id, { state, finished_at: now, next_run_at: now, hold_reason: null, ...(error ? { last_error: error } : {}) });
    skipOpenTasks(this.ctx, job.id, `Lead left the campaign (${state})`);
    if (state === 'done' || state === 'failed') {
      const lead = this.lead(job.lead_id);
      this.ctx.webhooks.emit(campaign.workspace_id, state === 'done' ? 'lead.finished' : 'lead.failed', {
        campaign: { id: campaign.id, name: campaign.name },
        lead: publicLead(lead, this.ctx),
        ...(error ? { error } : {}),
      });
    }
  }

  // Performs the LinkedIn/email action at the job's node. Returns true if anything was sent
  // to LinkedIn (so the account should pause before its next action), 'ai_wait' when the lead was
  // parked to wait for its AI variables (the account may act on another lead right away).
  private async runAction(a: AccountRow, job: CampaignLeadRow): Promise<boolean | 'ai_wait'> {
    const { ctx } = this;
    const campaign = this.campaign(job.campaign_id);
    const seq = campaignSequence(campaign);
    const settings = campaignSettings(campaign);
    const step = seq.nodes[job.node_id!] as Exclude<SeqNode, { type: 'wait' | 'condition' | 'task' | 'find_email' | 'sms' | 'whatsapp' }>;
    let lead = this.lead(job.lead_id);
    const base: Parameters<typeof logActivity>[1] = { workspaceId: a.workspace_id, accountId: a.id, campaignId: campaign.id, leadId: lead.id, type: step.type, timezone: a.timezone, nodeId: step.id };

    if (settings.stopOnReply && lead.replied_at && !this.replyGate(campaign, job, lead)) return false;
    const banned = blacklistReason(ctx, lead);
    if (banned) {
      logActivity(ctx, { ...base, status: 'skipped', detail: banned });
      this.finish(campaign, job, 'skipped', banned);
      return false;
    }
    const suppressed = suppressionReason(ctx, lead);
    if (suppressed) {
      logActivity(ctx, { ...base, status: 'skipped', detail: suppressed });
      this.finish(campaign, job, 'skipped', suppressed);
      return false;
    }

    // Lease the lead while the action runs (a browser action takes seconds): if it is released
    // meanwhile, no other sender sees it as due until this one has finished and moved it on.
    if (ctx.db.run('UPDATE campaign_leads SET next_run_at = ? WHERE id = ? AND account_id = ?', [ctx.clock.now() + ACTION_LEASE, job.id, a.id]).changes === 0) return false;

    // A/B steps send the lead's variant; it is logged with every outcome so results can be split by it.
    const variant = isVariantNode(step) ? ctx.db.tx(() => assignVariant(ctx, campaign, job, step)) : null;
    const node = isVariantNode(step) ? withVariant(step, variant) : step;
    if (variant) base.variant = variant;

    const vars = leadVars({ ...lead, custom: json(lead.custom, {}) });
    const aiNames = aiNamesIn(nodeTexts(node));
    let aiSkipNotes: string[] = [];
    // (An email step for a lead without an address is skipped below, so it doesn't wait for AI text.)
    if (aiNames.length && !(node.type === 'email' && !lead.email)) {
      // Real people only ever get real AI text: a browser account or real SMTP falls back from simulated text.
      const realChannel = node.type === 'email' ? !!ctx.sealer.open(a.smtp_enc) : a.driver !== 'simulator';
      const ai = resolveAiVars(ctx, campaign, job, aiNames, realChannel);
      if ('wait' in ai) {
        ctx.db.update('campaign_leads', job.id, { next_run_at: Math.min(ai.wait, ctx.clock.now() + AI_RECHECK) });
        return 'ai_wait';
      }
      for (const n of ai.notes) if (n.status === 'failed') logActivity(ctx, { ...base, type: 'ai_personalize', status: n.status, detail: n.detail });
      aiSkipNotes = ai.notes.filter((n) => n.status === 'skipped').map((n) => n.detail);
      Object.assign(vars, ai.values);
    }
    const advance = (status: 'ok' | 'skipped', detail?: string) => {
      ctx.db.tx(() => {
        // Queued first, so receivers hear about the send before the stage change it causes (both after commit).
        if (status === 'ok') {
          ctx.db.afterCommit(() =>
            ctx.webhooks.emit(a.workspace_id, 'action.performed', {
              type: node.type,
              detail,
              ...(variant ? { nodeId: node.id, variant } : {}),
              campaign: { id: campaign.id, name: campaign.name },
              lead: publicLead(this.lead(lead.id), ctx),
              account: { id: a.id, name: a.name },
            }),
          );
        }
        // Logged once, with the step's outcome: a retried or held step would repeat them otherwise.
        for (const d of aiSkipNotes) logActivity(ctx, { ...base, type: 'ai_personalize', status: 'skipped', detail: d });
        logActivity(ctx, { ...base, status, detail });
        // From the first real contact on, the lead stays with this sender. The pin is written again
        // because a pause or sender change may have released the lead while the action ran.
        if (status === 'ok' && job.contacted_at == null && (CONTACT_ACTIVITY_TYPES as readonly string[]).includes(node.type)) {
          ctx.db.update('campaign_leads', job.id, { contacted_at: ctx.clock.now(), account_id: a.id });
        }
        const moved = this.moveTo(campaign, job, node.next);
        if (moved.state === 'active') this.walk(campaign, moved);
      });
    };

    try {
      if (node.type === 'email') {
        if (!lead.email) return advance('skipped', 'no email address'), false;
        // Legacy path (campaigns without mailboxes): the account's own SMTP settings, if any.
        const raw = ctx.sealer.open(a.smtp_enc);
        const smtp = raw ? (JSON.parse(raw) as SmtpConfig) : null;
        // Addresses made up by the simulated finder never go out through a real server.
        if (smtp && lead.email_source === 'simulated') return advance('skipped', 'address made up by the simulated email finder: never sent from a real mailbox'), false;
        const subject = fitRendered(render(node.subject, vars, ctx.random), RENDERED_MAX.emailSubject);
        const from = smtp ? smtp.from || smtp.user : '';
        const how = await ctx.mailer.send(smtp && { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, pass: smtp.pass }, {
          from,
          to: lead.email,
          subject: subject.text,
          text: render(node.body, vars, ctx.random),
          messageId: newMessageId(/<([^>]+)>/.exec(from)?.[1] ?? from, ctx.random),
        });
        advance('ok', (how.status === 'simulated' ? `${subject.text} (not delivered: no SMTP configured)` : subject.text) + subject.note);
        return false;
      }

      const conn = connectionWith(ctx, lead, a.id, campaign.account_id);
      // An InMail to a connection goes out as a regular message, so it is logged and limited as one:
      // otherwise InMail steps could push the account past its own daily message cap.
      if (node.type === 'inmail' && conn === 'connected') {
        base.type = 'message';
        if (exhaustedActions(ctx, a).includes('message')) {
          const cooldown = json<Record<string, number>>(a.cooldowns, {}).message ?? 0;
          ctx.db.update('campaign_leads', job.id, { next_run_at: Math.max(nextWorkingDay(ctx.clock.now(), a), cooldown) });
          return false;
        }
      }
      const outcome = await ctx.drivers.use(a, async (d) => {
        // An import may have had the browser while this action waited for it; keep the pause after it.
        const held = ctx.db.get<{ next_action_at: number }>('SELECT next_action_at FROM accounts WHERE id = ?', [a.id])!.next_action_at > ctx.clock.now();
        return held ? null : this.perform(d, node, lead, conn, vars, settings.noteLimit);
      });
      if (!outcome) {
        ctx.db.update('campaign_leads', job.id, { next_run_at: job.next_run_at });
        return false;
      }
      if (outcome.lead) lead = enrichLead(ctx, lead, outcome.lead, a.id);
      // Connection state is tracked per sender; the lead's own status is the aggregate.
      if (outcome.connection) setConnection(ctx, lead.id, a.id, outcome.connection);
      if (outcome.message) recordOutbound(ctx, a, lead, outcome.message);
      advance(outcome.status, outcome.detail);
      return true;
    } catch (e) {
      if (!(e instanceof DriverError)) {
        return this.retry(campaign, job, base, (e as Error).message), true;
      }
      switch (e.code) {
        case 'SESSION_EXPIRED':
        case 'CHECKPOINT':
          // Nothing was sent: drop the lease so the lead can go out from another sender right away.
          ctx.db.update('campaign_leads', job.id, { next_run_at: job.next_run_at });
          throw e;
        case 'NOT_AVAILABLE':
          advance('skipped', e.message);
          return true;
        case 'NOT_FOUND':
          logActivity(ctx, { ...base, status: 'failed', detail: e.message });
          this.finish(campaign, job, 'failed', e.message);
          return true;
        case 'LIMIT_REACHED': {
          // LinkedIn said no; back off this action type for a day. The lead stays where it is.
          const cooldowns = json<Record<string, number>>(a.cooldowns, {});
          cooldowns[base.type] = ctx.clock.now() + DAY;
          ctx.db.run('UPDATE accounts SET cooldowns = ? WHERE id = ?', [JSON.stringify(cooldowns), a.id]);
          logActivity(ctx, { ...base, status: 'failed', detail: e.message });
          return true;
        }
        default:
          this.retry(campaign, job, base, e.message);
          return true;
      }
    }
  }

  retry(campaign: CampaignRow, job: CampaignLeadRow, base: Parameters<typeof logActivity>[1], message: string) {
    const attempts = job.attempts + 1;
    logActivity(this.ctx, { ...base, status: 'failed', detail: message });
    if (attempts >= MAX_ATTEMPTS) return this.finish(campaign, job, 'failed', message);
    this.ctx.db.update('campaign_leads', job.id, { attempts, last_error: message, next_run_at: this.ctx.clock.now() + 30 * MINUTE * attempts });
  }

  // `conn` is the lead's connection with the acting account (not with any account).
  private async perform(
    d: LinkedInDriver,
    node: Exclude<SeqNode, { type: 'wait' | 'condition' | 'email' | 'task' | 'find_email' | 'sms' | 'whatsapp' }>,
    lead: LeadRow,
    conn: ConnectionStatus,
    vars: Record<string, string>,
    noteLimit: number,
  ): Promise<{ status: 'ok' | 'skipped'; detail?: string; lead?: Awaited<ReturnType<LinkedInDriver['viewProfile']>>; connection?: ConnectionStatus; message?: string }> {
    const url = lead.profile_url;
    switch (node.type) {
      case 'view_profile': {
        const p = await d.viewProfile(url);
        return { status: 'ok', lead: p };
      }
      case 'follow':
        await d.follow(url);
        return { status: 'ok' };
      case 'endorse': {
        const n = await d.endorse(url, node.count);
        return { status: 'ok', detail: `${n} skill${n === 1 ? '' : 's'}` };
      }
      case 'like_post': {
        const liked = await d.likeRecentPost(url);
        return liked ? { status: 'ok' } : { status: 'skipped', detail: 'no recent posts' };
      }
      case 'connect': {
        if (conn === 'connected') return { status: 'skipped', detail: 'already connected' };
        const note = node.note.trim() ? clampNote(render(node.note, vars, this.ctx.random), noteLimit) : '';
        const r = await d.connect(url, note);
        if (r === 'already_connected') return { status: 'skipped', detail: 'already connected', connection: 'connected' };
        if (r === 'already_pending') return { status: 'skipped', detail: 'invitation already pending', connection: 'pending' };
        return { status: 'ok', detail: note || undefined, connection: 'pending' };
      }
      case 'message': {
        const { text, note } = fitRendered(render(node.text, vars, this.ctx.random), RENDERED_MAX.message);
        await d.sendMessage(url, text);
        return { status: 'ok', detail: text + note, message: text, connection: 'connected' };
      }
      case 'withdraw_invite': {
        if (conn === 'connected') return { status: 'skipped', detail: 'already connected' };
        const done = await d.withdrawInvite(url);
        return done ? { status: 'ok', connection: 'none' } : { status: 'skipped', detail: 'no pending invitation' };
      }
      case 'inmail': {
        const s = fitRendered(render(node.subject, vars, this.ctx.random), RENDERED_MAX.inmailSubject);
        const b = fitRendered(render(node.body, vars, this.ctx.random), RENDERED_MAX.inmailBody);
        const [subject, body, note] = [s.text, b.text, s.note || b.note];
        // A connection can be messaged for free; spending an InMail credit on them would be a waste.
        if (conn === 'connected') {
          await d.sendMessage(url, body);
          return { status: 'ok', detail: `${subject} (sent as a message: already connected)${note}`, message: body };
        }
        await d.sendInMail(url, { subject, body, via: node.via });
        return { status: 'ok', detail: subject + note, message: body };
      }
    }
  }
}

// Text over a network's limit once variables (AI ones especially) are filled in is shortened, and the
// activity says so.
function fitRendered(text: string, limit: number): { text: string; note: string } {
  if (text.length <= limit) return { text, note: '' };
  return { text: clampNote(text, limit), note: ` (shortened from ${text.length} to ${limit} characters)` };
}

export function isSessionError(e: unknown): e is DriverError {
  return e instanceof DriverError && (e.code === 'SESSION_EXPIRED' || e.code === 'CHECKPOINT');
}

// Session problems stop the account until the user reconnects it (actions, syncs and imports alike).
export async function accountNeedsLogin(ctx: Ctx, a: AccountRow, reason: string) {
  ctx.db.run("UPDATE accounts SET status = 'needs_login', status_message = ? WHERE id = ?", [reason, a.id]);
  releaseUnstartedLeads(ctx, a.id);
  ctx.webhooks.emit(a.workspace_id, 'account.needs_login', { accountId: a.id, name: a.name, reason });
  await ctx.drivers.drop(a.id);
}

// Messages sent by campaigns show up in the inbox right away; the next inbox sync matches
// them to LinkedIn's copy by body text.
export function recordOutbound(ctx: Ctx, a: AccountRow, lead: LeadRow, body: string) {
  const now = ctx.clock.now();
  let conv = ctx.db.get<{ id: number }>('SELECT id FROM conversations WHERE account_id = ? AND lead_id = ?', [a.id, lead.id]);
  if (!conv) {
    const id = ctx.db.insert('conversations', {
      workspace_id: a.workspace_id,
      account_id: a.id,
      lead_id: lead.id,
      thread_id: `local-${lead.public_id}`,
      participant_name: `${lead.first_name} ${lead.last_name}`.trim(),
      participant_url: lead.profile_url,
      last_message_at: now,
    });
    conv = { id };
  }
  ctx.db.insert('messages', { conversation_id: conv.id, external_id: `local:${now}:${Math.round(ctx.random() * 1e9)}`, direction: 'out', body, sent_at: now });
  ctx.db.run('UPDATE conversations SET last_message_at = ? WHERE id = ?', [now, conv.id]);
}
