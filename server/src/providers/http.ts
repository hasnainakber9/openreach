import type { Ctx } from '../context.js';
import type { PinnedAddress, PinnedInit } from '../services/pinned-fetch.js';

export type ProviderErrorCode = 'AUTH' | 'QUOTA' | 'RATE_LIMIT' | 'BAD_REQUEST' | 'NOT_FOUND' | 'UNAVAILABLE' | 'TIMEOUT';

// Errors from external services. Messages are user-readable and never contain keys, auth
// headers or full request URLs. The job queue maps codes to retry/permanent failures.
export class ProviderError extends Error {
  readonly retryAfterMs?: number;
  readonly status?: number;
  integrationId?: number | null;
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    opts: { retryAfterMs?: number; status?: number; integrationId?: number | null } = {},
  ) {
    super(message);
    this.retryAfterMs = opts.retryAfterMs;
    this.status = opts.status;
    this.integrationId = opts.integrationId;
  }
}

// In-memory token bucket per key (integration id), so one workspace can't hammer a vendor.
export class RateLimiter {
  private buckets = new Map<string | number, { tokens: number; at: number }>();
  constructor(
    private perSecond: number,
    private burst = Math.max(1, perSecond),
    private now = () => Date.now(),
  ) {}

  // Milliseconds until a token is free (0 = take it now). Exposed for tests.
  reserve(key: string | number): number {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: t };
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.perSecond);
    b.at = t;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - b.tokens) / this.perSecond) * 1000);
  }

  async take(key: string | number) {
    for (;;) {
      const wait = this.reserve(key);
      if (!wait) return;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export interface HttpJsonOptions<T = any> {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown; // sent as JSON
  form?: Record<string, string>; // sent as application/x-www-form-urlencoded
  timeoutMs?: number;
  limiter?: RateLimiter;
  limitKey?: string | number;
  // Credential values to scrub from any error message (some vendors echo the key back).
  secrets?: (string | null | undefined)[];
  integrationId?: number | null;
  // Connect only to these already-checked addresses (services/pinned-fetch.ts; GET and HEAD only).
  pinnedAddresses?: PinnedAddress[];
  // A non-2xx reply the caller understands, turned into a result (undefined: mapped to an error as usual).
  // Gets the raw body text; whatever it returns must not carry that text into an error message unchecked.
  readError?: (status: number, text: string) => T | undefined;
}

export function scrub(text: string, secrets: (string | null | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('••••');
  return out;
}

// A short vendor error string from a JSON error body. Never the raw body.
function vendorMessage(data: any): string | null {
  if (!data || typeof data !== 'object') return null;
  const candidates = [data.error?.message, data.message, data.error_description, typeof data.error === 'string' ? data.error : null, data.errors?.[0]?.message, data.errors?.[0]?.details, data.detail];
  const m = candidates.find((c) => typeof c === 'string' && c.trim());
  return m ? String(m).trim() : null;
}

function retryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

// Every outbound provider call goes through here: ctx.fetch (tests inject fakes), a timeout,
// no redirects (credentials are never replayed to another host), and errors mapped to ProviderError.
export async function httpJson<T = any>(ctx: Ctx, url: string, opts: HttpJsonOptions<T> = {}): Promise<T> {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      throw new ProviderError('BAD_REQUEST', 'Invalid service URL', { integrationId: opts.integrationId });
    }
  })();
  const fail = (code: ProviderErrorCode, message: string, extra: { status?: number; retryAfterMs?: number } = {}) =>
    new ProviderError(code, scrub(message, opts.secrets).slice(0, 300), { ...extra, integrationId: opts.integrationId });

  if (opts.limiter) await opts.limiter.take(opts.limitKey ?? opts.integrationId ?? host);
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  let body: string | undefined;
  if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    const init: PinnedInit = { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) };
    if (opts.pinnedAddresses) init.pinnedAddresses = opts.pinnedAddresses;
    res = await ctx.fetch(url, init);
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw fail('TIMEOUT', `${host} did not answer in time`);
    throw fail('UNAVAILABLE', `Could not reach ${host}`);
  }

  const text = await res.text().catch(() => '');
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (res.ok) return (data ?? (text ? text : null)) as T;
  if (opts.readError) {
    const read = opts.readError(res.status, text);
    if (read !== undefined) return read;
  }

  const vendor = vendorMessage(data);
  const detail = vendor ? `: ${scrub(vendor, opts.secrets).slice(0, 200)}` : '';
  const status = res.status;
  if (status === 401 || status === 403) throw fail('AUTH', `${host} rejected the credentials (${status})${detail}`, { status });
  if (status === 402) throw fail('QUOTA', `${host} says the plan or credits ran out${detail}`, { status });
  if (status === 429) throw fail('RATE_LIMIT', `${host} is rate limiting requests${detail}`, { status, retryAfterMs: retryAfter(res.headers.get('retry-after')) });
  if (status === 404) throw fail('NOT_FOUND', `${host} answered 404${detail}`, { status });
  if (status >= 500) throw fail('UNAVAILABLE', `${host} had a server error (${status})${detail}`, { status });
  throw fail('BAD_REQUEST', `${host} refused the request (${status})${detail}`, { status });
}
