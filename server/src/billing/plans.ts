import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Plans of a hosted installation, from BILLING_PLANS (inline JSON) or BILLING_PLANS_FILE (a JSON file). They are
// installation config, not data: changing a plan's limits takes effect on the next restart for everyone on it.

export const LIMIT_KEYS = ['linkedinAccounts', 'mailboxes', 'seats', 'clientWorkspaces', 'aiCreditsMonthly', 'enrichmentCreditsMonthly'] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
// null = unlimited.
export type PlanLimits = Record<LimitKey, number | null>;

const limit = z.number().int().min(0).nullable().default(null);

const PlanSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/i, 'use letters, digits, - or _ (at most 40)'),
  name: z.string().trim().min(1).max(60),
  // The Stripe recurring price people subscribe to. A free default plan has none.
  priceId: z.string().trim().min(1).max(200).nullable().default(null),
  // Applies to every workspace without an active subscription.
  default: z.boolean().default(false),
  limits: z.object(Object.fromEntries(LIMIT_KEYS.map((k) => [k, limit])) as Record<LimitKey, typeof limit>).strict().default({}),
});
export type Plan = z.infer<typeof PlanSchema>;

const PlansSchema = z
  .array(PlanSchema)
  .max(20)
  .superRefine((plans, c) => {
    const ids = new Set<string>();
    const prices = new Set<string>();
    plans.forEach((p, i) => {
      if (ids.has(p.id)) c.addIssue({ code: 'custom', path: [i, 'id'], message: `duplicate plan id "${p.id}"` });
      ids.add(p.id);
      if (p.priceId && prices.has(p.priceId)) c.addIssue({ code: 'custom', path: [i, 'priceId'], message: 'two plans use the same price' });
      if (p.priceId) prices.add(p.priceId);
      if (!p.priceId && !p.default) c.addIssue({ code: 'custom', path: [i, 'priceId'], message: 'only the default plan may go without a Stripe price' });
    });
    if (plans.filter((p) => p.default).length > 1) c.addIssue({ code: 'custom', path: [], message: 'at most one plan can be the default' });
  });

// Throws a readable error naming the variable and the bad field, so a typo stops the server at startup.
export function parsePlans(text: string, source: string): Plan[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${source} is not valid JSON: ${(e as Error).message}`);
  }
  const r = PlansSchema.safeParse(Array.isArray(raw) ? raw : (raw as { plans?: unknown })?.plans);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first.path.reduce<string>((s, p) => (typeof p === 'number' ? `${s}[${p}]` : `${s}.${p}`), 'plans');
    throw new Error(`${source}: ${where}: ${first.message}`);
  }
  return r.data;
}

export function loadPlans(env: Record<string, string | undefined>): Plan[] {
  if (env.BILLING_PLANS?.trim()) return parsePlans(env.BILLING_PLANS, 'BILLING_PLANS');
  const file = env.BILLING_PLANS_FILE?.trim();
  if (!file) return [];
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`BILLING_PLANS_FILE: can't read ${file}: ${(e as Error).message}`);
  }
  return parsePlans(text, 'BILLING_PLANS_FILE');
}
