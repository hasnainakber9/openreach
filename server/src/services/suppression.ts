import type { Ctx } from '../context.js';
import type { LeadRow } from '../types.js';
import { publicLead } from './leads.js';

export type SuppressionKind = 'linkedin' | 'email' | 'phone';
export type SuppressionReason = 'unsubscribe' | 'not_interested' | 'sms_stop' | 'bounce' | 'manual';

// Phones are stored as E.164. Only numbers already written in international form are
// recognised here; country-code guessing arrives with the SMS channel.
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/[\s().-]/g, '').replace(/^00/, '+');
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null;
}

function normalize(kind: SuppressionKind, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (kind === 'email') return v.toLowerCase();
  if (kind === 'phone') return normalizePhone(v);
  return v;
}

// Returns true when the identity was newly suppressed.
export function suppressIdentity(ctx: Ctx, workspaceId: number, kind: SuppressionKind, value: string, reason: SuppressionReason, source: string | null, leadId: number | null = null): boolean {
  const v = normalize(kind, value);
  if (!v) return false;
  const r = ctx.db.run(
    `INSERT INTO suppressions (workspace_id, kind, value, reason, source, lead_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, kind, value) DO NOTHING`,
    [workspaceId, kind, v, reason, source, leadId, ctx.clock.now()],
  );
  return r.changes > 0;
}

// Suppresses every identity the lead has (profile, email, phone) and takes the lead out of
// every running campaign, so no channel contacts them again.
export function suppressLead(ctx: Ctx, lead: LeadRow, reason: SuppressionReason, source: string | null) {
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    suppressIdentity(ctx, lead.workspace_id, 'linkedin', lead.public_id, reason, source, lead.id);
    if (lead.email) suppressIdentity(ctx, lead.workspace_id, 'email', lead.email, reason, source, lead.id);
    if (lead.phone) suppressIdentity(ctx, lead.workspace_id, 'phone', lead.phone, reason, source, lead.id);
    ctx.db.run("UPDATE campaign_leads SET state = 'skipped', finished_at = ?, next_run_at = ?, last_error = ? WHERE lead_id = ? AND state = 'active'", [
      now,
      now,
      `Suppressed: ${reason}`,
      lead.id,
    ]);
  });
  ctx.webhooks.emit(lead.workspace_id, 'lead.suppressed', { lead: publicLead(lead), reason, source });
}

// Why this lead must not be contacted, or null. Checked when leads join a campaign and before every action.
export function suppressionReason(ctx: Ctx, lead: LeadRow): string | null {
  const ids: [SuppressionKind, string | null][] = [
    ['linkedin', lead.public_id],
    ['email', lead.email ? lead.email.trim().toLowerCase() : null],
    ['phone', normalizePhone(lead.phone)],
  ];
  const wanted = ids.filter((i): i is [SuppressionKind, string] => !!i[1]);
  const row = ctx.db.get<{ reason: string }>(
    `SELECT reason FROM suppressions WHERE workspace_id = ? AND (${wanted.map(() => '(kind = ? AND value = ?)').join(' OR ')}) ORDER BY id LIMIT 1`,
    [lead.workspace_id, ...wanted.flat()],
  );
  return row ? `Suppressed: ${row.reason}` : null;
}
