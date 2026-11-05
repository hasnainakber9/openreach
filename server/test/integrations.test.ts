import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { httpJson, ProviderError, RateLimiter, scrub } from '../src/providers/http.js';
import { PROVIDER_KINDS, registerProvider, unregisterProvider } from '../src/providers/registry.js';
import { recordUsage } from '../src/services/usage.js';
import { fakeFetch, makeApi, makeWorld } from './helpers.js';

const KEY = 'sk-test-SECRET-1234567890';
const OTHER_KEY = 'sk-test-ROTATED-0987654321';

// A test-only vendor: one required secret, one optional secret, one validated setting.
beforeAll(() => {
  registerProvider({
    id: 'testvendor',
    kind: 'ai',
    label: 'Test Vendor',
    description: 'Only exists in tests',
    fields: [
      { key: 'apiKey', label: 'API key', type: 'password', secret: true, required: true },
      { key: 'orgSecret', label: 'Org secret', type: 'password', secret: true },
      { key: 'model', label: 'Model', type: 'select', options: [{ value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }] },
    ],
    credentials: z.object({ apiKey: z.string().min(10), orgSecret: z.string().optional() }),
    settings: z.object({ model: z.enum(['small', 'large']).default('small') }),
    create(ctx, cfg) {
      return {
        providerId: 'testvendor',
        simulated: false,
        async test() {
          const me = await httpJson(ctx, 'https://api.testvendor.example/v1/me', {
            headers: { authorization: `Bearer ${cfg.credentials.apiKey}` },
            secrets: [cfg.credentials.apiKey],
            integrationId: cfg.integrationId,
          });
          return { ok: true, message: `Signed in as ${me.name} (${cfg.settings.model})` };
        },
        async complete() {
          return { text: 'hi', model: cfg.settings.model, inputTokens: 1, outputTokens: 1 };
        },
      };
    },
  });
});
afterAll(() => unregisterProvider('ai', 'testvendor'));

async function setup() {
  const api = await makeApi();
  const owner = await api.register('Acme');
  return { ...api, owner };
}

describe('provider resolution', () => {
  it('falls back to the built-in simulator for every kind except crm', async () => {
    const w = makeWorld();
    for (const kind of PROVIDER_KINDS) {
      const inst = w.ctx.providers.get(w.workspaceId, kind);
      if (kind === 'crm') {
        expect(inst).toBeNull();
        expect(w.ctx.providers.list(w.workspaceId, kind)).toEqual([]);
      } else {
        expect(inst).toMatchObject({ providerId: 'simulated', simulated: true });
        expect(await inst!.test()).toMatchObject({ ok: true });
        expect(w.ctx.providers.list(w.workspaceId, kind)).toHaveLength(1);
      }
    }
    expect(w.ctx.providers.status(w.workspaceId).crm).toEqual({ provider: null, label: 'Not connected', simulated: false, integrationId: null });
  });

  it('simulated providers are deterministic and only produce .example addresses', async () => {
    const w = makeWorld();
    const finder = w.ctx.providers.get(w.workspaceId, 'email_finder')!;
    const people = Array.from({ length: 40 }, (_, i) => ({ firstName: `Ann${i}`, lastName: 'Lee', company: 'Acme Corp', profileUrl: `https://www.linkedin.com/in/ann-${i}/` }));
    const found = await Promise.all(people.map((p) => finder.find(p)));
    const again = await Promise.all([...people].reverse().map((p) => finder.find(p)));
    expect(again.reverse()).toEqual(found);
    const emails = found.filter((f) => f).map((f) => f!.email);
    expect(emails.length).toBeGreaterThan(10);
    expect(emails.length).toBeLessThan(40);
    expect(emails.every((e) => e.endsWith('@acmecorp.example'))).toBe(true);

    const verifier = w.ctx.providers.get(w.workspaceId, 'email_verifier')!;
    expect(await verifier.verify('a@b.example')).toEqual(await verifier.verify('A@B.example'));
    const ai = w.ctx.providers.get(w.workspaceId, 'ai')!;
    const out = await ai.complete({ purpose: 'write', system: 'x', prompt: 'firstName: Jane\ncompany: Northwind', maxTokens: 100, tier: 'writer' });
    expect(out.text).toContain('Jane');
    expect(out.text).toContain('Northwind');
    expect(await ai.complete({ purpose: 'write', system: 'x', prompt: 'firstName: Jane\ncompany: Northwind', maxTokens: 100, tier: 'writer' })).toEqual(out);
    expect(w.ctx.providers.get(w.workspaceId, 'sms')!.verifySignature('http://x', {}, 'anything')).toBe(false);
  });
});

describe('integrations API', () => {
  it('lists providers and per-kind status for every member', async () => {
    const { call, addUser, as } = await setup();
    const member = await addUser('member');
    as(member);
    const providers = await call('GET', '/api/integrations/providers');
    expect(providers.body.filter((p: any) => p.id === 'simulated').map((p: any) => p.kind).sort()).toEqual([...PROVIDER_KINDS].sort());
    expect(providers.body.find((p: any) => p.id === 'testvendor').fields).toHaveLength(3);
    const status = await call('GET', '/api/integrations/status');
    expect(status.body.ai).toEqual({ provider: 'simulated', label: 'Built-in simulator', simulated: true, integrationId: null });
  });

  it('creates, masks, updates and deletes an integration; secrets never leave in plaintext', async () => {
    const { w, call } = await setup();
    const created = await call('POST', '/api/integrations', { kind: 'ai', provider: 'testvendor', credentials: { apiKey: KEY, orgSecret: 'org-secret-abcdefgh' }, settings: { model: 'large' } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ kind: 'ai', provider: 'testvendor', label: 'Test Vendor', enabled: true, priority: 0, settings: { model: 'large' }, hasCredentials: true });
    expect(created.body.credentials).toEqual({ apiKey: '••••7890', orgSecret: '••••efgh' });
    expect(created.raw).not.toContain(KEY);
    const stored = w.ctx.db.get<{ credentials_enc: string }>('SELECT credentials_enc FROM integrations WHERE id = ?', [created.body.id])!;
    expect(stored.credentials_enc).not.toContain(KEY);
    expect(stored.credentials_enc).not.toContain('SECRET');

    const list = await call('GET', '/api/integrations');
    expect(list.body).toHaveLength(1);
    expect(list.raw).not.toContain(KEY);

    // A blank secret keeps the saved one; other fields still change.
    const kept = await call('PATCH', `/api/integrations/${created.body.id}`, { label: 'Main', credentials: { apiKey: '' }, settings: {} });
    expect(kept.body).toMatchObject({ label: 'Main', settings: { model: 'large' }, credentials: { apiKey: '••••7890' } });
    const creds = () => JSON.parse(w.ctx.sealer.open(w.ctx.db.get<any>('SELECT credentials_enc FROM integrations WHERE id = ?', [created.body.id])!.credentials_enc)!);
    expect(creds().apiKey).toBe(KEY);
    // null puts a setting back to its default.
    expect((await call('PATCH', `/api/integrations/${created.body.id}`, { settings: { model: null } })).body.settings).toEqual({ model: 'small' });

    // null clears an optional secret; a new value replaces.
    const rotated = await call('PATCH', `/api/integrations/${created.body.id}`, { credentials: { apiKey: OTHER_KEY, orgSecret: null } });
    expect(rotated.body.credentials).toEqual({ apiKey: '••••4321' });
    expect(rotated.raw).not.toContain(OTHER_KEY);
    expect(creds()).toEqual({ apiKey: OTHER_KEY });
    // Clearing a required secret is refused.
    expect((await call('PATCH', `/api/integrations/${created.body.id}`, { credentials: { apiKey: null } })).status).toBe(400);

    expect((await call('DELETE', `/api/integrations/${created.body.id}`)).body).toEqual({ ok: true });
    expect((await call('GET', '/api/integrations')).body).toEqual([]);
  });

  it('validates kind, provider, credentials and settings against the provider definition', async () => {
    const { call } = await setup();
    expect((await call('POST', '/api/integrations', { kind: 'fax', provider: 'testvendor' })).status).toBe(400);
    expect((await call('POST', '/api/integrations', { kind: 'ai', provider: 'nope' })).status).toBe(400);
    expect((await call('POST', '/api/integrations', { kind: 'sms', provider: 'testvendor', credentials: { apiKey: KEY } })).status).toBe(400);
    const missing = await call('POST', '/api/integrations', { kind: 'ai', provider: 'testvendor' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/credentials\.apiKey/);
    const bad = await call('POST', '/api/integrations', { kind: 'ai', provider: 'testvendor', credentials: { apiKey: KEY }, settings: { model: 'huge' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/settings\.model/);
    expect(bad.raw).not.toContain(KEY);
    const ok = await call('POST', '/api/integrations', { kind: 'ai', provider: 'testvendor', credentials: { apiKey: KEY } });
    expect(ok.body.settings).toEqual({ model: 'small' });
    expect((await call('POST', '/api/integrations', { kind: 'ai', provider: 'testvendor', credentials: { apiKey: KEY } })).status).toBe(409);
  });

  it('keeps integrations admin-only', async () => {
    const { call, addUser, as, owner } = await setup();
    const id = (await call('POST', '/api/integrations', { kind: 'ai', provider: 'testvendor', credentials: { apiKey: KEY } })).body.id;
    const admin = await addUser('admin');
    const member = await addUser('member');
    as(member);
    const denied = [
      ['GET', '/api/integrations'],
      ['POST', '/api/integrations', { kind: 'ai', provider: 'simulated' }],
      ['PATCH', `/api/integrations/${id}`, { label: 'x' }],
      ['DELETE', `/api/integrations/${id}`],
      ['POST', `/api/integrations/${id}/test`],
      ['PUT', '/api/integrations/order', { kind: 'ai', ids: [id] }],
      ['GET', '/api/usage'],
    ] as const;
    for (const [method, url, body] of denied) expect((await call(method, url, body)).status, `${method} ${url}`).toBe(403);
    as(admin);
    expect((await call('GET', '/api/integrations')).body).toHaveLength(1);
    as(owner);
    expect((await call('GET', '/api/integrations')).status).toBe(200);
  });

  it('keeps workspaces apart', async () => {
    const { call, register } = await setup();
    const id = (await call('POST', '/api/integrations', { kind: 'ai', provider: 'testvendor', credentials: { apiKey: KEY } })).body.id;
    await register('Other');
    expect((await call('GET', '/api/integrations')).body).toEqual([]);
    expect((await call('PATCH', `/api/integrations/${id}`, { label: 'mine now' })).status).toBe(404);
    expect((await call('POST', `/api/integrations/${id}/test`)).status).toBe(404);
    expect((await call('DELETE', `/api/integrations/${id}`)).status).toBe(404);
    expect((await call('PUT', '/api/integrations/order', { kind: 'ai', ids: [id] })).status).toBe(400);
    expect((await call('GET', '/api/integrations/status')).body.ai.provider).toBe('simulated');
    // The same provider can be set up in another workspace.
    expect((await call('POST', '/api/integrations', { kind: 'ai', provider: 'testvendor', credentials: { apiKey: OTHER_KEY } })).status).toBe(200);
  });

  it('tests a connection, stores the result and scrubs echoed keys from errors', async () => {
    const { w, call } = await setup();
    const id = (await call('POST', '/api/integrations', { kind: 'ai', provider: 'testvendor', credentials: { apiKey: KEY } })).body.id;

    // No fake installed: tests never reach the network.
    const offline = await call('POST', `/api/integrations/${id}/test`);
    expect(offline.body).toEqual({ ok: false, message: 'Could not reach api.testvendor.example' });

    let status = 200;
    const fetch = fakeFetch([
      {
        url: /testvendor\.example\/v1\/me$/,
        reply: (req) => (status === 200 ? { json: { name: 'Ana' } } : { status, json: { error: { message: `Invalid key ${req.headers.authorization.slice(7)}` } } }),
      },
    ]);
    w.ctx.fetch = fetch;
    const ok = await call('POST', `/api/integrations/${id}/test`);
    expect(ok.body).toEqual({ ok: true, message: 'Signed in as Ana (small)' });
    expect(fetch.calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect((await call('GET', '/api/integrations')).body[0]).toMatchObject({ lastStatus: 'ok', lastMessage: 'Signed in as Ana (small)', lastCheckedAt: w.ctx.clock.now() });

    status = 401;
    const bad = await call('POST', `/api/integrations/${id}/test`);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.message).toBe('api.testvendor.example rejected the credentials (401): Invalid key ••••');
    const listed = await call('GET', '/api/integrations');
    expect(listed.body[0]).toMatchObject({ lastStatus: 'error' });
    expect(listed.raw).not.toContain(KEY);
    // Changing the credentials clears the stale result.
    expect((await call('PATCH', `/api/integrations/${id}`, { credentials: { apiKey: OTHER_KEY } })).body.lastStatus).toBeNull();
  });

  it('resolves configured providers by priority and falls back when disabled', async () => {
    const { w, call, owner } = await setup();
    const vendor = (await call('POST', '/api/integrations', { kind: 'ai', provider: 'testvendor', credentials: { apiKey: KEY } })).body.id;
    const sim = (await call('POST', '/api/integrations', { kind: 'ai', provider: 'simulated', label: 'Sandbox' })).body;
    expect(sim).toMatchObject({ priority: 1, simulated: true, hasCredentials: false, credentials: {} });
    const ws = owner.workspaceId;
    expect(w.ctx.providers.get(ws, 'ai')!.providerId).toBe('testvendor');
    expect(w.ctx.providers.list(ws, 'ai').map((p) => p.providerId)).toEqual(['testvendor', 'simulated']);
    expect((await call('GET', '/api/integrations/status')).body.ai).toEqual({ provider: 'testvendor', label: 'Test Vendor', simulated: false, integrationId: vendor });

    expect((await call('PUT', '/api/integrations/order', { kind: 'ai', ids: [sim.id, vendor] })).body).toEqual({ ok: true });
    expect(w.ctx.providers.get(ws, 'ai')!.providerId).toBe('simulated');
    expect((await call('PUT', '/api/integrations/order', { kind: 'ai', ids: [sim.id] })).status).toBe(400); // must list all

    await call('PATCH', `/api/integrations/${sim.id}`, { enabled: false });
    expect(w.ctx.providers.get(ws, 'ai')!.providerId).toBe('testvendor');
    await call('PATCH', `/api/integrations/${vendor}`, { enabled: false });
    expect(w.ctx.providers.status(ws).ai).toMatchObject({ provider: 'simulated', integrationId: null });

    // A CRM is only used once someone adds one.
    const crm = (await call('POST', '/api/integrations', { kind: 'crm', provider: 'simulated' })).body.id;
    expect(w.ctx.providers.get(ws, 'crm')!.providerId).toBe('simulated');
    expect((await call('POST', `/api/integrations/${crm}/test`)).body.ok).toBe(true);
  });

  it('reports monthly usage per provider', async () => {
    const { w, call, owner } = await setup();
    recordUsage(w.ctx, { workspaceId: owner.workspaceId, kind: 'ai', provider: 'simulated', operation: 'ai.write', inputTokens: 100, outputTokens: 40 });
    recordUsage(w.ctx, { workspaceId: owner.workspaceId, kind: 'ai', provider: 'simulated', operation: 'ai.write', inputTokens: 50, outputTokens: 10 });
    recordUsage(w.ctx, { workspaceId: owner.workspaceId, kind: 'email_finder', provider: 'simulated', operation: 'finder.find', credits: 1 });
    const r = await call('GET', '/api/usage');
    expect(r.body).toEqual({
      month: '2026-01',
      rows: [
        { kind: 'ai', provider: 'simulated', operation: 'ai.write', calls: 2, credits: 0, inputTokens: 150, outputTokens: 50 },
        { kind: 'email_finder', provider: 'simulated', operation: 'finder.find', calls: 1, credits: 1, inputTokens: 0, outputTokens: 0 },
      ],
    });
    expect((await call('GET', '/api/usage?month=2025-12')).body.rows).toEqual([]);
    expect((await call('GET', '/api/usage?month=2025-13')).status).toBe(400);
  });
});

describe('foundation plumbing', () => {
  it('httpJson maps statuses to provider errors without leaking secrets', async () => {
    const w = makeWorld();
    w.ctx.fetch = fakeFetch([
      { url: /\/429$/, reply: () => ({ status: 429, json: { message: 'slow down' }, headers: { 'retry-after': '12' } }) },
      { url: /\/402\?/, reply: () => ({ status: 402, text: 'raw body with key=sk-live-zzzzzzzz' }) },
      { url: /\/500$/, reply: () => ({ status: 500, json: { error: 'down' } }) },
      { url: /\/ok$/, reply: () => ({ json: { fine: true } }) },
    ]);
    const err = (url: string) => httpJson(w.ctx, url, { secrets: ['sk-live-zzzzzzzz'], integrationId: 9 }).catch((e) => e as ProviderError);
    expect(await err('https://v.example/429')).toMatchObject({ code: 'RATE_LIMIT', retryAfterMs: 12_000, integrationId: 9 });
    const quota = await err('https://v.example/402?api_key=sk-live-zzzzzzzz');
    expect(quota).toMatchObject({ code: 'QUOTA', status: 402 });
    expect(quota.message).not.toContain('sk-live');
    expect(quota.message).not.toContain('raw body');
    expect(await err('https://v.example/500')).toMatchObject({ code: 'UNAVAILABLE', message: 'v.example had a server error (500): down' });
    expect(await httpJson(w.ctx, 'https://v.example/ok')).toEqual({ fine: true });
    expect(scrub('key abc12345 and abc12345', ['abc12345', '', null])).toBe('key •••• and ••••');
  });

  it('rate limiter spaces calls per key', () => {
    let t = 0;
    const limiter = new RateLimiter(2, 2, () => t);
    expect([limiter.reserve(1), limiter.reserve(1), limiter.reserve(2)]).toEqual([0, 0, 0]);
    expect(limiter.reserve(1)).toBe(500);
    t = 500;
    expect(limiter.reserve(1)).toBe(0);
  });

  it('takes form bodies only outside /api and on provider callbacks, so cross-site forms cannot drive the API', async () => {
    const app = await buildApp(makeWorld().ctx);
    // (/u/:token itself is the real unsubscribe route since g3-mailboxes, and /api/public/twilio/:id/inbound the real
    // Twilio webhook since g3-tasks-sms; any non-API path, and any path under the Twilio prefix, takes forms.)
    app.post('/form-echo/:token', async (req) => req.body);
    app.post('/api/public/twilio/echo/:id', async (req) => req.body);
    const form = (url: string, payload: string, cookie?: string) =>
      app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', ...(cookie ? { cookie } : {}) } });
    expect((await form('/form-echo/abc', 'List-Unsubscribe=One-Click')).json()).toEqual({ 'List-Unsubscribe': 'One-Click' });
    expect((await form('/api/public/twilio/echo/3', 'From=%2B15550100&Body=STOP')).json()).toEqual({ From: '+15550100', Body: 'STOP' });

    const { app: api, owner } = await setup();
    // Login CSRF: a cross-site form must not sign the victim into someone else's workspace.
    expect((await api.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'email=owner1%40example.com&password=correct-horse' })).statusCode).toBe(415);
    expect((await api.inject({ method: 'POST', url: '/api/auth/register', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'name=X&email=x%40example.com&password=correct-horse&workspace=X' })).statusCode).toBe(415);
    // A same-site form riding the session cookie cannot add an admin.
    const team = await api.inject({
      method: 'POST',
      url: '/api/team',
      headers: { 'content-type': 'Application/X-WWW-Form-Urlencoded', cookie: owner.cookie },
      payload: 'name=Mallory&email=mallory%40example.com&password=correct-horse&role=admin',
    });
    expect(team.statusCode).toBe(415);
    expect((await api.inject({ method: 'GET', url: '/api/team', headers: { cookie: owner.cookie } })).json().map((u: any) => u.email)).not.toContain('mallory@example.com');
  });

  it('reports features and leaves /api/public/ unauthenticated', async () => {
    const { app, call } = await setup();
    expect((await call('GET', '/api/auth/me')).body.user.features).toEqual({});
    expect((await app.inject({ method: 'GET', url: '/api/public/nothing-here' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(401);
  });
});
