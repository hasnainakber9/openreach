import { z } from 'zod';
import { httpJson, ProviderError, RateLimiter } from '../http.js';
import type { ProviderDef } from '../registry.js';
import type { EmailStatus, EmailVerifier } from './types.js';

// NeverBounce (https://developers.neverbounce.com/reference/single-check)
//   Check: GET https://api.neverbounce.com/v4.2/single/check?key&email → status ('success' | 'auth_failure' | ...), result
//   Test:  GET https://api.neverbounce.com/v4.2/account/info?key → credits_info
// API-level failures (a bad key, no credits) come back as HTTP 200 with a non-success `status`.
// Follows NeverBounce's public docs; tested only against fakes, never against the live API.

const API = 'https://api.neverbounce.com/v4.2';
const limiter = new RateLimiter(2);

export function neverBounceStatus(r: string | null | undefined): EmailStatus {
  switch (r) {
    case 'valid':
      return 'valid';
    case 'invalid':
    case 'disposable':
      return 'invalid';
    case 'catchall':
      return 'risky';
    default:
      return 'unknown';
  }
}

const FAILURES: Record<string, 'AUTH' | 'QUOTA' | 'RATE_LIMIT' | 'BAD_REQUEST' | 'UNAVAILABLE'> = {
  auth_failure: 'AUTH',
  bad_referrer: 'AUTH',
  temp_unavail: 'UNAVAILABLE',
  throttle_triggered: 'RATE_LIMIT',
  general_failure: 'UNAVAILABLE',
};

export const neverBounceVerifier: ProviderDef<'email_verifier'> = {
  id: 'neverbounce',
  kind: 'email_verifier',
  label: 'NeverBounce',
  description: 'Checks addresses for deliverability and flags catch-all and disposable domains.',
  docsUrl: 'https://developers.neverbounce.com/reference/single-check',
  fields: [{ key: 'apiKey', label: 'API key', type: 'password', secret: true, required: true, help: 'NeverBounce → Apps → create a Custom Integration app and copy its API key.' }],
  credentials: z.object({ apiKey: z.string().trim().min(10).max(200) }),
  settings: z.object({}),
  create(ctx, cfg): EmailVerifier {
    const key: string = cfg.credentials.apiKey ?? '';
    const get = async <T extends { status?: string; message?: string }>(path: string, params: Record<string, string>) => {
      if (!key) throw new ProviderError('AUTH', 'Add the NeverBounce API key', { integrationId: cfg.integrationId });
      const r = await httpJson<T>(ctx, `${API}${path}?${new URLSearchParams({ key, ...params })}`, { secrets: [key], integrationId: cfg.integrationId, limiter, timeoutMs: 30_000 });
      if (r && typeof r === 'object' && r.status && r.status !== 'success') {
        const msg = `NeverBounce: ${(r.message ?? r.status).split(key).join('••••').slice(0, 200)}`;
        const credits = /credit/i.test(r.message ?? '');
        throw new ProviderError(credits ? 'QUOTA' : (FAILURES[r.status] ?? 'BAD_REQUEST'), msg, { integrationId: cfg.integrationId });
      }
      return r;
    };
    return {
      providerId: 'neverbounce',
      simulated: false,
      async test() {
        const r = await get<{ status?: string; credits_info?: { paid_credits_remaining?: number; free_credits_remaining?: number } }>('/account/info', {});
        const c = r?.credits_info;
        const left = c ? (c.paid_credits_remaining ?? 0) + (c.free_credits_remaining ?? 0) : null;
        return { ok: true, message: `Connected to NeverBounce${left != null ? ` · ${left} credits left` : ''}` };
      },
      async verify(email) {
        const r = await get<{ status?: string; result?: string; message?: string }>('/single/check', { email });
        return { status: neverBounceStatus(r?.result), reason: `NeverBounce: ${r?.result ?? 'no result'}`, credits: 1 };
      },
    };
  },
};
