import type { Ctx } from '../context.js';
import { HttpError } from '../http.js';
import { ProviderError } from '../providers/http.js';
import { workspaceRow } from '../services/memberships.js';
import { monthOf } from '../services/usage.js';
import { LIMIT_KEYS, type LimitKey, type Plan } from './plans.js';

// Plan limits for hosted installations. With billing off (no STRIPE_SECRET_KEY) every check passes, so a
// self-hosted install is never limited. Limits are counted across the billing root: a standalone workspace,
// or an agency together with all of its client workspaces.

export interface SubscriptionRow {
  workspace_id: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan_id: string | null;
  status: string;
  current_period_end: number | null;
  cancel_at_period_end: number;
  last_event_at: number;
  updated_at: number;
  checkout_session_id: string | null;
  extra_subscription_id: string | null;
}

// Statuses that give the subscribed plan's limits. Anything else (past_due, unpaid, canceled, ...) falls back
// to the default plan; nothing is paused or deleted.
export const PAID_STATUSES = ['active', 'trialing'];
// A subscription in these states is still Stripe's to manage (portal), so Checkout would start a second one.
export const LIVE_STATUSES = [...PAID_STATUSES, 'past_due', 'unpaid', 'paused'];

export const billingEnabled = (ctx: Ctx) => !!ctx.stripe;
export const allPlans = (ctx: Ctx): Plan[] => ctx.config.plans ?? [];
export const defaultPlan = (ctx: Ctx) => allPlans(ctx).find((p) => p.default) ?? null;

// Client workspaces bill through their agency.
export const billingRoot = (ctx: Ctx, workspaceId: number) => workspaceRow(ctx, workspaceId)?.parent_id ?? workspaceId;

export const subscriptionOf = (ctx: Ctx, root: number) => ctx.db.get<SubscriptionRow>('SELECT * FROM subscriptions WHERE workspace_id = ?', [root]) ?? null;

// The plan whose limits apply now: the subscribed one while it is paid for, else the default plan (null:
// none, so nothing limited can be added until a plan is chosen).
export function currentPlan(ctx: Ctx, root: number): Plan | null {
  const sub = subscriptionOf(ctx, root);
  const paid = sub && PAID_STATUSES.includes(sub.status) ? allPlans(ctx).find((p) => p.id === sub.plan_id) : undefined;
  return paid ?? defaultPlan(ctx);
}

// The root and its client workspaces.
const TREE = '(SELECT id FROM workspaces WHERE id = ? OR parent_id = ?)';
const count = (ctx: Ctx, sql: string, params: (string | number)[]) => ctx.db.get<{ n: number | null }>(sql, params)?.n ?? 0;

export function usageOf(ctx: Ctx, root: number, key: LimitKey): number {
  const month = monthOf(ctx.clock.now());
  switch (key) {
    case 'linkedinAccounts':
      return count(ctx, `SELECT COUNT(*) AS n FROM accounts WHERE workspace_id IN ${TREE}`, [root, root]);
    case 'mailboxes':
      return count(ctx, `SELECT COUNT(*) AS n FROM mailboxes WHERE workspace_id IN ${TREE}`, [root, root]);
    case 'seats': {
      // People with write access anywhere in the tree (clients are free), plus pending invites for new people,
      // so accepting an invite never goes over the plan.
      const members = count(ctx, `SELECT COUNT(DISTINCT user_id) AS n FROM memberships WHERE role <> 'client' AND workspace_id IN ${TREE}`, [root, root]);
      const invites = count(
        ctx,
        `SELECT COUNT(DISTINCT i.email) AS n FROM invites i
         WHERE i.role <> 'client' AND i.accepted_at IS NULL AND i.expires_at > ? AND i.workspace_id IN ${TREE}
           AND NOT EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
                           WHERE lower(u.email) = i.email AND m.role <> 'client' AND m.workspace_id IN ${TREE})`,
        [Date.now(), root, root, root, root],
      );
      return members + invites;
    }
    case 'clientWorkspaces':
      return count(ctx, "SELECT COUNT(*) AS n FROM workspaces WHERE parent_id = ? AND kind = 'client'", [root]);
    case 'aiCreditsMonthly':
      // One credit per successful call to a real AI provider; the simulated one is free.
      return count(ctx, `SELECT COUNT(*) AS n FROM usage_events WHERE kind = 'ai' AND ok = 1 AND provider <> 'simulated' AND month = ? AND workspace_id IN ${TREE}`, [month, root, root]);
    case 'enrichmentCreditsMonthly':
      // Credits the vendors reported (simulated calls are recorded with 0).
      return count(
        ctx,
        `SELECT SUM(credits) AS n FROM usage_events WHERE kind IN ('email_finder', 'email_verifier', 'enrichment') AND month = ? AND workspace_id IN ${TREE}`,
        [month, root, root],
      );
  }
}

// 0 when the person already counts as a seat in the billing tree (a member with write access, or a pending
// invite), else 1. Used when inviting or promoting someone.
export function seatsNeeded(ctx: Ctx, workspaceId: number, who: { userId?: number; email?: string }): number {
  const root = billingRoot(ctx, workspaceId);
  const email = who.email?.trim().toLowerCase() ?? ctx.db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [who.userId ?? 0])?.email.toLowerCase() ?? '';
  const member = count(
    ctx,
    `SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role <> 'client' AND (u.id = ? OR lower(u.email) = ?) AND m.workspace_id IN ${TREE}`,
    [who.userId ?? 0, email, root, root],
  );
  const invited = count(
    ctx,
    `SELECT COUNT(*) AS n FROM invites WHERE role <> 'client' AND accepted_at IS NULL AND expires_at > ? AND email = ? AND workspace_id IN ${TREE}`,
    [Date.now(), email, root, root],
  );
  return member || invited ? 0 : 1;
}

export interface LimitUsage {
  used: number;
  // null = unlimited
  allowed: number | null;
}

export function usageReport(ctx: Ctx, root: number): Record<LimitKey, LimitUsage> {
  const plan = currentPlan(ctx, root);
  const on = billingEnabled(ctx);
  return Object.fromEntries(LIMIT_KEYS.map((k) => [k, { used: usageOf(ctx, root, k), allowed: on ? (plan ? plan.limits[k] : 0) : null }])) as Record<LimitKey, LimitUsage>;
}

const NOUNS: Record<LimitKey, [string, string]> = {
  linkedinAccounts: ['LinkedIn account', 'LinkedIn accounts'],
  mailboxes: ['mailbox', 'mailboxes'],
  seats: ['seat', 'seats'],
  clientWorkspaces: ['client workspace', 'client workspaces'],
  aiCreditsMonthly: ['AI credit', 'AI credits'],
  enrichmentCreditsMonthly: ['enrichment credit', 'enrichment credits'],
};

export interface PlanLimitDetails {
  code: 'plan_limit';
  limit: LimitKey;
  allowed: number;
  used: number;
}

function check(ctx: Ctx, workspaceId: number, key: LimitKey, adding: number): { message: string; details: PlanLimitDetails } | null {
  if (!billingEnabled(ctx) || adding <= 0) return null;
  const root = billingRoot(ctx, workspaceId);
  const plan = currentPlan(ctx, root);
  const allowed = plan ? plan.limits[key] : 0;
  if (allowed === null) return null;
  const used = usageOf(ctx, root, key);
  if (used + adding <= allowed) return null;
  const [one, many] = NOUNS[key];
  const noun = allowed === 1 ? one : many;
  const message = !plan
    ? `Choose a plan to ${key.endsWith('Monthly') ? 'use' : 'add'} ${many}.`
    : key.endsWith('Monthly')
      ? `Your plan includes ${allowed} ${noun} a month and they are used up. Upgrade or wait until next month.`
      : `Your plan allows ${allowed} ${noun}. Upgrade to add more.`;
  return { message, details: { code: 'plan_limit', limit: key, allowed, used } };
}

// For code that skips instead of failing (startup conversions).
export const withinPlan = (ctx: Ctx, workspaceId: number, key: LimitKey, adding = 1) => !check(ctx, workspaceId, key, adding);

// For creation routes: a 402 with details the web app turns into an upgrade prompt.
export function assertWithinPlan(ctx: Ctx, workspaceId: number, key: LimitKey, adding = 1) {
  const over = check(ctx, workspaceId, key, adding);
  if (over) throw new HttpError(402, over.message, over.details);
}

// Monthly credits ran out. A QUOTA error, so jobs fail for good (no retries) and the engine falls back as it
// does when a vendor's balance is empty; routes turn it into a 402.
export class PlanLimitError extends ProviderError {
  constructor(message: string, readonly details: PlanLimitDetails) {
    super('QUOTA', message);
  }
}

// Called before each call to a real (paid) provider. A call can overshoot by its own cost, since vendors only
// say what a call cost afterwards.
export function assertCredits(ctx: Ctx, workspaceId: number, key: 'aiCreditsMonthly' | 'enrichmentCreditsMonthly') {
  const over = check(ctx, workspaceId, key, 1);
  if (over) throw new PlanLimitError(over.message, over.details);
}
