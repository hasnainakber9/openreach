import type { Ctx } from '../context.js';
import { localParts } from '../engine/limits.js';

// Activity types that count as reaching out to a lead (analytics 'contacted', reply rate). Channels add theirs here.
export const CONTACT_ACTIVITY_TYPES = ['connect', 'message', 'email'] as const;
export const contactTypesSql = () => CONTACT_ACTIVITY_TYPES.map((t) => `'${t}'`).join(', ');

export type ActivityStatus = 'ok' | 'skipped' | 'failed';

export interface ActivityInput {
  workspaceId: number;
  accountId?: number | null;
  campaignId?: number | null;
  leadId?: number | null;
  type: string;
  status?: ActivityStatus;
  detail?: string | null;
  timezone?: string;
  // The sequence step that did it, and the A/B variant it sent (null when the step has no variants).
  nodeId?: string | null;
  variant?: string | null;
}

// `day` is the account's local calendar day, which is what daily limits are counted against.
export function logActivity(ctx: Ctx, a: ActivityInput): number {
  const now = ctx.clock.now();
  return ctx.db.insert('activity', {
    workspace_id: a.workspaceId,
    account_id: a.accountId ?? null,
    campaign_id: a.campaignId ?? null,
    lead_id: a.leadId ?? null,
    type: a.type,
    status: a.status ?? 'ok',
    detail: a.detail ?? null,
    node_id: a.nodeId ?? null,
    variant: a.variant ?? null,
    day: localParts(now, a.timezone ?? 'UTC').date,
    created_at: now,
  });
}
