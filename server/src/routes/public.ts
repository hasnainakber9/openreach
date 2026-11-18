import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { recordClick, recordOpen, verifyToken } from '../mail/tracking.js';
import { unsubscribeByToken } from '../mail/unsubscribe.js';

// Links inside campaign emails. They live outside /api, need no session, and identify the workspace
// only through the signed token. Nothing here reflects request input into the page.

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function page(reply: FastifyReply, status: number, title: string, body: string) {
  return reply
    .status(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('x-robots-tag', 'noindex')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
        '<style>body{font-family:system-ui,sans-serif;background:#f6f7f9;color:#1d2433;display:grid;place-items:center;min-height:100vh;margin:0}' +
        'main{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:32px;max-width:420px;margin:16px}h1{font-size:20px;margin:0 0 8px}' +
        'p{line-height:1.5;color:#4a5263}button{font:inherit;background:#1d4ed8;color:#fff;border:0;border-radius:8px;padding:10px 18px;cursor:pointer}</style>' +
        `</head><body><main>${body}</main></body></html>`,
    );
}

const tokenParam = z.object({ token: z.string().min(1).max(200) });

export function publicRoutes(app: FastifyInstance, ctx: Ctx) {
  // Mail scanners open links to check them, so the GET only asks; the button POSTs.
  app.get('/u/:token', async (req, reply) => {
    const { token } = tokenParam.parse(req.params);
    if (!verifyToken(ctx, 'u', token)) return page(reply, 404, 'Link not valid', '<h1>This link is not valid</h1><p>It may have been copied incompletely.</p>');
    return page(
      reply,
      200,
      'Unsubscribe',
      '<h1>Unsubscribe</h1><p>Press the button and you won’t receive any more emails from this sender.</p><form method="post"><button type="submit">Unsubscribe</button></form>',
    );
  });

  // The page's button and RFC 8058 one-click unsubscribe (List-Unsubscribe-Post) both land here.
  app.post('/u/:token', async (req, reply) => {
    const { token } = tokenParam.parse(req.params);
    const r = unsubscribeByToken(ctx, token);
    if (!r) return page(reply, 404, 'Link not valid', '<h1>This link is not valid</h1><p>It may have been copied incompletely.</p>');
    return page(reply, 200, 'Unsubscribed', '<h1>You’re unsubscribed</h1><p>You won’t receive any more emails from this sender.</p>');
  });

  app.get('/t/o/:token', async (req, reply) => {
    const { token } = tokenParam.parse(req.params);
    recordOpen(ctx, token);
    return reply.header('content-type', 'image/gif').header('cache-control', 'no-store, private').header('referrer-policy', 'no-referrer').send(PIXEL);
  });

  // Redirects only to the exact URL the link was signed for, so it can't be used as an open redirect.
  app.get('/t/c/:token', async (req, reply) => {
    const { token } = tokenParam.parse(req.params);
    const q = z.object({ u: z.string().max(4000).default(''), s: z.string().max(100).default('') }).parse(req.query);
    const to = recordClick(ctx, token, q.u, q.s);
    if (!to) return page(reply, 404, 'Link not valid', '<h1>This link is not valid</h1>');
    return reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').redirect(to, 302);
  });
}
