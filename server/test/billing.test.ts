import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { completeAi } from '../src/ai/complete.js';
import { assertCredits, currentPlan, overPlanIds, PlanLimitError, subscriptionOf, usageOf } from '../src/billing/limits.js';
import type { Sequence } from '../src/engine/sequence.js';
import { ensureLegacyMailboxes, serializeMailbox, setCampaignMailboxes } from '../src/mail/mailboxes.js';
import { serializeAccount } from '../src/routes/accounts.js';
import type { MailboxRow } from '../src/types.js';
import { isBlockedAddress } from '../src/services/hosts.js';
import { parsePlans, type PlanLimits } from '../src/billing/plans.js';
import type { CheckoutInput, StripeLike } from '../src/billing/stripe.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/services/crypto.js';
import { addMembership } from '../src/services/memberships.js';
import { recordUsage } from '../src/services/usage.js';
import type { AiProvider } from '../src/providers/ai/types.js';
import { DAY, HOUR } from '../src/clock.js';
import { addAccount, addLeads, fakeFetch, fakeImap, mailerOf, makeApi, makeCampaign, makeWorld, runFor, type World } from './helpers.js';

const SECRET = 'whsec_test_openreach';
const WEBHOOK = '/api/public/stripe/webhook';

const limits = (l: Partial<PlanLimits>): PlanLimits => ({
  linkedinAccounts: null,
  mailboxes: null,
  seats: null,
  clientWorkspaces: null,
  aiCreditsMonthly: null,
  enrichmentCreditsMonthly: null,
  ...l,
});

// A free default plan with one of everything, and a paid plan with more.
const PLANS = [
  { id: 'free', name: 'Free', default: true, limits: limits({ linkedinAccounts: 1, mailboxes: 1, seats: 2, clientWorkspaces: 0, aiCreditsMonthly: 0, enrichmentCreditsMonthly: 0 }) },
  { id: 'pro', name: 'Pro', priceId: 'price_pro', limits: limits({ linkedinAccounts: 3, mailboxes: 5, seats: 5, clientWorkspaces: 2, aiCreditsMonthly: 2 }) },
];

function stubStripe() {
  const calls = {
    customers: [] as { workspaceId: number; email: string; name: string }[],
    checkout: [] as CheckoutInput[],
    closed: [] as string[],
    portal: [] as { customerId: string; returnUrl: string }[],
  };
  // What closeCheckoutSession finds: an open (unpaid) session by default.
  const state = { sessionPaid: false };
  const stub: StripeLike = {
    async createCustomer(i) {
      calls.customers.push(i);
      return { id: 'cus_1' };
    },
    async createCheckoutSession(i) {
      calls.checkout.push(i);
      return { id: `cs_${calls.checkout.length}`, url: `https://checkout.stripe.test/c/${calls.checkout.length}` };
    },
    async closeCheckoutSession(id) {
      calls.closed.push(id);
      return state.sessionPaid ? 'complete' : 'closed';
    },
    async createPortalSession(i) {
      calls.portal.push(i);
      return { url: 'https://billing.stripe.test/p/1' };
    },
  };
  return Object.assign(stub, { calls, state });
}

// Billing as a hosted install has it: a key (here a stub client), plans and a webhook secret.
function enableBilling(w: World, plans: unknown[] = PLANS, webhookSecret: string | undefined = SECRET) {
  const stripe = stubStripe();
  w.ctx.stripe = stripe;
  w.ctx.config.plans = parsePlans(JSON.stringify(plans), 'test');
  w.ctx.config.stripeSecretKey = 'sk_test_stub';
  w.ctx.config.stripeWebhookSecret = webhookSecret;
  return stripe;
}

const account = (name: string) => ({ name, driver: 'simulator', timezone: 'UTC' });

type Api = Awaited<ReturnType<typeof makeApi>>;

// Posts an event the way Stripe does: the exact JSON bytes and a signature over them.
function deliver(api: Api, event: Record<string, unknown>, secret = SECRET) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return api.app.inject({ method: 'POST', url: WEBHOOK, payload, headers: { 'content-type': 'application/json', 'stripe-signature': signature } });
}

let seq = 0;
const event = (type: string, object: Record<string, unknown>, created: number) => ({ id: `evt_${++seq}`, object: 'event', type, created, data: { object } });
const checkoutDone = (ws: number, created = 1_000) =>
  event('checkout.session.completed', { id: 'cs_1', object: 'checkout.session', mode: 'subscription', client_reference_id: String(ws), customer: 'cus_1', subscription: 'sub_1', payment_status: 'paid', metadata: { workspace_id: String(ws), plan_id: 'pro' } }, created);
const subscription = (type: string, status: string, created: number, extra: Record<string, unknown> = {}) =>
  event(
    type,
    { id: 'sub_1', object: 'subscription', customer: 'cus_1', status, cancel_at_period_end: false, items: { data: [{ price: { id: 'price_pro' }, current_period_end: 1_900_000_000 }] }, metadata: {}, ...extra },
    created,
  );

describe('billing off (self-hosted)', () => {
  it('limits nothing and keeps the webhook closed', async () => {
    const api = await makeApi();
    await api.register('Solo');
    for (let i = 0; i < 4; i++) expect((await api.call('POST', '/api/accounts', account(`Seat ${i}`))).status).toBe(200);
    expect((await api.call('GET', '/api/auth/me')).body.user.features).toEqual({});
    const b = await api.call('GET', '/api/billing');
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ enabled: false, plan: null, plans: [] });
    expect(b.body.usage.linkedinAccounts).toEqual({ used: 4, allowed: null });
    expect((await api.call('POST', '/api/billing/checkout', { planId: 'pro' })).status).toBe(409);
    expect((await deliver(api, checkoutDone(1))).statusCode).toBe(404);
  });

  it('refuses to start with a Stripe key but no plans, and reports bad plan config clearly', () => {
    expect(() => loadConfig({ STRIPE_SECRET_KEY: 'sk_test_x', APP_SECRET: 'x', DATA_DIR: join(tmpdir(), 'openreach-test-billing') })).toThrow(/no plans are defined/);
    expect(() => parsePlans('[{"id":"a","name":"A"}]', 'BILLING_PLANS')).toThrow(/BILLING_PLANS: plans\[0\]\.priceId: only the default plan/);
    expect(() => parsePlans('[{"id":"a","name":"A","default":true},{"id":"b","name":"B","default":true}]', 'BILLING_PLANS')).toThrow(/at most one plan/);
    expect(() => parsePlans('[{"id":"a","name":"A","priceId":"p","limits":{"accounts":1}}]', 'BILLING_PLANS')).toThrow(/limits/);
    expect(() => parsePlans('{', 'BILLING_PLANS')).toThrow(/not valid JSON/);
    expect(parsePlans(JSON.stringify({ plans: PLANS }), 'x').map((p) => p.id)).toEqual(['free', 'pro']);
  });
});

describe('plan limits', () => {
  it('stops the second LinkedIn account on a one-account plan with an upgrade error', async () => {
    const w = makeWorld();
    enableBilling(w);
    const api = await makeApi(w);
    await api.register('Acme');
    expect((await api.call('GET', '/api/auth/me')).body.user.features).toEqual({ billing: true });
    expect((await api.call('POST', '/api/accounts', account('One'))).status).toBe(200);
    const r = await api.call('POST', '/api/accounts', account('Two'));
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('Your plan allows 1 LinkedIn account. Upgrade to add more.');
    expect(r.body.details).toEqual({ code: 'plan_limit', limit: 'linkedinAccounts', allowed: 1, used: 1 });
    // Mailboxes have their own limit.
    const mailbox = { name: 'Sim', provider: 'simulated', fromName: 'A', fromEmail: 'a@acme.example' };
    expect((await api.call('POST', '/api/mailboxes', mailbox)).status).toBe(200);
    expect((await api.call('POST', '/api/mailboxes', { ...mailbox, fromEmail: 'b@acme.example' })).body.details.limit).toBe('mailboxes');
    // Seats: the owner plus one teammate; read-only clients are free; pending invites hold a seat.
    await api.addUser('member');
    expect((await api.call('POST', '/api/team', { name: 'Third', email: 'third@example.com', password: 'correct-horse', role: 'admin' })).status).toBe(402);
    expect((await api.call('POST', '/api/invites', { email: 'new@example.com', role: 'member' })).status).toBe(402);
    expect((await api.call('POST', '/api/invites', { email: 'viewer@example.com', role: 'client' })).status).toBe(200);
    await api.addUser('client');

    const b = (await api.call('GET', '/api/billing')).body;
    expect(b).toMatchObject({ enabled: true, plan: { id: 'free', name: 'Free' }, status: 'none', canCheckout: true, webhookConfigured: true });
    expect(b.usage).toMatchObject({ linkedinAccounts: { used: 1, allowed: 1 }, mailboxes: { used: 1, allowed: 1 }, seats: { used: 2, allowed: 2 } });
    expect(b.plans.map((p: any) => [p.id, p.purchasable])).toEqual([
      ['free', false],
      ['pro', true],
    ]);
  });

  it('runs only the oldest accounts and mailboxes the plan allows after a cancellation, and all of them again after an upgrade', async () => {
    // Small daily limits, so the first account and mailbox can't do all the work on their own.
    const w = makeWorld({ acceptRate: 0 }, { delay_min_sec: 30, delay_max_sec: 60, limits: JSON.stringify({ connect: 3 }) });
    enableBilling(w);
    const b = addAccount(w, { delay_min_sec: 30, delay_max_sec: 60 });
    const box = (name: string) =>
      w.ctx.db.insert('mailboxes', {
        workspace_id: w.workspaceId,
        name,
        provider: 'simulated',
        from_name: 'S',
        from_email: `${name}@sender.example`,
        work_days: '[0,1,2,3,4,5,6]',
        daily_limit: 3,
        warmup: 0,
        gap_min_sec: 60,
        gap_max_sec: 120,
        created_at: w.ctx.clock.now(),
      });
    const [m1, m2] = [box('one'), box('two')];
    w.ctx.db.insert('subscriptions', { workspace_id: w.workspaceId, plan_id: 'pro', status: 'canceled', updated_at: 1 });
    const leads = addLeads(w, 12);
    leads.forEach((l, i) => w.ctx.db.run('UPDATE leads SET email = ? WHERE id = ?', [`p${i}@acme.dev`, l]));
    const seq: Sequence = { start: 'c', nodes: { c: { id: 'c', type: 'connect', note: '', next: 'e' }, e: { id: 'e', type: 'email', subject: 'Hi', body: 'Hi', next: null } } };
    const { id } = makeCampaign(w, seq, {}, leads, [w.accountId, b.id]);
    setCampaignMailboxes(w.ctx, id, [m1, m2]);
    const by = (col: string, type: string) =>
      Object.fromEntries(w.ctx.db.all<{ k: number; n: number }>(`SELECT ${col} AS k, COUNT(*) AS n FROM activity WHERE type = ? AND status = 'ok' GROUP BY ${col}`, [type]).map((r) => [r.k, r.n]));

    // Cancelled: the free plan allows one account and one mailbox, so the newer ones stand still.
    await runFor(w, 3 * HOUR);
    expect(Object.keys(by('account_id', 'connect'))).toEqual([String(w.accountId)]);
    expect(Object.keys(by('mailbox_id', 'email'))).toEqual([String(m1)]);
    expect(serializeAccount(w.ctx, b.row())).toMatchObject({ status: 'active', overPlan: true, statusMessage: expect.stringMatching(/sends nothing: your plan allows 1 LinkedIn account/) });
    expect(serializeAccount(w.ctx, w.account())).toMatchObject({ overPlan: false, statusMessage: null });
    const mbRow = (mid: number) => w.ctx.db.get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', [mid])!;
    expect(serializeMailbox(w.ctx, mbRow(m2))).toMatchObject({ overPlan: true, statusMessage: expect.stringMatching(/sends nothing: your plan allows 1 mailbox/) });

    // Subscribed again: both run, with no other change.
    w.ctx.db.run("UPDATE subscriptions SET status = 'active' WHERE workspace_id = ?", [w.workspaceId]);
    await runFor(w, 3 * HOUR);
    expect(by('account_id', 'connect')[b.id]).toBeGreaterThan(0);
    expect(by('mailbox_id', 'email')[m2]).toBeGreaterThan(0);
    expect(serializeAccount(w.ctx, b.row())).toMatchObject({ overPlan: false, statusMessage: null });

    // Self-hosted (billing off): nothing is ever over a plan.
    w.ctx.stripe = null as any;
    expect(overPlanIds(w.ctx, 'linkedinAccounts').size).toBe(0);
  });

  it('keeps syncing an account past the limit, so a reply meanwhile still stops its lead', async () => {
    const w = makeWorld({ acceptRate: 0, replyRate: 0 }, { limits: JSON.stringify({ connect: 2 }) });
    enableBilling(w);
    const b = addAccount(w);
    w.ctx.db.insert('subscriptions', { workspace_id: w.workspaceId, plan_id: 'pro', status: 'active', updated_at: 1 });
    const leads = addLeads(w, 4);
    const seq: Sequence = { start: 'c', nodes: { c: { id: 'c', type: 'connect', note: '', next: 'w' }, w: { id: 'w', type: 'wait', days: 1, hours: 0, next: 'f' }, f: { id: 'f', type: 'follow', next: null } } };
    const { id } = makeCampaign(w, seq, {}, leads, [w.accountId, b.id]);
    await runFor(w, 3 * HOUR);
    const mine = w.ctx.db.all<{ lead_id: number }>('SELECT lead_id FROM campaign_leads WHERE campaign_id = ? AND account_id = ? AND contacted_at IS NOT NULL', [id, b.id]);
    expect(mine.length).toBeGreaterThan(0);
    const replier = mine[0].lead_id;

    // Cancelled: B is past the free plan's single account. Its lead answers on LinkedIn meanwhile.
    w.ctx.db.run("UPDATE subscriptions SET status = 'canceled' WHERE workspace_id = ?", [w.workspaceId]);
    const before = w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE account_id = ? AND status = 'ok' AND type IN ('connect', 'follow')", [b.id])!.n;
    const pub = w.ctx.db.get<{ public_id: string }>('SELECT public_id FROM leads WHERE id = ?', [replier])!.public_id;
    w.ctx.db.run('UPDATE sim_people SET connected = 1, reply_at = ? WHERE account_id = ? AND public_id = ?', [w.ctx.clock.now(), b.id, pub]);
    await runFor(w, 2 * DAY, 5 * 60_000);
    expect(w.ctx.db.get('SELECT state FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?', [id, replier])).toEqual({ state: 'replied' });
    // It read the reply but acted on nothing.
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE account_id = ? AND status = 'ok' AND type IN ('connect', 'follow')", [b.id])!.n).toBe(before);
    expect(serializeAccount(w.ctx, b.row()).statusMessage).toMatch(/sends nothing/);

    // Upgraded again: B follows up its other leads, never the one who replied.
    w.ctx.db.run("UPDATE subscriptions SET status = 'active' WHERE workspace_id = ?", [w.workspaceId]);
    await runFor(w, DAY, 5 * 60_000);
    expect(w.ctx.db.all("SELECT 1 FROM activity WHERE lead_id = ? AND type = 'follow'", [replier])).toEqual([]);
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE account_id = ? AND status = 'ok' AND type = 'follow'", [b.id])!.n).toBeGreaterThan(0);
  });

  it('asks for a plan when there is no default plan', async () => {
    const w = makeWorld();
    enableBilling(w, [PLANS[1]]);
    const api = await makeApi(w);
    await api.register('Acme');
    const r = await api.call('POST', '/api/accounts', account('One'));
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('Choose a plan to add LinkedIn accounts.');
    expect(r.body.details).toMatchObject({ allowed: 0, used: 0 });
  });

  it("counts an agency's client workspaces against the agency's plan", async () => {
    const w = makeWorld();
    enableBilling(w, [{ ...PLANS[0], limits: limits({ linkedinAccounts: 1, clientWorkspaces: 2 }) }]);
    const api = await makeApi(w);
    const owner = await api.register('Agency');
    await api.call('POST', '/api/agency/enable');
    const a = (await api.call('POST', '/api/agency/clients', { name: 'A' })).body.id;
    const b = (await api.call('POST', '/api/agency/clients', { name: 'B' })).body.id;
    expect((await api.call('POST', '/api/agency/clients', { name: 'C' })).body.details).toMatchObject({ limit: 'clientWorkspaces', allowed: 2, used: 2 });
    await api.call('POST', '/api/workspaces/switch', { workspaceId: a });
    expect((await api.call('POST', '/api/accounts', account('A1'))).status).toBe(200);
    // The agency owner sees the agency's billing from inside a client.
    expect((await api.call('GET', '/api/billing')).body.usage.linkedinAccounts).toEqual({ used: 1, allowed: 1 });
    expect((await api.call('GET', '/api/auth/me')).body.user.features.billing).toBe(true);
    await api.call('POST', '/api/workspaces/switch', { workspaceId: b });
    expect((await api.call('POST', '/api/accounts', account('B1'))).status).toBe(402);

    // Someone who owns a client workspace, but not the agency, can't see or change the agency's plan.
    const id = w.ctx.db.insert('users', { workspace_id: a, email: 'clientowner@example.com', name: 'Client owner', password_hash: hashPassword('correct-horse'), role: 'owner', created_at: Date.now() });
    addMembership(w.ctx, id, a, 'owner');
    const login = await api.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'clientowner@example.com', password: 'correct-horse' } });
    const cookie = String([login.headers['set-cookie']].flat()[0]).split(';')[0];
    expect((await api.call('GET', '/api/auth/me', undefined, { cookie })).body.user.features.billing).toBeUndefined();
    expect((await api.call('GET', '/api/billing', undefined, { cookie })).status).toBe(403);
    expect((await api.call('POST', '/api/billing/checkout', { planId: 'free' }, { cookie })).status).toBe(403);
    expect(owner.id).not.toBe(id);
  });

  it('checks monthly AI and enrichment credits before calling a paid provider', async () => {
    const w = makeWorld();
    enableBilling(w);
    const ws = w.workspaceId;
    const calls: string[] = [];
    const paid: AiProvider = {
      providerId: 'anthropic',
      simulated: false,
      complete: async (req) => (calls.push(req.purpose), { text: 'Hi', model: 'm', inputTokens: 1, outputTokens: 1 }),
    } as AiProvider;
    const req = { purpose: 'write', system: '', prompt: 'p', maxTokens: 10, tier: 'writer' } as const;
    // Free plan: 0 AI credits.
    await expect(completeAi(w.ctx, ws, req, paid)).rejects.toBeInstanceOf(PlanLimitError);
    expect(calls).toEqual([]);
    // Pro: 2 calls a month.
    w.ctx.db.insert('subscriptions', { workspace_id: ws, plan_id: 'pro', status: 'active', updated_at: 1 });
    await completeAi(w.ctx, ws, req, paid);
    await completeAi(w.ctx, ws, req, paid);
    const err = await completeAi(w.ctx, ws, req, paid).catch((e) => e);
    expect(err).toBeInstanceOf(PlanLimitError);
    expect(err.code).toBe('QUOTA');
    expect(err.details).toEqual({ code: 'plan_limit', limit: 'aiCreditsMonthly', allowed: 2, used: 2 });
    expect(calls).toHaveLength(2);
    // Enrichment: Pro has no enrichment limit; on Free (canceled) the vendors' reported credits count.
    expect(() => assertCredits(w.ctx, ws, 'enrichmentCreditsMonthly')).not.toThrow();
    w.ctx.db.run("UPDATE subscriptions SET status = 'canceled' WHERE workspace_id = ?", [ws]);
    recordUsage(w.ctx, { workspaceId: ws, kind: 'email_finder', provider: 'hunter', operation: 'finder.find', credits: 3 });
    expect(usageOf(w.ctx, ws, 'enrichmentCreditsMonthly')).toBe(3);
    expect(() => assertCredits(w.ctx, ws, 'enrichmentCreditsMonthly')).toThrow(PlanLimitError);
    // The simulated provider is always free.
    w.ctx.db.run("UPDATE subscriptions SET status = 'past_due' WHERE workspace_id = ?", [ws]);
    await expect(completeAi(w.ctx, ws, req, { ...paid, providerId: 'simulated', simulated: true } as AiProvider)).resolves.toBeTruthy();
  });

  it('turns used-up AI credits into a 402 on AI routes', async () => {
    const w = makeWorld();
    enableBilling(w);
    const api = await makeApi(w);
    await api.register('Acme');
    // A real (non-simulated) AI integration; the plan check fires before any network call.
    expect((await api.call('POST', '/api/integrations', { kind: 'ai', provider: 'anthropic', credentials: { apiKey: 'sk-ant-test-key' } })).status).toBe(200);
    const r = await api.call('POST', '/api/ai/write', { nodeType: 'message', brief: { offer: 'A tool', tone: 'friendly', length: 'short', language: 'English' } });
    expect(r.status).toBe(402);
    expect(r.body.details).toMatchObject({ code: 'plan_limit', limit: 'aiCreditsMonthly' });
  });
});

describe('Stripe checkout and portal', () => {
  it('starts checkout and the portal for the owner only, through the stubbed client', async () => {
    const w = makeWorld();
    const stripe = enableBilling(w);
    const api = await makeApi(w);
    const owner = await api.register('Acme');
    const admin = await api.addUser('admin');

    // No customer yet: nothing to manage.
    expect((await api.call('POST', '/api/billing/portal')).status).toBe(409);
    const c = await api.call('POST', '/api/billing/checkout', { planId: 'pro' });
    expect(c.body).toEqual({ url: 'https://checkout.stripe.test/c/1' });
    // The workspace's customer is created first, so every subscription lands on it.
    expect(stripe.calls.customers).toEqual([{ workspaceId: owner.workspaceId, email: 'owner1@example.com', name: 'Acme' }]);
    expect(stripe.calls.checkout[0]).toEqual({
      workspaceId: owner.workspaceId,
      planId: 'pro',
      priceId: 'price_pro',
      customerId: 'cus_1',
      successUrl: 'http://localhost:8787/billing?status=success',
      cancelUrl: 'http://localhost:8787/billing?status=canceled',
    });
    expect(subscriptionOf(w.ctx, owner.workspaceId)).toMatchObject({ stripe_customer_id: 'cus_1', checkout_session_id: 'cs_1', status: 'none' });
    expect((await api.call('POST', '/api/billing/checkout', { planId: 'free' })).status).toBe(400);
    expect((await api.call('POST', '/api/billing/checkout', { planId: 'nope' })).status).toBe(404);

    // Admins can't touch billing.
    for (const [m, u] of [
      ['GET', '/api/billing'],
      ['POST', '/api/billing/checkout'],
      ['POST', '/api/billing/portal'],
    ]) {
      expect((await api.call(m, u, m === 'POST' ? { planId: 'pro' } : undefined, admin)).status).toBe(403);
    }

    // Starting again before paying (another tab, Back): the first page is closed and the same customer reused.
    expect((await api.call('POST', '/api/billing/checkout', { planId: 'pro' })).body).toEqual({ url: 'https://checkout.stripe.test/c/2' });
    expect(stripe.calls.closed).toEqual(['cs_1']);
    expect(stripe.calls.customers).toHaveLength(1);
    expect(stripe.calls.checkout[1].customerId).toBe('cus_1');
    expect(subscriptionOf(w.ctx, owner.workspaceId)!.checkout_session_id).toBe('cs_2');
    // That page was already paid (the webhook is on its way): no second checkout.
    stripe.state.sessionPaid = true;
    expect((await api.call('POST', '/api/billing/checkout', { planId: 'pro' })).status).toBe(409);
    expect(stripe.calls.checkout).toHaveLength(2);
    stripe.state.sessionPaid = false;

    // Once subscribed: the portal opens for the stored customer, and checkout would double-bill.
    expect((await deliver(api, checkoutDone(owner.workspaceId))).statusCode).toBe(200);
    expect((await api.call('POST', '/api/billing/portal')).body).toEqual({ url: 'https://billing.stripe.test/p/1' });
    expect(stripe.calls.portal).toEqual([{ customerId: 'cus_1', returnUrl: 'http://localhost:8787/billing' }]);
    expect((await api.call('POST', '/api/billing/checkout', { planId: 'pro' })).status).toBe(409);
    expect((await api.call('GET', '/api/billing')).body).toMatchObject({ plan: { id: 'pro' }, status: 'active', hasCustomer: true, canCheckout: false });

    // Return URLs need PUBLIC_URL.
    w.ctx.config.publicUrl = undefined;
    expect((await api.call('POST', '/api/billing/portal')).body.error).toMatch(/PUBLIC_URL/);
  });

  it('lets one checkout start at a time per workspace, across instances sharing the database', async () => {
    const w = makeWorld();
    const stripe = enableBilling(w);
    const api = await makeApi(w);
    const owner = await api.register('Acme');
    // Another instance is starting one (its claim is in the database, not in this process).
    w.ctx.db.run('INSERT INTO subscriptions (workspace_id, checkout_starting_until, updated_at) VALUES (?, ?, ?)', [owner.workspaceId, Date.now() + 60_000, 1]);
    const busy = await api.call('POST', '/api/billing/checkout', { planId: 'pro' });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatch(/already starting/);
    expect(stripe.calls.checkout).toHaveLength(0);
    // A claim left by a crash runs out; a finished start releases its own.
    w.ctx.db.run('UPDATE subscriptions SET checkout_starting_until = ? WHERE workspace_id = ?', [Date.now() - 1, owner.workspaceId]);
    expect((await api.call('POST', '/api/billing/checkout', { planId: 'pro' })).status).toBe(200);
    expect(subscriptionOf(w.ctx, owner.workspaceId)!.checkout_starting_until).toBeNull();
    expect((await api.call('POST', '/api/billing/checkout', { planId: 'pro' })).status).toBe(200);
    expect(stripe.calls.checkout).toHaveLength(2);
  });
});

describe('Stripe webhook', () => {
  async function setup() {
    const w = makeWorld();
    enableBilling(w);
    const api = await makeApi(w);
    const owner = await api.register('Acme');
    return { w, api, ws: owner.workspaceId, sub: () => subscriptionOf(w.ctx, owner.workspaceId) };
  }

  it('keeps the subscription row current through the subscription lifecycle', async () => {
    const { w, api, ws, sub } = await setup();
    const r = await deliver(api, checkoutDone(ws, 1_000));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ received: true, result: 'processed' });
    expect(sub()).toMatchObject({ stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', plan_id: 'pro', status: 'active' });
    expect(currentPlan(w.ctx, ws)?.id).toBe('pro');
    // Three accounts on Pro.
    for (const n of ['1', '2', '3']) expect((await api.call('POST', '/api/accounts', account(n))).status).toBe(200);
    expect((await api.call('POST', '/api/accounts', account('4'))).body.details).toMatchObject({ allowed: 3, used: 3 });

    // The subscription's own event sets the period and a scheduled cancellation.
    await deliver(api, subscription('customer.subscription.updated', 'active', 1_100, { cancel_at_period_end: true }));
    expect(sub()).toMatchObject({ status: 'active', plan_id: 'pro', current_period_end: 1_900_000_000_000, cancel_at_period_end: 1, last_event_at: 1_100 });

    // A failed renewal: past due, back to the default plan's limits (nothing deleted).
    await deliver(api, event('invoice.payment_failed', { id: 'in_1', object: 'invoice', customer: 'cus_1', subscription: 'sub_1', billing_reason: 'subscription_cycle' }, 1_200));
    expect(sub()!.status).toBe('past_due');
    expect(currentPlan(w.ctx, ws)?.id).toBe('free');
    expect((await api.call('GET', '/api/accounts')).body).toHaveLength(3);
    expect((await api.call('POST', '/api/accounts', account('4'))).body.details).toMatchObject({ allowed: 1, used: 3 });

    // Paid again, then canceled for good.
    await deliver(api, subscription('customer.subscription.updated', 'active', 1_300));
    expect(currentPlan(w.ctx, ws)?.id).toBe('pro');
    await deliver(api, subscription('customer.subscription.deleted', 'canceled', 1_400));
    expect(sub()).toMatchObject({ status: 'canceled', plan_id: null, stripe_customer_id: 'cus_1' });
    expect(currentPlan(w.ctx, ws)?.id).toBe('free');
    expect((await api.call('GET', '/api/billing')).body).toMatchObject({ plan: { id: 'free' }, status: 'canceled', canCheckout: true });
  });

  it('ignores duplicate and out-of-order events', async () => {
    const { api, ws, sub } = await setup();
    await deliver(api, checkoutDone(ws, 1_000));
    const update = subscription('customer.subscription.updated', 'past_due', 2_000);
    expect((await deliver(api, update)).json().result).toBe('processed');
    // Stripe redelivers the same event id.
    expect((await deliver(api, { ...update, data: { object: { ...update.data.object, status: 'active' } } })).json().result).toBe('duplicate');
    expect(sub()!.status).toBe('past_due');
    // An older event arriving late doesn't undo the newer state.
    expect((await deliver(api, subscription('customer.subscription.updated', 'active', 1_500))).json().result).toBe('stale');
    expect(sub()!.status).toBe('past_due');
    // Events for workspaces we don't know (or other event types) are acknowledged and ignored.
    const stranger = event('checkout.session.completed', { id: 'cs_9', mode: 'subscription', client_reference_id: '999999', customer: 'cus_9', subscription: 'sub_9', metadata: {} }, 3_000);
    expect((await deliver(api, stranger)).json().result).toBe('ignored');
    expect((await deliver(api, subscription('customer.subscription.updated', 'active', 3_000, { id: 'sub_9', customer: 'cus_9' }))).json().result).toBe('ignored');
    expect((await deliver(api, event('customer.created', { id: 'cus_2' }, 3_000))).json().result).toBe('ignored');
  });

  it('refuses bad signatures and unsigned events', async () => {
    const { w, api, ws, sub } = await setup();
    const bad = await deliver(api, checkoutDone(ws), 'whsec_someone_else');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('Invalid Stripe signature');
    // A valid signature over different bytes (re-serialized JSON) doesn't pass either.
    const payload = JSON.stringify(checkoutDone(ws));
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    const tampered = await api.app.inject({ method: 'POST', url: WEBHOOK, payload: payload.replace('"pro"', '"free"'), headers: { 'content-type': 'application/json', 'stripe-signature': signature } });
    expect(tampered.statusCode).toBe(400);
    expect((await api.app.inject({ method: 'POST', url: WEBHOOK, payload, headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
    expect(sub()).toBeNull();
    // With the key set but no webhook secret, nothing is processed.
    w.ctx.config.stripeWebhookSecret = undefined;
    expect((await deliver(api, checkoutDone(ws))).statusCode).toBe(503);
    expect((await api.call('GET', '/api/billing')).body.webhookConfigured).toBe(false);
    expect(sub()).toBeNull();
    // The rest of the API still parses JSON as usual.
    expect((await api.call('POST', '/api/accounts', account('One'))).status).toBe(200);
  });
});

describe('Stripe webhook: one subscription per workspace', () => {
  async function setup() {
    const w = makeWorld();
    enableBilling(w);
    const api = await makeApi(w);
    const owner = await api.register('Acme');
    await deliver(api, checkoutDone(owner.workspaceId, 1_000));
    return { w, api, ws: owner.workspaceId, sub: () => subscriptionOf(w.ctx, owner.workspaceId)! };
  }

  it('leaves an active subscription alone when an unrelated or off-cycle invoice fails', async () => {
    const { api, sub } = await setup();
    // A one-off invoice to the same customer (no subscription; newer API versions have parent: null).
    const oneOff = event('invoice.payment_failed', { id: 'in_2', object: 'invoice', customer: 'cus_1', subscription: null, parent: null, billing_reason: 'manual' }, 1_100);
    expect((await deliver(api, oneOff)).json().result).toBe('ignored');
    // A proration invoice of the subscription: Stripe keeps the subscription active.
    const proration = event('invoice.payment_failed', { id: 'in_3', object: 'invoice', customer: 'cus_1', parent: { subscription_details: { subscription: 'sub_1' } }, billing_reason: 'subscription_update' }, 1_200);
    expect((await deliver(api, proration)).json().result).toBe('ignored');
    // Another subscription's renewal.
    const other = event('invoice.payment_failed', { id: 'in_4', object: 'invoice', customer: 'cus_1', subscription: 'sub_2', billing_reason: 'subscription_cycle' }, 1_300);
    expect((await deliver(api, other)).json().result).toBe('ignored');
    expect(sub().status).toBe('active');
  });

  it('never swaps one live subscription for another, and tells the owner about the second', async () => {
    const { w, api, ws, sub } = await setup();
    // A second checkout paid on another customer: the stored customer and subscription stay.
    const second = event(
      'checkout.session.completed',
      { id: 'cs_2', object: 'checkout.session', mode: 'subscription', client_reference_id: String(ws), customer: 'cus_2', subscription: 'sub_2', payment_status: 'paid', metadata: { plan_id: 'pro' } },
      1_100,
    );
    expect((await deliver(api, second)).json().result).toBe('processed');
    expect(sub()).toMatchObject({ stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', extra_subscription_id: 'sub_2', status: 'active' });
    // Its own events don't take over the row either.
    const update2 = subscription('customer.subscription.updated', 'active', 1_200, { id: 'sub_2', customer: 'cus_2', metadata: { workspace_id: String(ws) } });
    expect((await deliver(api, update2)).json().result).toBe('ignored');
    expect(sub()).toMatchObject({ stripe_subscription_id: 'sub_1', status: 'active' });
    expect((await api.call('GET', '/api/billing')).body.duplicateSubscription).toBe(true);
    // The owner cancels the second one: the warning goes away.
    await deliver(api, subscription('customer.subscription.deleted', 'canceled', 1_300, { id: 'sub_2', customer: 'cus_2', metadata: { workspace_id: String(ws) } }));
    expect(sub()).toMatchObject({ stripe_subscription_id: 'sub_1', extra_subscription_id: null, status: 'active' });
    expect((await api.call('GET', '/api/billing')).body.duplicateSubscription).toBe(false);
    // Once the first one ended, a new paid subscription replaces it (subscribed again).
    await deliver(api, subscription('customer.subscription.deleted', 'canceled', 1_400));
    await deliver(api, subscription('customer.subscription.created', 'active', 1_500, { id: 'sub_3' }));
    expect(sub()).toMatchObject({ stripe_subscription_id: 'sub_3', status: 'active', plan_id: 'pro' });
    expect(currentPlan(w.ctx, ws)?.id).toBe('pro');
  });
});

describe('hosted installs: tenant-supplied hosts', () => {
  // A resolver with fixed answers; other names don't resolve.
  const dns = (w: World, answers: Record<string, string[]>) => {
    w.ctx.dns = { ...w.ctx.dns, lookup: async (h) => (answers[h] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) };
  };
  const PRO_DEFAULT = [{ ...PLANS[1], default: true }];

  it('knows private, local and metadata addresses', () => {
    const inside = ['127.0.0.1', '10.1.2.3', '100.100.100.200', '169.254.169.254', '172.31.0.1', '192.168.1.1', '0.0.0.0', '255.255.255.255', '::1', '::', 'fd00:ec2::254', 'fe80::1%eth0', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:a00:1::1', '[::1]'];
    for (const ip of inside) expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '93.184.215.14', '172.32.0.1', '2606:4700::1111', '::ffff:808:808', '64:ff9b::808:808']) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it('refuses an OpenAI-compatible base URL on a private network, when saved and before each request', async () => {
    const w = makeWorld();
    enableBilling(w, PRO_DEFAULT);
    dns(w, { 'llm.public.dev': ['93.184.215.14'], 'internal.corp.dev': ['10.0.0.5'] });
    const api = await makeApi(w);
    await api.register('Acme');
    const make = (baseUrl: string) => api.call('POST', '/api/integrations', { kind: 'ai', provider: 'openai_compat', credentials: { apiKey: 'sk-test-key-123' }, settings: { baseUrl, writerModel: 'gpt-test' } });
    for (const url of ['http://169.254.169.254/latest', 'http://localhost:11434/v1', 'http://[::1]:8080/v1', 'https://internal.corp.dev/v1', 'https://nowhere.dev/v1']) {
      const r = await make(url);
      expect(r.status, url).toBe(400);
      expect(r.body.error).toMatch(/^settings\.baseUrl: /);
    }
    const ok = await make('https://llm.public.dev/v1');
    expect(ok.status).toBe(200);
    expect((await api.call('PATCH', `/api/integrations/${ok.body.id}`, { settings: { baseUrl: 'http://192.168.0.10/v1' } })).status).toBe(400);
    // The name later points inside as well (DNS changed after saving): the request is never made.
    const fetch = fakeFetch([{ url: /models$/, reply: () => ({ json: { data: [] } }) }]);
    w.ctx.fetch = fetch;
    expect((await api.call('POST', `/api/integrations/${ok.body.id}/test`)).body.ok).toBe(true);
    dns(w, { 'llm.public.dev': ['93.184.215.14', '127.0.0.1'] });
    const r = await api.call('POST', `/api/integrations/${ok.body.id}/test`);
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/private or local network/);
    expect(fetch.calls).toHaveLength(1);
  });

  it('allows local hosts when billing is off (self-hosted)', async () => {
    const api = await makeApi();
    await api.register('Solo');
    const r = await api.call('POST', '/api/integrations', { kind: 'ai', provider: 'openai_compat', settings: { baseUrl: 'http://localhost:11434/v1', writerModel: 'llama3' } });
    expect(r.status).toBe(200);
    const mb = { name: 'Relay', fromEmail: 'me@solo.dev', smtp: { host: '127.0.0.1', port: 25 }, imap: { host: 'localhost', port: 143 } };
    expect((await api.call('POST', '/api/mailboxes', mb)).status).toBe(200);
  });

  it('refuses private mail servers and connects to the address it checked', async () => {
    const w = makeWorld();
    enableBilling(w, PRO_DEFAULT);
    dns(w, { 'smtp.sender.dev': ['93.184.215.14'], 'imap.sender.dev': ['93.184.215.15'], 'mail.lan.dev': ['192.168.1.20'] });
    const api = await makeApi(w);
    await api.register('Acme');
    const smtp = { host: 'smtp.sender.dev', port: 587, user: 'sara@sender.dev', pass: 'pw-123456789' };
    const imap = { host: 'imap.sender.dev', port: 993, secure: true, user: 'sara@sender.dev', pass: 'pw-123456789' };
    const base = { name: 'Sara', fromEmail: 'sara@sender.dev', smtp, imap };
    expect((await api.call('POST', '/api/mailboxes', { ...base, smtp: { ...smtp, host: '127.0.0.1' } })).body.error).toMatch(/^smtp: 127\.0\.0\.1 is on a private/);
    expect((await api.call('POST', '/api/mailboxes', { ...base, imap: { ...imap, host: 'mail.lan.dev' } })).body.error).toMatch(/^imap: mail\.lan\.dev is on a private/);
    const mb = (await api.call('POST', '/api/mailboxes', base)).body;
    expect(mb.id).toBeTruthy();
    expect((await api.call('PATCH', `/api/mailboxes/${mb.id}`, { smtp: { ...smtp, host: '10.0.0.1' } })).status).toBe(400);

    // SMTP and IMAP connect to the checked address; the name stays for TLS.
    const seen: { host: string; address?: string }[] = [];
    w.ctx.imap = (cfg) => (seen.push(cfg), fakeImap(() => []));
    const verified: unknown[] = [];
    mailerOf(w).verify = async (t) => (verified.push(t), { ok: true, message: 'ok' });
    expect((await api.call('POST', `/api/mailboxes/${mb.id}/test`)).body).toMatchObject({ smtp: { ok: true }, imap: { ok: true } });
    expect(verified[0]).toMatchObject({ host: 'smtp.sender.dev', address: '93.184.215.14' });
    expect(seen[0]).toMatchObject({ host: 'imap.sender.dev', address: '93.184.215.15' });
    // The saved settings never hold the address.
    const saved = w.ctx.db.get<{ smtp_enc: string }>('SELECT smtp_enc FROM mailboxes WHERE id = ?', [mb.id])!.smtp_enc;
    expect(JSON.parse(w.ctx.sealer.open(saved)!).address).toBeUndefined();
    // The names later point inside: nothing connects.
    dns(w, { 'smtp.sender.dev': ['10.0.0.9'], 'imap.sender.dev': ['169.254.169.254'] });
    const r = (await api.call('POST', `/api/mailboxes/${mb.id}/test`)).body;
    expect(r.smtp).toMatchObject({ ok: false, message: expect.stringMatching(/private or local network/) });
    expect(r.imap).toMatchObject({ ok: false, message: expect.stringMatching(/private or local network/) });
    expect(verified).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it('keeps account-level SMTP from going around the mailbox limit', async () => {
    const w = makeWorld();
    enableBilling(w, [{ ...PLANS[0], limits: limits({ linkedinAccounts: 10, mailboxes: 1 }) }]);
    const api = await makeApi(w);
    const owner = await api.register('Acme');
    const smtp = { host: 'smtp.acme.dev', port: 587, user: 'a@acme.dev', pass: 'pw', from: 'a@acme.dev' };
    const r = await api.call('POST', '/api/accounts', { ...account('One'), smtp });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Add a mailbox/);
    const a = (await api.call('POST', '/api/accounts', account('One'))).body;
    expect((await api.call('PATCH', `/api/accounts/${a.id}`, { smtp })).status).toBe(400);
    expect((await api.call('PATCH', `/api/accounts/${a.id}`, { smtp: null })).status).toBe(200);

    // Accounts that got SMTP settings before billing was on become mailboxes only up to the plan's limit.
    const sealed = w.ctx.sealer.seal(JSON.stringify(smtp));
    for (const name of ['L1', 'L2', 'L3']) w.ctx.db.insert('accounts', { workspace_id: owner.workspaceId, name, driver: 'simulator', timezone: 'UTC', smtp_enc: sealed, created_at: 1 });
    ensureLegacyMailboxes(w.ctx);
    expect(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mailboxes WHERE workspace_id = ?', [owner.workspaceId])!.n).toBe(1);
  });
});
