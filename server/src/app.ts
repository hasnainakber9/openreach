import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { PlanLimitError } from './billing/limits.js';
import type { TrustProxy } from './config.js';
import type { Ctx } from './context.js';
import { HttpError } from './http.js';
import { accountRoutes } from './routes/accounts.js';
import { agencyRoutes } from './routes/agency.js';
import { aiRoutes } from './routes/ai.js';
import { authRoutes, SESSION_COOKIE, sessionUser } from './routes/auth.js';
import { billingRoutes } from './routes/billing.js';
import { campaignRoutes } from './routes/campaigns.js';
import { crmRoutes } from './routes/crm.js';
import { enrichmentRoutes } from './routes/enrichment.js';
import { inboxRoutes } from './routes/inbox.js';
import { integrationRoutes } from './routes/integrations.js';
import { inviteRoutes } from './routes/invites.js';
import { jobRoutes } from './routes/jobs.js';
import { leadRoutes } from './routes/leads.js';
import { mailboxRoutes } from './routes/mailboxes.js';
import { pipelineRoutes } from './routes/pipeline.js';
import { publicRoutes } from './routes/public.js';
import { settingsRoutes } from './routes/settings.js';
import { taskRoutes } from './routes/tasks.js';
import { twilioRoutes } from './messaging/twilio-webhook.js';

// /api/branding reads the session cookie itself: the sign-in page needs it before anyone is signed in.
const PUBLIC = new Set(['/api/auth/status', '/api/auth/login', '/api/auth/register', '/api/health', '/api/branding']);
// Unauthenticated endpoints (unsubscribe, tracking, provider callbacks) identify the tenant through
// a signed token or a verified signature, never a client-supplied workspace id.
const isPublic = (path: string) => PUBLIC.has(path) || path.startsWith('/api/public/');
// Form bodies are what a cross-site <form> can send without a CORS preflight, so the API takes JSON
// only. Forms are accepted outside /api (the unsubscribe page) and on provider callbacks listed here.
// Never add a route that signs someone in or acts as the session user.
const FORM_PREFIXES = ['/api/public/twilio/'];
const acceptsForm = (path: string) => !path.startsWith('/api/') || FORM_PREFIXES.some((p) => path.startsWith(p));

// What the read-only `client` role may call (route patterns). Everything else is 403, so a route added
// later is closed to clients until it is listed here.
export const CLIENT_ALLOWED = new Set([
  'GET /api/auth/me',
  'GET /api/workspaces',
  'GET /api/branding',
  'GET /api/health',
  'GET /api/analytics',
  'GET /api/activity',
  'GET /api/campaigns',
  'GET /api/campaigns/:id',
  'GET /api/campaigns/:id/leads',
  'GET /api/campaigns/:id/variants',
  'GET /api/inbox',
  'GET /api/inbox/:id',
  'GET /api/pipeline/stages',
  'GET /api/pipeline/board',
  'GET /api/tags',
  'POST /api/auth/logout',
  'POST /api/auth/password',
  'POST /api/workspaces/switch',
]);

export interface RouteInfo {
  method: string;
  url: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    // Every registered route (tests walk it to check the client allowlist).
    apiRoutes: RouteInfo[];
  }
}

// Client IP (sign-in throttle) and Host (custom-domain branding) come from X-Forwarded-* only through
// trusted proxies. Fastify reads a bare hop count as "trust nothing", so hops become a trust function:
// the socket peer and the next n-1 entries from the right are proxies, the one after is the client.
export function fastifyTrustProxy(tp: TrustProxy): false | string[] | ((addr: string, i: number) => boolean) {
  if (tp === false || tp === 0) return false;
  if (typeof tp === 'number') return (_addr, i) => i < tp;
  return tp;
}

export async function buildApp(ctx: Ctx, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 25 * 1024 * 1024, trustProxy: fastifyTrustProxy(ctx.config.trustProxy) });
  const routes: RouteInfo[] = [];
  app.decorate('apiRoutes', routes);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) routes.push({ method, url: r.url });
  });
  await app.register(cookie);
  // HTML forms and provider callbacks (one-click unsubscribe, Twilio) post form-encoded bodies; the
  // onRequest hook refuses them everywhere else.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0];
    if (!acceptsForm(path) && req.headers['content-type']?.toLowerCase().startsWith('application/x-www-form-urlencoded')) throw new HttpError(415, 'Send JSON');
    if (!path.startsWith('/api/') || isPublic(path)) return;
    const u = sessionUser(ctx, req.cookies[SESSION_COOKIE]);
    if (!u) throw new HttpError(401, 'Not signed in');
    req.user = u;
  });

  // Clients (read-only portal users) only reach the allowlist. Matched on the route pattern, so ids in
  // the path can't change the answer.
  app.addHook('preHandler', async (req) => {
    if (req.user?.role !== 'client') return;
    const pattern = req.routeOptions.url;
    if (!pattern) return;
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (!CLIENT_ALLOWED.has(`${method} ${pattern}`)) throw new HttpError(403, 'Your access is read-only');
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, details: err.details });
    // Monthly plan credits used up somewhere a route didn't catch it: still the upgrade prompt, not a 500.
    if (err instanceof PlanLimitError) return reply.status(402).send({ error: err.message, details: err.details });
    if (err.validation || err.statusCode === 400) return reply.status(400).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    req.log.error(err);
    console.error(err);
    return reply.status(500).send({ error: 'Something went wrong on the server' });
  });

  app.get('/api/health', async () => ({ ok: true, time: ctx.clock.now(), demoSpeed: ctx.config.demoSpeed }));

  authRoutes(app, ctx);
  accountRoutes(app, ctx);
  leadRoutes(app, ctx);
  enrichmentRoutes(app, ctx);
  campaignRoutes(app, ctx);
  inboxRoutes(app, ctx);
  settingsRoutes(app, ctx);
  integrationRoutes(app, ctx);
  jobRoutes(app, ctx);
  aiRoutes(app, ctx);
  mailboxRoutes(app, ctx);
  taskRoutes(app, ctx);
  pipelineRoutes(app, ctx);
  agencyRoutes(app, ctx);
  crmRoutes(app, ctx);
  // Plans and Stripe (hosted installs), including Stripe's webhook (no session; verified by its signature).
  billingRoutes(app, ctx);
  // Invite management, plus the public invite pages' API (token-identified, no session needed).
  inviteRoutes(app, ctx);
  // Inbound SMS/WhatsApp (no session; verified by Twilio's signature).
  twilioRoutes(app, ctx);
  // Unsubscribe and tracking links (outside /api, no session); registered before the SPA fallback.
  publicRoutes(app, ctx);

  // Serve the built web app, falling back to index.html for client-side routes.
  if (existsSync(ctx.config.webDist)) {
    await app.register(fastifyStatic, { root: ctx.config.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
