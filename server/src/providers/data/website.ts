import { isIP } from 'node:net';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { billingEnabled, billingRoot } from '../../billing/limits.js';
import { isBlockedAddress } from '../../services/hosts.js';
import type { PinnedAddress, PinnedInit } from '../../services/pinned-fetch.js';
import { httpJson, ProviderError, RateLimiter } from '../http.js';
import type { ProviderConfig, ProviderDef } from '../registry.js';
import type { Enricher, EnrichInput, EnrichResult, LeadFields } from './types.js';

// "Company website": a free enricher with no key and no vendor account.
//   1. Reads the company's own homepage (and its About page when the homepage says little), honouring
//      robots.txt, and takes what the site publishes about itself: <meta>/OpenGraph tags and schema.org JSON-LD
//      Organization blocks (name, description, logo, foundingDate, numberOfEmployees, address, sameAs links).
//   2. Optionally looks the company up on Wikidata (CC0 data) by its official website (P856) for industry
//      (P452), employees (P1128), inception (P571), headquarters (P159), country (P17) and LinkedIn id (P4264).
//      GET https://query.wikidata.org/sparql?query=…&format=json (Accept: application/sparql-results+json).
// Nothing is guessed: a value is only returned when the site or Wikidata states it. Wikidata only knows
// notable companies, so most small firms get website facts only. Tested only against fakes.
//
// The domain comes from lead data (an import, a CSV), not from the workspace's settings, so the website fetch
// is always guarded, self-hosted or not: http(s) only, no user name or password, default ports, no IP
// literals or local names, every address the name resolves to must be public, and the connection goes only to
// those checked addresses (a later, different DNS answer can't redirect it); at most MAX_REDIRECTS redirects
// (each hop checked again), a timeout per request and one for the whole site, and a size cap. Pages are parsed
// with linear scans only, so a hostile page can't stall the server. On a hosted installation each billing
// root gets a daily number of lookups and a share of the Wikidata rate.

export const USER_AGENT = 'OpenReachBot/0.1 (+https://github.com/hasnainakber9/openreach)';
const ROBOTS_AGENT = 'openreachbot';
const WDQS = 'https://query.wikidata.org/sparql';

export const MAX_REDIRECTS = 4;
export const PAGE_TIMEOUT_MS = 10_000;
export const MAX_HTML_BYTES = 1_000_000;
export const MAX_ROBOTS_BYTES = 500_000;
const WIKIDATA_TIMEOUT_MS = 25_000;

// Politeness: Wikidata asks for about one query a second from one client (shared by every workspace on this
// server); websites get at most one request a second per host. On a hosted installation one billing root may
// use at most a quarter of the Wikidata rate, and `dailyLookups` lookups per rolling day. `siteDeadlineMs`
// bounds everything one site read does (robots.txt, redirects, the www./http fallbacks, the About page).
// Replaceable in tests.
export const limits = {
  wikidata: new RateLimiter(1),
  wikidataPerRoot: new RateLimiter(0.25, 4),
  site: new RateLimiter(1, 2),
  dailyLookups: 2000,
  siteDeadlineMs: 30_000,
};

// ---- Small caches (in memory, per server; a restart starts empty) ---------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SITE_TTL = 12 * HOUR;
const WIKIDATA_HIT_TTL = 7 * 24 * HOUR;
const WIKIDATA_MISS_TTL = 24 * HOUR;
const ROBOTS_TTL = HOUR;
const ROBOTS_ERROR_TTL = 10 * 60_000;

export class TtlCache<V> {
  private m = new Map<string, { until: number; value: V }>();
  constructor(private max: number) {}
  get(key: string, now: number): { value: V } | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.until <= now) {
      this.m.delete(key);
      return undefined;
    }
    return { value: e.value };
  }
  set(key: string, value: V, until: number) {
    this.m.delete(key);
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value!);
    this.m.set(key, { until, value });
  }
  clear() {
    this.m.clear();
  }
}

const siteCache = new TtlCache<SiteFacts | null>(500);
const wikidataCache = new TtlCache<WikidataFacts | null>(2000);
const robotsCache = new TtlCache<RobotsRule[] | 'allow' | 'busy'>(500);

export function forgetWebsiteCaches() {
  siteCache.clear();
  wikidataCache.clear();
  robotsCache.clear();
}

// ---- Domains -------------------------------------------------------------------------------------------

// Names that never belong to a public company website.
const LOCAL_TLDS = new Set(['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'example', 'test', 'invalid', 'onion', 'arpa', 'alt']);

export function publicHostName(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || isIP(host.replace(/^\[|\]$/g, ''))) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  const tld = labels[labels.length - 1];
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld) || LOCAL_TLDS.has(tld)) return null;
  return host;
}

// A lead's company domain or website ("Acme.com", "https://www.acme.com/about") as a bare host ("acme.com"),
// or null when it can't be a public website.
export function siteDomain(raw: string | null | undefined): string | null {
  let s = (raw ?? '').trim();
  if (!s || s.length > 500) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
  const host = publicHostName(u.hostname);
  return host ? host.replace(/^www\./, '') : null;
}

// Free, personal and ISP mail domains: an address there says nothing about the person's company.
const FREE_MAIL = new Set(
  `gmail.com googlemail.com ymail.com rocketmail.com outlook.com hotmail.com live.com msn.com passport.com windowslive.com icloud.com me.com mac.com
  aol.com aim.com verizon.net proton.me protonmail.com protonmail.ch pm.me tutanota.com tutanota.de tutamail.com tuta.io tuta.com
  mail.com email.com usa.com post.com consultant.com myself.com fastmail.com fastmail.fm hey.com zoho.com zohomail.com hushmail.com mailfence.com
  posteo.de posteo.net mailbox.org runbox.com disroot.org riseup.net startmail.com yandex.com yandex.ru ya.ru mail.ru inbox.ru bk.ru list.ru
  rambler.ru ukr.net i.ua meta.ua qq.com foxmail.com 163.com 126.com yeah.net sina.com sina.cn sohu.com aliyun.com 139.com 189.cn
  naver.com daum.net hanmail.net nate.com kakao.com rediffmail.com sify.com
  comcast.net xfinity.com att.net sbcglobal.net bellsouth.net pacbell.net ameritech.net flash.net prodigy.net swbell.net wans.net
  charter.net spectrum.net rr.com roadrunner.com twc.com cox.net optonline.net optimum.net earthlink.net mindspring.com juno.com netzero.net
  netzero.com frontier.com frontiernet.net centurylink.net embarqmail.com windstream.net q.com qwest.net suddenlink.net mediacombb.net
  btinternet.com btopenworld.com talk21.com sky.com virginmedia.com blueyonder.co.uk ntlworld.com talktalk.net tiscali.co.uk plus.net
  shaw.ca rogers.com sympatico.ca bell.net telus.net videotron.ca cogeco.ca eastlink.ca
  bigpond.com bigpond.net.au optusnet.com.au iinet.net.au internode.on.net tpg.com.au xtra.co.nz
  laposte.net orange.fr wanadoo.fr free.fr sfr.fr neuf.fr club-internet.fr bbox.fr numericable.fr aliceadsl.fr
  web.de t-online.de freenet.de arcor.de vodafone.de 1und1.de online.de email.de
  libero.it virgilio.it alice.it tin.it tim.it tiscali.it fastwebnet.it inwind.it iol.it
  telefonica.net terra.com terra.es ono.com movistar.es sapo.pt
  ziggo.nl kpnmail.nl planet.nl home.nl hetnet.nl chello.nl xs4all.nl telenet.be skynet.be proximus.be
  bluewin.ch hispeed.ch sunrise.ch chello.at aon.at a1.net telia.com bredband.net comhem.se online.no telenor.no
  seznam.cz centrum.cz atlas.cz post.cz wp.pl o2.pl interia.pl onet.pl op.pl tlen.pl gazeta.pl citromail.hu freemail.hu
  uol.com.br bol.com.br terra.com.br ig.com.br globo.com globomail.com oi.com.br prodigy.net.mx
  163.net 21cn.com tom.com sina.com.cn ocn.ne.jp nifty.com biglobe.ne.jp so-net.ne.jp docomo.ne.jp ezweb.ne.jp softbank.ne.jp i.softbank.jp
  hinet.net pchome.com.tw netvigator.com singnet.com.sg pacific.net.sg streamyx.com`.split(/\s+/),
);
// Big webmail brands under any country domain: yahoo.fr, hotmail.de, outlook.com.au, live.co.uk, gmx.at…
const FREE_MAIL_BRAND = /^(?:yahoo|ymail|hotmail|outlook|live|msn|windowslive|gmx|aol|yandex|icloud|gmail|googlemail|protonmail|zoho|mail|email|inbox)\.[a-z]{2,3}(?:\.[a-z]{2})?$/;
export const isFreeMailDomain = (d: string) => FREE_MAIL.has(d) || FREE_MAIL_BRAND.test(d);

// The company site to read for a lead: its company domain, else its email's domain unless that is free mail.
export function leadDomain(lead: Pick<EnrichInput, 'domain' | 'email'>): { domain: string; fromEmail: boolean } | null {
  const own = siteDomain(lead.domain);
  if (own) return { domain: own, fromEmail: false };
  const at = (lead.email ?? '').lastIndexOf('@');
  if (at < 0) return null;
  const d = siteDomain(lead.email!.slice(at + 1));
  return d && !isFreeMailDomain(d) ? { domain: d, fromEmail: true } : null;
}

// Whether a lead's typed company name and what a site or Wikidata calls itself (or its domain) are plausibly
// the same company: "Acme Inc." and "ACME" or acme.com, yes; "Acme" and "Comcast", no.
const LEGAL_WORDS = /\b(?:the|inc|incorporated|llc|llp|ltd|limited|plc|corp|corporation|co|company|group|holdings?|gmbh|ag|sa|sas|sarl|srl|spa|bv|nv|oy|ab|as|pty|pvt|kk|technologies|technology|solutions)\b/g;
const squash = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(LEGAL_WORDS, ' ').replace(/[^a-z0-9]+/g, '');
export function sameCompany(typed: string, names: (string | null | undefined)[], domain: string): boolean {
  const a = squash(typed);
  if (a.length < 2) return true;
  const label = domain.split('.')[0];
  for (const n of [...names, label]) {
    const b = n ? squash(n) : '';
    if (b.length < 2) continue;
    if (a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a)))) return true;
  }
  return false;
}

// ---- Guarded fetch -------------------------------------------------------------------------------------

// robots-busy: robots.txt answered 429 or 5xx, so nothing may be read for now (it may pass).
type SiteProblem = 'blocked' | 'unreachable' | 'timeout' | 'robots' | 'robots-busy' | 'redirects';
class SiteError extends Error {
  constructor(
    readonly problem: SiteProblem,
    message: string,
  ) {
    super(message);
  }
}

// The URL itself: plain http(s) on a default port, to a public host name. Returns the host.
function checkUrlShape(url: URL): string {
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) throw new SiteError('blocked', 'only plain http(s) URLs are read');
  if (url.port && url.port !== '80' && url.port !== '443') throw new SiteError('blocked', 'only the default web ports are read');
  const host = publicHostName(url.hostname);
  if (!host) throw new SiteError('blocked', `${url.hostname} is not a public host name`);
  return host;
}

// The addresses to connect to: every one the name resolves to, all public, or an error.
async function checkUrl(ctx: Ctx, url: URL): Promise<PinnedAddress[]> {
  const host = checkUrlShape(url);
  let addresses: PinnedAddress[];
  try {
    addresses = (await ctx.dns.lookup(host)).map((a) => ({ address: a.address, family: isIP(a.address) || a.family }));
  } catch {
    addresses = [];
  }
  addresses = addresses.filter((a) => isIP(a.address));
  if (!addresses.length) throw new SiteError('unreachable', `could not find ${host}`);
  if (addresses.some((a) => isBlockedAddress(a.address))) throw new SiteError('blocked', `${host} is on a private or local network`);
  return addresses;
}

async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - n;
    if (value.length >= room) {
      chunks.push(value.subarray(0, room));
      n += room;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    n += value.length;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return { bytes: out, truncated };
}

export function decodeBody(bytes: Uint8Array, contentType: string): string {
  let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
    charset = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

interface Fetched {
  url: URL;
  status: number;
  contentType: string;
  text: string;
}

interface GetOptions {
  accept: string;
  maxBytes: number;
  robots: boolean;
  // Aborts when the whole site read has run too long.
  deadline: AbortSignal;
}

const pastDeadline = (opts: GetOptions, url: URL) => {
  if (opts.deadline.aborted) throw new SiteError('timeout', `${url.host} took too long`);
};

// One GET with the guard above, following up to MAX_REDIRECTS redirects by hand (each hop checked again, and
// checked against that host's robots.txt when `robots` is on). The connection goes only to the addresses that
// were checked for that hop. Only a 200 body is read, up to `maxBytes`.
async function guardedGet(ctx: Ctx, start: URL, opts: GetOptions): Promise<Fetched> {
  let url = start;
  for (let hop = 0; ; hop++) {
    pastDeadline(opts, url);
    checkUrlShape(url);
    if (opts.robots) {
      const rule = await robotsAllow(ctx, url, opts.deadline);
      if (rule === 'busy') throw new SiteError('robots-busy', `${url.host}'s robots.txt can't be read right now`);
      if (rule === 'deny') throw new SiteError('robots', `${url.host}'s robots.txt asks crawlers not to read ${url.pathname}`);
    }
    await limits.site.take(url.hostname);
    pastDeadline(opts, url);
    // Checked right before connecting, and the connection is pinned to what was checked.
    const pinnedAddresses = await checkUrl(ctx, url);
    let res: Response;
    try {
      const init: PinnedInit = {
        method: 'GET',
        headers: { 'user-agent': USER_AGENT, accept: opts.accept },
        redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(PAGE_TIMEOUT_MS), opts.deadline]),
        pinnedAddresses,
      };
      res = await ctx.fetch(url.href, init);
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new SiteError('timeout', `${url.host} did not answer in time`);
      throw new SiteError('unreachable', `could not reach ${url.host}`);
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new SiteError('redirects', `${start.host} redirected too many times`);
      try {
        url = new URL(location, url);
      } catch {
        throw new SiteError('blocked', `${url.host} redirected to an invalid URL`);
      }
      continue;
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return { url, status: res.status, contentType, text: '' };
    }
    try {
      const { bytes } = await readCapped(res, opts.maxBytes);
      return { url, status: res.status, contentType, text: decodeBody(bytes, contentType) };
    } catch (e) {
      const name = (e as Error)?.name;
      throw new SiteError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable', `${url.host} stopped answering`);
    }
  }
}

// ---- robots.txt (RFC 9309) ------------------------------------------------------------------------------

export interface RobotsRule {
  allow: boolean;
  path: string;
}

// The rules that apply to OpenReachBot: its own group(s), else the "*" group(s). Empty means everything is allowed.
export function parseRobots(text: string, agent = ROBOTS_AGENT): RobotsRule[] {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(value.toLowerCase().split('/')[0].trim());
      lastWasAgent = true;
    } else {
      if ((key === 'allow' || key === 'disallow') && cur) cur.rules.push({ allow: key === 'allow', path: value });
      lastWasAgent = false;
    }
  }
  let mine = groups.filter((g) => g.agents.includes(agent));
  if (!mine.length) mine = groups.filter((g) => g.agents.includes('*'));
  return mine.flatMap((g) => g.rules).filter((r) => r.path !== '');
}

// "*" matches anything and a final "$" anchors the end; everything else is literal. A plain scan that remembers
// only the last "*" (no regex: a rule like "/*a*a*a*…b" would backtrack for minutes), at most rule × path steps.
export function robotsRuleMatches(rule: string, path: string): boolean {
  // An unanchored rule matches any path it is a prefix of: the same as the rule with a final "*".
  const p = rule.endsWith('$') ? rule.slice(0, -1) : `${rule}*`;
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < path.length) {
    if (i < p.length && p[i] === '*') {
      star = i++;
      mark = j;
    } else if (i < p.length && p[i] === path[j]) {
      i++;
      j++;
    } else if (star >= 0) {
      i = star + 1;
      j = ++mark;
    } else return false;
  }
  while (i < p.length && p[i] === '*') i++;
  return i === p.length;
}

// The longest matching rule wins; on a tie, allow wins. No matching rule: allowed.
export function robotsAllows(rules: RobotsRule[], pathAndQuery: string): boolean {
  let best: RobotsRule | null = null;
  for (const r of rules) {
    if (!robotsRuleMatches(r.path, pathAndQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

// 'busy': robots.txt answered 429 or 5xx, so nothing is read until it answers again (a passing problem).
async function robotsAllow(ctx: Ctx, url: URL, deadline: AbortSignal): Promise<'allow' | 'deny' | 'busy'> {
  if (url.pathname === '/robots.txt') return 'allow';
  const now = ctx.clock.now();
  let entry = robotsCache.get(url.origin, now)?.value;
  if (!entry) {
    let ttl = ROBOTS_TTL;
    try {
      const r = await guardedGet(ctx, new URL('/robots.txt', url.origin), { accept: 'text/plain, */*;q=0.5', maxBytes: MAX_ROBOTS_BYTES, robots: false, deadline });
      // 4xx: there are no rules. 429 and 5xx: the server can't say, so nothing is read for now (RFC 9309 §2.3.1).
      if (r.status === 200) entry = parseRobots(r.text);
      else if (r.status === 429 || r.status >= 500) ((entry = 'busy'), (ttl = ROBOTS_ERROR_TTL));
      else entry = 'allow';
    } catch (e) {
      if (!(e instanceof SiteError)) throw e;
      // A private address, or a host that doesn't answer at all: the page itself can't be read either.
      if (e.problem !== 'redirects') throw e;
      // Too many redirects counts as "no robots.txt" (RFC 9309 §2.3.1.2).
      entry = 'allow';
      ttl = ROBOTS_ERROR_TTL;
    }
    robotsCache.set(url.origin, entry, now + ttl);
  }
  if (entry === 'allow' || entry === 'busy') return entry;
  return robotsAllows(entry, url.pathname + url.search) ? 'allow' : 'deny';
}

// ---- HTML: meta tags, JSON-LD and links ------------------------------------------------------------------

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

// Text as a person would read it: entities decoded, tags dropped, whitespace collapsed, capped.
// Every "<…>" replaced by a space, in one pass (a regex like /<[^>]*>/ rescans to the end from each "<").
export function stripTags(s: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const lt = s.indexOf('<', at);
    if (lt < 0) break;
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) break;
    out += `${s.slice(at, lt)} `;
    at = gt + 1;
  }
  return out + s.slice(at);
}

function clean(v: unknown, max = 400): string | undefined {
  if (typeof v !== 'string') return undefined;
  let s = decodeEntities(stripTags(v.length > 20_000 ? v.slice(0, 20_000) : v)).replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  if (s.length > max) s = `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
  return s;
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

// A tag's attributes (the text between its name and ">"), read in one pass. The first of a repeated name wins;
// names without "=" (boolean attributes) are skipped.
export function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const n = tag.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSpace(tag[i]) || tag[i] === '/')) i++;
    const start = i;
    while (i < n && !isSpace(tag[i]) && tag[i] !== '=' && tag[i] !== '/' && tag[i] !== '>') i++;
    if (i === start) {
      i++;
      continue;
    }
    const name = tag.slice(start, i).toLowerCase();
    let k = i;
    while (k < n && isSpace(tag[k])) k++;
    if (tag[k] !== '=') continue;
    k++;
    while (k < n && isSpace(tag[k])) k++;
    let value: string;
    const q = tag[k];
    if (q === '"' || q === "'") {
      const end = tag.indexOf(q, k + 1);
      if (end < 0) break;
      value = tag.slice(k + 1, end);
      i = end + 1;
    } else {
      const begin = k;
      while (k < n && !isSpace(tag[k]) && tag[k] !== '"' && tag[k] !== "'" && tag[k] !== '>') k++;
      i = k;
      if (k === begin) continue;
      value = tag.slice(begin, k);
    }
    if (!(name in out)) out[name] = value;
  }
  return out;
}

// The tags of an HTML page that matter here, in one forward pass: comments are skipped and a script's body
// is taken whole (nothing inside it is read as tags). Every search is an indexOf that only moves forward, so
// a hostile page costs linear time, not the quadratic time /<!--[\s\S]*?-->/ or /<meta\b([^>]*)>/ can take.
interface Tag {
  name: string;
  attrs: string;
  body?: string;
}
const WANTED = new Set(['meta', 'script', 'a']);
const isNameChar = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-';

export function scanTags(doc: string): Tag[] {
  const tags: Tag[] = [];
  const n = doc.length;
  let at = 0;
  while (at < n) {
    const lt = doc.indexOf('<', at);
    if (lt < 0) break;
    if (doc.startsWith('<!--', lt)) {
      // An unclosed comment runs to the end of the page, as in a browser.
      const end = doc.indexOf('-->', lt + 4);
      if (end < 0) break;
      at = end + 3;
      continue;
    }
    let e = lt + 1;
    while (e < n && e - lt <= 8 && isNameChar(doc[e])) e++;
    const name = doc.slice(lt + 1, e).toLowerCase();
    if (!WANTED.has(name)) {
      at = lt + 1;
      continue;
    }
    const gt = doc.indexOf('>', e);
    // No ">" after this point: no later tag can be complete either.
    if (gt < 0) break;
    const tag: Tag = { name, attrs: doc.slice(e, gt) };
    at = gt + 1;
    if (name === 'script') {
      // The body runs to the first "</script" followed by optional spaces and ">".
      let close = -1;
      let from = at;
      for (;;) {
        const c = doc.indexOf('</', from);
        if (c < 0) break;
        from = c + 2;
        if (doc.slice(c + 2, c + 8).toLowerCase() !== 'script') continue;
        let k = c + 8;
        while (k < n && isSpace(doc[k])) k++;
        if (doc[k] === '>') {
          close = c;
          from = k + 1;
          break;
        }
      }
      // An unclosed script runs to the end of the page.
      if (close < 0) break;
      tag.body = doc.slice(at, close);
      at = from;
    }
    tags.push(tag);
  }
  return tags;
}

const ORG_TYPES = new Set([
  'Organization', 'Corporation', 'LocalBusiness', 'NGO', 'OnlineBusiness', 'OnlineStore', 'EducationalOrganization', 'GovernmentOrganization', 'NewsMediaOrganization', 'MedicalOrganization', 'ResearchOrganization', 'SportsOrganization',
  'PerformingGroup', 'Airline', 'Consortium', 'Cooperative', 'WorkersUnion', 'LibrarySystem', 'FundingScheme', 'Project', 'ProfessionalService', 'FinancialService', 'LegalService', 'Store', 'RealEstateAgent', 'TravelAgency',
  'EmploymentAgency', 'Restaurant', 'FoodEstablishment', 'LodgingBusiness', 'Dentist', 'Physician', 'ChildCare', 'EmergencyService', 'RadioStation', 'TelevisionStation', 'AnimalShelter', 'ArchiveOrganization',
]);
const isOrgType = (t: string) => {
  const name = t.replace(/^(?:https?:\/\/schema\.org\/|schema:)/i, '');
  return ORG_TYPES.has(name) || /(?:Organization|Organisation|Business|Corporation)$/.test(name);
};

const hostOf = (v: unknown, base?: URL): string | null => {
  if (typeof v !== 'string') return null;
  try {
    return new URL(v, base).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const textOf = (v: unknown): string | undefined => {
  const x = first(v);
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object' && typeof (x as any)['@value'] === 'string') return (x as any)['@value'];
  if (x && typeof x === 'object' && typeof (x as any).name === 'string') return (x as any).name;
  return undefined;
};

function absoluteUrl(v: unknown, base: URL): string | undefined {
  if (typeof v !== 'string' || !v.trim() || v.length > 1000) return undefined;
  try {
    const u = new URL(decodeEntities(v.trim()), base);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.href : undefined;
  } catch {
    return undefined;
  }
}

// numberOfEmployees: a number, or a QuantitativeValue with a value or a min/max range.
export function employeeCount(v: unknown): number | string | undefined {
  const x = first(v);
  const num = (n: unknown) => {
    const s = typeof n === 'string' ? n.replace(/[,\s]/g, '') : n;
    const k = typeof s === 'number' ? s : typeof s === 'string' && /^\d+$/.test(s) ? Number(s) : NaN;
    return Number.isInteger(k) && k > 0 && k < 10_000_000 ? k : undefined;
  };
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    const exact = num(o.value);
    if (exact) return exact;
    const lo = num(o.minValue);
    const hi = num(o.maxValue);
    if (lo && hi && hi >= lo) return lo === hi ? lo : `${lo}-${hi}`;
    if (lo) return `${lo}+`;
    return undefined;
  }
  return num(x);
}

export function yearOf(v: unknown, thisYear: number): number | undefined {
  const s = typeof v === 'number' ? String(v) : textOf(v);
  const m = s ? /^\+?(\d{4})(?:\D|$)/.exec(s.trim()) : null;
  const y = m ? Number(m[1]) : NaN;
  return y >= 1000 && y <= thisYear ? y : undefined;
}

function addressText(v: unknown): string | undefined {
  const x = first(v);
  if (typeof x === 'string') return clean(x, 200);
  if (!x || typeof x !== 'object') return undefined;
  const o = x as Record<string, unknown>;
  if (o.address) return addressText(o.address);
  const parts = [textOf(o.addressLocality), textOf(o.addressRegion), textOf(o.addressCountry)].map((p) => clean(p, 80)).filter((p): p is string => !!p);
  const unique = parts.filter((p, i) => parts.indexOf(p) === i);
  return unique.length ? unique.join(', ') : undefined;
}

// Social profile links, normalised. Share buttons, intents and other non-profile links are not profiles.
export type Network = 'linkedin' | 'x' | 'facebook' | 'instagram' | 'youtube' | 'github' | 'crunchbase' | 'tiktok';
const X_RESERVED = new Set(['intent', 'share', 'home', 'search', 'hashtag', 'i', 'login', 'signup', 'explore', 'settings', 'privacy', 'tos', 'messages', 'notifications']);
const FB_RESERVED = new Set(['sharer', 'sharer.php', 'share.php', 'share', 'dialog', 'tr', 'plugins', 'login', 'login.php', 'help', 'policies', 'privacy', 'watch', 'events', 'groups', 'profile.php']);
const IG_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'direct']);
const GH_RESERVED = new Set(['sponsors', 'features', 'about', 'login', 'join', 'pricing', 'marketplace', 'topics', 'collections', 'explore', 'settings', 'orgs', 'apps']);

export function socialProfile(raw: unknown): [Network, string] | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(decodeEntities(raw.trim()));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(?:www|m|mobile|[a-z]{2})\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  const p0 = parts[0]?.toLowerCase();
  if (host === 'linkedin.com' && (p0 === 'company' || p0 === 'school' || p0 === 'showcase') && parts[1]) return ['linkedin', `https://www.linkedin.com/${p0}/${parts[1]}`];
  if ((host === 'twitter.com' || host === 'x.com') && parts.length === 1 && /^\w{1,15}$/.test(parts[0]) && !X_RESERVED.has(p0)) return ['x', `https://x.com/${parts[0]}`];
  if ((host === 'facebook.com' || host === 'fb.com') && parts.length >= 1 && parts.length <= 2 && !FB_RESERVED.has(p0)) return ['facebook', `https://www.facebook.com/${parts.join('/')}`];
  if (host === 'instagram.com' && parts.length === 1 && !IG_RESERVED.has(p0)) return ['instagram', `https://www.instagram.com/${parts[0]}`];
  if (host === 'youtube.com' && parts.length >= 1 && (parts[0].startsWith('@') || (['channel', 'c', 'user'].includes(p0) && parts[1]))) return ['youtube', `https://www.youtube.com/${parts.slice(0, parts[0].startsWith('@') ? 1 : 2).join('/')}`];
  if (host === 'github.com' && parts.length === 1 && !GH_RESERVED.has(p0)) return ['github', `https://github.com/${parts[0]}`];
  if (host === 'crunchbase.com' && p0 === 'organization' && parts[1]) return ['crunchbase', `https://www.crunchbase.com/organization/${parts[1]}`];
  if (host === 'tiktok.com' && parts.length === 1 && parts[0].startsWith('@')) return ['tiktok', `https://www.tiktok.com/${parts[0]}`];
  return null;
}

export interface SiteFacts {
  website?: string;
  name?: string;
  description?: string;
  logo?: string;
  foundedYear?: number;
  size?: number | string;
  headquarters?: string;
  socials: Partial<Record<Network, string>>;
}

export interface PageFacts extends SiteFacts {
  // Whether the page had an Organization block with founding date, size or address (if not, the About page may).
  rich: boolean;
  aboutUrl?: string;
}

const trimSlashes = (p: string) => {
  let end = p.length;
  while (end > 0 && p[end - 1] === '/') end--;
  return p.slice(0, end);
};
const ABOUT_PATHS = new Set(['/about', '/about-us', '/aboutus', '/company', '/who-we-are', '/our-story', '/en/about', '/en/about-us', '/about/company']);

// What a page says about the company that owns `domain`.
export function extractFacts(html: string, pageUrl: URL, domain: string, thisYear: number): PageFacts {
  const tags = scanTags(html);

  const meta: Record<string, string> = {};
  for (const t of tags) {
    if (t.name !== 'meta') continue;
    const a = attrs(t.attrs);
    const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase().trim();
    if (key && a.content != null && !(key in meta)) meta[key] = a.content;
  }

  const blocks: unknown[] = [];
  for (const t of tags) {
    if (t.name !== 'script' || blocks.length >= 30 || !(attrs(t.attrs).type ?? '').trim().toLowerCase().startsWith('application/ld+json')) continue;
    let body = (t.body ?? '').trim();
    // A CDATA wrapper (sometimes inside /* */), looked for only at the very start and end.
    const open = /^(?:\/\*\s*)?<!\[CDATA\[(?:\s*\*\/)?/.exec(body.slice(0, 64));
    if (open) body = body.slice(open[0].length);
    const close = /(?:\/\*\s*)?\]\]>(?:\s*\*\/)?$/.exec(body.slice(-64));
    if (close) body = body.slice(0, body.length - close[0].length);
    body = body.trim();
    try {
      blocks.push(JSON.parse(body));
    } catch {
      // Not valid JSON: skipped.
    }
  }

  // Organizations at the top of a block (or of its @graph), and nested ones whose url is this site.
  const orgs: { node: Record<string, unknown>; score: number }[] = [];
  let budget = 5000;
  const visit = (n: unknown, depth: number, top: boolean) => {
    if (budget-- <= 0 || depth > 8 || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) visit(x, depth + 1, top);
      return;
    }
    const o = n as Record<string, unknown>;
    const types = ([] as unknown[]).concat(o['@type'] ?? []).filter((t): t is string => typeof t === 'string');
    const own = hostOf(o.url, pageUrl) === domain || hostOf(o['@id'], pageUrl) === domain;
    if (types.some(isOrgType) && (top || own)) {
      const filled = ['name', 'description', 'logo', 'foundingDate', 'numberOfEmployees', 'address', 'sameAs'].filter((k) => o[k] != null).length;
      orgs.push({ node: o, score: (own ? 20 : 0) + (top ? 10 : 0) + filled });
    }
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') visit(v, depth + 1, k === '@graph' && top);
  };
  for (const b of blocks) visit(b, 0, true);
  const org = orgs.sort((a, b) => b.score - a.score)[0]?.node ?? {};

  const socials: Partial<Record<Network, string>> = {};
  for (const s of ([] as unknown[]).concat(org.sameAs ?? [])) {
    const p = socialProfile(s);
    if (p && !socials[p[0]]) socials[p[0]] = p[1];
  }
  // Profile links on the page (usually the footer) fill in networks the JSON-LD didn't list, when the page
  // links to exactly one profile on that network.
  const linked: Partial<Record<Network, Set<string>>> = {};
  let aboutUrl: string | undefined;
  for (const t of tags) {
    if (t.name !== 'a') continue;
    const href = attrs(t.attrs).href;
    if (!href) continue;
    const p = socialProfile(href);
    if (p) (linked[p[0]] ??= new Set()).add(p[1]);
    else if (!aboutUrl) {
      const abs = absoluteUrl(href, pageUrl);
      if (abs) {
        const u = new URL(abs);
        if (u.origin === pageUrl.origin && ABOUT_PATHS.has(trimSlashes(u.pathname.toLowerCase()))) aboutUrl = `${u.origin}${u.pathname}`;
      }
    }
  }
  for (const [net, set] of Object.entries(linked) as [Network, Set<string>][]) {
    const distinct = new Set([...set].map((s) => s.toLowerCase()));
    if (!socials[net] && distinct.size === 1) socials[net] = [...set][0];
  }
  const handle = /^@?(\w{1,15})$/.exec((meta['twitter:site'] ?? '').trim())?.[1];
  if (!socials.x && handle && !X_RESERVED.has(handle.toLowerCase())) socials.x = `https://x.com/${handle}`;

  const logoRaw = first(org.logo);
  const logo = absoluteUrl(typeof logoRaw === 'object' && logoRaw ? ((logoRaw as any).url ?? (logoRaw as any).contentUrl) : logoRaw, pageUrl);
  const foundedYear = yearOf(org.foundingDate, thisYear);
  const size = employeeCount(org.numberOfEmployees);
  const headquarters = addressText(org.address ?? org.location);
  const name = clean(textOf(org.name), 120) ?? clean(textOf(org.legalName), 120) ?? clean(meta['og:site_name'], 120) ?? clean(meta['application-name'], 120);

  return {
    name: name && !/^https?:\/\//i.test(name) ? name : undefined,
    description: clean(textOf(org.description)) ?? clean(meta['og:description']) ?? clean(meta.description) ?? clean(meta['twitter:description']),
    logo,
    foundedYear,
    size,
    headquarters,
    socials,
    rich: foundedYear != null || size != null || headquarters != null,
    aboutUrl,
  };
}

function mergeFacts(a: SiteFacts, b: SiteFacts): SiteFacts {
  const out: SiteFacts = { ...a, socials: { ...b.socials, ...a.socials } };
  for (const k of ['name', 'description', 'logo', 'foundedYear', 'size', 'headquarters'] as const) if (out[k] == null && b[k] != null) (out as any)[k] = b[k];
  return out;
}

const HTML_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1';
const isHtml = (contentType: string) => !contentType || /html|xml/i.test(contentType);

// Whether a page's host belongs to the lead's site: the domain itself or a subdomain of it (www., en.), or
// the parent of a subdomain lead (shop.acme.com → acme.com). A redirect anywhere else (a parking page, a
// registrar's "for sale" page, an acquirer) describes another company.
export function sameSite(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  const d = domain.toLowerCase().replace(/^www\./, '');
  return h === d || h.endsWith(`.${d}`) || (d.endsWith(`.${h}`) && h.includes('.'));
}

// Reads the homepage (https, then www., then plain http when a name doesn't answer) and, if it says little,
// the About page, all within limits.siteDeadlineMs. null: nothing could be read (blocked, unreachable,
// robots.txt, not HTML, or a redirect to another site).
async function readSite(ctx: Ctx, domain: string): Promise<{ facts: SiteFacts | null; transient: boolean }> {
  const thisYear = new Date(ctx.clock.now()).getUTCFullYear();
  const deadline = AbortSignal.timeout(limits.siteDeadlineMs);
  const get = (url: URL) => guardedGet(ctx, url, { accept: HTML_ACCEPT, maxBytes: MAX_HTML_BYTES, robots: true, deadline });
  const starts = [`https://${domain}/`, `https://www.${domain}/`, `http://${domain}/`];
  let home: Fetched | null = null;
  let transient = false;
  for (const s of starts) {
    try {
      home = await get(new URL(s));
      break;
    } catch (e) {
      if (!(e instanceof SiteError)) throw e;
      // robots.txt answered 429 or 5xx: nothing is read now, and nothing is remembered.
      if (e.problem === 'robots-busy') return { facts: null, transient: true };
      // Only a name that doesn't answer is worth another try; a private address, robots.txt or a redirect loop isn't.
      if (e.problem !== 'unreachable' && e.problem !== 'timeout') return { facts: null, transient: false };
      transient = true;
    }
  }
  // A server error or 429 may pass, so it isn't remembered; a 404 or a page that isn't HTML is.
  if (!home) return { facts: null, transient };
  if (home.status !== 200 || !isHtml(home.contentType)) return { facts: null, transient: home.status === 429 || home.status >= 500 };
  if (!sameSite(home.url.hostname, domain)) return { facts: null, transient: false };
  const website = home.url.origin;
  const page = extractFacts(home.text, home.url, domain, thisYear);
  let facts: SiteFacts = { ...page, website };
  delete (facts as Partial<PageFacts>).rich;
  delete (facts as Partial<PageFacts>).aboutUrl;
  if (!page.rich) {
    try {
      const about = await get(new URL(page.aboutUrl ?? `${home.url.origin}/about`));
      if (about.status === 200 && isHtml(about.contentType) && hostOf(about.url.href) === hostOf(home.url.href)) {
        const more = extractFacts(about.text, about.url, domain, thisYear);
        // The About page's own description describes the page, so only its Organization facts are used.
        facts = mergeFacts(facts, { socials: more.socials, logo: more.logo, foundedYear: more.foundedYear, size: more.size, headquarters: more.headquarters });
      }
    } catch (e) {
      if (!(e instanceof SiteError)) throw e;
    }
  }
  return { facts, transient: false };
}

// ---- Wikidata ------------------------------------------------------------------------------------------

export interface WikidataFacts {
  qid: string;
  website: string;
  name?: string;
  industry?: string;
  employees?: number;
  employeesYear?: number;
  foundedYear?: number;
  headquarters?: string;
  linkedin?: string;
}

// The official-website values a company's item may hold: http(s), with or without www., with or without "/".
export const siteIris = (domain: string) => ['https', 'http'].flatMap((s) => [domain, `www.${domain}`].flatMap((h) => [`<${s}://${h}/>`, `<${s}://${h}>`]));

export function wikidataQuery(domain: string): string {
  const branch = (prop: string, pid: string, extra = '') => `{ ?item p:${pid} ?st . ?st ps:${pid} ?value . ${extra}BIND("${prop}" AS ?prop) }`;
  return `SELECT ?item ?itemLabel ?site ?prop ?value ?valueLabel ?rank ?date WHERE {
  VALUES ?site { ${siteIris(domain).join(' ')} }
  ?item wdt:P856 ?site .
  OPTIONAL {
    ${branch('industry', 'P452')}
    UNION ${branch('employees', 'P1128', 'OPTIONAL { ?st pq:P585 ?date . } ')}
    UNION ${branch('inception', 'P571')}
    UNION ${branch('hq', 'P159')}
    UNION ${branch('country', 'P17')}
    UNION ${branch('linkedin', 'P4264')}
    ?st wikibase:rank ?rank .
    FILTER(?rank != wikibase:DeprecatedRank)
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}
LIMIT 500`;
}

type Binding = Record<string, { type: string; value: string } | undefined>;
interface Statement {
  value: string;
  label?: string;
  rank: number;
  date?: string;
  entity: boolean;
}

const qidOf = (iri: string | undefined) => /\/entity\/(Q\d+)$/.exec(iri ?? '')?.[1];
const isQidLabel = (s: string | undefined) => !s || /^Q\d+$/.test(s);

// The best-ranked statements: preferred ones if there are any, else the normal ones.
const bestRanked = (list: Statement[]) => {
  const top = Math.max(0, ...list.map((s) => s.rank));
  return list.filter((s) => s.rank === top);
};
const labelsOf = (list: Statement[]) => [...new Set(bestRanked(list).filter((s) => s.entity && !isQidLabel(s.label)).map((s) => s.label!))];

// Picks one company out of a SPARQL answer. Several items can share a website (a company and its product):
// the one with the most facts wins, then the oldest (lowest Q number).
export function wikidataFacts(bindings: Binding[], thisYear: number): WikidataFacts | null {
  const items = new Map<string, { website: string; name?: string; props: Record<string, Statement[]> }>();
  for (const b of bindings) {
    const qid = qidOf(b.item?.value);
    if (!qid) continue;
    const it = items.get(qid) ?? { website: b.site?.value ?? '', name: isQidLabel(b.itemLabel?.value) ? undefined : b.itemLabel?.value, props: {} };
    items.set(qid, it);
    const prop = b.prop?.value;
    const value = b.value?.value;
    if (!prop || value == null) continue;
    const rank = /PreferredRank$/.test(b.rank?.value ?? '') ? 2 : /NormalRank$/.test(b.rank?.value ?? '') ? 1 : 0;
    if (!rank) continue;
    const list = (it.props[prop] ??= []);
    if (!list.some((s) => s.value === value && s.date === b.date?.value)) list.push({ value, label: b.valueLabel?.value, rank, date: b.date?.value, entity: b.value?.type === 'uri' });
  }
  if (!items.size) return null;
  const [qid, it] = [...items.entries()].sort(([qa, a], [qb, b]) => Object.keys(b.props).length - Object.keys(a.props).length || Number(qa.slice(1)) - Number(qb.slice(1)))[0];
  const p = it.props;
  const out: WikidataFacts = { qid, website: it.website.replace(/\/$/, '') };
  if (it.name) out.name = it.name;
  const industries = labelsOf(p.industry ?? []).slice(0, 3);
  if (industries.length) out.industry = industries.join(', ');
  // Employees: preferred rank first, then the most recent "point in time"; undated counts come last.
  const counts = (p.employees ?? [])
    .map((s) => ({ ...s, n: Number(s.value.replace(/^\+/, '')) }))
    .filter((s) => Number.isFinite(s.n) && s.n > 0)
    .sort((a, b) => b.rank - a.rank || (b.date ?? '').localeCompare(a.date ?? ''));
  if (counts.length) {
    out.employees = Math.round(counts[0].n);
    const y = yearOf(counts[0].date, thisYear);
    if (y) out.employeesYear = y;
  }
  const years = bestRanked(p.inception ?? [])
    .map((s) => yearOf(s.value, thisYear))
    .filter((y): y is number => y != null);
  if (years.length) out.foundedYear = Math.min(...years);
  const hq = labelsOf(p.hq ?? [])[0];
  const country = labelsOf(p.country ?? [])[0];
  const where = [hq, country].filter((x): x is string => !!x);
  if (where.length) out.headquarters = [...new Set(where)].join(', ');
  const li = bestRanked(p.linkedin ?? []).find((s) => /^[A-Za-z0-9%._-]{1,150}$/.test(s.value));
  if (li) out.linkedin = `https://www.linkedin.com/company/${li.value}`;
  return out;
}

const wikidataAgent = (contact?: string) => (contact ? `${USER_AGENT.replace(')', `; ${contact})`)} company-enrichment` : `${USER_AGENT} company-enrichment`);

async function sparql(ctx: Ctx, cfg: ProviderConfig, query: string): Promise<any> {
  const fail = (code: ProviderError['code'], message: string, status?: number) => new ProviderError(code, message, { integrationId: cfg.integrationId, status });
  let r: any;
  try {
    r = await httpJson<any>(ctx, `${WDQS}?${new URLSearchParams({ query, format: 'json' })}`, {
      headers: { accept: 'application/sparql-results+json', 'user-agent': wikidataAgent(cfg.settings.contact) },
      limiter: limits.wikidata,
      limitKey: 'wikidata',
      timeoutMs: WIKIDATA_TIMEOUT_MS,
      integrationId: cfg.integrationId,
    });
  } catch (e) {
    // Wikidata answers 403 to clients it has blocked (usually for a missing or generic User-Agent): not a key problem.
    if (e instanceof ProviderError && e.code === 'AUTH') throw fail('BAD_REQUEST', `Wikidata refused the request (${e.status}). It blocks clients without a descriptive User-Agent: add a contact under the integration's settings, or turn the Wikidata lookup off.`, e.status);
    throw e;
  }
  if (!r || typeof r !== 'object') throw fail('UNAVAILABLE', 'Wikidata returned an unexpected answer');
  return r;
}

async function lookupWikidata(ctx: Ctx, cfg: ProviderConfig, domain: string): Promise<WikidataFacts | null> {
  const now = ctx.clock.now();
  const hit = wikidataCache.get(domain, now);
  if (hit) return hit.value;
  // Hosted: one billing root can't take the whole shared Wikidata rate from the others.
  if (billingEnabled(ctx)) await limits.wikidataPerRoot.take(billingRoot(ctx, cfg.workspaceId));
  const r = await sparql(ctx, cfg, wikidataQuery(domain));
  const bindings = r?.results?.bindings;
  if (!Array.isArray(bindings)) throw new ProviderError('UNAVAILABLE', 'Wikidata returned an unexpected answer', { integrationId: cfg.integrationId });
  const facts = wikidataFacts(bindings, new Date(now).getUTCFullYear());
  wikidataCache.set(domain, facts, now + (facts ? WIKIDATA_HIT_TTL : WIKIDATA_MISS_TTL));
  return facts;
}

// ---- The result ----------------------------------------------------------------------------------------

export function websiteEnrichment(domain: string, site: SiteFacts | null, wd: WikidataFacts | null): EnrichResult | null {
  const fields: Partial<LeadFields> = {};
  const enrichment: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v != null && v !== '' && !(k in enrichment)) enrichment[k] = v;
  };
  const name = site?.name ?? wd?.name;
  if (name) fields.company = name;
  // The company's own site first; Wikidata fills the gaps. Industry only comes from Wikidata.
  put('website', site?.website ?? wd?.website);
  put('companyDescription', site?.description);
  put('industry', wd?.industry);
  if (site?.size != null) put('companySize', site.size);
  else if (wd?.employees != null) {
    put('companySize', wd.employees);
    put('companySizeYear', wd.employeesYear);
  }
  put('foundedYear', site?.foundedYear ?? wd?.foundedYear);
  put('headquarters', site?.headquarters ?? wd?.headquarters);
  put('companyLinkedin', site?.socials.linkedin ?? wd?.linkedin);
  const socials = Object.fromEntries(Object.entries(site?.socials ?? {}).filter(([k]) => k !== 'linkedin'));
  if (Object.keys(socials).length) put('companySocials', socials);
  put('companyLogo', site?.logo);
  if (wd) put('wikidata', `https://www.wikidata.org/wiki/${wd.qid}`);
  // A homepage that answered but said nothing about the company is not a result.
  const facts = Object.keys(enrichment).filter((k) => k !== 'website').length + Object.keys(fields).length;
  if (!facts) return null;
  return { fields, companyDomain: domain, enrichment, credits: 0 };
}

// Hosted: each billing root gets limits.dailyLookups lookups in any 24 hours (every call is in the usage log,
// at 0 credits), so one tenant can't turn the server into a crawler. Over it, the job waits and retries.
function withinDailyLookups(ctx: Ctx, cfg: ProviderConfig) {
  if (!billingEnabled(ctx)) return;
  const root = billingRoot(ctx, cfg.workspaceId);
  const since = ctx.clock.now() - DAY;
  const used =
    ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM usage_events WHERE kind = 'enrichment' AND provider = 'website' AND created_at > ? AND workspace_id IN (SELECT id FROM workspaces WHERE id = ? OR parent_id = ?)",
      [since, root, root],
    )?.n ?? 0;
  if (used >= limits.dailyLookups) {
    throw new ProviderError('RATE_LIMIT', `The company website lookup is limited to ${limits.dailyLookups} leads a day on this server; the rest continue later.`, {
      integrationId: cfg.integrationId,
      retryAfterMs: HOUR,
    });
  }
}

const contactSchema = z
  .string()
  .trim()
  .max(200)
  .refine((v) => /^[^\s@()<>;]+@[^\s@()<>;]+\.[^\s@()<>;]+$/.test(v) || /^https?:\/\/[^\s()<>;]+$/.test(v), 'Use an email address or an http(s) URL');

export const websiteEnricher: ProviderDef<'enrichment'> = {
  id: 'website',
  kind: 'enrichment',
  label: 'Company website (free)',
  description:
    'Free, no key: reads the company’s own homepage (meta tags and schema.org data) for its name, description, logo, socials and, when published, founding year, size and address, then Wikidata for industry, size, founding year and headquarters. Wikidata only knows notable companies, so most small firms get website facts only.',
  docsUrl: 'https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service',
  fields: [
    { key: 'noWikidata', label: 'Don’t look companies up on Wikidata', type: 'toggle', help: 'Only read the company websites. Wikidata adds industry, size and headquarters for well-known companies.' },
    {
      key: 'contact',
      label: 'Contact for Wikidata',
      type: 'text',
      placeholder: 'you@yourcompany.com',
      help: 'Optional. Wikimedia asks automated clients to say how to reach their operator; it is sent to Wikidata only, never to company websites.',
    },
  ],
  credentials: z.object({}),
  settings: z.object({ noWikidata: z.boolean().optional(), contact: contactSchema.optional() }),
  create(ctx, cfg): Enricher {
    const useWikidata = !cfg.settings.noWikidata;
    return {
      providerId: 'website',
      simulated: false,
      free: true,
      async test() {
        if (!useWikidata) return { ok: true, message: 'Ready: reads public company websites. Nothing to sign in to.' };
        const r = await sparql(ctx, cfg, 'ASK { BIND(1 AS ?x) }');
        if (r.boolean !== true) throw new ProviderError('UNAVAILABLE', 'Wikidata returned an unexpected answer', { integrationId: cfg.integrationId });
        return { ok: true, message: 'Ready: reads public company websites, and Wikidata answered.' };
      },
      async enrich(lead) {
        const target = leadDomain(lead);
        if (!target) return null;
        const { domain, fromEmail } = target;
        const now = ctx.clock.now();
        withinDailyLookups(ctx, cfg);
        let site = siteCache.get(domain, now)?.value;
        if (site === undefined) {
          const r = await readSite(ctx, domain);
          site = r.facts;
          if (!r.transient) siteCache.set(domain, site, now + SITE_TTL);
        }
        let wd: WikidataFacts | null = null;
        let wdError: unknown = null;
        if (useWikidata) {
          try {
            wd = await lookupWikidata(ctx, cfg, domain);
          } catch (e) {
            wdError = e;
          }
        }
        // An email domain is only a guess at the employer (it may be an ISP or webmail this list doesn't know):
        // when the lead has a company name that isn't this site's, the site says nothing about the lead.
        if (fromEmail && lead.company?.trim() && !sameCompany(lead.company, [site?.name, wd?.name], domain)) return null;
        if (wdError) {
          // What the website said still counts; with nothing from it, the lookup fails and is retried later.
          const partial = websiteEnrichment(domain, site, null);
          if (!partial) throw wdError;
          return partial;
        }
        return websiteEnrichment(domain, site, wd);
      },
    };
  },
};
