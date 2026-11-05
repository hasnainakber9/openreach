import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Ctx } from '../context.js';
import { logActivity } from '../services/activity.js';

// Links that leave the app (unsubscribe, open pixel, click redirect) carry an HMAC-signed token of
// (workspace, lead, email message) under a key derived from APP_SECRET, so the public routes can trust
// them without a lookup and without a client-supplied workspace id. Tokens never expire: an
// unsubscribe link must keep working in an old email. Each kind signs differently, so an open-pixel
// token can't be replayed as an unsubscribe.

export type TokenKind = 'u' | 'o' | 'c';
export interface TokenPayload {
  workspaceId: number;
  leadId: number;
  emailMessageId: number;
}

const keys = new Map<string, Buffer>();
function key(ctx: Ctx): Buffer {
  let k = keys.get(ctx.config.appSecret);
  if (!k) {
    k = createHash('sha256').update(`openreach:mail-links:${ctx.config.appSecret}`).digest();
    keys.set(ctx.config.appSecret, k);
  }
  return k;
}

const mac = (ctx: Ctx, data: string) => createHmac('sha256', key(ctx)).update(data).digest().subarray(0, 16).toString('base64url');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signToken(ctx: Ctx, kind: TokenKind, p: TokenPayload): string {
  const body = `${p.workspaceId}.${p.leadId}.${p.emailMessageId}`;
  return `${body}.${mac(ctx, `${kind}:${body}`)}`;
}

export function verifyToken(ctx: Ctx, kind: TokenKind, token: string): TokenPayload | null {
  const m = /^(\d{1,12})\.(\d{1,12})\.(\d{1,12})\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m) return null;
  if (!safeEqual(mac(ctx, `${kind}:${m[1]}.${m[2]}.${m[3]}`), m[4])) return null;
  return { workspaceId: Number(m[1]), leadId: Number(m[2]), emailMessageId: Number(m[3]) };
}

// A click link signs the destination too, so the redirect can't be pointed anywhere else (no open redirect).
export const clickSignature = (ctx: Ctx, token: string, url: string) => mac(ctx, `c-url:${token}:${url}`);
export const verifyClick = (ctx: Ctx, token: string, url: string, sig: string) => safeEqual(clickSignature(ctx, token, url), sig);

// Absolute links come from PUBLIC_URL only, never from a request's Host header.
export function mailLinks(ctx: Ctx, p: TokenPayload) {
  const base = ctx.config.publicUrl;
  if (!base) return null;
  const click = signToken(ctx, 'c', p);
  return {
    unsubscribe: `${base}/u/${signToken(ctx, 'u', p)}`,
    openPixel: `${base}/t/o/${signToken(ctx, 'o', p)}`,
    click: (url: string) => `${base}/t/c/${click}?u=${encodeURIComponent(url)}&s=${clickSignature(ctx, click, url)}`,
  };
}

interface TrackedRow {
  id: number;
  mailbox_id: number;
  campaign_id: number | null;
  lead_id: number | null;
  node_id: string | null;
  variant: string | null;
  opened_at: number | null;
  clicked_at: number | null;
  timezone: string;
}

function trackedMessage(ctx: Ctx, p: TokenPayload): TrackedRow | undefined {
  return ctx.db.get<TrackedRow>(
    `SELECT e.id, e.mailbox_id, e.campaign_id, e.lead_id, e.node_id, e.variant, e.opened_at, e.clicked_at, m.timezone
     FROM email_messages e JOIN mailboxes m ON m.id = e.mailbox_id WHERE e.id = ? AND e.workspace_id = ? AND e.direction = 'out'`,
    [p.emailMessageId, p.workspaceId],
  );
}

// Opens and clicks are counted on the email; the first of each also goes into the activity feed.
// (Mail scanners and image proxies fetch pixels and links too, so these are indications, not proof.)
export function recordOpen(ctx: Ctx, token: string): boolean {
  const p = verifyToken(ctx, 'o', token);
  const row = p && trackedMessage(ctx, p);
  if (!p || !row) return false;
  const now = ctx.clock.now();
  ctx.db.run('UPDATE email_messages SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?) WHERE id = ?', [now, row.id]);
  if (row.opened_at == null) {
    logActivity(ctx, { workspaceId: p.workspaceId, mailboxId: row.mailbox_id, campaignId: row.campaign_id, leadId: row.lead_id, type: 'email_open', timezone: row.timezone, nodeId: row.node_id, variant: row.variant });
  }
  return true;
}

// Returns where to send the browser, or null for a bad token or a URL this link was not signed for.
export function recordClick(ctx: Ctx, token: string, url: string, sig: string): string | null {
  const p = verifyToken(ctx, 'c', token);
  if (!p || !verifyClick(ctx, token, url, sig) || !/^https?:\/\//i.test(url)) return null;
  const row = trackedMessage(ctx, p);
  if (row) {
    const now = ctx.clock.now();
    ctx.db.run('UPDATE email_messages SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, ?) WHERE id = ?', [now, row.id]);
    if (row.clicked_at == null) {
      logActivity(ctx, { workspaceId: p.workspaceId, mailboxId: row.mailbox_id, campaignId: row.campaign_id, leadId: row.lead_id, type: 'email_click', detail: url.slice(0, 300), timezone: row.timezone, nodeId: row.node_id, variant: row.variant });
    }
  }
  return url;
}
