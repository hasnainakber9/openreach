import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { allPlans, billingEnabled, billingRoot, currentPlan, LIVE_STATUSES, subscriptionOf, usageReport } from '../billing/limits.js';
import { callStripe, ensureRow, handleStripeEvent, updateSubscription, verifyStripeEvent, type StripeLike } from '../billing/stripe.js';
import type { Ctx } from '../context.js';
import { HttpError, parse, user } from '../http.js';
import { directRole, workspaceRow } from '../services/memberships.js';

// Plan, usage and Stripe Checkout / Customer Portal for the billing root (a standalone or agency workspace;
// client workspaces bill through their agency), plus Stripe's webhook.

export const STRIPE_WEBHOOK_PATH = '/api/public/stripe/webhook';
// Longer than the Stripe calls of one checkout start can take (each times out well before).
const CHECKOUT_CLAIM_MS = 2 * 60_000;

export function billingRoutes(app: FastifyInstance, ctx: Ctx) {
  // Only an owner of the paying workspace. Owning a client workspace (directly or through the agency's
  // role) is not enough to see or change the agency's subscription.
  const requireRootOwner = (req: FastifyRequest) => {
    const u = user(req);
    const root = billingRoot(ctx, u.workspace_id);
    if (directRole(ctx, u.id, root) !== 'owner') throw new HttpError(403, 'Only the owner of the paying workspace can manage billing');
    return { u, root };
  };
  const requireStripe = () => {
    if (!ctx.stripe) throw new HttpError(409, 'Billing is not enabled on this server');
    return ctx.stripe;
  };
  // Stripe sends people back here after Checkout and the portal.
  const returnUrl = (status?: string) => {
    if (!ctx.config.publicUrl) throw new HttpError(409, 'Set PUBLIC_URL on the server so Stripe can send people back after paying');
    return `${ctx.config.publicUrl}/billing${status ? `?status=${status}` : ''}`;
  };
  // The workspace's one Stripe customer, created before its first Checkout, so every subscription it ever
  // starts shows in the same portal.
  const customerOf = async (stripe: StripeLike, root: number, email: string) => {
    const saved = ensureRow(ctx, root).stripe_customer_id;
    if (saved) return saved;
    const c = await callStripe(() => stripe.createCustomer({ workspaceId: root, email, name: workspaceRow(ctx, root)?.name ?? '' }));
    // A webhook may have stored one meanwhile; the first one stays.
    ctx.db.run('UPDATE subscriptions SET stripe_customer_id = ?, updated_at = ? WHERE workspace_id = ? AND stripe_customer_id IS NULL', [c.id, ctx.clock.now(), root]);
    return subscriptionOf(ctx, root)!.stripe_customer_id!;
  };
  // One checkout start at a time per workspace (two in parallel would each leave a payable page). Claimed in
  // the database, so it holds across instances sharing Postgres; the expiry frees a claim a crash left behind.
  const claimCheckout = (root: number) => {
    const now = Date.now();
    ensureRow(ctx, root);
    return (
      ctx.db.run('UPDATE subscriptions SET checkout_starting_until = ? WHERE workspace_id = ? AND (checkout_starting_until IS NULL OR checkout_starting_until < ?)', [
        now + CHECKOUT_CLAIM_MS,
        root,
        now,
      ]).changes > 0
    );
  };
  const releaseCheckout = (root: number) => void ctx.db.run('UPDATE subscriptions SET checkout_starting_until = NULL WHERE workspace_id = ?', [root]);

  app.get('/api/billing', async (req) => {
    const { root } = requireRootOwner(req);
    const sub = subscriptionOf(ctx, root);
    const plan = billingEnabled(ctx) ? currentPlan(ctx, root) : null;
    const plans = allPlans(ctx);
    return {
      enabled: billingEnabled(ctx),
      workspaceName: workspaceRow(ctx, root)?.name ?? '',
      // The plan whose limits apply now (the default plan while nothing is paid for).
      plan: plan ? { id: plan.id, name: plan.name } : null,
      // The plan of the subscription on file, whatever its status.
      subscribedPlanId: sub?.plan_id ?? null,
      status: sub?.status ?? 'none',
      currentPeriodEnd: sub?.current_period_end ?? null,
      cancelAtPeriodEnd: !!sub?.cancel_at_period_end,
      hasCustomer: !!sub?.stripe_customer_id,
      canCheckout: !LIVE_STATUSES.includes(sub?.status ?? 'none'),
      // A second live subscription was seen (both bill); the owner should cancel one in the portal.
      duplicateSubscription: !!sub?.extra_subscription_id,
      webhookConfigured: !!ctx.config.stripeWebhookSecret,
      publicUrlConfigured: !!ctx.config.publicUrl,
      plans: plans.map((p) => ({ id: p.id, name: p.name, default: p.default, purchasable: !!p.priceId, limits: p.limits })),
      usage: usageReport(ctx, root),
    };
  });

  app.post('/api/billing/checkout', async (req) => {
    const { u, root } = requireRootOwner(req);
    const stripe = requireStripe();
    const { planId } = parse(z.object({ planId: z.string().min(1).max(40) }), req.body);
    const plan = allPlans(ctx).find((p) => p.id === planId);
    if (!plan) throw new HttpError(404, 'Plan not found');
    if (!plan.priceId) throw new HttpError(400, `${plan.name} is free and needs no checkout`);
    const successUrl = returnUrl('success');
    const cancelUrl = returnUrl('canceled');
    if (!claimCheckout(root)) throw new HttpError(409, 'A checkout is already starting. Try again in a moment.');
    try {
      const sub = subscriptionOf(ctx, root);
      if (sub && LIVE_STATUSES.includes(sub.status)) throw new HttpError(409, 'You already have a subscription. Use "Manage billing" to change plans.');
      const customerId = await customerOf(stripe, root, u.email);
      // The page from an earlier Checkout (another tab, or Back) stays payable for a day: close it first.
      if (sub?.checkout_session_id) {
        if ((await callStripe(() => stripe.closeCheckoutSession(sub.checkout_session_id!))) === 'complete') {
          throw new HttpError(409, 'Your last checkout was paid. Your plan changes here as soon as Stripe confirms it.');
        }
        updateSubscription(ctx, root, { checkout_session_id: null, updated_at: ctx.clock.now() });
      }
      const session = await callStripe(() => stripe.createCheckoutSession({ workspaceId: root, planId: plan.id, priceId: plan.priceId!, customerId, successUrl, cancelUrl }));
      updateSubscription(ctx, root, { checkout_session_id: session.id, updated_at: ctx.clock.now() });
      if (!session.url) throw new HttpError(422, 'Stripe did not return a checkout page');
      return { url: session.url };
    } finally {
      releaseCheckout(root);
    }
  });

  app.post('/api/billing/portal', async (req) => {
    const { root } = requireRootOwner(req);
    const stripe = requireStripe();
    const customerId = subscriptionOf(ctx, root)?.stripe_customer_id;
    if (!customerId) throw new HttpError(409, 'There is no billing account yet. Choose a plan first.');
    const session = await callStripe(() => stripe.createPortalSession({ customerId, returnUrl: returnUrl() }));
    return { url: session.url };
  });

  // The signature covers the exact bytes Stripe sent, so this route keeps the body as a string: its own
  // scope replaces the JSON parser (the rest of the API still gets parsed JSON).
  void app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    scope.post(STRIPE_WEBHOOK_PATH, async (req) => {
      if (!ctx.stripe) throw new HttpError(404, 'Billing is not enabled on this server');
      const secret = ctx.config.stripeWebhookSecret;
      // Never act on events we can't verify.
      if (!secret) throw new HttpError(503, 'STRIPE_WEBHOOK_SECRET is not set on the server');
      const signature = req.headers['stripe-signature'];
      if (typeof signature !== 'string' || typeof req.body !== 'string') throw new HttpError(400, 'Invalid Stripe signature');
      const event = verifyStripeEvent(req.body, signature, secret);
      const result = handleStripeEvent(ctx, event);
      return { received: true, result };
    });
  });
}
