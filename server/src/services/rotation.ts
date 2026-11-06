import type { Ctx } from '../context.js';
import { accountLimits, exhaustedFrom, remaining, schedule, usage } from '../engine/capacity.js';
import { isWorkingTime, type Limits } from '../engine/limits.js';
import type { ActionType } from '../engine/sequence.js';
import type { AccountRow, CampaignRow, ConnectionStatus, LeadRow } from '../types.js';
import { skipTasksOfStoppedLeads } from './tasks.js';

// Sender rotation: a campaign can run from several LinkedIn accounts. Each lead is pinned to one
// sender before its first LinkedIn action, so the same person always hears from the same account.
// Rotation only decides *which* account handles a lead; every account still checks its own limits.

export interface SenderCapacity {
  limits: Limits;
  used: Record<string, number>;
  exhausted: ActionType[];
  working: boolean;
}
// Per-tick cache so choosing a sender for many leads doesn't recount usage every time.
export type CapacityCache = Map<number, SenderCapacity>;

const inList = (ids: unknown[]) => ids.map(() => '?').join(',');

export function campaignAccountIds(ctx: Ctx, campaignId: number): number[] {
  // The first sender (campaigns.account_id) first, then in the order they were added.
  return ctx.db
    .all<{ account_id: number }>(
      `SELECT ca.account_id FROM campaign_accounts ca JOIN campaigns c ON c.id = ca.campaign_id
       WHERE ca.campaign_id = ? ORDER BY CASE WHEN ca.account_id = c.account_id THEN 0 ELSE 1 END, ca.created_at, ca.account_id`,
      [campaignId],
    )
    .map((r) => r.account_id);
}

export function campaignAccounts(ctx: Ctx, campaignId: number) {
  const ids = campaignAccountIds(ctx, campaignId);
  if (!ids.length) return [];
  const rows = ctx.db.all<{ id: number; name: string; status: string }>(`SELECT id, name, status FROM accounts WHERE id IN (${inList(ids)})`, ids);
  return ids.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
}

// Replaces a campaign's senders. Unstarted leads pinned to a removed sender go back to the pool;
// leads it already contacted stay with it, so a conversation never switches accounts.
export function setCampaignAccounts(ctx: Ctx, campaignId: number, accountIds: number[]) {
  const ids = [...new Set(accountIds)];
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    const before = campaignAccountIds(ctx, campaignId);
    for (const id of before.filter((x) => !ids.includes(x))) {
      ctx.db.run('DELETE FROM campaign_accounts WHERE campaign_id = ? AND account_id = ?', [campaignId, id]);
      releaseUnstartedLeads(ctx, id, campaignId);
    }
    ids.forEach((id, i) => {
      // Spread created_at so the chosen order survives as the tie-breaking order.
      ctx.db.run('INSERT INTO campaign_accounts (campaign_id, account_id, created_at) VALUES (?, ?, ?) ON CONFLICT (campaign_id, account_id) DO NOTHING', [campaignId, id, now + i]);
    });
    ctx.db.run('UPDATE campaigns SET account_id = ? WHERE id = ?', [ids[0] ?? null, campaignId]);
  });
}

// A lead connected to the account (or with its invitation pending) stays too, though nothing was sent yet: no
// other sender could message them, so it waits for this one. Retiring an account drops its connections first.
export function releaseUnstartedLeads(ctx: Ctx, accountId: number, campaignId?: number) {
  const r = ctx.db.run(
    `UPDATE campaign_leads SET account_id = NULL WHERE account_id = ? AND state = 'active' AND contacted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM lead_connections lc WHERE lc.lead_id = campaign_leads.lead_id AND lc.account_id = campaign_leads.account_id AND lc.status IN ('connected', 'pending'))${campaignId ? ' AND campaign_id = ?' : ''}`,
    campaignId ? [accountId, campaignId] : [accountId],
  );
  return r.changes;
}

// Pins an unassigned lead; returns false if another loop pinned it first.
export function pinLead(ctx: Ctx, campaignLeadId: number, accountId: number): boolean {
  return ctx.db.run('UPDATE campaign_leads SET account_id = ? WHERE id = ? AND account_id IS NULL', [accountId, campaignLeadId]).changes > 0;
}

// Before an account is deleted: leads it already contacted can't move to another sender, so they
// stop; unstarted ones are released. Campaigns left without a sender pause. Its connections go too,
// and each lead's aggregate is recomputed, so a lead known only to this account reads as new again.
export function retireAccount(ctx: Ctx, accountId: number) {
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    const connected = ctx.db.all<{ lead_id: number }>('SELECT lead_id FROM lead_connections WHERE account_id = ?', [accountId]);
    ctx.db.run('DELETE FROM lead_connections WHERE account_id = ?', [accountId]);
    for (const r of connected) refreshConnectionStatus(ctx, r.lead_id, 'none');
    ctx.db.run(
      "UPDATE campaign_leads SET state = 'skipped', finished_at = ?, next_run_at = ?, last_error = 'Sender account was removed' WHERE account_id = ? AND state = 'active' AND contacted_at IS NOT NULL",
      [now, now, accountId],
    );
    const ws = ctx.db.get<{ workspace_id: number }>('SELECT workspace_id FROM accounts WHERE id = ?', [accountId]);
    if (ws) skipTasksOfStoppedLeads(ctx, ws.workspace_id, 'Lead left the campaign (sender account was removed)');
    releaseUnstartedLeads(ctx, accountId);
    const campaigns = ctx.db
      .all<{ id: number }>('SELECT campaign_id AS id FROM campaign_accounts WHERE account_id = ? UNION SELECT id FROM campaigns WHERE account_id = ?', [accountId, accountId])
      .map((r) => r.id);
    ctx.db.run('DELETE FROM campaign_accounts WHERE account_id = ?', [accountId]);
    for (const id of campaigns) {
      const left = campaignAccountIds(ctx, id).filter((x) => x !== accountId);
      ctx.db.run('UPDATE campaigns SET account_id = ? WHERE id = ?', [left[0] ?? null, id]);
      if (!left.length) ctx.db.run("UPDATE campaigns SET status = 'paused' WHERE id = ? AND status = 'active'", [id]);
    }
  });
}

// ---- Per-account connections ---------------------------------------------------------------

// Legacy leads (from before per-account tracking, with no attributable activity) only have the
// aggregate status. Inside a campaign it is credited to the campaign's first sender only
// (`legacyAccountId`, campaigns.account_id), so other senders still invite them themselves.
// Without a campaign (connection sync) it is credited to any account, as before.
export function connectionWith(ctx: Ctx, lead: Pick<LeadRow, 'id' | 'connection_status'>, accountId: number, legacyAccountId?: number | null): ConnectionStatus {
  const row = ctx.db.get<{ status: ConnectionStatus }>('SELECT status FROM lead_connections WHERE lead_id = ? AND account_id = ?', [lead.id, accountId]);
  if (row) return row.status;
  if (isLegacy(ctx, lead) && (legacyAccountId === undefined || legacyAccountId === accountId)) return lead.connection_status;
  return 'none';
}

export function isLegacy(ctx: Ctx, lead: Pick<LeadRow, 'id' | 'connection_status'>): boolean {
  return lead.connection_status !== 'none' && !ctx.db.get('SELECT 1 FROM lead_connections WHERE lead_id = ?', [lead.id]);
}

// Records what one account knows about a lead and refreshes the lead's aggregate status.
export function setConnection(ctx: Ctx, leadId: number, accountId: number, status: ConnectionStatus) {
  const now = ctx.clock.now();
  if (status === 'none') {
    ctx.db.run('DELETE FROM lead_connections WHERE lead_id = ? AND account_id = ?', [leadId, accountId]);
  } else {
    ctx.db.run(
      `INSERT INTO lead_connections (lead_id, account_id, status, connected_at, updated_at) VALUES ($lead, $acc, $status, $at, $now)
       ON CONFLICT (lead_id, account_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at,
         connected_at = CASE WHEN excluded.status = 'connected' THEN COALESCE(lead_connections.connected_at, excluded.connected_at) ELSE NULL END`,
      { lead: leadId, acc: accountId, status, at: status === 'connected' ? now : null, now },
    );
  }
  refreshConnectionStatus(ctx, leadId, status === 'none' ? 'none' : undefined);
}

// leads.connection_status is "connected to any of our accounts". With no per-account rows the
// aggregate is left alone (legacy data) unless the caller knows better.
export function refreshConnectionStatus(ctx: Ctx, leadId: number, whenNoRows?: ConnectionStatus) {
  const rows = ctx.db.all<{ status: ConnectionStatus }>('SELECT status FROM lead_connections WHERE lead_id = ?', [leadId]);
  const status: ConnectionStatus | undefined = rows.some((r) => r.status === 'connected') ? 'connected' : rows.some((r) => r.status === 'pending') ? 'pending' : whenNoRows;
  if (!status) return;
  const lead = ctx.db.get<{ connection_status: ConnectionStatus }>('SELECT connection_status FROM leads WHERE id = ?', [leadId]);
  if (!lead || lead.connection_status === status) return;
  ctx.db.update('leads', leadId, { connection_status: status, ...(status === 'connected' ? { connected_at: ctx.clock.now() } : {}) });
}

// The campaign sender a lead is connected to (or has a pending invite from), connected first, then active ones.
// A paused or logged-out sender still counts: the lead waits for it, since another sender couldn't message them.
export function connectedSender(ctx: Ctx, leadId: number, accountIds: number[], statuses: ConnectionStatus[] = ['connected']): number | null {
  if (!accountIds.length) return null;
  const row = ctx.db.get<{ account_id: number }>(
    `SELECT lc.account_id FROM lead_connections lc JOIN accounts a ON a.id = lc.account_id
     WHERE lc.lead_id = ? AND lc.account_id IN (${inList(accountIds)}) AND lc.status IN (${inList(statuses)})
     ORDER BY CASE WHEN lc.status = 'connected' THEN 0 ELSE 1 END, CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, lc.updated_at DESC, lc.account_id LIMIT 1`,
    [leadId, ...accountIds, ...statuses],
  );
  return row?.account_id ?? null;
}

// ---- Choosing a sender ---------------------------------------------------------------------

function capacityOf(ctx: Ctx, a: AccountRow, cache: CapacityCache): SenderCapacity {
  let c = cache.get(a.id);
  if (!c) {
    const limits = accountLimits(ctx, a);
    const used = usage(ctx, a);
    const now = ctx.clock.now();
    c = { limits, used, exhausted: exhaustedFrom(a, limits, used, now), working: isWorkingTime(now, schedule(a)) };
    cache.set(a.id, c);
  }
  return c;
}

// Picks the account that should take an unassigned lead's next action, or null if none can now.
// 1. A sender the lead is already connected to (or invited by) keeps them, even when it is busy or paused.
// 2. Otherwise the active sender, inside working hours and under its limit for this action, with
//    the most spare capacity: remaining today minus leads already queued for it at this action type
//    (across all campaigns). Ties go to the sender with fewer leads, then the lower id.
export function chooseSender(ctx: Ctx, campaign: CampaignRow, lead: LeadRow, actionType: ActionType, cache: CapacityCache): number | null {
  const ids = campaignAccountIds(ctx, campaign.id);
  if (!ids.length) return null;
  const known = connectedSender(ctx, lead.id, ids, ['connected', 'pending']);
  if (known != null) return known;
  // A legacy connection belongs to the campaign's first sender (see connectionWith).
  if (campaign.account_id != null && ids.includes(campaign.account_id) && isLegacy(ctx, lead)) {
    const first = ctx.db.get<{ status: string }>('SELECT status FROM accounts WHERE id = ?', [campaign.account_id]);
    if (first?.status === 'active') return campaign.account_id;
  }

  const accounts = ctx.db.all<AccountRow>(`SELECT * FROM accounts WHERE id IN (${inList(ids)}) AND workspace_id = ? AND status = 'active'`, [...ids, campaign.workspace_id]);
  let best: { id: number; score: number; load: number } | null = null;
  for (const a of accounts) {
    const cap = capacityOf(ctx, a, cache);
    if (!cap.working || cap.exhausted.includes(actionType)) continue;
    const waiting = ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
       WHERE cl.account_id = ? AND cl.state = 'active' AND cl.contacted_at IS NULL AND cl.node_type = ? AND c.status = 'active'`,
      [a.id, actionType],
    )!.n;
    const load = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM campaign_leads WHERE account_id = ? AND state = 'active'", [a.id])!.n;
    const score = remaining(cap.limits, cap.used, actionType) - waiting;
    // A sender whose queue already covers today's capacity takes no more; the lead waits unassigned.
    if (score <= 0) continue;
    if (!best || score > best.score || (score === best.score && (load < best.load || (load === best.load && a.id < best.id)))) best = { id: a.id, score, load };
  }
  return best?.id ?? null;
}
