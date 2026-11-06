import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { pipeline, Readable } from 'node:stream';
import zlib from 'node:zlib';

// A GET or HEAD that connects only to addresses the caller already checked, so a second DNS answer (rebinding)
// can't send it anywhere else. The host name is still used for the Host header and for TLS (SNI and the
// certificate check). ctx.fetch takes this path when the request init carries `pinnedAddresses`; a fake
// ctx.fetch in tests sees the field and can check it.

export interface PinnedAddress {
  address: string;
  family: number;
}

export type PinnedInit = RequestInit & { pinnedAddresses?: PinnedAddress[] };

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

const failed = (message: string, cause?: unknown) => Object.assign(new TypeError(message), { cause });

export function pinnedFetch(rawUrl: string, init: PinnedInit, addresses: PinnedAddress[]): Promise<Response> {
  const url = new URL(rawUrl);
  const method = (init.method ?? 'GET').toUpperCase();
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return Promise.reject(failed('fetch failed: only http(s) is supported'));
  if (method !== 'GET' && method !== 'HEAD') return Promise.reject(failed('fetch failed: only GET and HEAD are supported'));
  if (!addresses.length) return Promise.reject(failed('fetch failed: no address to connect to'));
  const signal = init.signal ?? undefined;
  if (signal?.aborted) return Promise.reject(signal.reason);

  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  headers['accept-encoding'] = 'gzip, deflate, br';

  // Only the checked addresses, whatever the name resolves to now.
  const lookup = ((_host: string, opts: { family?: number; all?: boolean }, cb: (...args: unknown[]) => void) => {
    const fam = opts?.family === 4 || opts?.family === 6 ? opts.family : 0;
    const list = addresses.filter((a) => !fam || a.family === fam);
    if (!list.length) return cb(Object.assign(new Error(`no checked ${fam === 6 ? 'IPv6' : 'IPv4'} address`), { code: 'ENOTFOUND' }));
    if (opts?.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  }) as unknown as LookupFunction;

  return new Promise<Response>((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    // A fresh connection each time (agent: false): a pooled socket could belong to an earlier answer.
    const req = mod.request(url, { method, headers, lookup, agent: false, signal }, (res) => {
      const status = res.statusCode ?? 0;
      const out = new Headers();
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
        try {
          out.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        } catch {
          // A header fetch would refuse: dropped.
        }
      }
      let body: Readable = res;
      const encoding = (res.headers['content-encoding'] ?? '').trim().toLowerCase();
      const decoder =
        encoding === 'gzip' || encoding === 'x-gzip'
          ? zlib.createGunzip()
          : encoding === 'deflate'
            ? zlib.createInflate()
            : encoding === 'br'
              ? zlib.createBrotliDecompress()
              : null;
      if (decoder) body = pipeline(res, decoder, () => {});
      // A timeout while the body streams ends the read with the signal's reason (a TimeoutError).
      const onAbort = () => body.destroy(signal!.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      body.once('close', () => signal?.removeEventListener('abort', onAbort));
      try {
        const stream = method === 'HEAD' || NULL_BODY.has(status) ? null : (Readable.toWeb(body) as ReadableStream<Uint8Array>);
        if (!stream) res.resume();
        resolve(new Response(stream, { status, headers: out }));
      } catch (e) {
        // A status fetch can't represent (below 200 or above 599).
        res.destroy();
        reject(failed('fetch failed: invalid response', e));
      }
    });
    req.on('error', (e) => reject(e.name === 'AbortError' && signal?.aborted ? signal.reason : failed('fetch failed', e)));
    req.end();
  });
}

// The default ctx.fetch: pinned when asked, the platform's fetch otherwise.
export function pinnableFetch(input: Parameters<typeof fetch>[0], init?: PinnedInit): Promise<Response> {
  if (init?.pinnedAddresses) {
    const { pinnedAddresses, ...rest } = init;
    return pinnedFetch(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, rest, pinnedAddresses);
  }
  return globalThis.fetch(input, init);
}
