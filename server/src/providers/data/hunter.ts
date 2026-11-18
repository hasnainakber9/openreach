import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { httpJson, ProviderError, RateLimiter } from '../http.js';
import type { ProviderConfig, ProviderDef } from '../registry.js';
import type { EmailFinder, EmailStatus, EmailVerifier } from './types.js';

// Hunter.io (https://hunter.io/api-documentation/v2)
//   Finder:   GET https://api.hunter.io/v2/email-finder?domain|company&first_name&last_name&api_key → data.email, data.score, data.verification.status
//   Verifier: GET https://api.hunter.io/v2/email-verifier?email&api_key → data.status, data.result
//   Test:     GET https://api.hunter.io/v2/account?api_key → data.email, data.requests
// Follows Hunter's public docs; tested only against fakes, never against the live API.

const API = 'https://api.hunter.io/v2';
// Hunter allows 15 requests/s on most plans; stay well under it per integration.
const limiter = new RateLimiter(2);

const credentials = z.object({ apiKey: z.string().trim().min(10).max(200) });
const fields = [{ key: 'apiKey', label: 'API key', type: 'password' as const, secret: true, required: true, help: 'Hunter dashboard → API → your secret API key.' }];

// Hunter's verification statuses. Accept-all servers and free webmail can't be confirmed, so they are risky;
// disposable addresses are as good as invalid.
export function hunterStatus(s: string | null | undefined): EmailStatus {
  switch (s) {
    case 'valid':
      return 'valid';
    case 'invalid':
    case 'disposable':
      return 'invalid';
    case 'accept_all':
    case 'webmail':
      return 'risky';
    default:
      return 'unknown';
  }
}

const REASONS: Record<string, string> = {
  valid: 'Hunter: the mailbox exists',
  invalid: 'Hunter: the mailbox does not exist',
  disposable: 'Hunter: disposable address',
  accept_all: 'Hunter: the server accepts every address, so it can’t be confirmed',
  webmail: 'Hunter: free webmail address',
  unknown: 'Hunter: could not be checked',
};

function client(ctx: Ctx, cfg: ProviderConfig) {
  const key: string = cfg.credentials.apiKey ?? '';
  const get = <T>(path: string, params: Record<string, string>) => {
    if (!key) throw new ProviderError('AUTH', 'Add the Hunter API key', { integrationId: cfg.integrationId });
    const qs = new URLSearchParams({ ...params, api_key: key });
    return httpJson<T>(ctx, `${API}${path}?${qs}`, { secrets: [key], integrationId: cfg.integrationId, limiter, timeoutMs: 20_000 });
  };
  const test = async () => {
    const r = await get<{ data?: { email?: string; plan_name?: string; requests?: { searches?: { used?: number; available?: number } } } }>('/account', {});
    const s = r?.data?.requests?.searches;
    const left = s && typeof s.available === 'number' ? ` · ${Math.max(0, s.available - (s.used ?? 0))} searches left this month` : '';
    return { ok: true, message: `Connected to Hunter${r?.data?.email ? ` as ${r.data.email}` : ''}${r?.data?.plan_name ? ` (${r.data.plan_name})` : ''}${left}` };
  };
  return { get, test };
}

export const hunterFinder: ProviderDef<'email_finder'> = {
  id: 'hunter',
  kind: 'email_finder',
  label: 'Hunter',
  description: 'Finds work emails from a name and a company domain (or company name), with Hunter’s own verification.',
  docsUrl: 'https://hunter.io/api-documentation/v2#email-finder',
  fields,
  credentials,
  settings: z.object({}),
  create(ctx, cfg): EmailFinder {
    const { get, test } = client(ctx, cfg);
    return {
      providerId: 'hunter',
      simulated: false,
      test,
      async find(p) {
        if (!p.firstName || !p.lastName || (!p.domain && !p.company)) return null;
        const params: Record<string, string> = { first_name: p.firstName, last_name: p.lastName };
        if (p.domain) params.domain = p.domain;
        else params.company = p.company;
        let r: { data?: { email?: string | null; score?: number; verification?: { status?: string | null } } };
        try {
          r = await get('/email-finder', params);
        } catch (e) {
          // 404: nobody found; 451: the person asked Hunter not to process their data.
          if (e instanceof ProviderError && (e.status === 404 || e.status === 451)) return null;
          throw e;
        }
        const email = r?.data?.email?.trim().toLowerCase();
        if (!email) return null;
        const v = r.data?.verification?.status;
        return { email, confidence: r.data?.score, status: v ? hunterStatus(v) : undefined, reason: v ? REASONS[v] : undefined, credits: 1 };
      },
    };
  },
};

export const hunterVerifier: ProviderDef<'email_verifier'> = {
  id: 'hunter',
  kind: 'email_verifier',
  label: 'Hunter',
  description: 'Checks whether an address can receive email (SMTP check, accept-all and disposable detection).',
  docsUrl: 'https://hunter.io/api-documentation/v2#email-verifier',
  fields,
  credentials,
  settings: z.object({}),
  create(ctx, cfg): EmailVerifier {
    const { get, test } = client(ctx, cfg);
    return {
      providerId: 'hunter',
      simulated: false,
      test,
      async verify(email) {
        // A 202 (check still running on Hunter's side) has no status yet: unknown.
        const r = await get<{ data?: { status?: string } }>('/email-verifier', { email });
        const s = r?.data?.status ?? 'unknown';
        return { status: hunterStatus(s), reason: REASONS[s] ?? `Hunter: ${s}`, credits: 1 };
      },
    };
  },
};
