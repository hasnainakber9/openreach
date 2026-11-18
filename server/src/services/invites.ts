import { createHash } from 'node:crypto';
import { DAY, MINUTE } from '../clock.js';
import type { Ctx } from '../context.js';
import type { Role } from '../http.js';
import type { JobHelpers, JobInfo } from '../jobs/queue.js';
import { PermanentError } from '../jobs/queue.js';
import { newMessageId } from '../mail/compose.js';
import { resolveBranding } from './branding.js';
import { token } from './crypto.js';
import { systemTransport } from './email.js';

// Email invites to a workspace. Only a hash of the token is stored; the link is shown once to the admin
// (and emailed through the installation mailer when SMTP_URL is set). Accepting is single-use.

export const INVITE_ROLES = ['admin', 'member', 'client'] as const satisfies readonly Role[];
export type InviteRole = (typeof INVITE_ROLES)[number];
export const INVITE_DAYS = 7;
export const INVITE_JOB_OPTIONS = { concurrency: 1, maxAttempts: 5, timeoutMs: 2 * MINUTE };

export interface InviteRow {
  id: number;
  workspace_id: number;
  email: string;
  role: InviteRole;
  token_hash: string;
  invited_by: number | null;
  expires_at: number;
  accepted_at: number | null;
  accepted_user_id: number | null;
  created_at: number;
}

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

// Absolute only from PUBLIC_URL, never from the request's Host header.
export const inviteLink = (ctx: Ctx, t: string) => `${ctx.config.publicUrl ?? ''}/invite/${t}`;

// Invite emails need both a mail server and an absolute link to put in them.
export const canEmailInvites = (ctx: Ctx) => !!(systemTransport(ctx.config.smtpUrl) && ctx.config.publicUrl);

// Creates an invite (replacing a pending one for the same address) and queues its email when possible.
export function createInvite(ctx: Ctx, input: { workspaceId: number; email: string; role: InviteRole; invitedBy: number }) {
  const t = token(32);
  // Wall-clock time like sessions: a sped-up demo clock must not expire invites in minutes.
  const now = Date.now();
  const email = input.email.trim().toLowerCase();
  const id = ctx.db.tx(() => {
    ctx.db.run('DELETE FROM invites WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL', [input.workspaceId, email]);
    const id = ctx.db.insert('invites', {
      workspace_id: input.workspaceId,
      email,
      role: input.role,
      token_hash: hashToken(t),
      invited_by: input.invitedBy,
      expires_at: now + INVITE_DAYS * DAY,
      created_at: now,
    });
    // The job needs the token to build the link; it is sealed so the jobs table never holds it in clear.
    if (canEmailInvites(ctx)) ctx.jobs.enqueue('invite.email', { inviteId: id, tokenEnc: ctx.sealer.seal(t) }, { workspaceId: input.workspaceId });
    return id;
  });
  return { id, token: t, link: inviteLink(ctx, t), emailed: canEmailInvites(ctx) };
}

// A usable invite for this token: not accepted, not expired, workspace still there.
export function findInvite(ctx: Ctx, t: string): InviteRow | null {
  const row = ctx.db.get<InviteRow>('SELECT * FROM invites WHERE token_hash = ?', [hashToken(t)]);
  if (!row || row.accepted_at || row.expires_at <= Date.now()) return null;
  return row;
}

export function serializeInvite(ctx: Ctx, r: InviteRow & { invited_by_name?: string | null }) {
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    invitedBy: r.invited_by_name ?? null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    expired: r.expires_at <= Date.now(),
  };
}

export async function inviteEmailJob(job: JobInfo<{ inviteId: number; tokenEnc: string }>, h: JobHelpers) {
  const { ctx } = h;
  const inv = ctx.db.get<InviteRow & { workspace_name: string; inviter: string | null }>(
    'SELECT i.*, w.name AS workspace_name, u.name AS inviter FROM invites i JOIN workspaces w ON w.id = i.workspace_id LEFT JOIN users u ON u.id = i.invited_by WHERE i.id = ? AND i.workspace_id = ?',
    [job.payload.inviteId, job.workspaceId],
  );
  // Revoked, replaced, used or expired since it was queued: nothing to send.
  if (!inv || inv.accepted_at || inv.expires_at <= Date.now()) return { note: 'Invite no longer pending' };
  const t = ctx.sealer.open(job.payload.tokenEnc);
  if (!t || hashToken(t) !== inv.token_hash) return { note: 'Invite was replaced' };
  const transport = systemTransport(ctx.config.smtpUrl);
  if (!transport || !ctx.config.publicUrl) throw new PermanentError('SMTP_URL and PUBLIC_URL are needed to email invites');
  const brand = resolveBranding(ctx, inv.workspace_id);
  const from = ctx.config.mailFrom ?? (transport.user.includes('@') ? transport.user : `no-reply@${transport.host}`);
  const who = inv.inviter ? `${inv.inviter} invited you` : 'You are invited';
  const link = inviteLink(ctx, t);
  await ctx.mailer.send(transport, {
    // The product name is the agency's text: a display name only, never part of the address.
    from: { name: brand.productName, address: from.replace(/^.*<|>.*$/g, '').trim() },
    to: inv.email,
    replyTo: brand.supportEmail ?? undefined,
    subject: `${who} to ${inv.workspace_name} on ${brand.productName}`,
    text: `${who} to join ${inv.workspace_name} on ${brand.productName}.\n\nOpen this link to accept (it works once and expires in ${INVITE_DAYS} days):\n${link}\n\nIf you weren't expecting this, you can ignore this email.`,
    messageId: newMessageId(from, ctx.random),
  });
  return { sent: true };
}
