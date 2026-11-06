import Stripe from 'stripe';
import { DAY } from '../clock.js';
import type { Ctx } from '../context.js';
import { HttpError } from '../http.js';
import { allPlans, LIVE_STATUSES, PAID_STATUSES, subscriptionOf, type SubscriptionRow } from './limits.js';

// Stripe Checkout (subscribe), the Customer Portal (change plan, card, cancel) and the webhook that keeps one
// `subscriptions` row per billing root current. Written from Stripe's public docs
// (https://docs.stripe.com/billing/subscriptions/build-subscriptions, /webhooks) and tested only against
// constructed events and a stubbed client, never the live API.

export interface CheckoutInput {
  workspaceId: number;
  planId: string;
  priceId: string;
  // Always the workspace's one customer, so every subscription shows (and can be canceled) in one portal.
  customerId: string;
  successUrl: string;
  cancelUrl: string;
}

// The calls we make. Tests stub this; the webhook check never needs it (it is local HMAC).
export interface StripeLike {
  createCustomer(input: { workspaceId: number; email: string; name: string }): Promise<{ id: string }>;
  createCheckoutSession(input: CheckoutInput): Promise<{ id: string; url: string | null }>;
  // Expires a Checkout session that is still open, so its page can't be paid any more. 'complete': it was
  // already paid (the webhook may not have arrived yet).
  closeCheckoutSession(id: string): Promise<'closed' | 'complete'>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
}

export function stripeClient(ctx: Ctx, secretKey: string): StripeLike {
  const stripe = new Stripe(secretKey, {
    // Through ctx.fetch like every other outbound call, read lazily so tests can swap it.
    httpClient: Stripe.createFetchHttpClient(((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ctx.fetch(input, init)) as typeof fetch),
    maxNetworkRetries: 1,
    timeout: 15_000,
  });
  return {
    async createCustomer(i) {
      const c = await stripe.customers.create({ email: i.email, name: i.name || undefined, metadata: { workspace_id: String(i.workspaceId) } });
      return { id: c.id };
    },
    async createCheckoutSession(i) {
      const ws = String(i.workspaceId);
      const s = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: i.priceId, quantity: 1 }],
        client_reference_id: ws,
        metadata: { workspace_id: ws, plan_id: i.planId },
        // Subscription events can arrive before checkout.session.completed; this lets them find the workspace.
        subscription_data: { metadata: { workspace_id: ws } },
        customer: i.customerId,
        success_url: i.successUrl,
        cancel_url: i.cancelUrl,
      });
      return { id: s.id, url: s.url };
    },
    async closeCheckoutSession(id) {
      const s = await stripe.checkout.sessions.retrieve(id);
      if (s.status === 'open') return (await stripe.checkout.sessions.expire(id)).status === 'complete' ? 'complete' : 'closed';
      return s.status === 'complete' ? 'complete' : 'closed';
    },
    async createPortalSession(i) {
      const s = await stripe.billingPortal.sessions.create({ customer: i.customerId, return_url: i.returnUrl });
      return { url: s.url };
    },
  };
}

// Stripe failures in routes: a 422 with Stripe's own message (it names ids, never keys).
export async function callStripe<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Stripe.errors.StripeError) throw new HttpError(422, `Stripe refused the request: ${e.message}`);
    throw e;
  }
}

export interface StripeEventLike {
  id: string;
  type: string;
  // Seconds.
  created: number;
  data: { object: any };
}

// Checks the Stripe-Signature header against the raw body (bytes as received; re-serialized JSON would not
// match) with the official library. Old timestamps are refused too (5-minute tolerance), against replays.
export function verifyStripeEvent(rawBody: string, signature: string, secret: string): StripeEventLike {
  try {
    return Stripe.webhooks.constructEvent(rawBody, signature, secret) as unknown as StripeEventLike;
  } catch {
    throw new HttpError(400, 'Invalid Stripe signature');
  }
}

export type EventResult = 'processed' | 'duplicate' | 'stale' | 'ignored';

const HANDLED = new Set(['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed']);

const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : null);

// Billing roots only: a client workspace never has its own subscription.
function rootFromMetadata(ctx: Ctx, value: unknown): number | null {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return ctx.db.get<{ id: number }>('SELECT id FROM workspaces WHERE id = ? AND parent_id IS NULL', [id])?.id ?? null;
}

// The workspace an event is about. Ids we already stored win over metadata.
function findRoot(ctx: Ctx, refs: { customer?: string | null; subscription?: string | null; metadata?: unknown }): number | null {
  if (refs.customer) {
    const r = ctx.db.get<{ workspace_id: number }>('SELECT workspace_id FROM subscriptions WHERE stripe_customer_id = ?', [refs.customer]);
    if (r) return r.workspace_id;
  }
  if (refs.subscription) {
    const r = ctx.db.get<{ workspace_id: number }>('SELECT workspace_id FROM subscriptions WHERE stripe_subscription_id = ?', [refs.subscription]);
    if (r) return r.workspace_id;
  }
  return rootFromMetadata(ctx, refs.metadata);
}

// Keyed by workspace_id (the table has no id column, so ctx.db.update doesn't apply).
export function updateSubscription(ctx: Ctx, root: number, values: Record<string, string | number | null>) {
  const keys = Object.keys(values);
  ctx.db.run(`UPDATE subscriptions SET ${keys.map((k) => `${k} = $${k}`).join(', ')} WHERE workspace_id = $__ws`, { ...values, __ws: root });
}

export function ensureRow(ctx: Ctx, root: number): SubscriptionRow {
  ctx.db.run('INSERT INTO subscriptions (workspace_id, updated_at) VALUES (?, ?) ON CONFLICT (workspace_id) DO NOTHING', [root, ctx.clock.now()]);
  return subscriptionOf(ctx, root)!;
}

// A customer id belongs to one workspace (unique index); a mismatch is logged and left alone rather than
// failing the webhook, which Stripe would retry for days.
function customerFree(ctx: Ctx, root: number, customer: string | null) {
  if (!customer) return false;
  const other = ctx.db.get<{ workspace_id: number }>('SELECT workspace_id FROM subscriptions WHERE stripe_customer_id = ? AND workspace_id <> ?', [customer, root]);
  if (other) console.warn(`[billing] Stripe customer ${customer} already belongs to workspace ${other.workspace_id}; not linking it to ${root}`);
  return !other;
}

const planForPrice = (ctx: Ctx, priceId: string | null) => (priceId ? allPlans(ctx).find((p) => p.priceId === priceId) ?? null : null);

// Newer API versions keep the period on the items; older ones on the subscription.
function periodEnd(sub: any): number | null {
  const ends = [sub.current_period_end, ...((sub.items?.data ?? []) as any[]).map((i) => i?.current_period_end)].filter((v): v is number => typeof v === 'number');
  return ends.length ? Math.max(...ends) * 1000 : null;
}

// Two live subscriptions at once would bill twice. The one on file keeps applying; the other is only noted, so
// GET /api/billing can tell the owner to cancel one in the portal (both belong to the same customer).
function flagSecondSubscription(row: SubscriptionRow, other: string, patch: Record<string, string | number | null>) {
  if (row.extra_subscription_id === other) return;
  console.warn(`[billing] Workspace ${row.workspace_id} has a second live subscription ${other} besides ${row.stripe_subscription_id}`);
  patch.extra_subscription_id = other;
}

function onCheckoutCompleted(ctx: Ctx, event: StripeEventLike): EventResult {
  const s = event.data.object;
  if (s.mode !== 'subscription') return 'ignored';
  const customer = idOf(s.customer);
  const subscription = idOf(s.subscription);
  const root = rootFromMetadata(ctx, s.client_reference_id ?? s.metadata?.workspace_id) ?? findRoot(ctx, { customer, subscription });
  if (!root) return 'ignored';
  const row = ensureRow(ctx, root);
  const patch: Record<string, string | number | null> = { updated_at: ctx.clock.now() };
  if (row.checkout_session_id === s.id) patch.checkout_session_id = null;
  // The stored customer is never replaced: the portal opens it, so it must stay the one that holds the subscriptions.
  if (customer && !row.stripe_customer_id && customerFree(ctx, root, customer)) patch.stripe_customer_id = customer;
  else if (customer && row.stripe_customer_id && row.stripe_customer_id !== customer) {
    console.warn(`[billing] Checkout ${s.id} used Stripe customer ${customer}, but workspace ${root} bills customer ${row.stripe_customer_id}; keeping the stored one`);
  }
  if (subscription && row.stripe_subscription_id && row.stripe_subscription_id !== subscription && LIVE_STATUSES.includes(row.status)) {
    flagSecondSubscription(row, subscription, patch);
  } else if (subscription && row.stripe_subscription_id !== subscription) {
    // The subscription's own events set its status and plan. Until they arrive, the plan bought here applies.
    const plan = allPlans(ctx).find((p) => p.id === s.metadata?.plan_id);
    const paid = s.payment_status === 'paid' || s.payment_status === 'no_payment_required';
    Object.assign(patch, { stripe_subscription_id: subscription, plan_id: plan?.id ?? null, status: paid ? 'active' : 'incomplete', cancel_at_period_end: 0 });
  }
  updateSubscription(ctx, root, patch);
  return 'processed';
}

function onSubscriptionChanged(ctx: Ctx, event: StripeEventLike): EventResult {
  const sub = event.data.object;
  const customer = idOf(sub.customer);
  const root = findRoot(ctx, { customer, subscription: sub.id, metadata: sub.metadata?.workspace_id });
  if (!root) return 'ignored';
  const row = ensureRow(ctx, root);
  if (event.created < row.last_event_at) return 'stale';
  const deleted = event.type === 'customer.subscription.deleted';
  const extra: Record<string, string | number | null> = {};
  if (row.stripe_subscription_id && row.stripe_subscription_id !== sub.id) {
    const live = !deleted && LIVE_STATUSES.includes(sub.status);
    // The second subscription ended: nothing left to warn about.
    if (!live && row.extra_subscription_id === sub.id) {
      updateSubscription(ctx, root, { extra_subscription_id: null, updated_at: ctx.clock.now() });
      return 'processed';
    }
    // Never swap one live subscription for another (the row would flip between them); note it for the owner.
    if (live && LIVE_STATUSES.includes(row.status)) {
      flagSecondSubscription(row, sub.id, extra);
      if (!Object.keys(extra).length) return 'ignored';
      updateSubscription(ctx, root, { ...extra, updated_at: ctx.clock.now() });
      return 'processed';
    }
    // News about an older subscription than the one on file. A paid one replaces an ended one (subscribed again).
    if (deleted || !PAID_STATUSES.includes(sub.status)) return 'ignored';
    if (row.extra_subscription_id === sub.id) extra.extra_subscription_id = null;
  }
  const patch: Record<string, string | number | null> = {
    ...extra,
    stripe_subscription_id: sub.id,
    current_period_end: periodEnd(sub),
    last_event_at: event.created,
    updated_at: ctx.clock.now(),
  };
  if (customer && !row.stripe_customer_id && customerFree(ctx, root, customer)) patch.stripe_customer_id = customer;
  if (deleted) Object.assign(patch, { status: 'canceled', plan_id: null, cancel_at_period_end: 0 });
  else {
    const priceId = idOf(sub.items?.data?.[0]?.price);
    const plan = planForPrice(ctx, priceId);
    if (!plan && priceId) console.warn(`[billing] Subscription ${sub.id} uses price ${priceId}, which no plan in BILLING_PLANS has`);
    // cancel_at: a cancellation scheduled from the portal on newer API versions.
    Object.assign(patch, { status: String(sub.status), plan_id: plan?.id ?? null, cancel_at_period_end: sub.cancel_at_period_end || sub.cancel_at ? 1 : 0 });
  }
  updateSubscription(ctx, root, patch);
  return 'processed';
}

function onPaymentFailed(ctx: Ctx, event: StripeEventLike): EventResult {
  const inv = event.data.object;
  // Older API versions put the subscription on the invoice; newer ones under parent.
  const subscription = idOf(inv.subscription) ?? idOf(inv.parent?.subscription_details?.subscription);
  // Only a failed renewal of the subscription on file. A one-off or proration invoice that fails leaves the
  // subscription active at Stripe, and no later event would set it back here.
  if (!subscription || inv.billing_reason !== 'subscription_cycle') return 'ignored';
  const root = findRoot(ctx, { customer: idOf(inv.customer), subscription });
  if (!root) return 'ignored';
  const row = subscriptionOf(ctx, root)!;
  if (event.created < row.last_event_at) return 'stale';
  if (subscription !== row.stripe_subscription_id) return 'ignored';
  if (!PAID_STATUSES.includes(row.status)) return 'ignored';
  updateSubscription(ctx, root, { status: 'past_due', last_event_at: event.created, updated_at: ctx.clock.now() });
  return 'processed';
}

// Applies a verified event. Each event id is handled once (Stripe redelivers until it gets a 2xx), in the same
// transaction as its effect, so a failure leaves it to be retried.
export function handleStripeEvent(ctx: Ctx, event: StripeEventLike): EventResult {
  if (!HANDLED.has(event.type)) return 'ignored';
  return ctx.db.tx(() => {
    const now = ctx.clock.now();
    if (!ctx.db.run('INSERT INTO stripe_events (id, type, received_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING', [event.id, event.type, now]).changes) return 'duplicate';
    // Stripe stops redelivering after three days; a month of ids is plenty.
    ctx.db.run('DELETE FROM stripe_events WHERE received_at < ?', [now - 30 * DAY]);
    if (event.type === 'checkout.session.completed') return onCheckoutCompleted(ctx, event);
    if (event.type === 'invoice.payment_failed') return onPaymentFailed(ctx, event);
    return onSubscriptionChanged(ctx, event);
  });
}
