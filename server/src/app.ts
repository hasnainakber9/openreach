import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import type { Ctx } from './context.js';
import { HttpError } from './http.js';
import { accountRoutes } from './routes/accounts.js';
import { aiRoutes } from './routes/ai.js';
import { authRoutes, SESSION_COOKIE, sessionUser } from './routes/auth.js';
import { campaignRoutes } from './routes/campaigns.js';
import { inboxRoutes } from './routes/inbox.js';
import { integrationRoutes } from './routes/integrations.js';
import { jobRoutes } from './routes/jobs.js';
import { leadRoutes } from './routes/leads.js';
import { mailboxRoutes } from './routes/mailboxes.js';
import { publicRoutes } from './routes/public.js';
import { settingsRoutes } from './routes/settings.js';
import { taskRoutes } from './routes/tasks.js';
import { twilioRoutes } from './messaging/twilio-webhook.js';

const PUBLIC = new Set(['/api/auth/status', '/api/auth/login', '/api/auth/register', '/api/health']);
// Unauthenticated endpoints (unsubscribe, tracking, provider callbacks) identify the tenant through
// a signed token or a verified signature, never a client-supplied workspace id.
const isPublic = (path: string) => PUBLIC.has(path) || path.startsWith('/api/public/');
// Form bodies are what a cross-site <form> can send without a CORS preflight, so the API takes JSON
// only. Forms are accepted outside /api (the unsubscribe page) and on provider callbacks listed here.
// Never add a route that signs someone in or acts as the session user.
const FORM_PREFIXES = ['/api/public/twilio/'];
const acceptsForm = (path: string) => !path.startsWith('/api/') || FORM_PREFIXES.some((p) => path.startsWith(p));

export async function buildApp(ctx: Ctx, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 25 * 1024 * 1024 });
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

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, details: err.details });
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
  campaignRoutes(app, ctx);
  inboxRoutes(app, ctx);
  settingsRoutes(app, ctx);
  integrationRoutes(app, ctx);
  jobRoutes(app, ctx);
  aiRoutes(app, ctx);
  mailboxRoutes(app, ctx);
  taskRoutes(app, ctx);
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
