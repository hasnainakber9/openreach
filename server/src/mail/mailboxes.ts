import { billingEnabled, overPlanIds, overPlanMessage, withinPlan, withPlanLock } from '../billing/limits.js';
import { DAY } from '../clock.js';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { DEFAULT_LIMITS, isWorkingTime, localParts, nextWorkingTime, type Schedule } from '../engine/limits.js';
import { mask } from '../services/crypto.js';
import type { SmtpConfig, SmtpTransport } from '../services/email.js';
import { skipTasksOfStoppedLeads } from '../services/tasks.js';
import type { AccountRow, CampaignRow, LeadRow, MailboxRow } from '../types.js';
import { publicLinkBase, publicLinkProblem } from './tracking.js';

// Mailboxes are the workspace's sending addresses for email steps, separate from LinkedIn accounts.
// Each one keeps its own daily limit (with a warm-up ramp), sending window and random gaps, and a
// campaign can rotate leads across several of them like LinkedIn senders.

export interface ServerSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  // Set only right before connecting (pinMailServer), never saved.
  address?: string;
}

export interface MailboxPreset {
  id: 'gmail' | 'outlook' | 'custom';
  label: string;
  smtp: { host: string; port: number; secure: boolean } | null;
  imap: { host: string; port: number; secure: boolean } | null;
  // The SPF include the provider's own servers need (deliverability check).
  spfInclude: string | null;
  help: string;
}

// Both hosted providers need an app password (OAuth sign-in is not included).
export const MAILBOX_PRESETS: MailboxPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    spfInclude: '_spf.google.com',
    help: 'Turn on 2-step verification, then create an app password under Google Account → Security → App passwords and use it as the password for both SMTP and IMAP. Signing in with Google (OAuth) is not supported.',
  },
  {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    spfInclude: 'spf.protection.outlook.com',
    help: 'Use an app password (Microsoft account → Security → Advanced security options). Some Microsoft 365 tenants turn off SMTP AUTH; your admin can enable it per mailbox. Signing in with Microsoft (OAuth) is not supported.',
  },
  {
    id: 'custom',
    label: 'Other SMTP / IMAP server',
    smtp: null,
    imap: null,
    spfInclude: null,
    help: 'Use the SMTP and IMAP settings from your email provider. Port 465 uses TLS from the start; 587 upgrades with STARTTLS.',
  },
];

export const presetById = (id: string) => MAILBOX_PRESETS.find((p) => p.id === id) ?? MAILBOX_PRESETS[2];

export const isSimulated = (mb: Pick<MailboxRow, 'provider'>) => mb.provider === 'simulated';

// Why a mailbox can't send campaign email for lack of an unsubscribe link, or null. Every campaign email
// offers an opt-out: an unsubscribe link when PUBLIC_URL is a public https address, otherwise (reply mode)
// a footer asking people to reply "unsubscribe", which inbound mail detection honours, so the mailbox must
// have IMAP for those replies to be read. A self-hosted install, often a laptop nobody can reach, sends in
// reply mode. A server that sends other people's campaigns (billing on, or open sign-up) does so at volume,
// where mailbox providers expect a one-click link, so its real mailboxes need it.
// A mailbox migrated from an account's SMTP settings sent without a link before mailboxes existed, so it
// keeps doing so rather than stopping those campaigns' email steps after an upgrade.
export function optOutProblem(ctx: Ctx, mb: Pick<MailboxRow, 'provider' | 'legacy_account_id' | 'imap_enc'>): string | null {
  if (isSimulated(mb) || mb.legacy_account_id != null) return null;
  const problem = publicLinkProblem(ctx);
  if (!problem) return null;
  if (sendsForOthers(ctx)) return `${problem}: on this hosted server, campaign emails must carry a working unsubscribe link. Set PUBLIC_URL to the server's public https:// address.`;
  if (!mb.imap_enc) return 'Add IMAP settings: with no unsubscribe link (PUBLIC_URL is not a public https:// address), campaign emails ask people to reply "unsubscribe", and only IMAP lets OpenReach read those replies.';
  return null;
}

// Other people's campaigns go through this server: billing is on, or anyone can sign up.
export const sendsForOthers = (ctx: Ctx) => billingEnabled(ctx) || ctx.config.allowSignup;

// How this mailbox's campaign emails offer the opt-out: an unsubscribe link, a reply (no public PUBLIC_URL),
// or neither because it can't send campaign email until that is fixed (see optOutProblem).
export function unsubscribeMode(ctx: Ctx, mb: MailboxRow): 'link' | 'reply' | 'none' {
  if (publicLinkBase(ctx)) return 'link';
  return !isSimulated(mb) && mb.legacy_account_id == null && sendsForOthers(ctx) ? 'none' : 'reply';
}

// Before reply mode, a real mailbox without PUBLIC_URL was stopped with this message. Where it may now send
// in reply mode it goes back to work after the upgrade instead of waiting for someone to click Resume; on a
// hosted server the message is brought up to date.
const OLD_PUBLIC_URL_MESSAGE = 'Set PUBLIC_URL so emails can carry an unsubscribe link';

export function clearOldPublicUrlHolds(ctx: Ctx) {
  const held = ctx.db.all<MailboxRow>("SELECT * FROM mailboxes WHERE status = 'needs_attention' AND status_message = ?", [OLD_PUBLIC_URL_MESSAGE]);
  for (const mb of held) {
    const problem = optOutProblem(ctx, mb);
    if (problem) ctx.db.run('UPDATE mailboxes SET status_message = ? WHERE id = ?', [problem, mb.id]);
    else ctx.db.run("UPDATE mailboxes SET status = 'active', status_message = NULL WHERE id = ?", [mb.id]);
  }
}

export function serverSettings(ctx: Ctx, sealed: string | null): ServerSettings | null {
  const raw = ctx.sealer.open(sealed);
  return raw ? json<ServerSettings | null>(raw, null) : null;
}

export function smtpTransport(ctx: Ctx, mb: MailboxRow): SmtpTransport | null {
  if (isSimulated(mb)) return null;
  return serverSettings(ctx, mb.smtp_enc);
}

export function mailboxSchedule(mb: MailboxRow): Schedule {
  return { timezone: mb.timezone, work_days: json(mb.work_days, [1, 2, 3, 4, 5]), work_start: mb.work_start, work_end: mb.work_end };
}

export function warmupDay(mb: Pick<MailboxRow, 'created_at'>, now: number): number {
  return Math.max(0, Math.floor((now - mb.created_at) / DAY));
}

// Warm-up ramps the daily limit linearly from `warmup_start` on day 0 to `daily_limit` after `warmup_days`.
export function effectiveDailyLimit(mb: Pick<MailboxRow, 'daily_limit' | 'warmup' | 'warmup_days' | 'warmup_start' | 'created_at'>, now: number): number {
  if (!mb.warmup) return mb.daily_limit;
  const days = warmupDay(mb, now);
  const start = Math.min(mb.warmup_start, mb.daily_limit);
  return Math.min(mb.daily_limit, start + Math.floor((days * (mb.daily_limit - start)) / Math.max(1, mb.warmup_days)));
}

// Emails sent today in the mailbox's time zone: campaign steps and inbox replies alike (one source of truth).
export function sentToday(ctx: Ctx, mb: MailboxRow): number {
  const today = localParts(ctx.clock.now(), mb.timezone).date;
  return ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE mailbox_id = ? AND day = ? AND type = 'email' AND status = 'ok'", [mb.id, today])!.n;
}

export function remainingToday(ctx: Ctx, mb: MailboxRow): number {
  return effectiveDailyLimit(mb, ctx.clock.now()) - sentToday(ctx, mb);
}

// RFC 2606/6761 names that never belong to a real person. Real mailboxes refuse them, so made-up
// addresses (the simulator's @<company>.example) can never reach anyone.
const RESERVED_TLDS = ['example', 'test', 'invalid', 'localhost'];
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];
export function isReservedAddress(email: string): boolean {
  const domain = email.trim().toLowerCase().split('@').pop() ?? '';
  const tld = domain.split('.').pop() ?? '';
  return RESERVED_TLDS.includes(tld) || RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export const emailDomain = (email: string) => (email.trim().toLowerCase().split('@')[1] ?? '').replace(/>$/, '');

export function fromLine(mb: Pick<MailboxRow, 'from_name' | 'from_email'>): string {
  const name = mb.from_name.replace(/["\r\n]/g, '').trim();
  return name ? `"${name}" <${mb.from_email}>` : mb.from_email;
}

// ---- Campaign mailboxes and pinning ---------------------------------------------------------

const inList = (ids: unknown[]) => ids.map(() => '?').join(',');

export function campaignMailboxIds(ctx: Ctx, campaignId: number): number[] {
  return ctx.db.all<{ mailbox_id: number }>('SELECT mailbox_id FROM campaign_mailboxes WHERE campaign_id = ? ORDER BY created_at, mailbox_id', [campaignId]).map((r) => r.mailbox_id);
}

export function campaignMailboxes(ctx: Ctx, campaignId: number) {
  const ids = campaignMailboxIds(ctx, campaignId);
  if (!ids.length) return [];
  const rows = ctx.db.all<{ id: number; name: string; status: string; fromEmail: string; provider: string }>(
    `SELECT id, name, status, from_email AS "fromEmail", provider FROM mailboxes WHERE id IN (${inList(ids)})`,
    ids,
  );
  return ids.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
}

export function setCampaignMailboxes(ctx: Ctx, campaignId: number, mailboxIds: number[]) {
  const ids = [...new Set(mailboxIds)];
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    for (const id of campaignMailboxIds(ctx, campaignId).filter((x) => !ids.includes(x))) {
      ctx.db.run('DELETE FROM campaign_mailboxes WHERE campaign_id = ? AND mailbox_id = ?', [campaignId, id]);
      releaseUnstartedMailboxLeads(ctx, id, campaignId);
    }
    ids.forEach((id, i) => {
      ctx.db.run('INSERT INTO campaign_mailboxes (campaign_id, mailbox_id, created_at) VALUES (?, ?, ?) ON CONFLICT (campaign_id, mailbox_id) DO NOTHING', [campaignId, id, now + i]);
    });
  });
}

// Outbound rows that may have reached the person. A failed send (login refused, server down) never did;
// an in-flight 'sending' row counts, since the email may already be out.
export const WENT_OUT = "e.direction = 'out' AND e.status <> 'failed'";

// SQL for "this campaign lead already got an email from its pinned mailbox": such a lead never moves,
// so the person keeps hearing from the same address.
const EMAILED = `EXISTS (SELECT 1 FROM email_messages e WHERE e.mailbox_id = campaign_leads.mailbox_id AND e.lead_id = campaign_leads.lead_id
  AND e.campaign_id = campaign_leads.campaign_id AND ${WENT_OUT})`;

// Leads pinned to the mailbox that it hasn't emailed yet go back to the campaign's other mailboxes.
export function releaseUnstartedMailboxLeads(ctx: Ctx, mailboxId: number, campaignId?: number): number {
  return ctx.db.run(
    `UPDATE campaign_leads SET mailbox_id = NULL WHERE mailbox_id = ? AND state = 'active' AND NOT ${EMAILED}${campaignId ? ' AND campaign_id = ?' : ''}`,
    campaignId ? [mailboxId, campaignId] : [mailboxId],
  ).changes;
}

export function pinMailbox(ctx: Ctx, campaignLeadId: number, mailboxId: number): boolean {
  return ctx.db.run('UPDATE campaign_leads SET mailbox_id = ? WHERE id = ? AND mailbox_id IS NULL', [mailboxId, campaignLeadId]).changes > 0;
}

// Before a mailbox is deleted: leads it already emailed can't switch address, so they stop; the rest
// are released. Campaigns left with no mailbox and no LinkedIn account pause.
export function retireMailbox(ctx: Ctx, mailboxId: number) {
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE campaign_leads SET state = 'skipped', finished_at = ?, next_run_at = ?, hold_reason = NULL, last_error = 'Mailbox was removed'
       WHERE mailbox_id = ? AND state = 'active' AND ${EMAILED}`,
      [now, now, mailboxId],
    );
    const ws = ctx.db.get<{ workspace_id: number }>('SELECT workspace_id FROM mailboxes WHERE id = ?', [mailboxId]);
    if (ws) skipTasksOfStoppedLeads(ctx, ws.workspace_id, 'Lead left the campaign (mailbox was removed)');
    releaseUnstartedMailboxLeads(ctx, mailboxId);
    const campaigns = ctx.db.all<{ campaign_id: number }>('SELECT campaign_id FROM campaign_mailboxes WHERE mailbox_id = ?', [mailboxId]).map((r) => r.campaign_id);
    ctx.db.run('DELETE FROM campaign_mailboxes WHERE mailbox_id = ?', [mailboxId]);
    for (const id of campaigns) {
      const senders = ctx.db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM campaign_mailboxes WHERE campaign_id = ?) + (SELECT COUNT(*) FROM campaign_accounts WHERE campaign_id = ?) AS n', [id, id])!.n;
      if (!senders) ctx.db.run("UPDATE campaigns SET status = 'paused' WHERE id = ? AND status = 'active'", [id]);
    }
  });
}

// A mailbox that can't send (login refused, no public PUBLIC_URL on a hosted server) stops until the user fixes it.
// Leads whose email never went out move on to the campaign's other mailboxes.
export function mailboxNeedsAttention(ctx: Ctx, mb: MailboxRow, reason: string) {
  const changed = ctx.db.run("UPDATE mailboxes SET status = 'needs_attention', status_message = ? WHERE id = ? AND status <> 'needs_attention'", [reason, mb.id]).changes;
  ctx.db.run('UPDATE mailboxes SET status_message = ? WHERE id = ?', [reason, mb.id]);
  releaseUnstartedMailboxLeads(ctx, mb.id);
  if (changed) ctx.webhooks.emit(mb.workspace_id, 'mailbox.needs_attention', { mailboxId: mb.id, name: mb.name, reason });
}

export interface MailboxCapacity {
  remaining: number;
  working: boolean;
}
export type MailboxCapacityCache = Map<number, MailboxCapacity>;

function capacityOf(ctx: Ctx, mb: MailboxRow, cache: MailboxCapacityCache): MailboxCapacity {
  let c = cache.get(mb.id);
  if (!c) {
    c = { remaining: remainingToday(ctx, mb), working: isWorkingTime(ctx.clock.now(), mailboxSchedule(mb)) };
    cache.set(mb.id, c);
  }
  return c;
}

// Picks the mailbox for an unassigned lead's email step, or null if none can send now.
// 1. A mailbox of the campaign that already emailed the lead keeps the thread (even when busy).
// 2. Otherwise the active campaign mailbox, inside its window and under its limit, with the most room
//    left today minus the leads already waiting for it. Ties go to the lower id.
// Each mailbox still checks its own limit before sending, so rotation can't push one past it.
// Mailboxes in `skip` (past their plan's limit) take no new leads.
export function chooseMailbox(
  ctx: Ctx,
  campaign: CampaignRow,
  lead: Pick<LeadRow, 'id'>,
  cache: MailboxCapacityCache,
  accountId: number | null = null,
  skip: ReadonlySet<number> = new Set(),
): number | null {
  const ids = campaignMailboxIds(ctx, campaign.id);
  if (!ids.length) return null;
  const known = ctx.db.get<{ mailbox_id: number }>(
    `SELECT e.mailbox_id FROM email_messages e JOIN mailboxes m ON m.id = e.mailbox_id
     WHERE e.lead_id = ? AND ${WENT_OUT} AND m.status = 'active' AND e.mailbox_id IN (${inList(ids)}) ORDER BY e.sent_at DESC, e.id DESC LIMIT 1`,
    [lead.id, ...ids],
  );
  if (known) return known.mailbox_id;
  // A lead pinned to a LinkedIn sender whose SMTP settings became a mailbox keeps emailing from it, as before.
  if (accountId != null) {
    const legacy = ctx.db.get<{ id: number }>(`SELECT id FROM mailboxes WHERE legacy_account_id = ? AND status = 'active' AND id IN (${inList(ids)})`, [accountId, ...ids]);
    if (legacy && !skip.has(legacy.id)) return legacy.id;
  }
  const boxes = ctx.db.all<MailboxRow>(`SELECT * FROM mailboxes WHERE id IN (${inList(ids)}) AND workspace_id = ? AND status = 'active'`, [...ids, campaign.workspace_id]);
  let best: { id: number; score: number } | null = null;
  for (const mb of boxes) {
    if (skip.has(mb.id)) continue;
    const cap = capacityOf(ctx, mb, cache);
    if (!cap.working || cap.remaining <= 0) continue;
    const waiting = ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
       WHERE cl.mailbox_id = ? AND cl.state = 'active' AND cl.node_type = 'email' AND c.status = 'active'`,
      [mb.id],
    )!.n;
    const score = cap.remaining - waiting;
    if (score <= 0) continue;
    if (!best || score > best.score || (score === best.score && mb.id < best.id)) best = { id: mb.id, score };
  }
  return best?.id ?? null;
}

// ---- API shape -------------------------------------------------------------------------------

function maskedServer(s: ServerSettings | null) {
  return s ? { host: s.host, port: s.port, secure: s.secure, user: s.user, pass: mask(s.pass) } : null;
}

export function serializeMailbox(ctx: Ctx, mb: MailboxRow) {
  const now = ctx.clock.now();
  const sched = mailboxSchedule(mb);
  const smtp = serverSettings(ctx, mb.smtp_enc);
  const imap = serverSettings(ctx, mb.imap_enc);
  const overPlan = overPlanIds(ctx, 'mailboxes', mb.workspace_id).has(mb.id);
  return {
    id: mb.id,
    name: mb.name,
    provider: mb.provider,
    simulated: isSimulated(mb),
    preset: mb.preset,
    fromName: mb.from_name,
    fromEmail: mb.from_email,
    domain: emailDomain(mb.from_email),
    replyTo: mb.reply_to,
    signature: mb.signature,
    smtp: maskedServer(smtp),
    imap: maskedServer(imap),
    hasSmtp: !!smtp,
    hasImap: !!imap,
    status: mb.status,
    // Past the plan's limit (hosted installs after a downgrade) the mailbox sends nothing; the status line says why.
    overPlan,
    statusMessage: overPlan ? overPlanMessage(ctx, 'mailboxes', mb.workspace_id) : mb.status_message,
    // How campaign emails offer the opt-out: an unsubscribe link, a footer asking for a reply, or 'none' (can't send).
    unsubscribe: unsubscribeMode(ctx, mb),
    timezone: mb.timezone,
    workDays: sched.work_days,
    workStart: mb.work_start,
    workEnd: mb.work_end,
    dailyLimit: mb.daily_limit,
    effectiveLimit: effectiveDailyLimit(mb, now),
    sentToday: sentToday(ctx, mb),
    warmup: !!mb.warmup,
    warmupDays: mb.warmup_days,
    warmupStart: mb.warmup_start,
    warmupDay: warmupDay(mb, now),
    gapMinSec: mb.gap_min_sec,
    gapMaxSec: mb.gap_max_sec,
    working: isWorkingTime(now, sched),
    nextWorkingAt: nextWorkingTime(now, sched),
    nextSendAt: mb.next_send_at,
    lastSyncAt: mb.last_sync_at,
    campaigns: ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM campaign_mailboxes WHERE mailbox_id = ?', [mb.id])!.n,
    legacyAccountId: mb.legacy_account_id,
    createdAt: mb.created_at,
  };
}

// ---- Accounts' SMTP settings from before mailboxes ------------------------------------------

function parseFrom(from: string): { name: string; email: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: '', email: from.trim() };
}

// Turns each LinkedIn account's SMTP settings into a mailbox, once, and links it to the campaigns that
// send email from that account. Those campaigns then send through the mail runner, so the mailbox keeps
// the account's behaviour: no warm-up, the account's email limit, schedule and pauses. Idempotent.
// It also keeps sending without PUBLIC_URL (see optOutProblem).

export function ensureLegacyMailboxes(ctx: Ctx) {
  const accounts = ctx.db.all<AccountRow>('SELECT * FROM accounts WHERE smtp_enc IS NOT NULL AND id NOT IN (SELECT legacy_account_id FROM mailboxes WHERE legacy_account_id IS NOT NULL)');
  for (const a of accounts) {
    const smtp = json<SmtpConfig | null>(ctx.sealer.open(a.smtp_enc), null);
    if (!smtp?.host) continue;
    const from = parseFrom(smtp.from || smtp.user);
    const limit = Number(json<Record<string, number>>(a.limits, {}).email ?? DEFAULT_LIMITS.email);
    const now = ctx.clock.now();
    withPlanLock(ctx, a.workspace_id, () => {
      // Hosted installs: no mailbox past the plan's limit (the account's SMTP then stays unused; see the engine).
      if (!withinPlan(ctx, a.workspace_id, 'mailboxes')) {
        console.warn(`[mail] Account ${a.id}'s SMTP settings were not turned into a mailbox: workspace ${a.workspace_id}'s plan has no mailbox left`);
        return;
      }
      const row = ctx.db.get<{ id: number }>(
        `INSERT INTO mailboxes (workspace_id, name, provider, preset, from_name, from_email, smtp_enc, status, timezone, work_days, work_start, work_end,
           daily_limit, warmup, gap_min_sec, gap_max_sec, legacy_account_id, created_at)
         VALUES (?, ?, 'smtp', 'custom', ?, ?, ?, 'active', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
         ON CONFLICT (legacy_account_id) WHERE legacy_account_id IS NOT NULL DO NOTHING RETURNING id`,
        [
          a.workspace_id,
          `${a.name} (email)`.slice(0, 100),
          from.name,
          (from.email || smtp.user).toLowerCase(),
          ctx.sealer.seal(JSON.stringify({ host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, pass: smtp.pass })),
          a.timezone,
          a.work_days,
          a.work_start,
          a.work_end,
          Math.max(1, Math.min(500, Number.isFinite(limit) ? limit : DEFAULT_LIMITS.email)),
          a.delay_min_sec,
          a.delay_max_sec,
          a.id,
          now,
        ],
      );
      if (!row) return;
      const campaigns = ctx.db.all<{ id: number; sequence: string }>(
        'SELECT id, sequence FROM campaigns WHERE workspace_id = ? AND (account_id = ? OR id IN (SELECT campaign_id FROM campaign_accounts WHERE account_id = ?))',
        [a.workspace_id, a.id, a.id],
      );
      for (const c of campaigns) {
        const nodes = Object.values(json<{ nodes?: Record<string, { type?: string }> }>(c.sequence, {}).nodes ?? {});
        if (!nodes.some((n) => n.type === 'email')) continue;
        ctx.db.run('INSERT INTO campaign_mailboxes (campaign_id, mailbox_id, created_at) VALUES (?, ?, ?) ON CONFLICT (campaign_id, mailbox_id) DO NOTHING', [c.id, row.id, now]);
      }
    });
  }
}
