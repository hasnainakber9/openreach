import { DAY, MINUTE } from '../clock.js';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import type { AccountRow } from '../types.js';
import { effectiveLimits, localParts, nextWorkingTime, type Limits, type Schedule } from './limits.js';
import { ACTION_TYPES, type ActionType } from './sequence.js';

export function schedule(a: AccountRow): Schedule {
  return { timezone: a.timezone, work_days: json(a.work_days, [1, 2, 3, 4, 5]), work_start: a.work_start, work_end: a.work_end };
}

// Start of the account's next working day (daily budgets reset at local midnight).
export function nextWorkingDay(now: number, a: AccountRow): number {
  const toMidnight = (24 * 60 - localParts(now, a.timezone).minutes + 1) * MINUTE;
  return nextWorkingTime(now + toMidnight, schedule(a));
}

export function accountLimits(ctx: Ctx, a: AccountRow): Limits {
  return effectiveLimits(json(a.limits, {}), a.created_at, ctx.clock.now(), !!a.warmup);
}

// Today's successful actions per type for an account, connects over the last 7 days, and the
// profiles its imports collected today (`scrape`).
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
  out.scrape = ctx.db.get<{ n: number | null }>('SELECT SUM(scraped) AS n FROM imports WHERE account_id = ? AND day = ?', [a.id, today])!.n ?? 0;
  return out;
}

// How many more actions of a type the account may take today (weekly invite cap included).
export function remaining(limits: Limits, used: Record<string, number>, t: ActionType): number {
  const daily = limits[t] - (used[t] ?? 0);
  return t === 'connect' ? Math.min(daily, limits.connect_weekly - (used.connect_weekly ?? 0)) : daily;
}

export function exhaustedFrom(a: AccountRow, limits: Limits, used: Record<string, number>, now: number): ActionType[] {
  const cooldowns = json<Record<string, number>>(a.cooldowns, {});
  return ACTION_TYPES.filter((t) => (cooldowns[t] ?? 0) > now || remaining(limits, used, t) <= 0);
}

export function exhaustedActions(ctx: Ctx, a: AccountRow): ActionType[] {
  return exhaustedFrom(a, accountLimits(ctx, a), usage(ctx, a), ctx.clock.now());
}
