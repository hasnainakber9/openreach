import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import type { Ctx } from './context.js';
import { HttpError } from './http.js';
import { accountRoutes } from './routes/accounts.js';
import { authRoutes, SESSION_COOKIE, sessionUser } from './routes/auth.js';
import { campaignRoutes } from './routes/campaigns.js';
import { inboxRoutes } from './routes/inbox.js';
import { leadRoutes } from './routes/leads.js';
import { settingsRoutes } from './routes/settings.js';

const PUBLIC = new Set(['/api/auth/status', '/api/auth/login', '/api/auth/register', '/api/health']);

export async function buildApp(ctx: Ctx, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 25 * 1024 * 1024 });
  await app.register(cookie);

  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || PUBLIC.has(path)) return;
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
