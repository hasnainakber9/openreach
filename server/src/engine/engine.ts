import { DAY, HOUR, MINUTE } from '../clock.js';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { DriverError, type LinkedInDriver } from '../drivers/types.js';
import { logActivity } from '../services/activity.js';
import type { SmtpConfig } from '../services/email.js';
import { blacklistReason, campaignSequence, campaignSettings, enrichLead, publicLead } from '../services/leads.js';
import type { AccountRow, CampaignLeadRow, CampaignLeadState, CampaignRow, LeadRow } from '../types.js';
import { effectiveLimits, isWorkingTime, localParts, randomDelay, type Limits, type Schedule } from './limits.js';
import { ACTION_TYPES, type ActionType, type SeqNode } from './sequence.js';
import { syncAccount } from './sync.js';
import { clampNote, leadVars, render } from './template.js';

const MAX_ATTEMPTS = 3;
const FREE_STEPS_PER_TICK = 500;

export function schedule(a: AccountRow): Schedule {
  return { timezone: a.timezone, work_days: json(a.work_days, [1, 2, 3, 4, 5]), work_start: a.work_start, work_end: a.work_end };
}

export function accountLimits(ctx: Ctx, a: AccountRow): Limits {
  return effectiveLimits(json(a.limits, {}), a.created_at, ctx.clock.now(), !!a.warmup);
}

// Today's successful actions per type for an account, plus connects over the last 7 days.
export function usage(ctx: Ctx, a: AccountRow): Record<string, number> {
  const now = ctx.clock.now();
  const today = localParts(now, a.timezone).date;
  const rows = ctx.db.all<{ type: string; n: number }>(
    "SELECT type, COUNT(*) AS n FROM activity WHERE account_id = ? AND day = ? AND status = 'ok' GROUP BY type",
    [a.id, today],
  );
  const out: Record<string, number> = Object.fromEntries(rows.map((r) => [r.type, r.n]));
  out.connect_weekly = ctx.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM activity WHERE account_id = ? AND type = 'connect' AND status = 'ok' AND created_at >= ?",
    [a.id, now - 7 * DAY],
  )!.n;
  return out;
}

export function exhaustedActions(ctx: Ctx, a: AccountRow): ActionType[] {
  const limits = accountLimits(ctx, a);
  const used = usage(ctx, a);
  const cooldowns = json<Record<string, number>>(a.cooldowns, {});
  const now = ctx.clock.now();
  return ACTION_TYPES.filter((t) => {
    if ((cooldowns[t] ?? 0) > now) return true;
    if ((used[t] ?? 0) >= limits[t]) return true;
    return t === 'connect' && used.connect_weekly >= limits.connect_weekly;
  });
}

class StopAccount extends Error {}

export class Engine {
  private busy = new Set<number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private ctx: Ctx) {}

  start() {
    this.timer = setInterval(() => void this.tick().catch((e) => console.error('[engine] tick failed', e)), this.ctx.config.tickMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Runs one pass over every active account. Accounts work in parallel; each account does
  // at most one LinkedIn action per pass and then waits out its randomized delay.
  async tick(): Promise<void> {
    const accounts = this.ctx.db.all<AccountRow>("SELECT * FROM accounts WHERE status = 'active'");
    await Promise.all(
      accounts
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
    );
  }

  async runAccount(a: AccountRow) {
    const { ctx } = this;
    const now = ctx.clock.now();
    const working = isWorkingTime(now, schedule(a));

    if (working && now - a.last_sync_at >= ctx.config.syncIntervalMin * MINUTE) {
      ctx.db.run('UPDATE accounts SET last_sync_at = ? WHERE id = ?', [now, a.id]);
      await this.guarded(a, () => syncAccount(ctx, a));
    }

    this.advanceFreeSteps(a);

    if (!working || a.next_action_at > now) return;
    const job = this.nextActionJob(a);
    if (!job) return;
    const acted = await this.guarded(a, () => this.runAction(a, job));
    if (acted) {
      ctx.db.run('UPDATE accounts SET next_action_at = ? WHERE id = ?', [now + randomDelay(a.delay_min_sec, a.delay_max_sec, ctx.random), a.id]);
    }
  }

  // Session problems stop the account until the user reconnects it.
  private async guarded<T>(a: AccountRow, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof DriverError && (e.code === 'SESSION_EXPIRED' || e.code === 'CHECKPOINT')) {
        this.ctx.db.run("UPDATE accounts SET status = 'needs_login', status_message = ? WHERE id = ?", [e.message, a.id]);
        this.ctx.webhooks.emit(a.workspace_id, 'account.needs_login', { accountId: a.id, name: a.name, reason: e.message });
        await this.ctx.drivers.drop(a.id);
        throw new StopAccount();
      }
      throw e;
    }
  }

  private dueJobs(a: AccountRow, where: string, params: any[], limit: number) {
    return this.ctx.db.all<CampaignLeadRow & { c_seq: string; c_settings: string; c_name: string }>(
      `SELECT cl.*, c.sequence AS c_seq, c.settings AS c_settings, c.name AS c_name
       FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
       WHERE c.account_id = ? AND c.status = 'active' AND cl.state = 'active' AND cl.next_run_at <= ? AND ${where}
       ORDER BY cl.next_run_at, cl.id LIMIT ${limit}`,
      [a.id, this.ctx.clock.now(), ...params],
    );
  }

  // Waits and conditions only read the database, so they advance immediately, any time of day.
  advanceFreeSteps(a: AccountRow) {
    const jobs = this.dueJobs(a, "(cl.node_type IN ('wait', 'condition') OR cl.node_type IS NULL)", [], FREE_STEPS_PER_TICK);
    for (const job of jobs) {
      const campaign = this.campaign(job.campaign_id);
      this.ctx.db.tx(() => this.walk(campaign, job));
    }
  }

  private nextActionJob(a: AccountRow) {
    const blocked = exhaustedActions(this.ctx, a);
    const allowed = ACTION_TYPES.filter((t) => !blocked.includes(t));
    if (!allowed.length) return null;
    return this.dueJobs(a, `cl.node_type IN (${allowed.map(() => '?').join(',')})`, allowed, 1)[0] ?? null;
  }

  private campaign(id: number) {
    return this.ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [id])!;
  }

  private lead(id: number) {
    return this.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id])!;
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
        if (node.kind === 'is_connected') branch = lead.connection_status === 'connected';
        else if (node.kind === 'has_email') branch = !!lead.email;
        else if (node.kind === 'replied') branch = lead.replied_at != null;
        else {
          const deadline = cur.node_entered_at + node.withinDays * DAY;
          if (lead.connection_status === 'connected') branch = true;
          else if (now >= deadline) branch = false;
          // Connection sync wakes this job as soon as the invite is accepted.
          else return this.ctx.db.update('campaign_leads', cur.id, { next_run_at: Math.min(deadline, now + 6 * HOUR) });
        }
        cur = this.moveTo(campaign, cur, branch ? node.yes : node.no);
        continue;
      }
      return; // an action: the scheduler picks it up when the account has capacity
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
    const node = seq.nodes[job.node_id!] as Exclude<SeqNode, { type: 'wait' | 'condition' }>;
    let lead = this.lead(job.lead_id);
    const base = { workspaceId: a.workspace_id, accountId: a.id, campaignId: campaign.id, leadId: lead.id, type: node.type, timezone: a.timezone };

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

    const vars = leadVars({ ...lead, custom: json(lead.custom, {}) });
    const advance = (status: 'ok' | 'skipped', detail?: string) => {
      ctx.db.tx(() => {
        logActivity(ctx, { ...base, status, detail });
        const moved = this.moveTo(campaign, job, node.next);
        if (moved.state === 'active') this.walk(campaign, moved);
      });
      if (status === 'ok') {
        ctx.webhooks.emit(a.workspace_id, 'action.performed', { type: node.type, detail, campaign: { id: campaign.id, name: campaign.name }, lead: publicLead(this.lead(lead.id)) });
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

      const outcome = await ctx.drivers.use(a, (d) => this.perform(d, node, lead, vars, settings.noteLimit));
      if (outcome.lead) lead = enrichLead(ctx, lead, outcome.lead);
      if (outcome.connection) {
        const patch: Record<string, unknown> = { connection_status: outcome.connection };
        if (outcome.connection === 'connected' && lead.connection_status !== 'connected') patch.connected_at = ctx.clock.now();
        ctx.db.update('leads', lead.id, patch as any);
      }
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

  private async perform(
    d: LinkedInDriver,
    node: Exclude<SeqNode, { type: 'wait' | 'condition' | 'email' }>,
    lead: LeadRow,
    vars: Record<string, string>,
    noteLimit: number,
  ): Promise<{ status: 'ok' | 'skipped'; detail?: string; lead?: Awaited<ReturnType<LinkedInDriver['viewProfile']>>; connection?: LeadRow['connection_status']; message?: string }> {
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
        if (lead.connection_status === 'connected') return { status: 'skipped', detail: 'already connected' };
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
        if (lead.connection_status === 'connected') return { status: 'skipped', detail: 'already connected' };
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
