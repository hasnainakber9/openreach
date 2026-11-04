import { DAY, HOUR, MINUTE } from '../clock.js';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { DriverError, type LinkedInDriver } from '../drivers/types.js';
import { CONTACT_ACTIVITY_TYPES, logActivity } from '../services/activity.js';
import type { SmtpConfig } from '../services/email.js';
import { suppressionReason } from '../services/suppression.js';
import { blacklistReason, campaignSequence, campaignSettings, enrichLead, publicLead } from '../services/leads.js';
import { campaignAccountIds, chooseSender, connectedSender, connectionWith, isLegacy, pinLead, releaseUnstartedLeads, setConnection, type CapacityCache } from '../services/rotation.js';
import type { AccountRow, CampaignLeadRow, CampaignLeadState, CampaignRow, ConnectionStatus, LeadRow } from '../types.js';
import { exhaustedActions, schedule } from './capacity.js';
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

type DueJob = CampaignLeadRow & { c_seq: string; c_settings: string; c_name: string };

class StopAccount extends Error {}

export class Engine {
  private busy = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private capacity: CapacityCache = new Map();

  constructor(private ctx: Ctx) {}

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
    const job = this.nextActionJob(a);
    if (!job) return;
    const acted = await this.guarded(a, () => this.runAction(a, job));
    if (acted) {
      ctx.db.run('UPDATE accounts SET next_action_at = ? WHERE id = ?', [now + randomDelay(a.delay_min_sec, a.delay_max_sec, ctx.random), a.id]);
    }
  }

  // Session problems stop the account until the user reconnects it. Leads it hasn't contacted
  // yet go back to the pool so the campaign's other senders can take them.
  private async guarded<T>(a: AccountRow, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof DriverError && (e.code === 'SESSION_EXPIRED' || e.code === 'CHECKPOINT')) {
        this.ctx.db.run("UPDATE accounts SET status = 'needs_login', status_message = ? WHERE id = ?", [e.message, a.id]);
        releaseUnstartedLeads(this.ctx, a.id);
        this.ctx.webhooks.emit(a.workspace_id, 'account.needs_login', { accountId: a.id, name: a.name, reason: e.message });
        await this.ctx.drivers.drop(a.id);
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
    const candidates = this.dueJobs(a, `cl.node_type IN (${allowed.map(() => '?').join(',')})`, allowed, ACTION_CANDIDATES);
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
  private walk(campaign: CampaignRow, job: CampaignLeadRow) {
    const seq = campaignSequence(campaign);
    const now = this.ctx.clock.now();
    let cur = job;
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
        else {
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
      return; // an action: the scheduler picks it up when an account has capacity
    }
  }

  private moveTo(campaign: CampaignRow, job: CampaignLeadRow, nextId: string | null): CampaignLeadRow {
    const seq = campaignSequence(campaign);
    const now = this.ctx.clock.now();
    const next = nextId ? seq.nodes[nextId] : undefined;
    if (!next) {
      this.finish(campaign, job, 'done');
      return { ...job, node_id: null, state: 'done' };
    }
    const patch = { node_id: next.id, node_type: next.type, node_entered_at: now, next_run_at: now, attempts: 0, last_error: null };
    this.ctx.db.update('campaign_leads', job.id, patch);
    return { ...job, ...patch };
  }

  private finish(campaign: CampaignRow, job: CampaignLeadRow, state: CampaignLeadState, error?: string) {
    const now = this.ctx.clock.now();
    this.ctx.db.update('campaign_leads', job.id, { state, finished_at: now, next_run_at: now, ...(error ? { last_error: error } : {}) });
    if (state === 'done' || state === 'failed') {
      const lead = this.lead(job.lead_id);
      this.ctx.webhooks.emit(campaign.workspace_id, state === 'done' ? 'lead.finished' : 'lead.failed', {
        campaign: { id: campaign.id, name: campaign.name },
        lead: publicLead(lead),
        ...(error ? { error } : {}),
      });
    }
  }

  // Performs the LinkedIn/email action at the job's node. Returns true if anything was sent
  // to LinkedIn (so the account should pause before its next action).
  private async runAction(a: AccountRow, job: CampaignLeadRow): Promise<boolean> {
    const { ctx } = this;
    const campaign = this.campaign(job.campaign_id);
    const seq = campaignSequence(campaign);
    const settings = campaignSettings(campaign);
    const step = seq.nodes[job.node_id!] as Exclude<SeqNode, { type: 'wait' | 'condition' }>;
    let lead = this.lead(job.lead_id);
    const base: Parameters<typeof logActivity>[1] = { workspaceId: a.workspace_id, accountId: a.id, campaignId: campaign.id, leadId: lead.id, type: step.type, timezone: a.timezone, nodeId: step.id };

    if (settings.stopOnReply && lead.replied_at) {
      this.finish(campaign, job, 'replied');
      return false;
    }
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
    const advance = (status: 'ok' | 'skipped', detail?: string) => {
      ctx.db.tx(() => {
        logActivity(ctx, { ...base, status, detail });
        // From the first real contact on, the lead stays with this sender. The pin is written again
        // because a pause or sender change may have released the lead while the action ran.
        if (status === 'ok' && job.contacted_at == null && (CONTACT_ACTIVITY_TYPES as readonly string[]).includes(node.type)) {
          ctx.db.update('campaign_leads', job.id, { contacted_at: ctx.clock.now(), account_id: a.id });
        }
        const moved = this.moveTo(campaign, job, node.next);
        if (moved.state === 'active') this.walk(campaign, moved);
      });
      if (status === 'ok') {
        ctx.webhooks.emit(a.workspace_id, 'action.performed', {
          type: node.type,
          detail,
          ...(variant ? { nodeId: node.id, variant } : {}),
          campaign: { id: campaign.id, name: campaign.name },
          lead: publicLead(this.lead(lead.id)),
          account: { id: a.id, name: a.name },
        });
      }
    };

    try {
      if (node.type === 'email') {
        if (!lead.email) return advance('skipped', 'no email address'), false;
        const smtp = ctx.sealer.open(a.smtp_enc);
        const subject = render(node.subject, vars, ctx.random);
        const how = await ctx.mailer.send(smtp ? (JSON.parse(smtp) as SmtpConfig) : null, lead.email, subject, render(node.body, vars, ctx.random));
        advance('ok', how === 'simulated' ? `${subject} (not delivered: no SMTP configured)` : subject);
        return false;
      }

      const conn = connectionWith(ctx, lead, a.id, campaign.account_id);
      const outcome = await ctx.drivers.use(a, (d) => this.perform(d, node, lead, conn, vars, settings.noteLimit));
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
          cooldowns[node.type] = ctx.clock.now() + DAY;
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

  private retry(campaign: CampaignRow, job: CampaignLeadRow, base: Parameters<typeof logActivity>[1], message: string) {
    const attempts = job.attempts + 1;
    logActivity(this.ctx, { ...base, status: 'failed', detail: message });
    if (attempts >= MAX_ATTEMPTS) return this.finish(campaign, job, 'failed', message);
    this.ctx.db.update('campaign_leads', job.id, { attempts, last_error: message, next_run_at: this.ctx.clock.now() + 30 * MINUTE * attempts });
  }

  // `conn` is the lead's connection with the acting account (not with any account).
  private async perform(
    d: LinkedInDriver,
    node: Exclude<SeqNode, { type: 'wait' | 'condition' | 'email' }>,
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
        const text = render(node.text, vars, this.ctx.random);
        await d.sendMessage(url, text);
        return { status: 'ok', detail: text, message: text, connection: 'connected' };
      }
      case 'withdraw_invite': {
        if (conn === 'connected') return { status: 'skipped', detail: 'already connected' };
        const done = await d.withdrawInvite(url);
        return done ? { status: 'ok', connection: 'none' } : { status: 'skipped', detail: 'no pending invitation' };
      }
    }
  }
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
