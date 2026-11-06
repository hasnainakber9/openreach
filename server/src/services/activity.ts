import type { Ctx } from '../context.js';
import { localParts } from '../engine/limits.js';
import { advanceOnActivity } from './pipeline.js';

// Activity types that count as reaching out to a lead (analytics 'contacted', reply rate). Channels add theirs here.
export const CONTACT_ACTIVITY_TYPES = ['connect', 'message', 'email', 'inmail', 'sms', 'whatsapp'] as const;
export const contactTypesSql = () => CONTACT_ACTIVITY_TYPES.map((t) => `'${t}'`).join(', ');

export type ActivityStatus = 'ok' | 'skipped' | 'failed';

export interface ActivityInput {
  workspaceId: number;
  accountId?: number | null;
  // Email activity: the mailbox it went out from (or came in to); counted against that mailbox's daily limit.
  mailboxId?: number | null;
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
  const id = ctx.db.insert('activity', {
    workspace_id: a.workspaceId,
    account_id: a.accountId ?? null,
    mailbox_id: a.mailboxId ?? null,
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
  // Every channel logs its sends here, so this is the one place "first contact" moves the pipeline stage.
  advanceOnActivity(ctx, a);
  return id;
}
