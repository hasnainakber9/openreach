import MailChecker from 'mailchecker';
import { z } from 'zod';
import { assertCredits } from '../../billing/limits.js';
import type { Ctx } from '../../context.js';
import { isReservedAddress } from '../../mail/mailboxes.js';
import { recordUsage } from '../../services/usage.js';
import { ProviderError } from '../http.js';
import { providerDef, type ProviderConfig, type ProviderDef } from '../registry.js';
import { isFreeMailDomain, siteDomain, TtlCache } from './website.js';
import type { EmailFinder, EmailStatus, EmailVerifier, FoundEmail } from './types.js';

// "Pattern finder": a free email finder with no vendor and no key. Hunter's data can't be rebuilt, but its method can:
//   1. The lead's company domain (a bare host; webmail, disposable, reserved and malformed domains are skipped).
//      Disposable domains come from mailchecker (MIT, https://github.com/FGRibreau/mailchecker).
//   2. The domain must have a mail server: one MX lookup through ctx.dns (no MX, or a "null MX", is "nobody found").
//   3. Address guesses from the name, most common pattern first (first.last@, first@, flast@, firstlast@, f.last@...),
//      with accents, umlauts, apostrophes, titles, suffixes and compound or hyphenated names normalised.
//   4. The workspace's own email verifiers (Settings → Integrations, in their order) confirm the guesses:
//      first one made-up address, which tells a catch-all domain (accepted: every guess would look valid, so the
//      top guess is returned as risky without more checks) from one that refuses unknown mailboxes; then the
//      guesses in order, stopping at the first the verifier calls valid. At most `maxProbes` checks per lead
//      (the made-up one included), and at most PROBE_BUDGET_MS of them.
//   5. With no verifier connected (or none that can judge the domain), or with verification of found addresses
//      turned off for the run or the workspace, the most common guess comes back unverified ("unknown"), with no
//      verifier check spent: never "valid" unless a verifier said so, and never "risky", which "accept risky
//      addresses" would let through to sending.
// Verifier checks are recorded and charged like any other verifier call; the finder itself costs nothing. A domain's
// catch-all answer and the pattern that worked there are remembered for a while (in memory), so the next lead at the
// same company costs fewer checks. No HTTP of its own: the verifiers do their own (guarded) requests.

export const DEFAULT_MAX_PROBES = 6;
export const MAX_PROBES_LIMIT = 20;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A made-up address the verifier called valid: the server accepts anything, remembered for a day. One it called
// risky is only a maybe: the self-hosted verifier also says risky when the server greylisted, blocked or timed
// out the check, so that answer is remembered briefly and the domain is tested again soon after.
const CATCH_ALL_TTL = DAY;
const CATCH_ALL_MAYBE_TTL = 30 * 60_000;
const PATTERN_TTL = 30 * DAY;

// A self-hosted verifier can take up to a minute per check (port 25 timeouts), and enrich jobs time out after five:
// no new check starts after `budgetMs`. Wall-clock time (not ctx.clock, which the demo runs faster). Replaceable in tests.
export const limits = { budgetMs: 3 * 60_000, now: () => Date.now() };

// Per workspace and domain: whether its mail server accepts any address, and the pattern a verifier confirmed there.
const catchAllCache = new TtlCache<boolean>(5000);
const patternCache = new TtlCache<PatternId>(5000);
export function forgetPatternCaches() {
  catchAllCache.clear();
  patternCache.clear();
}

// ---- Domains -------------------------------------------------------------------------------------------

// A throwaway-mail domain (or a subdomain of one), from mailchecker's list.
export function isDisposableDomain(domain: string): boolean {
  const list = MailChecker.blacklist();
  let d = domain.trim().toLowerCase();
  for (;;) {
    if (list.has(d)) return true;
    const dot = d.indexOf('.');
    if (dot < 0) return false;
    d = d.slice(dot + 1);
  }
}

// The domain to guess addresses at, or why there is none.
export function guessDomain(raw: string | null | undefined): { domain: string } | { skip: string } {
  const domain = siteDomain(raw);
  if (!domain) return { skip: 'no company domain' };
  if (isReservedAddress(`x@${domain}`)) return { skip: 'a reserved example domain' };
  if (isFreeMailDomain(domain)) return { skip: 'a webmail domain' };
  if (isDisposableDomain(domain)) return { skip: 'a disposable email domain' };
  return { domain };
}

// Whether the domain can receive mail at all. No such domain, or no MX records, is a plain "no"; a lookup that
// failed (a timeout, a broken resolver) is a temporary error, retried later.
async function hasMailServer(ctx: Ctx, domain: string, integrationId: number | null): Promise<boolean> {
  let mx: { exchange: string; priority: number }[];
  try {
    mx = await ctx.dns.resolveMx(domain);
  } catch (e) {
    const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : '';
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') return false;
    throw new ProviderError('UNAVAILABLE', `Pattern finder: could not look up the mail servers of ${domain}${/^[A-Z_]{2,20}$/.test(code) ? ` (${code})` : ''}`, { integrationId });
  }
  // RFC 7505 "null MX" (a single record with exchange "" or ".") says the domain accepts no mail.
  return mx.some((r) => !!r.exchange && r.exchange !== '.');
}

// ---- Names and patterns --------------------------------------------------------------------------------

export const PATTERNS = ['first.last', 'first', 'flast', 'firstlast', 'f.last', 'firstl', 'first_last', 'last', 'last.first', 'first-last', 'lastf', 'lastfirst', 'first.l'] as const;
export type PatternId = (typeof PATTERNS)[number];

const BUILD: Record<PatternId, (f: string, l: string) => string> = {
  'first.last': (f, l) => `${f}.${l}`,
  first: (f) => f,
  flast: (f, l) => `${f[0]}${l}`,
  firstlast: (f, l) => `${f}${l}`,
  'f.last': (f, l) => `${f[0]}.${l}`,
  firstl: (f, l) => `${f}${l[0]}`,
  first_last: (f, l) => `${f}_${l}`,
  last: (_f, l) => l,
  'last.first': (f, l) => `${l}.${f}`,
  'first-last': (f, l) => `${f}-${l}`,
  lastf: (f, l) => `${l}${f[0]}`,
  lastfirst: (f, l) => `${l}${f}`,
  'first.l': (f, l) => `${f}.${l[0]}`,
};
// Name variants (a compound surname's parts, the "ae/oe/ue" spelling of umlauts) only get the commonest patterns.
const VARIANT_PATTERNS: PatternId[] = ['first.last', 'flast', 'firstlast'];

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir', 'dame', 'rev', 'herr', 'frau', 'mme', 'mlle', 'sr', 'sra', 'srta']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'mba', 'cpa', 'cfa', 'esq', 'pmp', 'msc', 'bsc', 'dds', 'jd', 'rn', 'cissp']);
const PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'das', 'dos', 'du', 'la', 'le', 'ten', 'ter', 'zu', 'bin', 'binti', 'al', 'el', 'st']);
const LETTERS: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ð: 'd', þ: 'th', ł: 'l', ı: 'i', ħ: 'h', ŧ: 't', ŋ: 'n' };

// Lower-case ASCII: accents dropped (José → jose), special letters spelled out (ß → ss, Ø → o); with `umlauts`,
// ä/ö/ü become ae/oe/ue the German way (Müller → mueller).
function ascii(s: string, umlauts: boolean): string {
  let t = s.normalize('NFC').toLowerCase();
  if (umlauts) t = t.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
  return t
    .replace(/[ßæœøđðþłıħŧŋ]/g, (c) => LETTERS[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

// A name field as words, each a list of its hyphenated parts: "Dr. Mary-Jane (MJ) O'Neil, PhD" → [[mary, jane], [oneil]].
function words(raw: string, umlauts: boolean): string[][] {
  const s = ascii(raw, umlauts)
    .replace(/\([^)]*\)|"[^"]*"|“[^”]*”/g, ' ') // nicknames in brackets or quotes
    .replace(/,.*$/, '') // "Smith, PhD"
    .replace(/['’`‘]/g, ''); // O'Neil → oneil
  return s
    .split(/[\s_/]+/)
    .map((w) =>
      w
        .split('-')
        .map((p) => p.replace(/[^a-z0-9]/g, ''))
        .filter(Boolean),
    )
    .filter((w) => w.length > 0);
}

interface NameForms {
  firsts: string[]; // the main first name first, then variants
  lasts: string[];
}

function nameForms(firstName: string, lastName: string, umlauts: boolean): NameForms | null {
  let first = words(firstName ?? '', umlauts);
  let last = words(lastName ?? '', umlauts);
  while (first.length > 1 && first[0].length === 1 && TITLES.has(first[0][0])) first = first.slice(1);
  while (last.length > 1 && last[last.length - 1].length === 1 && SUFFIXES.has(last[last.length - 1][0])) last = last.slice(0, -1);
  // The whole name typed into the first-name field.
  if (!last.length && first.length > 1) [first, last] = [first.slice(0, 1), first.slice(1)];
  if (!first.length || !last.length) return null;
  const firstWord = first[0];
  const firsts = [firstWord.join(''), firstWord.join('-'), firstWord[0]];
  // "van der Berg" → vanderberg, berg; "Smith-Jones" → smithjones, smith-jones, smith, jones; "García López" → garcialopez, garcia, lopez.
  // A particle (van, de, von...) is never a surname on its own.
  const parts = last.flat();
  const core = parts.filter((x) => !PARTICLES.has(x));
  const lasts = [parts.join(''), last.map((w) => w.join('-')).join(''), core.join(''), core[0] ?? '', core[core.length - 1] ?? ''];
  const clean = (xs: string[]) => [...new Set(xs.filter((x) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x)))];
  const out = { firsts: clean(firsts), lasts: clean(lasts) };
  return out.firsts.length && out.lasts.length ? out : null;
}

export interface Guess {
  local: string;
  pattern: PatternId;
}

const validLocal = (l: string) => l.length <= 64 && /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(l) && !/[._-]{2}/.test(l);

// Address local parts to try, most likely first: every pattern for the main name form, with the commonest patterns
// for the other forms (compound surnames, umlauts spelled ae/oe/ue) slotted in after the five commonest. A pattern
// a verifier already confirmed at this domain (`learned`) goes first.
export function guessLocals(firstName: string, lastName: string, learned?: PatternId): Guess[] {
  const plain = nameForms(firstName, lastName, false);
  if (!plain) return [];
  const german = nameForms(firstName, lastName, true);
  const main = { f: plain.firsts[0], l: plain.lasts[0] };
  const variants: { f: string; l: string }[] = [];
  const forms = [plain, ...(german ? [german] : [])];
  for (const form of forms) for (const f of form.firsts) for (const l of form.lasts) if (f !== main.f || l !== main.l) variants.push({ f, l });

  const ordered: Guess[] = [];
  const add = (f: string, l: string, pattern: PatternId) => ordered.push({ local: BUILD[pattern](f, l), pattern });
  if (learned) {
    add(main.f, main.l, learned);
    for (const v of variants) add(v.f, v.l, learned);
  }
  PATTERNS.slice(0, 5).forEach((p) => add(main.f, main.l, p));
  for (const v of variants) VARIANT_PATTERNS.forEach((p) => add(v.f, v.l, p));
  PATTERNS.slice(5).forEach((p) => add(main.f, main.l, p));

  const seen = new Set<string>();
  return ordered.filter((g) => validLocal(g.local) && !seen.has(g.local) && !!seen.add(g.local));
}

// ---- Checking guesses with the workspace's verifiers ---------------------------------------------------

const label = (v: EmailVerifier) => providerDef('email_verifier', v.providerId)?.label ?? v.providerId;
const isTransient = (e: unknown) => !(e instanceof ProviderError) || e.code === 'UNAVAILABLE' || e.code === 'TIMEOUT';
const errorText = (e: unknown) => (e instanceof ProviderError ? e.message : 'unexpected error');

// The workspace's real verifiers in their order. Each check is charged and logged like the waterfall's own; a
// verifier that fails (a bad key, no credits, an outage) is dropped for the rest of this lead and the next one
// takes over. Rate limits end the lookup, so the job retries it later.
class Prober {
  calls = 0;
  errors: unknown[] = [];
  private readonly deadline: number;
  constructor(
    private ctx: Ctx,
    private workspaceId: number,
    private chain: EmailVerifier[],
    private maxCalls: number,
  ) {
    this.deadline = limits.now() + limits.budgetMs;
  }

  get usable() {
    return this.chain.length > 0;
  }
  get spent() {
    return this.calls >= this.maxCalls || limits.now() >= this.deadline;
  }
  current() {
    return this.chain[0];
  }
  // The current verifier can't judge this domain: the next one gets a go.
  skipCurrent() {
    this.chain.shift();
  }

  // A verdict, or null when no check is left (cap, time budget, or every verifier failed).
  async check(email: string): Promise<{ status: EmailStatus; reason: string; by: EmailVerifier } | null> {
    while (this.chain.length && !this.spent) {
      const v = this.chain[0];
      const log = (credits: number, ok: boolean) => recordUsage(this.ctx, { workspaceId: this.workspaceId, kind: 'email_verifier', provider: v.providerId, operation: 'verifier.verify', credits, ok });
      try {
        if (!v.free) assertCredits(this.ctx, this.workspaceId, 'enrichmentCreditsMonthly');
        this.calls++;
        const r = await v.verify(email);
        log(r.credits ?? 1, true);
        return { status: r.status, reason: r.reason, by: v };
      } catch (e) {
        log(0, false);
        if (e instanceof ProviderError && e.code === 'RATE_LIMIT') throw e;
        if (e instanceof ProviderError && (e.code === 'AUTH' || e.code === 'QUOTA') && e.integrationId) this.ctx.providers.markStatus(e.integrationId, 'error', e.message);
        this.errors.push(e);
        this.chain.shift();
      }
    }
    return null;
  }
}

// A made-up mailbox nobody has: 16 random letters and digits, starting with a letter.
function randomLocal(ctx: Ctx): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = chars[Math.floor(ctx.random() * 26)];
  for (let i = 0; i < 15; i++) s += chars[Math.floor(ctx.random() * chars.length)];
  return s;
}

const P = 'Pattern finder';

export const patternFinder: ProviderDef<'email_finder'> = {
  id: 'pattern',
  kind: 'email_finder',
  label: 'Pattern finder (free)',
  description:
    'Free, no key: guesses the work address from the name and company domain (first.last@, first@, flast@…), skips webmail and disposable domains and domains without a mail server, then checks the guesses with your email verifier and keeps the first one it confirms. Without a verifier the most common pattern comes back unverified.',
  docsUrl: 'https://github.com/FGRibreau/mailchecker',
  fields: [
    {
      key: 'maxProbes',
      label: 'Checks per lead',
      type: 'number',
      placeholder: String(DEFAULT_MAX_PROBES),
      help: `At most this many verifier checks per lead (2–${MAX_PROBES_LIMIT}), including one made-up address that spots catch-all domains. Each costs what your verifier charges per check: nothing on the self-hosted verifier, a credit on Hunter, ZeroBounce or NeverBounce.`,
    },
  ],
  credentials: z.object({}),
  settings: z.object({
    maxProbes: z.coerce.number().int('Use a whole number').min(2, 'Use at least 2: one check goes to the catch-all test').max(MAX_PROBES_LIMIT, `Use at most ${MAX_PROBES_LIMIT}`).optional(),
  }),
  create(ctx, cfg: ProviderConfig): EmailFinder {
    const maxProbes: number = cfg.settings.maxProbes ?? DEFAULT_MAX_PROBES;
    const verifiers = () => ctx.providers.list(cfg.workspaceId, 'email_verifier').filter((v) => !v.simulated);
    return {
      providerId: 'pattern',
      simulated: false,
      free: true,
      async test() {
        const vs = verifiers();
        if (!vs.length)
          return { ok: true, message: 'Ready, but no email verifier is connected, so guesses stay unverified. Connect one under Email verifier (the self-hosted verifier is free).' };
        return { ok: true, message: `Ready: checks guesses with ${vs.map(label).join(', then ')}, at most ${maxProbes} checks per lead. Nothing to sign in to.` };
      },
      async find(p): Promise<FoundEmail | null> {
        const target = guessDomain(p.domain);
        if (!('domain' in target)) return null;
        const { domain } = target;
        const key = `${cfg.workspaceId}:${domain}`;
        const learned = patternCache.get(key, ctx.clock.now())?.value;
        const guesses = guessLocals(p.firstName, p.lastName, learned);
        if (!guesses.length) return null;
        if (!(await hasMailServer(ctx, domain, cfg.integrationId))) return null;

        const at = (g: Guess) => `${g.local}@${domain}`;
        const unverified = (g: Guess, why: string): FoundEmail => ({ email: at(g), status: 'unknown', reason: `${P}: the most likely pattern (${g.pattern}), not verified: ${why}`, credits: 0 });
        if (p.verify === false) return unverified(guesses[0], 'verification of found addresses is off');
        const prober = new Prober(ctx, cfg.workspaceId, verifiers(), maxProbes);
        if (!prober.usable) return unverified(guesses[0], 'no email verifier is connected');

        // Every verifier failed: an outage is retried later; a bad key or no credits leaves the guess unverified.
        const failed = (g: Guess): FoundEmail => {
          const transient = prober.errors.find(isTransient);
          if (transient) throw new ProviderError(transient instanceof ProviderError ? transient.code : 'UNAVAILABLE', `${P}: could not check guesses: ${errorText(transient)}`);
          return unverified(g, errorText(prober.errors[prober.errors.length - 1]));
        };

        // 1. Catch-all: does the mail server accept a mailbox that can't exist?
        const now = ctx.clock.now();
        let catchAll = catchAllCache.get(key, now)?.value;
        let cantJudge = '';
        let ttl = CATCH_ALL_TTL;
        while (catchAll === undefined && prober.usable && !prober.spent) {
          const r = await prober.check(`${randomLocal(ctx)}@${domain}`);
          if (!r) break;
          if (r.status === 'invalid') catchAll = false;
          else if (r.status === 'valid') catchAll = true;
          else if (r.status === 'risky') {
            catchAll = true;
            ttl = CATCH_ALL_MAYBE_TTL;
          } else {
            // "unknown" (port 25 blocked, a greylisting server...): this verifier can't judge mailboxes here.
            cantJudge = r.reason;
            prober.skipCurrent();
          }
        }
        if (catchAll !== undefined) catchAllCache.set(key, catchAll, now + ttl);
        if (catchAll === true) {
          return {
            email: at(guesses[0]),
            status: 'risky',
            reason: `${P}: ${domain} accepts mail for any address (catch-all), so the most likely pattern (${guesses[0].pattern}) can't be confirmed`,
            credits: 0,
            verified: true,
          };
        }
        if (catchAll === undefined) {
          if (cantJudge) return unverified(guesses[0], cantJudge);
          if (prober.errors.length) return failed(guesses[0]);
          return unverified(guesses[0], `no checks left (at most ${maxProbes} per lead)`);
        }

        // 2. The guesses in order, until the verifier confirms one.
        let fallback: { g: Guess; status: EmailStatus; reason: string } | null = null;
        let next = 0;
        for (; next < guesses.length; next++) {
          const g = guesses[next];
          const r = await prober.check(at(g));
          if (!r) break;
          if (r.status === 'valid') {
            patternCache.set(key, g.pattern, ctx.clock.now() + PATTERN_TTL);
            return { email: at(g), status: 'valid', reason: `${P} (${g.pattern}): ${r.reason}`, credits: 0, verified: true };
          }
          // On a domain that refuses made-up mailboxes, risky or unknown is a maybe: kept in case nothing better turns up.
          if (r.status !== 'invalid' && (!fallback || (r.status === 'risky' && fallback.status === 'unknown'))) fallback = { g, status: r.status, reason: r.reason };
        }
        if (fallback) return { email: at(fallback.g), status: fallback.status, reason: `${P} (${fallback.g.pattern}): ${fallback.reason}`, credits: 0, verified: true };
        // Stopped because every verifier failed, with guesses left to try.
        if (next < guesses.length && !prober.usable && prober.errors.length) return failed(guesses[next]);
        // Every guess tried was refused (or the checks ran out): nobody found.
        return null;
      },
    };
  },
};
