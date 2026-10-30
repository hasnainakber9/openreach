import { DAY, MINUTE } from '../clock.js';
import type { ActionType } from './sequence.js';

export type Limits = Record<ActionType, number> & { connect_weekly: number };

// Conservative defaults, well under what LinkedIn tolerates for an established account.
export const DEFAULT_LIMITS: Limits = {
  view_profile: 80,
  follow: 30,
  endorse: 20,
  like_post: 30,
  connect: 20,
  connect_weekly: 100,
  message: 50,
  email: 60,
  withdraw_invite: 20,
};

export interface Schedule {
  timezone: string;
  work_days: number[]; // 0 = Sunday
  work_start: string; // "HH:MM"
  work_end: string;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localParts(ms: number, tz: string) {
  const parts = Object.fromEntries(formatter(tz).formatToParts(ms).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS.indexOf(parts.weekday),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function isValidTimezone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

export function isWorkingTime(ms: number, s: Schedule): boolean {
  const p = localParts(ms, s.timezone);
  if (!s.work_days.includes(p.weekday)) return false;
  const start = toMinutes(s.work_start);
  const end = toMinutes(s.work_end);
  return start <= end ? p.minutes >= start && p.minutes < end : p.minutes >= start || p.minutes < end;
}

// Earliest moment at or after `ms` inside working hours (5-minute resolution, looks ahead 8 days).
export function nextWorkingTime(ms: number, s: Schedule): number {
  if (!s.work_days.length) return ms + 7 * DAY;
  let t = Math.ceil(ms / (5 * MINUTE)) * 5 * MINUTE;
  for (let i = 0; i < 8 * 24 * 12; i++, t += 5 * MINUTE) {
    if (isWorkingTime(t, s)) return t;
  }
  return ms + DAY;
}

// New accounts ramp up over a week so LinkedIn sees gradual growth: 30% on day one, full by day eight.
export function warmupFactor(createdAt: number, now: number, enabled: boolean): number {
  if (!enabled) return 1;
  const days = Math.floor((now - createdAt) / DAY);
  return Math.min(1, 0.3 + 0.1 * days);
}

export function effectiveLimits(custom: Partial<Limits>, createdAt: number, now: number, warmup: boolean): Limits {
  const f = warmupFactor(createdAt, now, warmup);
  const out = { ...DEFAULT_LIMITS, ...custom } as Limits;
  for (const k of Object.keys(out) as (keyof Limits)[]) {
    out[k] = Math.max(out[k] > 0 ? 1 : 0, Math.floor(out[k] * f));
  }
  return out;
}

export function randomDelay(minSec: number, maxSec: number, random: () => number = Math.random): number {
  const lo = Math.max(0, Math.min(minSec, maxSec));
  const hi = Math.max(minSec, maxSec);
  return Math.round((lo + random() * (hi - lo)) * 1000);
}
