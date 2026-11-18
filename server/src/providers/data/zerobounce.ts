import { z } from 'zod';
import { httpJson, ProviderError, RateLimiter } from '../http.js';
import type { ProviderDef } from '../registry.js';
import type { EmailStatus, EmailVerifier } from './types.js';

// ZeroBounce (https://www.zerobounce.net/docs/email-validation-api-quickstart/)
//   Validate: GET https://api.zerobounce.net/v2/validate?api_key&email&ip_address= → status, sub_status
//   Test:     GET https://api.zerobounce.net/v2/getcredits?api_key → Credits ("-1" means the key is invalid)
// A bad key comes back as HTTP 200 with an `error` field, so both are checked here.
// Follows ZeroBounce's public docs; tested only against fakes, never against the live API.

const API = 'https://api.zerobounce.net/v2';
const limiter = new RateLimiter(2);

// Spam traps, abuse and do-not-mail addresses must never be emailed, so they count as invalid.
export function zeroBounceStatus(s: string | null | undefined): EmailStatus {
  switch (s) {
    case 'valid':
      return 'valid';
    case 'invalid':
    case 'spamtrap':
    case 'abuse':
    case 'do_not_mail':
      return 'invalid';
    case 'catch-all':
      return 'risky';
    default:
      return 'unknown';
  }
}

export const zeroBounceVerifier: ProviderDef<'email_verifier'> = {
  id: 'zerobounce',
  kind: 'email_verifier',
  label: 'ZeroBounce',
  description: 'Checks addresses for deliverability, catch-all domains, spam traps and abuse addresses.',
  docsUrl: 'https://www.zerobounce.net/docs/email-validation-api-quickstart/',
  fields: [{ key: 'apiKey', label: 'API key', type: 'password', secret: true, required: true, help: 'ZeroBounce → API → API keys.' }],
  credentials: z.object({ apiKey: z.string().trim().min(10).max(200) }),
  settings: z.object({}),
  create(ctx, cfg): EmailVerifier {
    const key: string = cfg.credentials.apiKey ?? '';
    const get = async <T extends { error?: string }>(path: string, params: Record<string, string>) => {
      if (!key) throw new ProviderError('AUTH', 'Add the ZeroBounce API key', { integrationId: cfg.integrationId });
      const r = await httpJson<T>(ctx, `${API}${path}?${new URLSearchParams({ api_key: key, ...params })}`, { secrets: [key], integrationId: cfg.integrationId, limiter, timeoutMs: 30_000 });
      if (r && typeof r === 'object' && typeof r.error === 'string') {
        const auth = /key|credit/i.test(r.error);
        throw new ProviderError(auth ? 'AUTH' : 'BAD_REQUEST', `ZeroBounce: ${r.error.split(key).join('••••').slice(0, 200)}`, { integrationId: cfg.integrationId });
      }
      return r;
    };
    return {
      providerId: 'zerobounce',
      simulated: false,
      async test() {
        const r = await get<{ Credits?: string | number; error?: string }>('/getcredits', {});
        const credits = Number(r?.Credits);
        if (credits < 0) return { ok: false, message: 'ZeroBounce did not accept the API key' };
        return { ok: true, message: `Connected to ZeroBounce · ${Number.isFinite(credits) ? credits : 'unknown'} credits left` };
      },
      async verify(email) {
        const r = await get<{ status?: string; sub_status?: string; error?: string }>('/validate', { email, ip_address: '' });
        const status = zeroBounceStatus(r?.status);
        const detail = [r?.status, r?.sub_status].filter(Boolean).join(', ').replace(/_/g, ' ');
        // ZeroBounce doesn't charge for "unknown" results.
        return { status, reason: `ZeroBounce: ${detail || 'no result'}`, credits: status === 'unknown' ? 0 : 1 };
      },
    };
  },
};
