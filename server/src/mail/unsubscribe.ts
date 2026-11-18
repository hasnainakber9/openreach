import type { Ctx } from '../context.js';
import { alreadySuppressed, suppressIdentity, suppressLead } from '../services/suppression.js';
import type { LeadRow } from '../types.js';
import { verifyToken } from './tracking.js';

export type UnsubscribeResult = { ok: true; already: boolean } | null;

// One-click unsubscribe from a campaign email: the person goes on the do-not-contact list (every
// identity they have) and stops in every campaign. Null for a token we didn't sign.
export function unsubscribeByToken(ctx: Ctx, token: string): UnsubscribeResult {
  const p = verifyToken(ctx, 'u', token);
  if (!p) return null;
  const lead = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [p.leadId, p.workspaceId]);
  if (lead) {
    const already = alreadySuppressed(ctx, lead);
    if (!already) suppressLead(ctx, lead, 'unsubscribe', 'email link');
    return { ok: true, already };
  }
  // The lead was deleted since: still keep the address it was sent to off every list.
  const msg = ctx.db.get<{ to_email: string }>("SELECT to_email FROM email_messages WHERE id = ? AND workspace_id = ? AND direction = 'out'", [p.emailMessageId, p.workspaceId]);
  if (msg) suppressIdentity(ctx, p.workspaceId, 'email', msg.to_email, 'unsubscribe', 'email link');
  return { ok: true, already: false };
}
