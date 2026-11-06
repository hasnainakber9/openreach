import type { Ctx } from '../context.js';
import type { LeadRow } from '../types.js';
import { publicLead } from './leads.js';
import { stopLeadEverywhere } from './replies.js';

export type SuppressionKind = 'linkedin' | 'email' | 'phone';
export type SuppressionReason = 'unsubscribe' | 'not_interested' | 'sms_stop' | 'bounce' | 'manual';

// Phones are stored as E.164. Numbers in international form (+44..., 0044...) are always recognised; a
// national number (07700 900123) only with a default country code (the SMS provider's setting, e.g. "44").
export function normalizePhone(raw: string | null | undefined, defaultCountryCode?: string | null): string | null {
  if (!raw) return null;
  let s = raw.replace(/^(whatsapp|tel|sms):/i, '').replace(/[\s().\-/]/g, '').replace(/^00/, '+');
  const cc = defaultCountryCode?.replace(/^\+/, '');
  if (!s.startsWith('+') && cc && /^[1-9]\d{0,3}$/.test(cc) && /^\d+$/.test(s)) s = `+${cc}${s.replace(/^0+/, '')}`;
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
  ctx.db.tx(() => {
    suppressIdentity(ctx, lead.workspace_id, 'linkedin', lead.public_id, reason, source, lead.id);
    if (lead.email) suppressIdentity(ctx, lead.workspace_id, 'email', lead.email, reason, source, lead.id);
    if (lead.phone) suppressIdentity(ctx, lead.workspace_id, 'phone', lead.phone, reason, source, lead.id);
    stopLeadEverywhere(ctx, lead.id, 'skipped', `Suppressed: ${reason}`);
  });
  ctx.webhooks.emit(lead.workspace_id, 'lead.suppressed', { lead: publicLead(lead, ctx), reason, source });
}

// Already on the do-not-contact list and in no running campaign: suppressing again would change nothing
// (and only repeat the lead.suppressed event).
export function alreadySuppressed(ctx: Ctx, lead: LeadRow): boolean {
  return !!suppressionReason(ctx, lead) && !ctx.db.get("SELECT 1 FROM campaign_leads WHERE lead_id = ? AND state = 'active'", [lead.id]);
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
