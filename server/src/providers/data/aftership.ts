import { isIP } from 'node:net';
import { z } from 'zod';
import { checkHost, HostCheckError } from '../../services/hosts.js';
import { httpJson, ProviderError, RateLimiter, scrub } from '../http.js';
import type { ProviderDef } from '../registry.js';
import type { EmailStatus, EmailVerifier, VerifyResult } from './types.js';

// A verifier the user runs themselves: AfterShip email-verifier (https://github.com/AfterShip/email-verifier,
// MIT), built from its cmd/apiserver with the replacement main.go in docs/selfhosted/aftership-apiserver/.
//   Check: GET {base}/v1/{email}/verification → the library's Result as JSON:
//          { email, reachable: 'yes'|'no'|'unknown', syntax: { valid }, smtp: { host_exists, full_inbox, catch_all,
//            deliverable, disabled } | null, disposable, role_account, free, has_mx_records }
//          plus `error` (OpenReach's main.go only) when a check could not finish (MX lookup, port 25 blocked...).
//          The stock apiserver answers a malformed address with the plain text "email address syntax is invalid"
//          (HTTP 200) and any failed check with a plain-text 500: for a domain that doesn't exist that text is
//          the library's "Mail server does not exist : lookup ...: no such host", read here as invalid; any other
//          500 (a failed MX lookup) is a temporary failure, retried like one.
//   Test:  GET {base}/healthz (OpenReach's main.go) → { ok, smtp_check, catch_all_check }; the stock apiserver
//          has no such route (404), so the test then checks a malformed address, which never leaves the verifier.
// Free: no vendor, no credits. Tested only against fakes, never against a running verifier.

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
export const SECRET_HEADER = 'x-verifier-secret';
export const SYNTAX_INVALID_TEXT = 'email address syntax is invalid';
// The library's ErrNoSuchHost, which Verify returns (with reachable "no") when the domain doesn't exist.
const NO_SUCH_HOST = /^\s*Mail server does not exist :/;
// One SMTP conversation can take connect + catch-all probe + RCPT, 10 s each by default, plus the MX lookup.
// OpenReach's main.go stops writing at 55 s.
export const VERIFY_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 10_000;
// Every check opens an SMTP conversation from the verifier's own IP: gently, so that IP stays off blocklists.
// Keyed by the verifier's URL, so several workspaces using one verifier share the budget. Exposed for tests.
export const limits = { verifier: new RateLimiter(1) };

const P = 'Self-hosted verifier';

export const verifierUrlSchema = z
  .string()
  .trim()
  .max(300)
  .url(`Enter a full URL such as ${DEFAULT_BASE_URL}`)
  .refine((v) => {
    // Runs after a failed .url() too, so an unparsable value must not throw here.
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return true;
    }
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.search && !u.hash;
  }, 'Use an http(s) URL without a user name, password, query or #fragment')
  .transform((v) => v.replace(/\/+$/, ''));

export interface AfterShipSmtp {
  host_exists?: boolean;
  full_inbox?: boolean;
  catch_all?: boolean;
  deliverable?: boolean;
  disabled?: boolean;
}

export interface AfterShipResult {
  email?: string;
  reachable?: string;
  syntax?: { username?: string; domain?: string; valid?: boolean };
  smtp?: AfterShipSmtp | null;
  disposable?: boolean;
  role_account?: boolean;
  free?: boolean;
  has_mx_records?: boolean;
  suggestion?: string;
  error?: string;
}

const isResult = (r: unknown): r is AfterShipResult => !!r && typeof r === 'object' && !Array.isArray(r) && ('reachable' in r || 'syntax' in r);

// A server error text in one short, printable line.
const oneLine = (s: string, secrets: (string | null | undefined)[] = []) =>
  scrub(s, secrets)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

// The verifier's answer as an OpenReach status, with the reason recorded on the lead. Checked in this order:
// bad syntax and throwaway domains are invalid; reachable "no" (no mail server, or the server refused the
// mailbox) is invalid; a check that could not finish is unknown; an accepted mailbox is valid; then catch_all;
// everything else (SMTP check off) is unknown.
// What catch_all means in v1.5.0 (smtp.go CheckSMTP): it starts true and only the catch-all probe (RCPT TO a
// made-up address) clears it, and only when the server answers "no such mailbox". So with the probe on, true
// means "the made-up address wasn't turned away": a real catch-all, or greylisting (4xx), a block, a timeout.
// The library then stops before asking about the real mailbox, so deliverable stays false. With the probe off
// it is always true and says nothing, which is why an accepted mailbox is read before it. A probe the server
// refused as "not allowed" or "out of space" sets disabled / full_inbox: that answer is about the probe, not
// about this mailbox, so it is unknown.
export function afterShipVerdict(raw: unknown, secrets: (string | null | undefined)[] = []): { status: EmailStatus; reason: string } {
  const out = (status: EmailStatus, why: string) => ({ status, reason: `${P}: ${why}` });
  if (typeof raw === 'string') {
    if (raw.trim().toLowerCase() === SYNTAX_INVALID_TEXT) return out('invalid', 'the address syntax is invalid');
    return out('unknown', 'unexpected answer');
  }
  if (!isResult(raw)) return out('unknown', 'unexpected answer');
  const r = raw;
  const smtp = r.smtp && typeof r.smtp === 'object' ? r.smtp : null;
  const err = typeof r.error === 'string' ? oneLine(r.error, secrets) : '';
  const notes = [r.role_account && 'role address', r.free && 'free mail provider'].filter(Boolean).join(', ');
  const noted = (why: string) => (notes ? `${why} (${notes})` : why);

  if (r.syntax?.valid === false) return out('invalid', 'the address syntax is invalid');
  if (r.disposable) return out('invalid', 'disposable (throwaway) email domain');
  if (r.reachable === 'no') {
    if (r.has_mx_records === false) return out('invalid', 'the domain has no mail server');
    if (smtp?.disabled) return out('invalid', 'the mail server says this mailbox is disabled');
    return out('invalid', smtp?.full_inbox ? 'the mail server refused this mailbox (inbox full)' : 'the mail server refused this mailbox');
  }
  if (err) return out('unknown', `check not possible: ${err}`);
  if (r.reachable === 'yes' || smtp?.deliverable === true) return out('valid', noted('the mail server accepted this mailbox'));
  if (smtp?.catch_all) {
    if (smtp.disabled || smtp.full_inbox) return out('unknown', 'the mail server refused the verifier\'s test address in a way that says nothing about this mailbox');
    return out('risky', noted('the mail server didn\'t turn away a made-up address at this domain (a catch-all domain, or it delayed or blocked the check), so this mailbox can\'t be confirmed'));
  }
  if (smtp && smtp.host_exists && smtp.deliverable === false) return out('invalid', 'the mail server refused this mailbox');
  if (r.has_mx_records === false) return out('invalid', 'the domain has no mail server');
  if (!smtp) return out('unknown', 'the verifier\'s SMTP check is off, so only the syntax, mail server and disposable domains were checked');
  return out('unknown', `the mail server gave no clear answer (reachable: ${oneLine(String(r.reachable ?? 'missing')).slice(0, 20)})`);
}

// The stock apiserver's plain-text 500 for a domain that doesn't exist, read as the answer OpenReach's main.go
// gives for it (reachable "no", no MX records), so the address is invalid instead of retried until the job gives up.
function stockNoSuchHost(status: number, text: string): AfterShipResult | undefined {
  if (status !== 500 || !NO_SUCH_HOST.test(text)) return undefined;
  return { reachable: 'no', has_mx_records: false, smtp: null };
}

// Checked here before any request: what the URL route can't carry, or what is plainly not an address.
function localVerdict(email: string): { status: EmailStatus; reason: string } | null {
  const at = email.lastIndexOf('@');
  if (!email || email.length > 254 || at < 1 || at === email.length - 1 || /\s/.test(email)) return { status: 'invalid', reason: `${P}: the address syntax is invalid` };
  // The verifier's router reads the decoded path, so a "/" (even as %2F) would split the address.
  if (email.includes('/')) return { status: 'unknown', reason: `${P}: addresses containing "/" can't be checked by this verifier` };
  return null;
}

export const afterShipVerifier: ProviderDef<'email_verifier'> = {
  id: 'aftership',
  kind: 'email_verifier',
  label: 'Self-hosted verifier (AfterShip email-verifier)',
  description:
    'Free and open source (MIT): a verifier you run yourself checks syntax, mail servers and disposable domains and, where outbound port 25 is open, asks the mail server whether the mailbox exists.',
  docsUrl: 'https://github.com/AfterShip/email-verifier',
  fields: [
    {
      key: 'baseUrl',
      label: 'Verifier URL',
      type: 'url',
      placeholder: DEFAULT_BASE_URL,
      help: `Where the verifier listens; the part before /v1. Left empty: ${DEFAULT_BASE_URL} (this computer). Setup: docs/selfhosted/aftership-email-verifier.md.`,
    },
    {
      key: 'secret',
      label: 'Shared secret',
      type: 'password',
      secret: true,
      help: 'Optional. The VERIFIER_SECRET the verifier was started with; sent in the X-Verifier-Secret header.',
    },
  ],
  credentials: z.object({ secret: z.string().trim().min(8, 'Use at least 8 characters').max(200).optional() }),
  settings: z.object({ baseUrl: verifierUrlSchema.default(DEFAULT_BASE_URL) }),
  hostSettings: ['baseUrl'],
  create(ctx, cfg): EmailVerifier {
    const base: string = cfg.settings.baseUrl ?? DEFAULT_BASE_URL;
    const host = new URL(base).host;
    const secret: string | undefined = cfg.credentials.secret || undefined;
    const fail = (code: ProviderError['code'], message: string, status?: number) => new ProviderError(code, message, { integrationId: cfg.integrationId, status });
    const common = { headers: secret ? { [SECRET_HEADER]: secret } : undefined, secrets: [secret], integrationId: cfg.integrationId, limiter: limits.verifier, limitKey: `aftership:${base}` };

    // Hosted installs (billing on): the URL must point at a public host, checked when saved and again before every
    // request (DNS can change), and the request connects only to the address that was checked, so a second DNS
    // answer (rebinding) can't send it to the server's own network. A private host is a settings problem, shown on
    // the integration's card (AUTH). Self-hosted installs skip this, so the verifier on 127.0.0.1 or the LAN works.
    const guard = async () => {
      try {
        const address = await checkHost(ctx, new URL(base).hostname);
        return address ? [{ address, family: isIP(address) || 4 }] : undefined;
      } catch (e) {
        if (e instanceof HostCheckError) throw fail(e.code === 'BLOCKED' ? 'AUTH' : 'UNAVAILABLE', e.message);
        throw e;
      }
    };

    // httpJson's errors, said in terms of this verifier.
    const get = async (path: string, timeoutMs: number) => {
      const pinnedAddresses = await guard();
      try {
        return await httpJson<unknown>(ctx, `${base}${path}`, { ...common, timeoutMs, pinnedAddresses, readError: stockNoSuchHost });
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        if (e.code === 'AUTH') throw fail('AUTH', `The verifier at ${host} refused the shared secret (${e.status}). Use the VERIFIER_SECRET it was started with.`, e.status);
        if (e.code === 'TIMEOUT')
          throw fail('TIMEOUT', `The verifier at ${host} did not answer within ${Math.round(timeoutMs / 1000)} s. If outbound port 25 is blocked, its SMTP checks hang until they time out.`);
        if (e.code === 'NOT_FOUND') throw fail('NOT_FOUND', `No email-verifier API at ${base}: check the URL (the part before /v1).`, e.status);
        if (e.code === 'UNAVAILABLE' && e.status == null) throw fail('UNAVAILABLE', `Could not reach the verifier at ${host}. Is it running?`);
        if (e.code === 'UNAVAILABLE' && e.status === 500)
          throw fail('UNAVAILABLE', `The verifier at ${host} could not finish the check (500). The stock apiserver answers this way when the mail server lookup fails; the main.go in docs/selfhosted reports the reason instead.`, 500);
        throw e;
      }
    };

    return {
      providerId: 'aftership',
      simulated: false,
      free: true,
      async test() {
        let health: unknown;
        try {
          health = await get('/healthz', TEST_TIMEOUT_MS);
        } catch (e) {
          if (!(e instanceof ProviderError && e.code === 'NOT_FOUND')) throw e;
          // The stock apiserver: a malformed address is answered by the verifier alone, without DNS or SMTP.
          const r = await get('/v1/openreach-connection-test/verification', TEST_TIMEOUT_MS);
          if (afterShipVerdict(r).status !== 'invalid') throw fail('BAD_REQUEST', `The server at ${host} did not answer like AfterShip email-verifier: check the URL.`);
          return { ok: true, message: `Connected to email-verifier at ${host}. It looks like the stock apiserver, which doesn't check mailboxes (SMTP is off); build the main.go from docs/selfhosted to turn it on.` };
        }
        const h = health as { ok?: unknown; smtp_check?: unknown; catch_all_check?: unknown } | null;
        if (!h || typeof h !== 'object' || h.ok !== true) throw fail('BAD_REQUEST', `The server at ${host} did not answer like the OpenReach email-verifier build: check the URL.`);
        if (h.smtp_check !== true) return { ok: true, message: `Connected to the verifier at ${host}. Its SMTP check is off, so mailboxes stay unknown (syntax, mail servers and disposable domains are still checked).` };
        const catchAll =
          h.catch_all_check === false ? ' Catch-all detection is off: catch-all domains look valid and refused mailboxes look risky. Build the main.go from docs/selfhosted, which keeps it on.' : '';
        return { ok: true, message: `Connected to the verifier at ${host} · SMTP check on.${catchAll}` };
      },
      async verify(email): Promise<VerifyResult> {
        const address = email.trim();
        const local = localVerdict(address);
        if (local) return { ...local, credits: 0 };
        const r = await get(`/v1/${encodeURIComponent(address)}/verification`, VERIFY_TIMEOUT_MS);
        // A page that isn't the verifier's (a wrong port, another app) is a settings problem, not an answer.
        if (!isResult(r) && !(typeof r === 'string' && r.trim().toLowerCase() === SYNTAX_INVALID_TEXT))
          throw fail('BAD_REQUEST', `The server at ${host} did not answer like AfterShip email-verifier: check the URL.`);
        return { ...afterShipVerdict(r, [secret]), credits: 0 };
      },
    };
  },
};
