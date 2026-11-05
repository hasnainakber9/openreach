import { z } from 'zod';
import type { Ctx } from '../context.js';
import { workspaceRow } from './memberships.js';

// White-label settings. An agency sets them once; its clients inherit each field and may override it.
// /api/branding picks them by the request's Host (custom domains), else by the signed-in workspace.

export interface Branding {
  productName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  supportEmail: string | null;
}

export const DEFAULT_BRANDING: Branding = { productName: 'OpenReach', logoUrl: null, primaryColor: null, supportEmail: null };

interface BrandingRow {
  workspace_id: number;
  product_name: string | null;
  logo_url: string | null;
  primary_color: string | null;
  support_email: string | null;
  custom_domain: string | null;
  updated_at: number;
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
// '' clears a field (the client then inherits the agency's value again).
const optional = <T extends z.ZodTypeAny>(s: T) => z.union([z.literal(''), z.null(), s]).optional();

export const BrandingInput = z.object({
  // Also the display name of invite emails: no address punctuation or control characters.
  productName: optional(
    z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[^<>@,;:"\\\x00-\x1f\x7f]+$/, 'Leave out < > @ , ; : " and \\'),
  ),
  // https only: the logo is shown on the sign-in page, and a plain-http image would be mixed content.
  logoUrl: optional(
    z
      .string()
      .trim()
      .max(500)
      .url()
      .refine((u) => new URL(u).protocol === 'https:' && !new URL(u).username && !new URL(u).password, 'Use an https:// address'),
  ),
  primaryColor: optional(z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a color like #4f46e5')),
  supportEmail: optional(z.string().trim().email().max(200)),
  customDomain: optional(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(HOSTNAME, 'Enter a hostname like app.youragency.com'),
  ),
});
export type BrandingInput = z.infer<typeof BrandingInput>;

const rowOf = (ctx: Ctx, ws: number) => ctx.db.get<BrandingRow>('SELECT * FROM branding WHERE workspace_id = ?', [ws]);

function fields(r: BrandingRow | undefined) {
  return {
    productName: r?.product_name ?? null,
    logoUrl: r?.logo_url ?? null,
    primaryColor: r?.primary_color ?? null,
    supportEmail: r?.support_email ?? null,
    customDomain: r?.custom_domain ?? null,
  };
}

// The workspace's own saved values (nulls where it inherits) and what it inherits from its agency.
export function brandingSettings(ctx: Ctx, ws: number) {
  const w = workspaceRow(ctx, ws);
  const parent = w?.kind === 'client' && w.parent_id ? rowOf(ctx, w.parent_id) : undefined;
  const { customDomain: _, ...inherited } = fields(parent);
  return { ...fields(rowOf(ctx, ws)), inherited: w?.kind === 'client' ? inherited : null, effective: resolveBranding(ctx, ws) };
}

// Field by field: the workspace's value, else its agency's, else the default.
export function resolveBranding(ctx: Ctx, ws: number): Branding {
  const w = workspaceRow(ctx, ws);
  const own = fields(rowOf(ctx, ws));
  const parent = fields(w?.kind === 'client' && w.parent_id ? rowOf(ctx, w.parent_id) : undefined);
  return {
    productName: own.productName ?? parent.productName ?? DEFAULT_BRANDING.productName,
    logoUrl: own.logoUrl ?? parent.logoUrl ?? null,
    primaryColor: own.primaryColor ?? parent.primaryColor ?? null,
    supportEmail: own.supportEmail ?? parent.supportEmail ?? null,
  };
}

const hostOf = (host: string | undefined) => host?.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '') || '';
const publicHost = (ctx: Ctx) => (ctx.config.publicUrl ? hostOf(new URL(ctx.config.publicUrl).host) : '');
const LOCAL = /(^|\.)(localhost|local|internal)$/;

// Why a workspace may not use this domain, or null. The installation's own host is never a tenant's:
// whoever held it would brand everyone's sign-in page. Past that, the operator decides (CUSTOM_DOMAINS).
export function customDomainProblem(ctx: Ctx, domain: string, requestHost?: string): string | null {
  const own = publicHost(ctx) || hostOf(requestHost);
  if (domain === own || LOCAL.test(domain)) return "That is this server's own address. Use a domain of your own, like app.youragency.com.";
  const allowed = ctx.config.customDomains;
  if (!allowed?.length) return ctx.config.allowSignup ? 'Custom domains need to be enabled by the server operator (CUSTOM_DOMAINS).' : null;
  const ok = allowed.some((p) => (p.startsWith('*.') ? domain.endsWith(p.slice(1)) : domain === p));
  return ok ? null : 'That domain is not on the list the server operator allows (CUSTOM_DOMAINS).';
}

export function workspaceForHost(ctx: Ctx, host: string | undefined): number | null {
  const h = hostOf(host);
  if (!h || !HOSTNAME.test(h)) return null;
  const ws = ctx.db.get<{ workspace_id: number }>('SELECT workspace_id FROM branding WHERE custom_domain = ?', [h])?.workspace_id ?? null;
  // Saved before the rules changed (or before PUBLIC_URL was set): ignored rather than served.
  return ws && !customDomainProblem(ctx, h) ? ws : null;
}

// Saves the fields present in `input`; '' or null clears one. Another workspace's domain is refused.
export function saveBranding(ctx: Ctx, ws: number, input: BrandingInput): 'ok' | 'domain_taken' {
  const cur = fields(rowOf(ctx, ws));
  const pick = <K extends keyof typeof cur>(k: K) => (input[k] === undefined ? cur[k] : input[k] || null);
  const next = {
    product_name: pick('productName'),
    logo_url: pick('logoUrl'),
    primary_color: pick('primaryColor')?.toLowerCase() ?? null,
    support_email: pick('supportEmail'),
    custom_domain: pick('customDomain'),
  };
  if (next.custom_domain && ctx.db.get('SELECT 1 FROM branding WHERE custom_domain = ? AND workspace_id <> ?', [next.custom_domain, ws])) return 'domain_taken';
  ctx.db.run(
    `INSERT INTO branding (workspace_id, product_name, logo_url, primary_color, support_email, custom_domain, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id) DO UPDATE SET product_name = excluded.product_name, logo_url = excluded.logo_url, primary_color = excluded.primary_color,
       support_email = excluded.support_email, custom_domain = excluded.custom_domain, updated_at = excluded.updated_at`,
    [ws, next.product_name, next.logo_url, next.primary_color, next.support_email, next.custom_domain, ctx.clock.now()],
  );
  return 'ok';
}
