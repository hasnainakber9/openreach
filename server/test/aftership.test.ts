import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePlans } from '../src/billing/plans.js';
import { afterShipVerdict, DEFAULT_BASE_URL, limits, SYNTAX_INVALID_TEXT, VERIFY_TIMEOUT_MS } from '../src/providers/data/aftership.js';
import { ProviderError, RateLimiter } from '../src/providers/http.js';
import { createIntegration } from '../src/providers/store.js';
import { startEnrichmentRun } from '../src/services/enrichment.js';
import { monthlyUsage } from '../src/services/usage.js';
import type { LeadRow } from '../src/types.js';
import { addLeads, drainJobs, fakeFetch, makeApi, makeWorld, type FakeRoute, type World } from './helpers.js';

// The self-hosted AfterShip email-verifier: status mapping, the plain-text syntax reply, errors, timeouts, the
// shared secret, hosts and the connection test. Every HTTP call and DNS answer is a fake; nothing touches the network.

const SECRET = 'verifier-SECRET-0123456789';
const PUBLIC_IP = '93.184.216.34';

// What the library's Result looks like (fields from email-verifier's verifier.go / smtp.go).
const result = (o: Record<string, unknown> = {}) => ({
  email: 'ann@acme.dev',
  reachable: 'yes',
  syntax: { username: 'ann', domain: 'acme.dev', valid: true },
  smtp: { host_exists: true, full_inbox: false, catch_all: false, deliverable: true, disabled: false },
  gravatar: null,
  suggestion: '',
  disposable: false,
  role_account: false,
  free: false,
  has_mx_records: true,
  ...o,
});

function verifier(w: World, settings: Record<string, unknown> = {}, credentials: Record<string, string> = {}) {
  const row = createIntegration(w.ctx, w.workspaceId, { kind: 'email_verifier', provider: 'aftership', credentials, settings });
  return () => w.ctx.providers.instance<'email_verifier'>(row)!;
}

const answers = (reply: FakeRoute['reply']) => fakeFetch([{ method: 'GET', url: /\/v1\/.+\/verification$/, reply }]);

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error('expected a failure');
};

beforeEach(() => {
  limits.verifier = new RateLimiter(10_000, 10_000);
});
afterEach(() => vi.restoreAllMocks());

describe('AfterShip verifier: status mapping', () => {
  it('maps every verdict to valid / risky / invalid / unknown with a reason', () => {
    const cases: [unknown, string, RegExp][] = [
      [result(), 'valid', /accepted this mailbox$/],
      [result({ role_account: true, free: true }), 'valid', /accepted this mailbox \(role address, free mail provider\)$/],
      [result({ reachable: 'unknown', smtp: { host_exists: true, deliverable: true } }), 'valid', /accepted/],
      // Syntax and throwaway domains first, whatever else the answer says.
      [SYNTAX_INVALID_TEXT, 'invalid', /syntax is invalid/],
      ['  Email Address Syntax Is Invalid\n', 'invalid', /syntax is invalid/],
      [result({ reachable: 'unknown', syntax: { valid: false }, smtp: null }), 'invalid', /syntax is invalid/],
      [result({ reachable: 'yes', disposable: true }), 'invalid', /disposable/],
      // reachable "no": no mail server, or the server refused the mailbox.
      [result({ reachable: 'no', has_mx_records: false, smtp: null, error: 'lookup acme.dev: no such host' }), 'invalid', /no mail server/],
      [result({ reachable: 'no', smtp: { host_exists: true, deliverable: false } }), 'invalid', /refused this mailbox$/],
      [result({ reachable: 'no', smtp: { host_exists: true, deliverable: false, disabled: true } }), 'invalid', /disabled/],
      [result({ reachable: 'no', smtp: { host_exists: true, deliverable: false, full_inbox: true } }), 'invalid', /inbox full/],
      [result({ reachable: 'unknown', smtp: { host_exists: true, catch_all: false, deliverable: false } }), 'invalid', /refused this mailbox/],
      [result({ reachable: 'unknown', has_mx_records: false, smtp: null }), 'invalid', /no mail server/],
      // catch_all: the made-up address wasn't turned away (a catch-all, or greylisting / a block / a timeout).
      [result({ reachable: 'unknown', smtp: { host_exists: true, catch_all: true, deliverable: false } }), 'risky', /didn't turn away a made-up address.*catch-all/],
      [result({ reachable: 'unknown', role_account: true, smtp: { host_exists: true, catch_all: true } }), 'risky', /catch-all.*\(role address\)$/],
      // The probe refused as "not allowed" (554) or "out of space" (452/552): about the probe, not this mailbox.
      [result({ reachable: 'unknown', smtp: { host_exists: true, catch_all: true, deliverable: false, disabled: true } }), 'unknown', /refused the verifier's test address/],
      [result({ reachable: 'unknown', smtp: { host_exists: true, catch_all: true, deliverable: false, full_inbox: true } }), 'unknown', /refused the verifier's test address/],
      // Probe off (DisableCatchAllCheck): v1.5.0 leaves catch_all true on every answer, so an accepted mailbox is valid.
      [result({ reachable: 'yes', smtp: { host_exists: true, catch_all: true, deliverable: true } }), 'valid', /accepted this mailbox$/],
      // A check that could not finish (port 25 blocked, a 4xx/5xx greeting...) is unknown, with the reason.
      [result({ reachable: 'unknown', smtp: { host_exists: false, catch_all: false, deliverable: false }, error: 'Mail server is unavailable: dial tcp 1.2.3.4:25: i/o timeout' }), 'unknown', /check not possible: Mail server is unavailable: dial tcp 1\.2\.3\.4:25: i\/o timeout$/],
      [result({ reachable: 'unknown', smtp: { host_exists: true, catch_all: true }, error: 'timeout' }), 'unknown', /check not possible: timeout/],
      [result({ reachable: 'unknown', smtp: null }), 'unknown', /SMTP check is off/],
      [result({ reachable: 'maybe', smtp: { host_exists: true } }), 'unknown', /no clear answer \(reachable: maybe\)/],
      ['<html>hello</html>', 'unknown', /unexpected answer/],
      [null, 'unknown', /unexpected answer/],
      [[1, 2], 'unknown', /unexpected answer/],
    ];
    for (const [raw, status, reason] of cases) {
      const v = afterShipVerdict(raw);
      expect(v.status, JSON.stringify(raw)).toBe(status);
      expect(v.reason, JSON.stringify(raw)).toMatch(/^Self-hosted verifier: /);
      expect(v.reason, JSON.stringify(raw)).toMatch(reason);
    }
  });

  it('keeps error reasons to one short line without secrets', () => {
    const v = afterShipVerdict(result({ reachable: 'unknown', error: `550\r\n5.7.1 blocked ${SECRET} ${'x'.repeat(400)}` }), [SECRET]);
    expect(v.status).toBe('unknown');
    expect(v.reason).not.toContain(SECRET);
    expect(v.reason).not.toMatch(/[\r\n]/);
    expect(v.reason.length).toBeLessThan(260);
  });
});

describe('AfterShip verifier: checks', () => {
  it('asks the verifier on 127.0.0.1:8080 by default, with the address in the path and the secret in a header', async () => {
    const w = makeWorld();
    const v = verifier(w, {}, { secret: SECRET });
    const fetch = (w.ctx.fetch = answers(() => ({ json: result() })));
    expect(await v().verify(' ann+news@acme.dev ')).toEqual({ status: 'valid', reason: 'Self-hosted verifier: the mail server accepted this mailbox', credits: 0 });
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].url).toBe(`${DEFAULT_BASE_URL}/v1/ann%2Bnews%40acme.dev/verification`);
    expect(fetch.calls[0].headers['x-verifier-secret']).toBe(SECRET);
    expect(v().free).toBe(true);
    // One check a second per verifier URL, shared by every workspace using it: the next one has to wait.
    limits.verifier = new RateLimiter(1, 1, () => 0);
    await v().verify('ann@acme.dev');
    expect(limits.verifier.reserve(`aftership:${DEFAULT_BASE_URL}`)).toBe(1000);
    expect(v().simulated).toBe(false);
  });

  it('sends no secret header when none is set, and uses a custom URL without its trailing slash', async () => {
    const w = makeWorld();
    const v = verifier(w, { baseUrl: 'http://192.168.1.20:9000/verifier/' });
    const fetch = (w.ctx.fetch = answers(() => ({ json: result({ reachable: 'unknown', smtp: { host_exists: true, catch_all: true } }) })));
    expect((await v().verify('ann@acme.dev')).status).toBe('risky');
    expect(fetch.calls[0].url).toBe('http://192.168.1.20:9000/verifier/v1/ann%40acme.dev/verification');
    expect(fetch.calls[0].headers).not.toHaveProperty('x-verifier-secret');
  });

  it('handles the stock apiserver: plain-text syntax reply, and SMTP off', async () => {
    const w = makeWorld();
    const v = verifier(w);
    w.ctx.fetch = answers(() => ({ text: SYNTAX_INVALID_TEXT }));
    expect(await v().verify('ann@@acme')).toEqual({ status: 'invalid', reason: 'Self-hosted verifier: the address syntax is invalid', credits: 0 });
    w.ctx.fetch = answers(() => ({ json: result({ reachable: 'unknown', smtp: null }) }));
    expect((await v().verify('ann@acme.dev')).status).toBe('unknown');
  });

  it('reads the stock apiserver’s 500 for a domain that does not exist as invalid, and retries other 500s', async () => {
    const w = makeWorld();
    const v = verifier(w);
    // http.Error(w, err.Error(), 500) for v1.5.0's ErrNoSuchHost.
    w.ctx.fetch = answers(() => ({ status: 500, text: 'Mail server does not exist : lookup acme.dve on 192.168.1.1:53: no such host\n' }));
    expect(await v().verify('ann@acme.dve')).toEqual({ status: 'invalid', reason: 'Self-hosted verifier: the domain has no mail server', credits: 0 });
    w.ctx.fetch = answers(() => ({ status: 500, text: 'lookup acme.dev on 192.168.1.1:53: server misbehaving\n' }));
    const e = await failure(v().verify('ann@acme.dev'));
    expect([e.code, e.status]).toEqual(['UNAVAILABLE', 500]);
    // Only a 500 carries that meaning: a proxy's 502 with the same text doesn't.
    w.ctx.fetch = answers(() => ({ status: 502, text: 'Mail server does not exist : lookup x: no such host' }));
    expect((await failure(v().verify('ann@acme.dev'))).code).toBe('UNAVAILABLE');
  });

  it('records why a check could not finish (port 25 blocked) as unknown', async () => {
    const w = makeWorld();
    const v = verifier(w);
    w.ctx.fetch = answers(() => ({ json: result({ reachable: 'unknown', smtp: { host_exists: false }, error: 'Mail server is unavailable: dial tcp: i/o timeout' }) }));
    expect(await v().verify('ann@acme.dev')).toEqual({ status: 'unknown', reason: 'Self-hosted verifier: check not possible: Mail server is unavailable: dial tcp: i/o timeout', credits: 0 });
  });

  it('judges plainly malformed addresses itself, without a request', async () => {
    const w = makeWorld();
    const v = verifier(w);
    const fetch = (w.ctx.fetch = answers(() => ({ json: result() })));
    for (const email of ['', 'no-at-sign', '@acme.dev', 'ann@', 'ann smith@acme.dev', `${'a'.repeat(250)}@acme.dev`]) expect((await v().verify(email)).status, email).toBe('invalid');
    // A "/" would split the address in the verifier's router, so it isn't sent.
    expect(await v().verify('a/b@acme.dev')).toEqual({ status: 'unknown', reason: 'Self-hosted verifier: addresses containing "/" can\'t be checked by this verifier', credits: 0 });
    expect(fetch.calls).toEqual([]);
  });

  it('refuses an answer that is not the verifier’s (wrong URL)', async () => {
    const w = makeWorld();
    const v = verifier(w);
    for (const reply of [{ text: '<html>router login</html>' }, { json: { hello: 'world' } }, { text: '' }]) {
      w.ctx.fetch = answers(() => reply);
      const e = await failure(v().verify('ann@acme.dev'));
      expect(e.code).toBe('BAD_REQUEST');
      expect(e.message).toBe('The server at 127.0.0.1:8080 did not answer like AfterShip email-verifier: check the URL.');
    }
  });
});

describe('AfterShip verifier: errors', () => {
  it('maps every status to a provider error without leaking the secret', async () => {
    const w = makeWorld();
    const v = verifier(w, {}, { secret: SECRET });
    const cases: [number, string, RegExp, Record<string, string>?][] = [
      [401, 'AUTH', /refused the shared secret \(401\)/],
      [403, 'AUTH', /refused the shared secret \(403\)/],
      [404, 'NOT_FOUND', /No email-verifier API at http:\/\/127\.0\.0\.1:8080: check the URL/],
      [429, 'RATE_LIMIT', /rate limiting/, { 'retry-after': '7' }],
      [500, 'UNAVAILABLE', /could not finish the check \(500\)/],
      [502, 'UNAVAILABLE', /server error \(502\)/],
      [400, 'BAD_REQUEST', /refused the request \(400\)/],
    ];
    for (const [status, code, message, headers] of cases) {
      w.ctx.fetch = answers(() => ({ status, headers, json: { error: `nope ${SECRET}` } }));
      const e = await failure(v().verify('ann@acme.dev'));
      expect(e).toBeInstanceOf(ProviderError);
      expect([status, e.code]).toEqual([status, code]);
      expect(e.message).toMatch(message);
      expect(e.message).not.toContain(SECRET);
      expect(e.integrationId).toBeTypeOf('number');
      if (status === 429) expect(e.retryAfterMs).toBe(7000);
    }
  });

  it('says when the verifier is not running', async () => {
    const w = makeWorld();
    const v = verifier(w);
    w.ctx.fetch = (async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:8080');
    }) as typeof fetch;
    const e = await failure(v().verify('ann@acme.dev'));
    expect([e.code, e.message]).toEqual(['UNAVAILABLE', 'Could not reach the verifier at 127.0.0.1:8080. Is it running?']);
    expect((await failure(v().test())).code).toBe('UNAVAILABLE');
  });

  it('waits 60 seconds for a check, then times out with the port 25 hint', async () => {
    const w = makeWorld();
    const v = verifier(w);
    const seen: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      seen.push(ms);
      return AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    });
    w.ctx.fetch = (async (_url: unknown, init: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      throw new Error('signal was not aborted');
    }) as typeof fetch;
    const e = await failure(v().verify('ann@acme.dev'));
    expect(seen).toEqual([VERIFY_TIMEOUT_MS]);
    expect(e.code).toBe('TIMEOUT');
    expect(e.message).toBe('The verifier at 127.0.0.1:8080 did not answer within 60 s. If outbound port 25 is blocked, its SMTP checks hang until they time out.');
    // The connection test gives up sooner.
    expect((await failure(v().test())).code).toBe('TIMEOUT');
    expect(seen[1]).toBe(10_000);
  });
});

describe('AfterShip verifier: connection test', () => {
  it('reads /healthz from the OpenReach build', async () => {
    const w = makeWorld();
    const v = verifier(w, {}, { secret: SECRET });
    const health = (json: unknown) => (w.ctx.fetch = fakeFetch([{ method: 'GET', url: /^http:\/\/127\.0\.0\.1:8080\/healthz$/, reply: () => ({ json }) }]));
    const fetch = health({ ok: true, service: 'email-verifier', smtp_check: true, catch_all_check: true });
    expect(await v().test()).toEqual({ ok: true, message: 'Connected to the verifier at 127.0.0.1:8080 · SMTP check on.' });
    expect(fetch.calls[0].headers['x-verifier-secret']).toBe(SECRET);
    health({ ok: true, smtp_check: true, catch_all_check: false });
    expect((await v().test()).message).toMatch(/Catch-all detection is off: catch-all domains look valid and refused mailboxes look risky/);
    health({ ok: true, smtp_check: false, catch_all_check: false });
    expect((await v().test()).message).toMatch(/SMTP check is off, so mailboxes stay unknown/);
    health({ status: 'up' });
    expect((await failure(v().test())).code).toBe('BAD_REQUEST');
  });

  it('falls back to a syntax-only check on the stock apiserver', async () => {
    const w = makeWorld();
    const v = verifier(w);
    const routes = (verification: FakeRoute['reply']) =>
      (w.ctx.fetch = fakeFetch([
        { method: 'GET', url: /\/healthz$/, reply: () => ({ status: 404, text: '404 page not found' }) },
        { method: 'GET', url: /\/v1\/openreach-connection-test\/verification$/, reply: verification },
      ]));
    const fetch = routes(() => ({ text: SYNTAX_INVALID_TEXT }));
    expect((await v().test()).message).toMatch(/^Connected to email-verifier at 127\.0\.0\.1:8080\. It looks like the stock apiserver/);
    expect(fetch.calls.map((c) => new URL(c.url).pathname)).toEqual(['/healthz', '/v1/openreach-connection-test/verification']);
    // Something else answering on that port.
    routes(() => ({ json: { ok: true } }));
    expect((await failure(v().test())).code).toBe('BAD_REQUEST');
    routes(() => ({ status: 404, text: 'nothing here' }));
    expect((await failure(v().test())).code).toBe('NOT_FOUND');
  });

  it('reports a wrong secret as an auth problem', async () => {
    const w = makeWorld();
    const v = verifier(w, {}, { secret: 'not-the-right-one' });
    w.ctx.fetch = fakeFetch([{ url: /healthz/, reply: () => ({ status: 401, json: { error: 'wrong or missing X-Verifier-Secret' } }) }]);
    const e = await failure(v().test());
    expect(e.code).toBe('AUTH');
    expect(e.message).toBe('The verifier at 127.0.0.1:8080 refused the shared secret (401). Use the VERIFIER_SECRET it was started with.');
  });
});

describe('AfterShip verifier: settings and hosts', () => {
  it('validates the URL and secret, stores the default URL, and lists its fields', async () => {
    const api = await makeApi();
    await api.register('Solo');
    const make = (body: Record<string, unknown>) => api.call('POST', '/api/integrations', { kind: 'email_verifier', provider: 'aftership', ...body });
    for (const baseUrl of ['ftp://127.0.0.1:8080', 'http://user:pw@127.0.0.1:8080', 'http://127.0.0.1:8080/?x=1', 'http://127.0.0.1:8080/#a', 'localhost:8080', 'x'.repeat(301)]) {
      const r = await make({ settings: { baseUrl } });
      expect(r.status, baseUrl).toBe(400);
      expect(r.body.error).toMatch(/^settings\.baseUrl: /);
    }
    expect((await make({ credentials: { secret: 'short' } })).status).toBe(400);
    const ok = await make({ credentials: { secret: SECRET } });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toEqual({ baseUrl: DEFAULT_BASE_URL });
    expect(ok.body.credentials).toEqual({ secret: '••••6789' });
    expect(ok.raw).not.toContain(SECRET);
    // The secret is never sent to a new host it wasn't entered for.
    const moved = await api.call('PATCH', `/api/integrations/${ok.body.id}`, { settings: { baseUrl: 'http://10.0.0.5:8080/' } });
    expect([moved.status, moved.body.error]).toEqual([400, 'credentials.secret: Enter it again for the new baseUrl']);
    const again = await api.call('PATCH', `/api/integrations/${ok.body.id}`, { settings: { baseUrl: 'http://10.0.0.5:8080/' }, credentials: { secret: SECRET } });
    expect(again.body.settings).toEqual({ baseUrl: 'http://10.0.0.5:8080' });

    const providers = (await api.call('GET', '/api/integrations/providers')).body;
    const def = (providers.providers ?? providers).find((d: any) => d.kind === 'email_verifier' && d.id === 'aftership');
    expect(def.label).toBe('Self-hosted verifier (AfterShip email-verifier)');
    expect(def.fields.map((f: any) => [f.key, f.type, !!f.secret])).toEqual([
      ['baseUrl', 'url', false],
      ['secret', 'password', true],
    ]);
  });

  it('allows loopback and LAN verifiers on self-hosted installs and refuses them on hosted ones', async () => {
    const api = await makeApi();
    await api.register('Hosted');
    api.w.ctx.stripe = {} as any;
    api.w.ctx.dns = { ...api.w.ctx.dns, lookup: async (h: string) => (h === 'verify.example.com' ? [{ address: PUBLIC_IP, family: 4 }] : [{ address: '127.0.0.1', family: 4 }]) } as any;
    for (const baseUrl of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://192.168.1.20:8080', 'http://[::1]:8080', 'http://169.254.169.254']) {
      const r = await api.call('POST', '/api/integrations', { kind: 'email_verifier', provider: 'aftership', settings: { baseUrl } });
      expect(r.status, baseUrl).toBe(400);
      expect(r.body.error).toMatch(/^settings\.baseUrl: .*private or local network/);
    }
    const ok = await api.call('POST', '/api/integrations', { kind: 'email_verifier', provider: 'aftership', settings: { baseUrl: 'https://verify.example.com' } });
    expect(ok.status).toBe(200);
  });

  it('checks the host before every request on a hosted install', async () => {
    const w = makeWorld();
    const v = verifier(w, { baseUrl: 'https://verify.example.com' });
    const fetch = (w.ctx.fetch = answers(() => ({ json: result() })));
    w.ctx.stripe = {} as any;
    let address = PUBLIC_IP;
    w.ctx.dns = { ...w.ctx.dns, lookup: async () => [{ address, family: 4 }] } as any;
    expect((await v().verify('ann@acme.dev')).status).toBe('valid');
    // The name now points at the server's own network (DNS rebinding): refused before any request.
    address = '10.0.0.7';
    const e = await failure(v().verify('ann@acme.dev'));
    expect(e.code).toBe('AUTH');
    expect(e.message).toMatch(/private or local network/);
    expect((await failure(v().test())).code).toBe('AUTH');
    expect(fetch.calls).toHaveLength(1);

    // The connection goes only to the address that was checked, so a name that answers differently by the time
    // fetch resolves it (rebinding between the check and the connection) can't redirect it.
    const w3 = makeWorld();
    const pinned = verifier(w3, { baseUrl: 'https://verify.example.com' });
    w3.ctx.stripe = {} as any;
    w3.ctx.dns = { ...w3.ctx.dns, lookup: async () => [{ address: PUBLIC_IP, family: 4 }] } as any;
    const inits: any[] = [];
    w3.ctx.fetch = (async (_url: unknown, init: any) => {
      inits.push(init);
      return new Response(JSON.stringify(result()), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    expect((await pinned().verify('ann@acme.dev')).status).toBe('valid');
    expect(inits[0].pinnedAddresses).toEqual([{ address: PUBLIC_IP, family: 4 }]);
    // Self-hosted installs (billing off) resolve the name as usual.
    const w4 = makeWorld();
    const plain = verifier(w4, { baseUrl: 'https://verify.example.com' });
    w4.ctx.fetch = (async (_url: unknown, init: any) => {
      inits.push(init);
      return new Response(JSON.stringify(result()), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await plain().verify('ann@acme.dev');
    expect(inits[1]).not.toHaveProperty('pinnedAddresses');

    // A saved default (127.0.0.1) on a hosted install never connects either.
    const w2 = makeWorld();
    const local = verifier(w2);
    w2.ctx.fetch = answers(() => ({ json: result() }));
    w2.ctx.stripe = {} as any;
    expect((await failure(local().verify('ann@acme.dev'))).code).toBe('AUTH');
  });
});

describe('AfterShip verifier: in an enrichment run', () => {
  it('verifies lead emails, records usage at 0 credits, and runs on a plan with no enrichment credits', async () => {
    const w = makeWorld();
    w.ctx.stripe = {} as any;
    w.ctx.config.plans = parsePlans(JSON.stringify([{ id: 'free', name: 'Free', default: true, limits: { enrichmentCreditsMonthly: 0 } }]), 'test');
    w.ctx.dns = { ...w.ctx.dns, lookup: async () => [{ address: PUBLIC_IP, family: 4 }] } as any;
    const ids = addLeads(w, 3);
    const emails = ['ann@acme.dev', 'bob@catchall.dev', 'cy@gone.dev'];
    ids.forEach((id, i) => w.ctx.db.run("UPDATE leads SET email = ?, email_source = 'csv' WHERE id = ?", [emails[i], id]));
    verifier(w, { baseUrl: 'https://verify.example.com' });
    const fetch = (w.ctx.fetch = answers((req) => {
      const email = decodeURIComponent(new URL(req.url).pathname.split('/')[2]);
      if (email.startsWith('bob')) return { json: result({ email, reachable: 'unknown', smtp: { host_exists: true, catch_all: true } }) };
      if (email.startsWith('cy')) return { json: result({ email, reachable: 'no', smtp: { host_exists: true, deliverable: false } }) };
      return { json: result({ email }) };
    }));
    startEnrichmentRun(w.ctx, w.workspaceId, null, ids, { find: false, verify: true, company: false, overwrite: false });
    await drainJobs(w);
    expect(fetch.calls).toHaveLength(3);
    const leads = ids.map((id) => w.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id])!);
    expect(leads.map((l) => l.email_status)).toEqual(['valid', 'risky', 'invalid']);
    expect(leads[1].email_status_reason).toMatch(/^Self-hosted verifier: .*catch-all/);
    const month = new Date(w.ctx.clock.now()).toISOString().slice(0, 7);
    expect(monthlyUsage(w.ctx, w.workspaceId, month)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'email_verifier', provider: 'aftership', operation: 'verifier.verify', calls: 3, credits: 0 })]));
  });
});
