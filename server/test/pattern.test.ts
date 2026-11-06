import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { parsePlans } from '../src/billing/plans.js';
import { limits as afterShipLimits } from '../src/providers/data/aftership.js';
import { DEFAULT_MAX_PROBES, forgetPatternCaches, guessDomain, guessLocals, isDisposableDomain, limits, PATTERNS, patternFinder } from '../src/providers/data/pattern.js';
import type { VerifyResult } from '../src/providers/data/types.js';
import { ProviderError, RateLimiter } from '../src/providers/http.js';
import { providerDef, registerProvider, unregisterProvider } from '../src/providers/registry.js';
import { createIntegration, loadIntegration } from '../src/providers/store.js';
import { findEmailWaterfall, enrichmentSettings, startEnrichmentRun } from '../src/services/enrichment.js';
import { monthlyUsage } from '../src/services/usage.js';
import type { LeadRow } from '../src/types.js';
import { addLeads, drainJobs, fakeFetch, makeApi, makeWorld, type World } from './helpers.js';

// The free Pattern finder: name normalisation and patterns, domain screening (webmail, disposable, reserved, no MX),
// catch-all detection, probing in order with a cap and a time budget, the verifier chain and its errors, what is
// remembered per domain, and how it sits in the waterfall. DNS and every verifier are fakes; nothing touches the network.

// Two programmable verifiers, so the chain (priority order, fallbacks) can be exercised without HTTP.
type Verdict = (email: string, integrationId: number | null) => VerifyResult | Promise<VerifyResult>;
const verdicts: Record<string, Verdict> = {};
const checked: Record<string, string[]> = {};
for (const id of ['testverifier', 'testverifier2']) {
  registerProvider({
    id,
    kind: 'email_verifier',
    label: id === 'testverifier' ? 'Test Verifier' : 'Second Verifier',
    description: 'fake',
    fields: [],
    credentials: z.object({}),
    settings: z.object({}),
    create: (_ctx, cfg) => ({
      providerId: id,
      simulated: false,
      free: true,
      test: async () => ({ ok: true, message: 'ok' }),
      verify: async (email: string) => {
        (checked[id] ??= []).push(email);
        return verdicts[id](email, cfg.integrationId);
      },
    }),
  });
}
afterAll(() => {
  unregisterProvider('email_verifier', 'testverifier');
  unregisterProvider('email_verifier', 'testverifier2');
});

const invalid = (by = 'Test'): VerifyResult => ({ status: 'invalid', reason: `${by}: no such mailbox`, credits: 0 });
const valid = (by = 'Test'): VerifyResult => ({ status: 'valid', reason: `${by}: the mailbox exists`, credits: 0 });
const risky = (by = 'Test'): VerifyResult => ({ status: 'risky', reason: `${by}: accept-all`, credits: 0 });
const unknown = (by = 'Test'): VerifyResult => ({ status: 'unknown', reason: `${by}: port 25 is blocked`, credits: 0 });
// Accepts only `good` addresses; refuses everything else, including the made-up catch-all probe.
const accepts = (...good: string[]): Verdict => (email) => (good.includes(email) ? valid() : invalid());

// Mail servers per domain; any other domain doesn't exist.
function mx(w: World, table: Record<string, { exchange: string; priority: number }[] | Error>) {
  w.ctx.dns = {
    ...w.ctx.dns,
    resolveMx: async (d: string) => {
      const r = table[d];
      if (r instanceof Error) throw r;
      if (r) return r;
      throw Object.assign(new Error(`queryMx ENOTFOUND ${d}`), { code: 'ENOTFOUND' });
    },
  };
}
const MX = [{ exchange: 'mx1.acme.dev', priority: 10 }];

// The workspace's Pattern finder (added on first use).
function finder(w: World, settings: Record<string, unknown> = {}, workspaceId = w.workspaceId) {
  const id = w.ctx.db.get<{ id: number }>("SELECT id FROM integrations WHERE workspace_id = ? AND kind = 'email_finder' AND provider = 'pattern'", [workspaceId])?.id;
  const row = id ? loadIntegration(w.ctx, workspaceId, id)! : createIntegration(w.ctx, workspaceId, { kind: 'email_finder', provider: 'pattern', settings });
  return w.ctx.providers.instance<'email_finder'>(row)!;
}
const addVerifier = (w: World, provider: string, credentials: Record<string, string> = {}, settings: Record<string, unknown> = {}) =>
  createIntegration(w.ctx, w.workspaceId, { kind: 'email_verifier', provider, credentials, settings });
const input = (o: Partial<{ firstName: string; lastName: string; domain: string }> = {}) => ({ firstName: 'Ann', lastName: 'Smith', company: 'Acme', domain: 'acme.dev', profileUrl: 'https://www.linkedin.com/in/ann/', ...o });
const lead = (w: World, id: number) => w.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id])!;
const month = (w: World) => new Date(w.ctx.clock.now()).toISOString().slice(0, 7);

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error('expected a failure');
};

beforeAll(() => {
  // The real providers' rate limits would only slow the end-to-end tests down.
  afterShipLimits.verifier = new RateLimiter(10_000, 10_000);
});
beforeEach(() => {
  forgetPatternCaches();
  for (const k of Object.keys(checked)) delete checked[k];
  verdicts.testverifier = accepts();
  verdicts.testverifier2 = accepts();
  limits.budgetMs = 3 * 60_000;
  limits.now = () => Date.now();
});
afterEach(() => vi.restoreAllMocks());

describe('Pattern finder: names and patterns', () => {
  it('guesses the commonest patterns first for a plain name', () => {
    expect(guessLocals('Ann', 'Smith').map((g) => g.local)).toEqual([
      'ann.smith',
      'ann',
      'asmith',
      'annsmith',
      'a.smith',
      'anns',
      'ann_smith',
      'smith',
      'smith.ann',
      'ann-smith',
      'smitha',
      'smithann',
      'ann.s',
    ]);
    expect(guessLocals('Ann', 'Smith').map((g) => g.pattern)).toEqual([...PATTERNS]);
  });

  it('normalises case, accents, special letters, apostrophes, titles, suffixes and nicknames', () => {
    expect(guessLocals('  ANN ', 'SMITH')[0].local).toBe('ann.smith');
    expect(guessLocals('José', 'Núñez')[0].local).toBe('jose.nunez');
    expect(guessLocals('Søren', 'Kierkegaard')[0].local).toBe('soren.kierkegaard');
    expect(guessLocals('Łukasz', 'Straße')[0].local).toBe('lukasz.strasse');
    expect(guessLocals('Dr. Mary (MJ)', "O'Neil, PhD")[0].local).toBe('mary.oneil');
    expect(guessLocals('Prof Ann', 'Smith Jr.')[0].local).toBe('ann.smith');
    expect(guessLocals('Ann', 'Smith III')[0].local).toBe('ann.smith');
    // The whole name typed into the first-name field.
    expect(guessLocals('Ann Smith', '')[0].local).toBe('ann.smith');
  });

  it('spells umlauts both ways and tries the plain spelling first', () => {
    const locals = guessLocals('Jörg', 'Müller').map((g) => g.local);
    expect(locals.slice(0, 5)).toEqual(['jorg.muller', 'jorg', 'jmuller', 'jorgmuller', 'j.muller']);
    expect(locals).toEqual(expect.arrayContaining(['joerg.mueller', 'jmueller', 'joergmueller']));
    expect(locals.indexOf('joerg.mueller')).toBeLessThan(locals.indexOf('jorgm'));
  });

  it('handles hyphenated and compound names, never using a particle alone', () => {
    const hyphen = guessLocals('Jean-Luc', 'Picard').map((g) => g.local);
    expect(hyphen.slice(0, 3)).toEqual(['jeanluc.picard', 'jeanluc', 'jpicard']);
    expect(hyphen).toEqual(expect.arrayContaining(['jean-luc.picard', 'jean.picard']));
    const double = guessLocals('Mary', 'Smith-Jones').map((g) => g.local);
    expect(double[0]).toBe('mary.smithjones');
    expect(double).toEqual(expect.arrayContaining(['mary.smith-jones', 'mary.smith', 'mary.jones', 'msmith']));
    const dutch = guessLocals('Kees', 'van der Berg').map((g) => g.local);
    expect(dutch[0]).toBe('kees.vanderberg');
    expect(dutch).toContain('kees.berg');
    expect(dutch).not.toContain('kees.van');
    expect(dutch).not.toContain('kees.der');
    const spanish = guessLocals('José', 'García López').map((g) => g.local);
    expect(spanish).toEqual(expect.arrayContaining(['jose.garcialopez', 'jose.garcia', 'jose.lopez']));
  });

  it('only makes valid, unique local parts, and none from names it cannot spell in ASCII', () => {
    for (const [f, l] of [
      ['Ann', 'Smith'],
      ['Jean-Luc', 'Picard'],
      ['Dr. Jörg', 'Müller-Lüdenscheidt, PhD'],
      ['A', 'B'],
      ['x'.repeat(40), 'y'.repeat(40)],
    ]) {
      const locals = guessLocals(f, l).map((g) => g.local);
      expect(new Set(locals).size).toBe(locals.length);
      for (const local of locals) expect(local).toMatch(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/);
      for (const local of locals) expect(local.length).toBeLessThanOrEqual(64);
      for (const local of locals) expect(local).not.toMatch(/[._-]{2}/);
    }
    expect(guessLocals('李', '王')).toEqual([]);
    expect(guessLocals('Ann', '')).toEqual([]);
    expect(guessLocals('', 'Smith')).toEqual([]);
    expect(guessLocals('🙂', '🙃')).toEqual([]);
  });

  it('tries a pattern already confirmed at the domain first', () => {
    expect(guessLocals('Ann', 'Smith', 'flast').slice(0, 3).map((g) => g.local)).toEqual(['asmith', 'ann.smith', 'ann']);
    expect(guessLocals('Ann', 'Smith', 'flast').filter((g) => g.local === 'asmith')).toHaveLength(1);
  });
});

describe('Pattern finder: domains', () => {
  it('takes a bare host from a domain or website and skips webmail, disposable, reserved and malformed ones', () => {
    expect(guessDomain('Acme.dev')).toEqual({ domain: 'acme.dev' });
    expect(guessDomain('https://www.acme.dev/about?x=1')).toEqual({ domain: 'acme.dev' });
    expect(guessDomain('gmail.com')).toEqual({ skip: 'a webmail domain' });
    expect(guessDomain('yahoo.co.uk')).toEqual({ skip: 'a webmail domain' });
    expect(guessDomain('mailinator.com')).toEqual({ skip: 'a disposable email domain' });
    expect(guessDomain('acme.example')).toEqual({ skip: 'no company domain' });
    expect(guessDomain('example.com')).toEqual({ skip: 'a reserved example domain' });
    expect(guessDomain('10.0.0.1')).toEqual({ skip: 'no company domain' });
    expect(guessDomain('')).toEqual({ skip: 'no company domain' });
    expect(guessDomain(undefined)).toEqual({ skip: 'no company domain' });
  });

  it('knows disposable domains and their subdomains from the mailchecker list', () => {
    expect(isDisposableDomain('mailinator.com')).toBe(true);
    expect(isDisposableDomain('MAILINATOR.COM')).toBe(true);
    expect(isDisposableDomain('team.mailinator.com')).toBe(true);
    expect(isDisposableDomain('10minutemail.com')).toBe(true);
    expect(isDisposableDomain('acme.dev')).toBe(false);
    expect(isDisposableDomain('mailinator.com.acme.dev')).toBe(false);
  });

  it('finds nobody without a usable domain, without a DNS lookup or a check', async () => {
    const w = makeWorld();
    addVerifier(w, 'testverifier');
    const resolveMx = vi.fn(async () => MX);
    w.ctx.dns = { ...w.ctx.dns, resolveMx };
    const f = finder(w);
    for (const domain of ['', 'gmail.com', 'mailinator.com', 'acme.example', 'not a domain']) expect(await f.find(input({ domain }))).toBeNull();
    expect(await f.find({ ...input(), domain: undefined })).toBeNull();
    expect(await f.find(input({ firstName: '李', lastName: '王' }))).toBeNull();
    expect(resolveMx).not.toHaveBeenCalled();
    expect(checked.testverifier).toBeUndefined();
  });

  it('finds nobody at a domain with no mail server (no domain, no MX, null MX)', async () => {
    const w = makeWorld();
    addVerifier(w, 'testverifier');
    mx(w, {
      'nomx.dev': Object.assign(new Error('queryMx ENODATA nomx.dev'), { code: 'ENODATA' }),
      'nullmx.dev': [{ exchange: '', priority: 0 }],
      'dotmx.dev': [{ exchange: '.', priority: 0 }],
      'empty.dev': [],
    });
    const f = finder(w);
    for (const domain of ['gone.dev', 'nomx.dev', 'nullmx.dev', 'dotmx.dev', 'empty.dev']) expect(await f.find(input({ domain }))).toBeNull();
    expect(checked.testverifier).toBeUndefined();
  });

  it('treats a failed MX lookup as a temporary error', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': Object.assign(new Error('queryMx ETIMEOUT acme.dev'), { code: 'ETIMEOUT' }) });
    const e = await failure(finder(w).find(input()));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.code).toBe('UNAVAILABLE');
    expect(e.message).toBe('Pattern finder: could not look up the mail servers of acme.dev (ETIMEOUT)');
  });
});

describe('Pattern finder: without a verifier', () => {
  it('returns the commonest pattern unverified, never valid or risky', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    const r = await finder(w).find(input());
    expect(r).toEqual({ email: 'ann.smith@acme.dev', status: 'unknown', reason: 'Pattern finder: the most likely pattern (first.last), not verified: no email verifier is connected', credits: 0 });
  });

  it('ignores the built-in simulator and disabled verifiers', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    createIntegration(w.ctx, w.workspaceId, { kind: 'email_verifier', provider: 'simulated' });
    createIntegration(w.ctx, w.workspaceId, { kind: 'email_verifier', provider: 'testverifier', enabled: false });
    const r = await finder(w).find(input());
    expect(r?.status).toBe('unknown');
    expect(checked.testverifier).toBeUndefined();
  });
});

describe('Pattern finder: checking guesses', () => {
  it('tests for catch-all first, then checks guesses in order and stops at the first valid one', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    addVerifier(w, 'testverifier');
    verdicts.testverifier = accepts('asmith@acme.dev');
    const r = await finder(w).find(input());
    expect(r).toEqual({ email: 'asmith@acme.dev', status: 'valid', reason: 'Pattern finder (flast): Test: the mailbox exists', credits: 0, verified: true });
    expect(checked.testverifier).toHaveLength(4);
    expect(checked.testverifier[0]).toMatch(/^[a-z][a-z0-9]{15}@acme\.dev$/);
    expect(checked.testverifier.slice(1)).toEqual(['ann.smith@acme.dev', 'ann@acme.dev', 'asmith@acme.dev']);
  });

  it('returns the top guess as risky on a catch-all domain without checking the rest, and remembers the domain', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    addVerifier(w, 'testverifier');
    verdicts.testverifier = () => valid();
    const f = finder(w);
    const r = await f.find(input());
    expect(r).toEqual({
      email: 'ann.smith@acme.dev',
      status: 'risky',
      reason: "Pattern finder: acme.dev accepts mail for any address (catch-all), so the most likely pattern (first.last) can't be confirmed",
      credits: 0,
      verified: true,
    });
    expect(checked.testverifier).toHaveLength(1);
    // A verifier's own "accept-all" answer to the made-up address means the same.
    forgetPatternCaches();
    verdicts.testverifier = () => risky();
    expect((await f.find(input()))?.status).toBe('risky');
    expect(checked.testverifier).toHaveLength(2);
    // The next lead at the same company: no check at all.
    expect((await f.find(input({ firstName: 'Bob', lastName: 'Jones' })))?.email).toBe('bob.jones@acme.dev');
    expect(checked.testverifier).toHaveLength(2);
  });

  it('remembers a risky answer to the made-up address only briefly (it may be greylisting), a valid one for a day', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX, 'other.dev': MX });
    addVerifier(w, 'testverifier');
    const f = finder(w);
    verdicts.testverifier = () => risky();
    expect((await f.find(input()))?.status).toBe('risky');
    expect(checked.testverifier).toHaveLength(1);
    // 31 minutes later the domain is tested again: the server now refuses made-up addresses, and the guesses get checked.
    w.ctx.clock.advance(31 * 60_000);
    verdicts.testverifier = accepts('ann.smith@acme.dev');
    expect(await f.find(input())).toMatchObject({ email: 'ann.smith@acme.dev', status: 'valid' });
    expect(checked.testverifier).toHaveLength(3);
    // A made-up address called valid: still catch-all hours later, with no check.
    verdicts.testverifier = () => valid();
    expect((await f.find(input({ domain: 'other.dev' })))?.status).toBe('risky');
    w.ctx.clock.advance(12 * 3_600_000);
    expect((await f.find(input({ firstName: 'Bob', lastName: 'Jones', domain: 'other.dev' })))?.status).toBe('risky');
    expect(checked.testverifier).toHaveLength(4);
  });

  it('spends no checks when verification of found addresses is off, and returns the top guess unverified', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    addVerifier(w, 'testverifier');
    const r = await finder(w).find({ ...input(), verify: false });
    expect(r).toEqual({ email: 'ann.smith@acme.dev', status: 'unknown', reason: 'Pattern finder: the most likely pattern (first.last), not verified: verification of found addresses is off', credits: 0 });
    expect(checked.testverifier).toBeUndefined();
  });

  it('stops at the per-lead cap (default 6, the catch-all test included) and finds nobody when every guess is refused', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    addVerifier(w, 'testverifier');
    expect(await finder(w).find(input())).toBeNull();
    expect(checked.testverifier).toHaveLength(DEFAULT_MAX_PROBES);
    expect(checked.testverifier.slice(1)).toEqual(['ann.smith@acme.dev', 'ann@acme.dev', 'asmith@acme.dev', 'annsmith@acme.dev', 'a.smith@acme.dev']);
  });

  it('uses the cap from the settings, and a domain known not to be catch-all skips the test', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    addVerifier(w, 'testverifier');
    const f = finder(w, { maxProbes: '3' });
    expect(await f.find(input())).toBeNull();
    expect(checked.testverifier).toHaveLength(3);
    // acme.dev refused the made-up address: the next lead's three checks all go to guesses.
    expect(await f.find(input({ firstName: 'Bob', lastName: 'Jones' }))).toBeNull();
    expect(checked.testverifier.slice(3)).toEqual(['bob.jones@acme.dev', 'bob@acme.dev', 'bjones@acme.dev']);
  });

  it('checks the pattern confirmed at a domain first for the next lead there', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX, 'other.dev': MX });
    addVerifier(w, 'testverifier');
    verdicts.testverifier = accepts('asmith@acme.dev', 'bjones@acme.dev', 'bob.jones@other.dev');
    const f = finder(w);
    expect((await f.find(input()))?.email).toBe('asmith@acme.dev');
    checked.testverifier = [];
    expect(await f.find(input({ firstName: 'Bob', lastName: 'Jones' }))).toMatchObject({ email: 'bjones@acme.dev', status: 'valid' });
    expect(checked.testverifier).toEqual(['bjones@acme.dev']);
    // Another domain, and another workspace, learn on their own.
    checked.testverifier = [];
    expect((await f.find(input({ firstName: 'Bob', lastName: 'Jones', domain: 'other.dev' })))?.email).toBe('bob.jones@other.dev');
    expect(checked.testverifier).toHaveLength(2);
    const other = w.ctx.db.insert('workspaces', { name: 'Other', created_at: w.ctx.clock.now() });
    createIntegration(w.ctx, other, { kind: 'email_verifier', provider: 'testverifier' });
    checked.testverifier = [];
    expect((await finder(w, {}, other).find(input({ firstName: 'Bob', lastName: 'Jones' })))?.email).toBe('bjones@acme.dev');
    expect(checked.testverifier.slice(1)).toEqual(['bob.jones@acme.dev', 'bob@acme.dev', 'bjones@acme.dev']);
  });

  it('keeps the best maybe (risky over unknown) when nothing is confirmed on a domain that refuses made-up addresses', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    addVerifier(w, 'testverifier');
    verdicts.testverifier = (email) => (email === 'ann@acme.dev' ? unknown() : email === 'asmith@acme.dev' ? risky() : invalid());
    expect(await finder(w).find(input())).toEqual({ email: 'asmith@acme.dev', status: 'risky', reason: 'Pattern finder (flast): Test: accept-all', credits: 0, verified: true });
    forgetPatternCaches();
    verdicts.testverifier = (email) => (email === 'ann@acme.dev' ? unknown() : invalid());
    expect(await finder(w).find(input())).toMatchObject({ email: 'ann@acme.dev', status: 'unknown', verified: true });
  });

  it('stops checking when the time budget runs out', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    addVerifier(w, 'testverifier');
    let t = 0;
    limits.now = () => t;
    limits.budgetMs = 100_000;
    verdicts.testverifier = () => {
      t += 45_000; // each check takes 45 s
      return invalid();
    };
    expect(await finder(w).find(input())).toBeNull();
    expect(checked.testverifier).toHaveLength(3);
  });
});

describe('Pattern finder: the verifier chain and errors', () => {
  it('moves to the next verifier when one cannot judge the domain, and stays unverified when none can', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    addVerifier(w, 'testverifier');
    addVerifier(w, 'testverifier2');
    verdicts.testverifier = () => unknown();
    verdicts.testverifier2 = accepts('ann@acme.dev');
    expect(await finder(w).find(input())).toMatchObject({ email: 'ann@acme.dev', status: 'valid', reason: 'Pattern finder (first): Test: the mailbox exists' });
    expect(checked.testverifier).toHaveLength(1);
    expect(checked.testverifier2).toHaveLength(3);

    forgetPatternCaches();
    verdicts.testverifier2 = () => unknown('Second');
    expect(await finder(w).find(input())).toEqual({ email: 'ann.smith@acme.dev', status: 'unknown', reason: 'Pattern finder: the most likely pattern (first.last), not verified: Second: port 25 is blocked', credits: 0 });
    expect(checked.testverifier2).toHaveLength(4);
  });

  it('flags a verifier with a bad key and carries on with the next one', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    const bad = addVerifier(w, 'testverifier');
    addVerifier(w, 'testverifier2');
    verdicts.testverifier = (_e, integrationId) => {
      throw new ProviderError('AUTH', 'Test Verifier rejected the key', { integrationId });
    };
    verdicts.testverifier2 = accepts('ann.smith@acme.dev');
    expect(await finder(w).find(input())).toMatchObject({ email: 'ann.smith@acme.dev', status: 'valid' });
    expect(checked.testverifier).toHaveLength(1);
    expect(loadIntegration(w.ctx, w.workspaceId, bad.id)).toMatchObject({ last_status: 'error', last_message: 'Test Verifier rejected the key' });
    expect(monthlyUsage(w.ctx, w.workspaceId, month(w))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'email_verifier', provider: 'testverifier', calls: 1, credits: 0 }),
        expect.objectContaining({ kind: 'email_verifier', provider: 'testverifier2', calls: 2 }),
      ]),
    );
  });

  it('switches verifiers mid-way when one fails, and leaves the next guess unverified when all have failed', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    addVerifier(w, 'testverifier');
    let n = 0;
    verdicts.testverifier = (_e, integrationId) => {
      if (++n > 2) throw new ProviderError('QUOTA', 'Test Verifier: no credits left', { integrationId });
      return invalid();
    };
    expect(await finder(w).find(input())).toEqual({ email: 'ann@acme.dev', status: 'unknown', reason: 'Pattern finder: the most likely pattern (first), not verified: Test Verifier: no credits left', credits: 0 });
    expect(checked.testverifier).toHaveLength(3);
  });

  it('throws a temporary error (retried later) when every verifier is down', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    addVerifier(w, 'testverifier');
    verdicts.testverifier = (_e, integrationId) => {
      throw new ProviderError('TIMEOUT', 'The verifier did not answer in time', { integrationId });
    };
    const e = await failure(finder(w).find(input()));
    expect(e.code).toBe('TIMEOUT');
    expect(e.message).toBe('Pattern finder: could not check guesses: The verifier did not answer in time');
  });

  it('passes rate limits on, so the job waits and retries', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    addVerifier(w, 'testverifier');
    addVerifier(w, 'testverifier2');
    verdicts.testverifier = () => {
      throw new ProviderError('RATE_LIMIT', 'slow down', { retryAfterMs: 30_000 });
    };
    const e = await failure(finder(w).find(input()));
    expect(e.code).toBe('RATE_LIMIT');
    expect(checked.testverifier2).toBeUndefined();
  });

  it('charges paid verifier checks to the plan and stays unverified once the credits run out', async () => {
    const w = makeWorld();
    w.ctx.stripe = {} as any;
    w.ctx.config.plans = parsePlans(JSON.stringify([{ id: 'free', name: 'Free', default: true, limits: { enrichmentCreditsMonthly: 0 } }]), 'test');
    mx(w, { 'acme.dev': MX });
    addVerifier(w, 'hunter', { apiKey: 'hunter-test-key-1234567' });
    const fetch = (w.ctx.fetch = fakeFetch([{ url: /api\.hunter\.io\/v2\/email-verifier/, reply: () => ({ json: { data: { status: 'valid' } } }) }]));
    const r = await finder(w).find(input());
    expect(r).toMatchObject({ email: 'ann.smith@acme.dev', status: 'unknown' });
    expect(r?.reason).toMatch(/^Pattern finder: the most likely pattern \(first\.last\), not verified: .+/);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('Pattern finder: settings and connection test', () => {
  it('is free, has one optional setting, and validates it', async () => {
    const def = providerDef('email_finder', 'pattern')!;
    expect(def).toBe(patternFinder);
    expect(def.fields.map((f) => f.key)).toEqual(['maxProbes']);
    expect(def.settings.parse({})).toEqual({});
    expect(def.settings.parse({ maxProbes: '4' })).toEqual({ maxProbes: 4 });
    for (const bad of [1, 21, 2.5, 'many']) expect(def.settings.safeParse({ maxProbes: bad }).success).toBe(false);
    const w = makeWorld();
    expect(() => createIntegration(w.ctx, w.workspaceId, { kind: 'email_finder', provider: 'pattern', settings: { maxProbes: 50 } })).toThrow(/at most 20/);
    const f = finder(w);
    expect(f.free).toBe(true);
    expect(f.simulated).toBe(false);
  });

  it('says which verifiers will check its guesses', async () => {
    const w = makeWorld();
    const f = finder(w, { maxProbes: 4 });
    expect(await f.test()).toEqual({ ok: true, message: expect.stringMatching(/^Ready, but no email verifier is connected/) });
    addVerifier(w, 'testverifier');
    addVerifier(w, 'testverifier2');
    expect(await f.test()).toEqual({ ok: true, message: 'Ready: checks guesses with Test Verifier, then Second Verifier, at most 4 checks per lead. Nothing to sign in to.' });
  });

  it('can be added from the integrations API with no credentials', async () => {
    const api = await makeApi();
    await api.register();
    const providers = (await api.call('GET', '/api/integrations/providers')).body;
    expect(providers.find((p: any) => p.kind === 'email_finder' && p.id === 'pattern')).toMatchObject({ label: 'Pattern finder (free)' });
    const created = await api.call('POST', '/api/integrations', { kind: 'email_finder', provider: 'pattern', settings: { maxProbes: 8 } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ provider: 'pattern', settings: { maxProbes: 8 }, hasCredentials: false });
  });
});

describe('Pattern finder: in the waterfall', () => {
  it('finds and verifies with the self-hosted verifier end to end, at no credit cost, without checking the address twice', async () => {
    const w = makeWorld();
    w.ctx.stripe = {} as any;
    w.ctx.config.plans = parsePlans(JSON.stringify([{ id: 'free', name: 'Free', default: true, limits: { enrichmentCreditsMonthly: 0 } }]), 'test');
    mx(w, { 'acme.dev': MX });
    w.ctx.dns = { ...w.ctx.dns, lookup: async () => [{ address: '93.184.216.34', family: 4 }] };
    createIntegration(w.ctx, w.workspaceId, { kind: 'email_finder', provider: 'pattern' });
    // A hosted install: the verifier must be on a public host (checked through the faked DNS).
    addVerifier(w, 'aftership', {}, { baseUrl: 'https://verify.example.com' });
    const fetch = (w.ctx.fetch = fakeFetch([
      {
        url: /^https:\/\/verify\.example\.com\/v1\/.+\/verification$/,
        reply: (req) => {
          const email = decodeURIComponent(new URL(req.url).pathname.split('/')[2]);
          const ok = email === 'first0.last@acme.dev';
          return { json: { email, reachable: ok ? 'yes' : 'no', syntax: { valid: true }, smtp: { host_exists: true, catch_all: false, deliverable: ok }, has_mx_records: true } };
        },
      },
    ]));
    const [id] = addLeads(w, 1);
    w.ctx.db.run("UPDATE leads SET company_domain = 'acme.dev' WHERE id = ?", [id]);
    startEnrichmentRun(w.ctx, w.workspaceId, null, [id], { find: true, verify: true, company: false, overwrite: false });
    await drainJobs(w);
    expect(lead(w, id)).toMatchObject({ email: 'first0.last@acme.dev', email_source: 'pattern', email_status: 'valid' });
    expect(lead(w, id).email_status_reason).toBe('Pattern finder (first.last): Self-hosted verifier: the mail server accepted this mailbox');
    // The catch-all test and one guess; the waterfall trusts the verifier's answer and doesn't ask again.
    expect(fetch.calls).toHaveLength(2);
    const usage = monthlyUsage(w.ctx, w.workspaceId, month(w));
    expect(usage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'email_finder', provider: 'pattern', operation: 'finder.find', calls: 1, credits: 0 }),
        expect.objectContaining({ kind: 'email_verifier', provider: 'aftership', operation: 'verifier.verify', calls: 2, credits: 0 }),
      ]),
    );
  });

  it('charges each paid check like any other verification', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    createIntegration(w.ctx, w.workspaceId, { kind: 'email_finder', provider: 'pattern' });
    addVerifier(w, 'hunter', { apiKey: 'hunter-test-key-1234567' });
    w.ctx.fetch = fakeFetch([
      { url: /api\.hunter\.io\/v2\/email-verifier/, reply: (req) => ({ json: { data: { status: new URL(req.url).searchParams.get('email') === 'ann@acme.dev' ? 'valid' : 'invalid' } } }) },
    ]);
    const [id] = addLeads(w, 1);
    w.ctx.db.run("UPDATE leads SET first_name = 'Ann', last_name = 'Smith', company_domain = 'acme.dev' WHERE id = ?", [id]);
    const r = await findEmailWaterfall(w.ctx, w.workspaceId, lead(w, id), { verify: true, settings: enrichmentSettings(w.ctx, w.workspaceId) });
    expect(r).toMatchObject({ email: 'ann@acme.dev', status: 'valid', source: 'pattern', accepted: true });
    expect(monthlyUsage(w.ctx, w.workspaceId, month(w))).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'email_verifier', provider: 'hunter', calls: 3, credits: 3 })]));
  });

  it('makes no verifier checks for a find-only run or a workspace that does not verify found addresses', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    createIntegration(w.ctx, w.workspaceId, { kind: 'email_finder', provider: 'pattern' });
    addVerifier(w, 'testverifier');
    const [id] = addLeads(w, 1);
    w.ctx.db.run("UPDATE leads SET first_name = 'Ann', last_name = 'Smith', company_domain = 'acme.dev' WHERE id = ?", [id]);
    const settings = enrichmentSettings(w.ctx, w.workspaceId);
    let r = await findEmailWaterfall(w.ctx, w.workspaceId, lead(w, id), { verify: false, settings });
    expect(r).toMatchObject({ email: 'ann.smith@acme.dev', status: 'unknown', source: 'pattern', accepted: false });
    r = await findEmailWaterfall(w.ctx, w.workspaceId, lead(w, id), { verify: true, settings: { ...settings, verifyFound: false } });
    expect(r).toMatchObject({ email: 'ann.smith@acme.dev', status: 'unknown', source: 'pattern', accepted: false });
    expect(checked.testverifier).toBeUndefined();
    expect(monthlyUsage(w.ctx, w.workspaceId, month(w)).filter((u) => u.kind === 'email_verifier')).toEqual([]);
  });

  it('leaves an unverified guess behind a finder that finds a verified address', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    createIntegration(w.ctx, w.workspaceId, { kind: 'email_finder', provider: 'pattern' });
    createIntegration(w.ctx, w.workspaceId, { kind: 'email_finder', provider: 'hunter', credentials: { apiKey: 'hunter-test-key-1234567' } });
    w.ctx.fetch = fakeFetch([{ url: /api\.hunter\.io\/v2\/email-finder/, reply: () => ({ json: { data: { email: 'a.smith@acme.dev', score: 90, verification: { status: 'valid' } } } }) }]);
    const [id] = addLeads(w, 1);
    w.ctx.db.run("UPDATE leads SET first_name = 'Ann', last_name = 'Smith', company_domain = 'acme.dev' WHERE id = ?", [id]);
    const r = await findEmailWaterfall(w.ctx, w.workspaceId, lead(w, id), { verify: true, settings: enrichmentSettings(w.ctx, w.workspaceId) });
    expect(r).toMatchObject({ email: 'a.smith@acme.dev', status: 'valid', source: 'hunter', accepted: true });
    expect(r.tried).toEqual([
      { provider: 'Pattern finder (free)', result: 'found', detail: 'ann.smith@acme.dev (unknown)' },
      { provider: 'Hunter', result: 'found', detail: 'a.smith@acme.dev (valid)' },
    ]);
  });

  it('keeps its unverified guess when nothing better turns up, and never lets it through as verified', async () => {
    const w = makeWorld();
    mx(w, { 'acme.dev': MX });
    createIntegration(w.ctx, w.workspaceId, { kind: 'email_finder', provider: 'pattern' });
    const [id] = addLeads(w, 1);
    w.ctx.db.run("UPDATE leads SET first_name = 'Ann', last_name = 'Smith', company_domain = 'acme.dev' WHERE id = ?", [id]);
    const settings = { ...enrichmentSettings(w.ctx, w.workspaceId), acceptRisky: true };
    const r = await findEmailWaterfall(w.ctx, w.workspaceId, lead(w, id), { verify: true, settings });
    expect(r).toMatchObject({ email: 'ann.smith@acme.dev', status: 'unknown', source: 'pattern', accepted: false });
  });
});
