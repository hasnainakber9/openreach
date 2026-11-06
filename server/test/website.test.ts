import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePlans } from '../src/billing/plans.js';
import { RateLimiter, ProviderError } from '../src/providers/http.js';
import {
  attrs,
  decodeEntities,
  employeeCount,
  extractFacts,
  forgetWebsiteCaches,
  isFreeMailDomain,
  leadDomain,
  limits,
  MAX_HTML_BYTES,
  MAX_REDIRECTS,
  parseRobots,
  robotsAllows,
  robotsRuleMatches,
  sameCompany,
  sameSite,
  siteDomain,
  stripTags,
  siteIris,
  socialProfile,
  USER_AGENT,
  wikidataFacts,
  wikidataQuery,
} from '../src/providers/data/website.js';
import type { Enricher, EnrichInput } from '../src/providers/data/types.js';
import { createIntegration } from '../src/providers/store.js';
import { startEnrichmentRun } from '../src/services/enrichment.js';
import { pinnedFetch } from '../src/services/pinned-fetch.js';
import { monthlyUsage, recordUsage } from '../src/services/usage.js';
import type { LeadRow } from '../src/types.js';
import { addLeads, drainJobs, fakeFetch, makeApi, makeWorld, type FakeRoute, type World } from './helpers.js';

// The free "Company website" enricher: homepage meta tags and JSON-LD, robots.txt, the SSRF guard and the
// Wikidata lookup. Every HTTP call and DNS answer is a fake; nothing touches the network.

const PUBLIC_IP = '93.184.216.34';
const HTML = { 'content-type': 'text/html; charset=utf-8' };

const ACME_HOME = `<!doctype html><html><head>
<title>Home | Acme &amp; Co — widgets</title>
<meta name="description" content="Meta description that loses to JSON-LD.">
<meta property="og:site_name" content="Acme &amp; Co">
<meta name="twitter:site" content="@acmeco">
<!-- <meta property="og:site_name" content="Commented out"> -->
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"WebSite","@id":"https://acme.com/#website","name":"Acme site","publisher":{"@id":"https://acme.com/#org"}},
  {"@type":"Organization","@id":"https://acme.com/#org","name":"Acme &amp; Co","url":"https://acme.com/",
   "description":"Acme makes <b>industrial</b> widgets\\nfor factories.",
   "logo":{"@type":"ImageObject","url":"/img/logo.png"},
   "foundingDate":"2011-04-01","numberOfEmployees":{"@type":"QuantitativeValue","minValue":51,"maxValue":200},
   "address":{"@type":"PostalAddress","addressLocality":"Lahore","addressRegion":"Punjab","addressCountry":{"@type":"Country","name":"Pakistan"}},
   "sameAs":["https://www.linkedin.com/company/acme-co/","https://twitter.com/acmeco","https://www.wikidata.org/wiki/Q1"]}
]}
</script>
<script type="application/ld+json">{ not json </script>
<script type="application/ld+json">{"@type":"Review","author":{"@type":"Organization","name":"Some Client Ltd"}}</script>
</head><body>
<a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>
<a href="https://www.facebook.com/acmeco">Facebook</a>
<a href="https://github.com/acme-co">GitHub</a>
<a href="https://instagram.com/one">a</a><a href="https://instagram.com/two">b</a>
<a href="/about-us/">About us</a>
</body></html>`;

const THIN_HOME = `<html><head><meta property="og:description" content="We build boats."><meta property="og:site_name" content="Boaty"></head>
<body><a href="/company">Company</a><a href="https://www.linkedin.com/company/boaty">in</a></body></html>`;
const BOATY_ABOUT = `<html><head><meta name="description" content="About Boaty: the about page's own description is not used.">
<script type="application/ld+json">{"@type":"Corporation","name":"Boaty Ltd","url":"https://boaty.io","foundingDate":"1999","numberOfEmployees":"1,200","address":"Karachi, Pakistan"}</script></head></html>`;

const wdRow = (o: Record<string, string>, item = 'Q7624104', label = 'Stripe') => ({
  item: { type: 'uri', value: `http://www.wikidata.org/entity/${item}` },
  itemLabel: { type: 'literal', value: label },
  site: { type: 'uri', value: 'https://stripe.com/' },
  ...Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, { type: k === 'value' && v.startsWith('http://www.wikidata.org/entity/') ? 'uri' : 'literal', value: v }]),
  ),
});
const PREF = 'http://wikiba.se/ontology#PreferredRank';
const NORMAL = 'http://wikiba.se/ontology#NormalRank';
const ent = (q: string) => `http://www.wikidata.org/entity/${q}`;

const STRIPE_ROWS = [
  wdRow({ prop: 'industry', value: ent('Q837171'), valueLabel: 'financial services', rank: NORMAL }),
  wdRow({ prop: 'industry', value: ent('Q99999'), valueLabel: 'Q99999', rank: NORMAL }),
  wdRow({ prop: 'employees', value: '2500', valueLabel: '2500', rank: NORMAL, date: '2019-01-01T00:00:00Z' }),
  wdRow({ prop: 'employees', value: '8000', valueLabel: '8000', rank: NORMAL, date: '2023-01-01T00:00:00Z' }),
  wdRow({ prop: 'employees', value: '+7000', valueLabel: '7000', rank: NORMAL }),
  wdRow({ prop: 'inception', value: '2010-01-01T00:00:00Z', valueLabel: '2010-01-01T00:00:00Z', rank: NORMAL }),
  wdRow({ prop: 'hq', value: ent('Q62'), valueLabel: 'San Francisco', rank: NORMAL }),
  wdRow({ prop: 'country', value: ent('Q30'), valueLabel: 'United States', rank: NORMAL }),
  wdRow({ prop: 'linkedin', value: 'stripe', valueLabel: 'stripe', rank: NORMAL }),
];

const sparql = (rows: unknown[]) => ({ json: { head: { vars: [] }, results: { bindings: rows } } });

// DNS: public names answer PUBLIC_IP; `answers` overrides per host.
function dns(w: World, answers: Record<string, string[]> = {}) {
  w.ctx.dns = {
    ...w.ctx.dns,
    lookup: async (h) => {
      const list = answers[h] ?? [PUBLIC_IP];
      if (!list.length) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
  };
}

const page = (html: string, headers: Record<string, string> = HTML) => () => ({ text: html, headers });
const robots = (text: string) => () => ({ text, headers: { 'content-type': 'text/plain' } });
const WIKIDATA = /^https:\/\/query\.wikidata\.org\/sparql\?/;

function website(w: World, settings: Record<string, unknown> = {}) {
  const row = createIntegration(w.ctx, w.workspaceId, { kind: 'enrichment', provider: 'website', settings });
  return () => w.ctx.providers.instance<'enrichment'>(row)! as Enricher;
}

const input = (o: Partial<EnrichInput> = {}): EnrichInput => ({ firstName: 'Ann', lastName: 'Lee', company: '', title: '', email: null, profileUrl: 'https://www.linkedin.com/in/ann/', domain: 'acme.com', ...o });

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error('expected a failure');
};

const originalLimits = { ...limits };
beforeEach(() => {
  forgetWebsiteCaches();
  limits.site = new RateLimiter(10_000, 10_000);
  limits.wikidata = new RateLimiter(10_000, 10_000);
});
afterEach(() => Object.assign(limits, originalLimits));

describe('Company website: domains', () => {
  it('turns company domains and website URLs into a bare public host', () => {
    expect(siteDomain('Acme.com')).toBe('acme.com');
    expect(siteDomain(' https://www.acme.co.uk/about?x=1 ')).toBe('acme.co.uk');
    expect(siteDomain('http://acme.com:8080/')).toBe('acme.com');
    expect(siteDomain('acme.com.')).toBe('acme.com');
    expect(siteDomain('xn--bcher-kva.example.de')).toBe('xn--bcher-kva.example.de');
    for (const bad of ['', null, undefined, 'localhost', 'acme', '127.0.0.1', '[::1]', '10.0.0.5', 'https://user:pw@acme.com', 'ftp://acme.com', 'intranet.local', 'acme.internal', 'shop.example', 'a.test', 'bad_host.com', 'javascript:alert(1)', 'acme.c0m'])
      expect(siteDomain(bad as string), String(bad)).toBeNull();
  });

  it('uses the email domain when the lead has no company domain, but never free mail', () => {
    expect(leadDomain({ domain: 'acme.com', email: 'a@other.com' })).toEqual({ domain: 'acme.com', fromEmail: false });
    expect(leadDomain({ domain: undefined, email: 'ann@Boaty.io' })).toEqual({ domain: 'boaty.io', fromEmail: true });
    expect(leadDomain({ domain: undefined, email: 'ann@gmail.com' })).toBeNull();
    expect(leadDomain({ domain: undefined, email: 'ann@acme.example' })).toBeNull();
    expect(leadDomain({ domain: undefined, email: null })).toBeNull();
  });

  it('knows ISP and regional webmail domains, so a home address never names a company', () => {
    for (const d of ['comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net', 'btinternet.com', 'shaw.ca', 'bigpond.com', 'hotmail.fr', 'outlook.de', 'live.co.uk', 'yahoo.fr', 'yahoo.de', 'gmx.at', 'outlook.com.au', 'yahoo.co.jp'])
      expect(isFreeMailDomain(d), d).toBe(true);
    for (const d of ['acme.com', 'boaty.io', 'mailchimp.com', 'yahoo-finance-partners.com']) expect(isFreeMailDomain(d), d).toBe(false);
    expect(leadDomain({ domain: undefined, email: 'ann@comcast.net' })).toBeNull();
  });

  it('tells whether a typed company name and a site plausibly name the same company', () => {
    expect(sameCompany('Acme Inc.', ['ACME'], 'acme.com')).toBe(true);
    expect(sameCompany('Acme Widgets GmbH', [null], 'acmewidgets.de')).toBe(true);
    expect(sameCompany('Société Générale', ['Societe Generale Group'], 'societegenerale.com')).toBe(true);
    expect(sameCompany('Acme', ['Comcast'], 'comcast.net')).toBe(false);
    expect(sameCompany('Globex', [undefined], 'acme.com')).toBe(false);
  });

  it('treats the domain, its subdomains and a subdomain lead’s parent as the same site, and nothing else', () => {
    for (const [host, domain] of [['acme.com', 'acme.com'], ['www.acme.com', 'acme.com'], ['en.acme.com', 'acme.com'], ['acme.com', 'shop.acme.com'], ['ACME.com.', 'acme.com']]) expect(sameSite(host, domain), host).toBe(true);
    for (const [host, domain] of [['hugedomains.com', 'acme.com'], ['acme.com.evil.io', 'acme.com'], ['notacme.com', 'acme.com'], ['com', 'acme.com']]) expect(sameSite(host, domain), host).toBe(false);
  });
});

describe('Company website: robots.txt', () => {
  it('matches rules with wildcards in linear time, even rules built to make a regex backtrack', () => {
    for (const [rule, path, hit] of [
      ['/', '/anything', true],
      ['/private', '/private/x', true],
      ['/private', '/priv', false],
      ['/*.pdf$', '/files/a.pdf', true],
      ['/*.pdf$', '/files/a.pdf?x=1', false],
      ['/*.pdf', '/files/a.pdf?x=1', true],
      ['/$', '/', true],
      ['/$', '/a', false],
      ['*', '/a', true],
      ['/a*b*c', '/axxbyyc/z', true],
      ['/a*b*c$', '/axxbyycz', false],
    ] as [string, string, boolean][])
      expect(robotsRuleMatches(rule, path), `${rule} ${path}`).toBe(hit);
    const t = Date.now();
    expect(robotsRuleMatches(`/${'*-'.repeat(200)}z`, `/${'-'.repeat(2000)}`)).toBe(false);
    expect(Date.now() - t).toBeLessThan(500);
  });

  const TXT = `# comment
User-agent: *
Disallow: /private
Allow: /private/press
Disallow: /*.pdf$

User-agent: BadBot
Disallow: /

User-agent: OpenReachBot/1.0
User-agent: OtherBot
Disallow: /about
Allow: /about/team$
`;

  it('applies the OpenReachBot group, else the * group, longest match first', () => {
    const own = parseRobots(TXT);
    expect(robotsAllows(own, '/')).toBe(true);
    expect(robotsAllows(own, '/about')).toBe(false);
    expect(robotsAllows(own, '/about/team')).toBe(true);
    expect(robotsAllows(own, '/about/team/x')).toBe(false);
    // Our own group replaces the * group.
    expect(robotsAllows(own, '/private')).toBe(true);

    const star = parseRobots(TXT, 'someone');
    expect(robotsAllows(star, '/private/x')).toBe(false);
    expect(robotsAllows(star, '/private/press/1')).toBe(true);
    expect(robotsAllows(star, '/files/a.pdf')).toBe(false);
    expect(robotsAllows(star, '/files/a.pdf?x')).toBe(true);
    // Allow wins a tie; an empty Disallow allows everything; no rules at all allows everything.
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /a\nAllow: /a'), '/a')).toBe(true);
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow:'), '/')).toBe(true);
    expect(robotsAllows(parseRobots(''), '/')).toBe(true);
    // Regex characters in a path are literal.
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /a.b'), '/axb')).toBe(true);
  });
});

describe('Company website: reading a page', () => {
  it('takes the site’s own Organization block, meta tags and profile links', () => {
    const facts = extractFacts(ACME_HOME, new URL('https://acme.com/'), 'acme.com', 2026);
    expect(facts).toEqual({
      name: 'Acme & Co',
      description: 'Acme makes industrial widgets for factories.',
      logo: 'https://acme.com/img/logo.png',
      foundedYear: 2011,
      size: '51-200',
      headquarters: 'Lahore, Punjab, Pakistan',
      socials: {
        linkedin: 'https://www.linkedin.com/company/acme-co',
        x: 'https://x.com/acmeco',
        facebook: 'https://www.facebook.com/acmeco',
        github: 'https://github.com/acme-co',
      },
      rich: true,
      aboutUrl: 'https://acme.com/about-us/',
    });
  });

  it('never takes a nested organization from another site, and falls back to meta tags', () => {
    const facts = extractFacts(THIN_HOME, new URL('https://boaty.io/'), 'boaty.io', 2026);
    expect(facts).toMatchObject({ name: 'Boaty', description: 'We build boats.', rich: false, aboutUrl: 'https://boaty.io/company', socials: { linkedin: 'https://www.linkedin.com/company/boaty' } });
    const review = extractFacts('<script type="application/ld+json">{"@type":"Review","author":{"@type":"Organization","name":"Other","foundingDate":"1990"}}</script>', new URL('https://x.com/'), 'acme.com', 2026);
    expect(review).toMatchObject({ name: undefined, foundedYear: undefined, rich: false });
  });

  it('reads sizes, years, entities and social links carefully', () => {
    expect([100, '1,200', { value: 40 }, { minValue: 10 }, { minValue: 5, maxValue: 5 }, { maxValue: 9 }, 'many', -3, 0, [{ value: '12' }]].map(employeeCount)).toEqual([100, 1200, 40, '10+', 5, undefined, undefined, undefined, undefined, 12]);
    expect(decodeEntities('A&amp;B &#39;x&#x27; &eacute; &#0; &nbsp;')).toBe('A&B \'x\' &eacute; &#0;  ');
    expect(socialProfile('https://twitter.com/intent/tweet?text=hi')).toBeNull();
    expect(socialProfile('https://x.com/share')).toBeNull();
    expect(socialProfile('https://www.linkedin.com/in/person')).toBeNull();
    expect(socialProfile('https://uk.linkedin.com/company/acme/about/')).toEqual(['linkedin', 'https://www.linkedin.com/company/acme']);
    expect(socialProfile('https://www.youtube.com/@acme/videos')).toEqual(['youtube', 'https://www.youtube.com/@acme']);
    expect(socialProfile('https://www.youtube.com/watch?v=1')).toBeNull();
    expect(socialProfile('https://www.crunchbase.com/organization/acme')).toEqual(['crunchbase', 'https://www.crunchbase.com/organization/acme']);
    expect(socialProfile('javascript:alert(1)')).toBeNull();
  });
});

describe('Company website: Wikidata', () => {
  it('asks by official website with every URL variant', () => {
    expect(siteIris('acme.com')).toEqual(['<https://acme.com/>', '<https://acme.com>', '<https://www.acme.com/>', '<https://www.acme.com>', '<http://acme.com/>', '<http://acme.com>', '<http://www.acme.com/>', '<http://www.acme.com>']);
    const q = wikidataQuery('acme.com');
    for (const p of ['wdt:P856', 'P452', 'P1128', 'pq:P585', 'P571', 'P159', 'P17', 'P4264', 'DeprecatedRank']) expect(q).toContain(p);
  });

  it('picks the latest employee count, real labels, and the earliest inception', () => {
    expect(wikidataFacts(STRIPE_ROWS, 2026)).toEqual({
      qid: 'Q7624104',
      website: 'https://stripe.com',
      name: 'Stripe',
      industry: 'financial services',
      employees: 8000,
      employeesYear: 2023,
      foundedYear: 2010,
      headquarters: 'San Francisco, United States',
      linkedin: 'https://www.linkedin.com/company/stripe',
    });
  });

  it('prefers preferred-rank statements and the item with the most facts', () => {
    const rows = [
      wdRow({ prop: 'employees', value: '100', rank: PREF, date: '2015-01-01T00:00:00Z' }, 'Q50', 'Acme'),
      wdRow({ prop: 'employees', value: '900', rank: NORMAL, date: '2024-01-01T00:00:00Z' }, 'Q50', 'Acme'),
      wdRow({ prop: 'industry', value: ent('Q1'), valueLabel: 'retail', rank: NORMAL }, 'Q50', 'Acme'),
      wdRow({ prop: 'industry', value: ent('Q2'), valueLabel: 'software', rank: PREF }, 'Q50', 'Acme'),
      // A product sharing the website, with fewer facts.
      wdRow({ prop: 'inception', value: '2020-01-01T00:00:00Z', rank: NORMAL }, 'Q10', 'Acme App'),
      // An item with no facts at all still has a label row.
      { item: { type: 'uri', value: ent('Q5') }, itemLabel: { type: 'literal', value: 'Q5' }, site: { type: 'uri', value: 'https://acme.com/' } },
    ];
    expect(wikidataFacts(rows as any, 2026)).toMatchObject({ qid: 'Q50', name: 'Acme', employees: 100, employeesYear: 2015, industry: 'software' });
    expect(wikidataFacts([rows[5]] as any, 2026)).toEqual({ qid: 'Q5', website: 'https://acme.com' });
    expect(wikidataFacts([], 2026)).toBeNull();
  });
});

describe('Company website: enrich', () => {
  function acme(w: World, o: { home?: string; robotsTxt?: string; wd?: unknown[] } = {}) {
    const routes: FakeRoute[] = [
      { url: /^https:\/\/acme\.com\/robots\.txt$/, reply: robots(o.robotsTxt ?? 'User-agent: *\nDisallow: /cart') },
      { url: /^https:\/\/acme\.com\/$/, reply: page(o.home ?? ACME_HOME) },
      { url: WIKIDATA, reply: () => sparql(o.wd ?? []) },
    ];
    const fetch = fakeFetch(routes);
    w.ctx.fetch = fetch;
    return fetch;
  }

  it('fills the company and adds website facts, with Wikidata filling the gaps, at no cost', async () => {
    const w = makeWorld();
    dns(w);
    const fetch = acme(w, { wd: STRIPE_ROWS });
    const r = await website(w)().enrich(input());
    expect(r).toEqual({
      fields: { company: 'Acme & Co' },
      companyDomain: 'acme.com',
      credits: 0,
      enrichment: {
        website: 'https://acme.com',
        companyDescription: 'Acme makes industrial widgets for factories.',
        industry: 'financial services',
        companySize: '51-200',
        foundedYear: 2011,
        headquarters: 'Lahore, Punjab, Pakistan',
        companyLinkedin: 'https://www.linkedin.com/company/acme-co',
        companySocials: { x: 'https://x.com/acmeco', facebook: 'https://www.facebook.com/acmeco', github: 'https://github.com/acme-co' },
        companyLogo: 'https://acme.com/img/logo.png',
        wikidata: 'https://www.wikidata.org/wiki/Q7624104',
      },
    });
    // robots.txt first, then the homepage (rich enough: no About page), then one Wikidata query.
    expect(fetch.calls.map((c) => c.url.replace(/\?.*/, ''))).toEqual(['https://acme.com/robots.txt', 'https://acme.com/', 'https://query.wikidata.org/sparql']);
    for (const c of fetch.calls.slice(0, 2)) expect(c.headers['user-agent']).toBe(USER_AGENT);
    const wd = fetch.calls[2];
    expect(wd.headers.accept).toBe('application/sparql-results+json');
    expect(wd.headers['user-agent']).toMatch(/^OpenReachBot\/0\.1 \(\+https:\/\/github\.com\/hasnainakber9\/openreach\) company-enrichment$/);
    expect(new URL(wd.url).searchParams.get('query')).toContain('<https://www.acme.com/>');
  });

  it('reads the About page when the homepage says little, and caches both lookups', async () => {
    const w = makeWorld();
    dns(w);
    const fetch = fakeFetch([
      { url: /^https:\/\/boaty\.io\/robots\.txt$/, reply: () => ({ status: 404, text: 'nope' }) },
      { url: /^https:\/\/boaty\.io\/$/, reply: page(THIN_HOME) },
      { url: /^https:\/\/boaty\.io\/company$/, reply: page(BOATY_ABOUT) },
      { url: WIKIDATA, reply: () => sparql([]) },
    ]);
    w.ctx.fetch = fetch;
    const enricher = website(w)();
    const r = await enricher.enrich(input({ domain: undefined, email: 'ann@boaty.io' }));
    expect(r).toEqual({
      fields: { company: 'Boaty' },
      companyDomain: 'boaty.io',
      credits: 0,
      enrichment: { website: 'https://boaty.io', companyDescription: 'We build boats.', companySize: 1200, foundedYear: 1999, headquarters: 'Karachi, Pakistan', companyLinkedin: 'https://www.linkedin.com/company/boaty' },
    });
    expect(fetch.calls).toHaveLength(4);
    // The next lead at the same company is answered from the caches.
    expect(await enricher.enrich(input({ domain: 'boaty.io' }))).toEqual(r);
    expect(fetch.calls).toHaveLength(4);
    // After 12 hours the site (and its robots.txt) is read again; Wikidata's "not found" lasts a day.
    w.ctx.clock.advance(13 * 3_600_000);
    await enricher.enrich(input({ domain: 'boaty.io' }));
    expect(fetch.calls.filter((c) => c.url.startsWith('https://boaty.io/'))).toHaveLength(6);
    expect(fetch.calls.filter((c) => WIKIDATA.test(c.url))).toHaveLength(1);
    w.ctx.clock.advance(12 * 3_600_000);
    await enricher.enrich(input({ domain: 'boaty.io' }));
    expect(fetch.calls.filter((c) => WIKIDATA.test(c.url))).toHaveLength(2);
  });

  it('returns nothing found without any request for leads with no usable domain', async () => {
    const w = makeWorld();
    dns(w);
    const fetch = fakeFetch([]);
    w.ctx.fetch = fetch;
    const enricher = website(w)();
    for (const lead of [input({ domain: undefined }), input({ domain: undefined, email: 'ann@gmail.com' }), input({ domain: 'localhost' }), input({ domain: '192.168.1.10' })]) expect(await enricher.enrich(lead)).toBeNull();
    expect(fetch.calls).toEqual([]);
  });

  it('returns nothing found when neither the site nor Wikidata says anything', async () => {
    const w = makeWorld();
    dns(w);
    acme(w, { home: '<html><head><title>Welcome</title></head><body>Hi</body></html>' });
    expect(await website(w)().enrich(input())).toBeNull();
  });

  it('skips Wikidata when it is turned off, and sends the contact only to Wikidata', async () => {
    const w = makeWorld();
    dns(w);
    let fetch = acme(w, { wd: STRIPE_ROWS });
    const r = await website(w, { noWikidata: true })().enrich(input());
    expect(r?.enrichment).not.toHaveProperty('industry');
    expect(fetch.calls.some((c) => WIKIDATA.test(c.url))).toBe(false);

    forgetWebsiteCaches();
    const w2 = makeWorld();
    dns(w2);
    fetch = acme(w2, { wd: STRIPE_ROWS });
    await website(w2, { contact: 'ops@agency.pk' })().enrich(input());
    expect(fetch.calls.find((c) => WIKIDATA.test(c.url))!.headers['user-agent']).toBe('OpenReachBot/0.1 (+https://github.com/hasnainakber9/openreach; ops@agency.pk) company-enrichment');
    expect(fetch.calls.filter((c) => !WIKIDATA.test(c.url)).every((c) => c.headers['user-agent'] === USER_AGENT)).toBe(true);
  });
});

describe('Company website: the SSRF guard', () => {
  it('never fetches a site whose name resolves to a private, loopback or metadata address', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.4', '169.254.169.254', '::1', 'fd00:ec2::254', '::ffff:7f00:1']) {
      forgetWebsiteCaches();
      const w = makeWorld();
      dns(w, { 'acme.com': [PUBLIC_IP, address] });
      const fetch = fakeFetch([{ url: WIKIDATA, reply: () => sparql([]) }]);
      w.ctx.fetch = fetch;
      expect(await website(w)().enrich(input()), address).toBeNull();
      // Only Wikidata was asked; the site wasn't touched, nor its www. or http:// variants.
      expect(fetch.calls.map((c) => c.url.replace(/\?.*/, '')), address).toEqual(['https://query.wikidata.org/sparql']);
    }
  });

  it('checks every redirect: private hosts, IP literals, other ports, credentials and too many hops are refused', async () => {
    const targets = ['https://internal.acme.com/', 'http://10.0.0.1/', 'https://acme.com:8443/', 'https://user:pw@acme.com/x', 'file:///etc/passwd', 'https://metadata.google.internal/'];
    for (const location of targets) {
      forgetWebsiteCaches();
      const w = makeWorld();
      dns(w, { 'internal.acme.com': ['10.9.9.9'] });
      const fetch = fakeFetch([
        { url: /^https:\/\/acme\.com\/robots\.txt$/, reply: robots('') },
        { url: /^https:\/\/acme\.com\/$/, reply: () => ({ status: 301, headers: { location } }) },
        { url: WIKIDATA, reply: () => sparql([]) },
      ]);
      w.ctx.fetch = fetch;
      expect(await website(w)().enrich(input()), location).toBeNull();
      expect(fetch.calls.filter((c) => !WIKIDATA.test(c.url)).map((c) => c.url), location).toEqual(['https://acme.com/robots.txt', 'https://acme.com/']);
    }

    // A redirect loop stops after MAX_REDIRECTS hops.
    forgetWebsiteCaches();
    const w = makeWorld();
    dns(w);
    let n = 0;
    const fetch = fakeFetch([
      { url: /\/robots\.txt$/, reply: robots('') },
      { url: /^https:\/\/acme\.com\/\d*$/, reply: () => ({ status: 302, headers: { location: `/${++n}` } }) },
      { url: WIKIDATA, reply: () => sparql([]) },
    ]);
    w.ctx.fetch = fetch;
    expect(await website(w)().enrich(input())).toBeNull();
    expect(fetch.calls.filter((c) => !/robots|wikidata/.test(c.url))).toHaveLength(MAX_REDIRECTS + 1);
  });

  it('follows a redirect to another public host and reads it there (robots.txt included)', async () => {
    const w = makeWorld();
    dns(w);
    const fetch = fakeFetch([
      { url: /^https:\/\/acme\.com\/robots\.txt$/, reply: robots('') },
      { url: /^https:\/\/acme\.com\/$/, reply: () => ({ status: 301, headers: { location: 'https://www.acme.com/en/' } }) },
      { url: /^https:\/\/www\.acme\.com\/robots\.txt$/, reply: robots('User-agent: *\nAllow: /') },
      { url: /^https:\/\/www\.acme\.com\/en\/$/, reply: page(ACME_HOME) },
      { url: WIKIDATA, reply: () => sparql([]) },
    ]);
    w.ctx.fetch = fetch;
    const r = await website(w)().enrich(input());
    expect(r?.enrichment).toMatchObject({ website: 'https://www.acme.com', foundedYear: 2011 });
    expect(fetch.calls.map((c) => c.url).slice(0, 4)).toEqual(['https://acme.com/robots.txt', 'https://acme.com/', 'https://www.acme.com/robots.txt', 'https://www.acme.com/en/']);
    expect(fetch.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('reads at most MAX_HTML_BYTES of a page and ignores what isn’t HTML', async () => {
    const w = makeWorld();
    dns(w);
    const huge = ACME_HOME.replace('</body>', `${'x'.repeat(MAX_HTML_BYTES * 2)}</body>`);
    let read = 0;
    w.ctx.fetch = (async (url: string) => {
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      if (WIKIDATA.test(url)) return new Response(JSON.stringify(sparql([]).json), { headers: { 'content-type': 'application/json' } });
      const bytes = new TextEncoder().encode(huge);
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (read >= bytes.length) return c.close();
          c.enqueue(bytes.subarray(read, read + 65_536));
          read += 65_536;
        },
      });
      return new Response(body, { headers: HTML });
    }) as typeof fetch;
    const r = await website(w)().enrich(input());
    expect(r?.enrichment).toMatchObject({ foundedYear: 2011 });
    expect(read).toBeLessThan(MAX_HTML_BYTES + 3 * 65_536);

    forgetWebsiteCaches();
    const w2 = makeWorld();
    dns(w2);
    w2.ctx.fetch = fakeFetch([
      { url: /robots\.txt$/, reply: robots('') },
      { url: /^https:\/\/acme\.com\/$/, reply: page(ACME_HOME, { 'content-type': 'application/pdf' }) },
      { url: WIKIDATA, reply: () => sparql([]) },
    ]);
    expect(await website(w2)().enrich(input())).toBeNull();
  });
});

describe('Company website: robots.txt and failures', () => {
  function site(w: World, robotsReply: FakeRoute['reply'], extra: FakeRoute[] = []) {
    const fetch = fakeFetch([{ url: /^https:\/\/acme\.com\/robots\.txt$/, reply: robotsReply }, { url: /^https:\/\/acme\.com\/$/, reply: page(ACME_HOME) }, ...extra, { url: WIKIDATA, reply: () => sparql([]) }]);
    w.ctx.fetch = fetch;
    return fetch;
  }
  const homeFetched = (fetch: ReturnType<typeof fakeFetch>) => fetch.calls.some((c) => c.url === 'https://acme.com/');

  it('reads nothing robots.txt disallows, nor anything while robots.txt answers 429 or 5xx', async () => {
    for (const [reply, read] of [
      [robots('User-agent: *\nDisallow: /'), false],
      [robots('User-agent: *\nDisallow: /\n\nUser-agent: OpenReachBot\nAllow: /'), true],
      [robots('User-agent: OpenReachBot\nDisallow: /$'), false],
      [() => ({ status: 404, text: '' }), true],
      [() => ({ status: 403, text: '' }), true],
      [() => ({ status: 429, text: '' }), false],
      [() => ({ status: 503, text: '' }), false],
    ] as [FakeRoute['reply'], boolean][]) {
      forgetWebsiteCaches();
      const w = makeWorld();
      dns(w);
      const fetch = site(w, reply);
      const r = await website(w)().enrich(input());
      expect(homeFetched(fetch), JSON.stringify(reply({} as any))).toBe(read);
      expect(r === null).toBe(!read);
    }
  });

  it('tries www. and then http:// when the name doesn’t answer, and gives up quietly', async () => {
    const w = makeWorld();
    dns(w, { 'acme.com': [] });
    const fetch = fakeFetch([
      { url: /^https:\/\/www\.acme\.com\/robots\.txt$/, reply: robots('') },
      { url: /^https:\/\/www\.acme\.com\/$/, reply: page(ACME_HOME) },
      { url: WIKIDATA, reply: () => sparql([]) },
    ]);
    w.ctx.fetch = fetch;
    expect((await website(w)().enrich(input()))?.enrichment).toMatchObject({ website: 'https://www.acme.com' });

    // Every variant times out: nothing from the site, and the failure isn't cached.
    forgetWebsiteCaches();
    const w2 = makeWorld();
    dns(w2);
    let siteCalls = 0;
    w2.ctx.fetch = (async (url: string) => {
      if (WIKIDATA.test(url)) return new Response(JSON.stringify(sparql(STRIPE_ROWS).json), { headers: { 'content-type': 'application/json' } });
      siteCalls++;
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as typeof fetch;
    const enricher = website(w2)();
    const r = await enricher.enrich(input());
    expect(r?.enrichment).toMatchObject({ industry: 'financial services', website: 'https://stripe.com', companySize: 8000, companySizeYear: 2023 });
    expect(r?.fields).toEqual({ company: 'Stripe' });
    expect(siteCalls).toBe(3);
    await enricher.enrich(input());
    expect(siteCalls).toBe(6);
  });

  it('remembers a missing homepage, but asks again after a server error', async () => {
    for (const [status, again] of [
      [404, false],
      [503, true],
    ] as const) {
      forgetWebsiteCaches();
      const w = makeWorld();
      dns(w);
      const fetch = fakeFetch([{ url: /robots\.txt$/, reply: robots('') }, { url: /^https:\/\/acme\.com\/$/, reply: () => ({ status, text: 'no' }) }, { url: WIKIDATA, reply: () => sparql([]) }]);
      w.ctx.fetch = fetch;
      const enricher = website(w)();
      expect(await enricher.enrich(input())).toBeNull();
      expect(await enricher.enrich(input())).toBeNull();
      expect(fetch.calls.filter((c) => c.url === 'https://acme.com/'), String(status)).toHaveLength(again ? 2 : 1);
    }
  });

  it('maps Wikidata errors, and keeps the website facts when Wikidata fails', async () => {
    const cases: [FakeRoute['reply'], string, number | undefined][] = [
      [() => ({ status: 429, json: { message: 'slow down' }, headers: { 'retry-after': '7' } }), 'RATE_LIMIT', 429],
      [() => ({ status: 500, text: 'java.util.concurrent.TimeoutException' }), 'UNAVAILABLE', 500],
      [() => ({ status: 403, text: 'blocked' }), 'BAD_REQUEST', 403],
      [() => ({ status: 400, text: 'bad query' }), 'BAD_REQUEST', 400],
      [() => ({ text: '<html>not json</html>' }), 'UNAVAILABLE', undefined],
    ];
    for (const [reply, code, status] of cases) {
      forgetWebsiteCaches();
      const w = makeWorld();
      dns(w);
      w.ctx.fetch = fakeFetch([{ url: /robots\.txt$/, reply: robots('User-agent: *\nDisallow: /') }, { url: WIKIDATA, reply }]);
      const e = await failure(website(w)().enrich(input()));
      expect(e, code).toBeInstanceOf(ProviderError);
      expect(e.code, code).toBe(code);
      expect(e.status).toBe(status);
      if (code === 'RATE_LIMIT') expect(e.retryAfterMs).toBe(7000);
      if (status === 403) expect(e.message).toMatch(/User-Agent/);
    }

    // A timeout from Wikidata with nothing from the site fails (and is retried later by the job queue)...
    forgetWebsiteCaches();
    const w = makeWorld();
    dns(w);
    w.ctx.fetch = (async (url: string) => {
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /');
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as typeof fetch;
    expect((await failure(website(w)().enrich(input()))).code).toBe('TIMEOUT');

    // ...but with website facts in hand they are returned, and Wikidata is asked again next time.
    forgetWebsiteCaches();
    const w2 = makeWorld();
    dns(w2);
    let down = true;
    const fetch = fakeFetch([
      { url: /robots\.txt$/, reply: robots('') },
      { url: /^https:\/\/acme\.com\/$/, reply: page(ACME_HOME) },
      { url: WIKIDATA, reply: () => (down ? { status: 502, text: '' } : sparql(STRIPE_ROWS)) },
    ]);
    w2.ctx.fetch = fetch;
    const enricher = website(w2)();
    const partial = await enricher.enrich(input());
    expect(partial?.enrichment).toMatchObject({ foundedYear: 2011 });
    expect(partial?.enrichment).not.toHaveProperty('industry');
    down = false;
    expect((await enricher.enrich(input()))?.enrichment).toMatchObject({ industry: 'financial services' });
  });

  it('is polite: one Wikidata query a second, two quick requests a second per website', () => {
    expect(originalLimits.wikidata.reserve('test-a')).toBe(0);
    expect(originalLimits.wikidata.reserve('test-a')).toBeGreaterThan(0);
    expect(originalLimits.site.reserve('test-b')).toBe(0);
    expect(originalLimits.site.reserve('test-b')).toBe(0);
    expect(originalLimits.site.reserve('test-b')).toBeGreaterThan(0);
  });
});

describe('Company website: as an integration', () => {
  it('tests the connection with a tiny Wikidata query, or without any request when Wikidata is off', async () => {
    const w = makeWorld();
    const fetch = fakeFetch([{ url: WIKIDATA, reply: () => ({ json: { head: {}, boolean: true } }) }]);
    w.ctx.fetch = fetch;
    expect(await website(w)().test()).toEqual({ ok: true, message: 'Ready: reads public company websites, and Wikidata answered.' });
    expect(new URL(fetch.calls[0].url).searchParams.get('query')).toBe('ASK { BIND(1 AS ?x) }');
    const w2 = makeWorld();
    w2.ctx.fetch = fetch;
    const off = await website(w2, { noWikidata: true })().test();
    expect(off.ok).toBe(true);
    expect(fetch.calls).toHaveLength(1);
  });

  it('needs no key, validates the contact, and lists its fields for the form', async () => {
    const api = await makeApi();
    await api.register('Solo');
    const providers = (await api.call('GET', '/api/integrations/providers')).body;
    const def = (providers.providers ?? providers).find((d: any) => d.kind === 'enrichment' && d.id === 'website');
    expect(def.fields.map((f: any) => [f.key, f.type, !!f.secret])).toEqual([
      ['noWikidata', 'toggle', false],
      ['contact', 'text', false],
    ]);
    const make = (settings: Record<string, unknown>) => api.call('POST', '/api/integrations', { kind: 'enrichment', provider: 'website', settings });
    for (const contact of ['not a contact', 'a@b.c (x)', 'ftp://x.y', 'a@b.c\r\nX-Evil: 1']) expect((await make({ contact })).status, contact).toBe(400);
    const ok = await make({ contact: 'ops@agency.pk', noWikidata: false });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toEqual({ contact: 'ops@agency.pk', noWikidata: false });
    await api.register('Other');
    expect((await make({})).body).toMatchObject({ provider: 'website', settings: {} });
  });

  it('fills blank lead fields through an enrichment run, records usage at 0 credits, and runs on a plan with no enrichment credits', async () => {
    const w = makeWorld();
    // A hosted install whose plan includes no enrichment credits: a free provider still runs.
    w.ctx.stripe = {} as any;
    w.ctx.config.plans = parsePlans(JSON.stringify([{ id: 'free', name: 'Free', default: true, limits: { enrichmentCreditsMonthly: 0 } }]), 'test');
    dns(w);
    const [a, b] = addLeads(w, 2);
    w.ctx.db.run("UPDATE leads SET company = '', email = 'ann@acme.com', email_source = 'csv' WHERE id = ?", [a]);
    w.ctx.db.run("UPDATE leads SET company_domain = 'nowhere.org' WHERE id = ?", [b]);
    website(w);
    w.ctx.fetch = fakeFetch([
      { url: /^https:\/\/acme\.com\/robots\.txt$/, reply: robots('') },
      { url: /^https:\/\/acme\.com\/$/, reply: page(ACME_HOME) },
      { url: /nowhere\.org\/robots\.txt$/, reply: robots('User-agent: *\nDisallow: /') },
      { url: WIKIDATA, reply: (req) => sparql(new URL(req.url).searchParams.get('query')!.includes('acme.com') ? STRIPE_ROWS : []) },
    ]);
    startEnrichmentRun(w.ctx, w.workspaceId, null, [a, b], { find: false, verify: false, company: true, overwrite: false });
    await drainJobs(w);
    const lead = (id: number) => w.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id])!;
    expect(lead(a)).toMatchObject({ company: 'Acme & Co', company_domain: 'acme.com', enrichment_status: 'done', location: '' });
    expect(JSON.parse(lead(a).enrichment)).toMatchObject({ source: 'website', industry: 'financial services', foundedYear: 2011, companySize: '51-200' });
    expect(JSON.parse(lead(a).enrichment)).not.toHaveProperty('simulated');
    // Robots.txt said no and Wikidata doesn't know it: nothing found, the company typed in stays.
    expect(lead(b)).toMatchObject({ company: 'Acme', company_domain: 'nowhere.org', enrichment_status: 'not_found' });
    const month = new Date(w.ctx.clock.now()).toISOString().slice(0, 7);
    expect(monthlyUsage(w.ctx, w.workspaceId, month)).toEqual([expect.objectContaining({ kind: 'enrichment', provider: 'website', operation: 'enrich.person', calls: 2, credits: 0 })]);
  });
});

describe('Company website: review fixes', () => {
  it('connects only to the addresses it checked, for robots.txt and every hop', async () => {
    const w = makeWorld();
    // The name answers a public address at check time; a later answer (rebinding) can't reach the connection.
    let answer = PUBLIC_IP;
    w.ctx.dns = { ...w.ctx.dns, lookup: async () => [{ address: answer, family: 4 }] };
    const pinned: { url: string; to: unknown }[] = [];
    const inner = fakeFetch([
      { url: /robots\.txt$/, reply: robots('') },
      { url: /^https:\/\/acme\.com\/$/, reply: () => ({ status: 301, headers: { location: 'https://www.acme.com/' } }) },
      { url: /^https:\/\/www\.acme\.com\/$/, reply: page(ACME_HOME) },
      { url: WIKIDATA, reply: () => sparql([]) },
    ]);
    w.ctx.fetch = (async (url: string, init: any) => {
      if (!WIKIDATA.test(url)) pinned.push({ url, to: init.pinnedAddresses });
      return inner(url, init);
    }) as typeof fetch;
    const r = await website(w)().enrich(input());
    expect(r?.enrichment).toMatchObject({ website: 'https://www.acme.com' });
    expect(pinned.map((p) => p.url)).toEqual(['https://acme.com/robots.txt', 'https://acme.com/', 'https://www.acme.com/robots.txt', 'https://www.acme.com/']);
    for (const p of pinned) expect(p.to, p.url).toEqual([{ address: PUBLIC_IP, family: 4 }]);

    // A name that turns private between hops is refused before the next request.
    forgetWebsiteCaches();
    const w2 = makeWorld();
    let calls = 0;
    w2.ctx.dns = { ...w2.ctx.dns, lookup: async () => [{ address: calls++ < 2 ? PUBLIC_IP : '169.254.169.254', family: 4 }] };
    const f2 = fakeFetch([
      { url: /robots\.txt$/, reply: robots('') },
      { url: /^https:\/\/acme\.com\/$/, reply: () => ({ status: 302, headers: { location: '/next' } }) },
      { url: WIKIDATA, reply: () => sparql([]) },
    ]);
    w2.ctx.fetch = f2;
    expect(await website(w2)().enrich(input())).toBeNull();
    expect(f2.calls.filter((c) => !WIKIDATA.test(c.url)).map((c) => c.url)).toEqual(['https://acme.com/robots.txt', 'https://acme.com/']);
  });

  it('pinnedFetch connects to the pinned address whatever the name, keeps the Host header and decodes gzip', async () => {
    const seen: { host?: string; ua?: string }[] = [];
    const server = createServer((req, res) => {
      seen.push({ host: req.headers.host, ua: req.headers['user-agent'] });
      if (req.url === '/gz') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        res.end(gzipSync('<html>zipped</html>'));
      } else if (req.url === '/moved') {
        res.writeHead(301, { location: '/gz' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('plain');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      // rebind.invalid has no DNS at all: only the pinned address can be reached.
      const at = [{ address: '127.0.0.1', family: 4 }];
      const r1 = await pinnedFetch(`http://rebind.invalid:${port}/gz`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(5000) }, at);
      expect(r1.status).toBe(200);
      expect(await r1.text()).toBe('<html>zipped</html>');
      const r2 = await pinnedFetch(`http://rebind.invalid:${port}/moved`, { redirect: 'manual' }, at);
      expect([r2.status, r2.headers.get('location')]).toEqual([301, '/gz']);
      await r2.body?.cancel();
      expect(seen[0]).toEqual({ host: `rebind.invalid:${port}`, ua: USER_AGENT });
      // No checked address of the family the connection wants: refused like a network error.
      await expect(pinnedFetch(`http://rebind.invalid:${port}/`, {}, [])).rejects.toThrow(/fetch failed/);
      await expect(pinnedFetch(`http://rebind.invalid:${port}/`, { method: 'POST' }, at)).rejects.toThrow(/GET/);
    } finally {
      server.close();
    }
  });

  it('a robots.txt that answers 503 blocks reading only until it answers again, not for the site cache’s 12 hours', async () => {
    const w = makeWorld();
    dns(w);
    let robotsStatus = 503;
    const fetch = fakeFetch([
      { url: /robots\.txt$/, reply: () => ({ status: robotsStatus, text: '' }) },
      { url: /^https:\/\/acme\.com\/$/, reply: page(ACME_HOME) },
      { url: WIKIDATA, reply: () => sparql([]) },
    ]);
    w.ctx.fetch = fetch;
    const enricher = website(w)();
    expect(await enricher.enrich(input())).toBeNull();
    robotsStatus = 200;
    w.ctx.clock.advance(11 * 60_000);
    expect((await enricher.enrich(input()))?.enrichment).toMatchObject({ foundedYear: 2011 });
    expect(fetch.calls.filter((c) => c.url === 'https://acme.com/')).toHaveLength(1);
  });

  it('takes nothing from a redirect to another site (a parking or for-sale page), and remembers that', async () => {
    const w = makeWorld();
    dns(w);
    const parked = `<html><head><meta property="og:site_name" content="HugeDomains"><meta name="description" content="acme.com is for sale!"></head></html>`;
    const fetch = fakeFetch([
      { url: /robots\.txt$/, reply: robots('') },
      { url: /^https:\/\/acme\.com\/$/, reply: () => ({ status: 302, headers: { location: 'https://www.hugedomains.com/domain_profile.cfm?d=acme.com' } }) },
      { url: /hugedomains\.com\/domain_profile/, reply: page(parked) },
      { url: WIKIDATA, reply: () => sparql([]) },
    ]);
    w.ctx.fetch = fetch;
    const enricher = website(w)();
    expect(await enricher.enrich(input())).toBeNull();
    expect(await enricher.enrich(input())).toBeNull();
    expect(fetch.calls.filter((c) => c.url === 'https://acme.com/')).toHaveLength(1);
  });

  it('ignores an email domain’s site when the lead’s company is plainly another company', async () => {
    for (const [company, found] of [
      ['Globex', false],
      ['Acme', true],
      ['', true],
    ] as const) {
      forgetWebsiteCaches();
      const w = makeWorld();
      dns(w);
      w.ctx.fetch = fakeFetch([{ url: /robots\.txt$/, reply: robots('') }, { url: /^https:\/\/acme\.com\/$/, reply: page(ACME_HOME) }, { url: WIKIDATA, reply: () => sparql([]) }]);
      const r = await website(w)().enrich(input({ domain: undefined, email: 'ann@acme.com', company }));
      expect(r !== null, company).toBe(found);
    }
  });

  it('parses hostile pages in linear time', () => {
    const url = new URL('https://acme.com/');
    const n = 400_000;
    const cases: [string, string][] = [
      ['unclosed comments', '<!--'.repeat(n / 4)],
      ['unclosed meta tags', '<meta '.repeat(n / 6)],
      ['unclosed links', '<a '.repeat(n / 3)],
      ['scripts without an end', '<script>'.repeat(n / 8)],
      ['long attribute names', `<meta ${'a'.repeat(n)}>`],
      ['a JSON-LD description full of "<"', `<script type="application/ld+json">${JSON.stringify({ '@type': 'Organization', name: 'Acme', description: '<'.repeat(n) })}</script>`],
      ['links with long slash runs', `<a href="/${'/'.repeat(900)}x">`.repeat(400)],
    ];
    for (const [what, html] of cases) {
      const t = Date.now();
      extractFacts(html, url, 'acme.com', 2026);
      expect(Date.now() - t, what).toBeLessThan(1000);
    }
    expect(stripTags('a <b>bold</b> <i x="1">it</i> < tail')).toBe('a  bold   it  < tail');
    expect(attrs(` property="og:title" content='It' data-x=raw checked name = "n" /`)).toEqual({ property: 'og:title', content: 'It', 'data-x': 'raw', name: 'n' });
  });

  it('gives up on a site that keeps a lead busy past the overall deadline, without remembering it', async () => {
    limits.siteDeadlineMs = 150;
    const w = makeWorld();
    dns(w);
    let hops = 0;
    w.ctx.fetch = (async (url: string) => {
      if (WIKIDATA.test(url)) return new Response(JSON.stringify(sparql([]).json), { headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      hops++;
      await new Promise((r) => setTimeout(r, 60));
      // Each hop goes to a fresh origin, so robots.txt is asked again every time.
      return new Response('', { status: 302, headers: { location: `https://h${hops}.acme.com/` } });
    }) as typeof fetch;
    const t = Date.now();
    expect(await website(w)().enrich(input())).toBeNull();
    expect(Date.now() - t).toBeLessThan(1500);
    // The www. and http:// fallbacks don't start after the deadline.
    expect(hops).toBeLessThan(MAX_REDIRECTS + 1);
  });

  it('on a hosted server, limits each billing root’s lookups a day and its share of Wikidata', async () => {
    const w = makeWorld();
    w.ctx.stripe = {} as any;
    limits.dailyLookups = 2;
    dns(w);
    w.ctx.fetch = fakeFetch([{ url: /robots\.txt$/, reply: robots('') }, { url: /^https:\/\/(acme\.com|boaty\.io)\/$/, reply: page(ACME_HOME) }, { url: WIKIDATA, reply: () => sparql([]) }]);
    const taken: (string | number)[] = [];
    limits.wikidataPerRoot = { take: async (k: string | number) => void taken.push(k) } as any;
    const enricher = website(w)();
    const used = (ctx: World['ctx'], workspaceId: number) => recordUsage(ctx, { workspaceId, kind: 'enrichment', provider: 'website', operation: 'enrich.person', credits: 0 });
    expect(await enricher.enrich(input())).not.toBeNull();
    // The Wikidata share is taken per billing root.
    expect(taken).toEqual([w.workspaceId]);
    used(w.ctx, w.workspaceId);
    used(w.ctx, w.workspaceId);
    const e = await failure(enricher.enrich(input()));
    expect([e.code, e.retryAfterMs]).toEqual(['RATE_LIMIT', 3_600_000]);
    // A day later the old lookups no longer count.
    w.ctx.clock.advance(24 * 3_600_000 + 1);
    expect(await enricher.enrich(input({ domain: 'boaty.io' }))).not.toBeNull();

    // Self-hosted (billing off): no daily limit and no share.
    forgetWebsiteCaches();
    taken.length = 0;
    const w2 = makeWorld();
    dns(w2);
    w2.ctx.fetch = fakeFetch([{ url: /robots\.txt$/, reply: robots('') }, { url: /^https:\/\/acme\.com\/$/, reply: page(ACME_HOME) }, { url: WIKIDATA, reply: () => sparql([]) }]);
    for (let i = 0; i < 3; i++) used(w2.ctx, w2.workspaceId);
    expect(await website(w2)().enrich(input())).not.toBeNull();
    expect(taken).toEqual([]);
  });
});
