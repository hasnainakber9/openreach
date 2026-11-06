import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertWithinPlan, billingEnabled, withPlanLock } from '../billing/limits.js';
import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import { accountLimits, schedule, usage } from '../engine/engine.js';
import { isValidTimezone, isWorkingTime, nextWorkingTime } from '../engine/limits.js';
import { HttpError, idParam, notFound, parse, requireWriter, user } from '../http.js';
import { ensureLegacyMailboxes } from '../mail/mailboxes.js';
import { callLinkedIn } from '../services/linkedin-calls.js';
import { releaseUnstartedLeads, retireAccount } from '../services/rotation.js';
import type { AccountRow } from '../types.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const limitsSchema = z.record(z.string(), z.number().int().min(0).max(1000));
const smtpSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  user: z.string().default(''),
  pass: z.string().default(''),
  from: z.string().default(''),
});

const accountBody = z.object({
  name: z.string().min(1).max(100),
  driver: z.enum(['simulator', 'playwright']).default('playwright'),
  liAt: z.string().min(10).max(2000).optional(),
  proxyUrl: z.string().url().nullable().optional(),
  timezone: z.string().refine(isValidTimezone, 'Unknown time zone').default('UTC'),
  workDays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
  workStart: hhmm.default('09:00'),
  workEnd: hhmm.default('18:00'),
  limits: limitsSchema.default({}),
  delayMinSec: z.number().int().min(5).max(3600).default(60),
  delayMaxSec: z.number().int().min(5).max(7200).default(240),
  warmup: z.boolean().default(true),
  smtp: smtpSchema.nullable().optional(),
});

export function serializeAccount(ctx: Ctx, a: AccountRow) {
  const now = ctx.clock.now();
  const sched = schedule(a);
  const smtp = ctx.sealer.open(a.smtp_enc);
  return {
    id: a.id,
    name: a.name,
    driver: a.driver,
    status: a.status,
    statusMessage: a.status_message,
    hasSession: !!a.session_enc,
    proxyUrl: a.proxy_url ? a.proxy_url.replace(/\/\/([^:@/]+):[^@/]+@/, '//$1:***@') : null,
    timezone: a.timezone,
    workDays: sched.work_days,
    workStart: a.work_start,
    workEnd: a.work_end,
    limits: json(a.limits, {}),
    effectiveLimits: accountLimits(ctx, a),
    usedToday: usage(ctx, a),
    delayMinSec: a.delay_min_sec,
    delayMaxSec: a.delay_max_sec,
    warmup: !!a.warmup,
    smtp: smtp ? { ...JSON.parse(smtp), pass: '' } : null,
    cooldowns: json(a.cooldowns, {}),
    linkedinName: a.linkedin_name,
    linkedinUrl: a.linkedin_url,
    working: isWorkingTime(now, sched),
    nextWorkingAt: nextWorkingTime(now, sched),
    nextActionAt: a.next_action_at,
    lastSyncAt: a.last_sync_at,
    createdAt: a.created_at,
  };
}

export function accountRoutes(app: FastifyInstance, ctx: Ctx) {
  const load = (req: any): AccountRow => {
    const { id } = parse(idParam, req.params);
    return ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]) ?? notFound('Account');
  };

  const columns = (b: Partial<z.infer<typeof accountBody>>, existing?: AccountRow) => {
    const out: Record<string, any> = {};
    // Hosted installs: email goes through mailboxes only, which the plan counts and whose hosts are checked.
    // Account-level SMTP (from before mailboxes) would bypass both; clearing it is still allowed.
    if (b.smtp && billingEnabled(ctx)) throw new HttpError(400, 'smtp: Add a mailbox under Mailboxes instead. SMTP settings on an account are not available on this server');
    if (b.name !== undefined) out.name = b.name;
    if (b.driver !== undefined) out.driver = b.driver;
    if (b.liAt) {
      out.session_enc = ctx.sealer.seal(b.liAt.trim());
      out.status = 'active';
      out.status_message = null;
    }
    if (b.proxyUrl !== undefined) out.proxy_url = b.proxyUrl;
    if (b.timezone !== undefined) out.timezone = b.timezone;
    if (b.workDays !== undefined) out.work_days = JSON.stringify([...new Set(b.workDays)].sort());
    if (b.workStart !== undefined) out.work_start = b.workStart;
    if (b.workEnd !== undefined) out.work_end = b.workEnd;
    if (b.limits !== undefined) out.limits = JSON.stringify(b.limits);
    if (b.delayMinSec !== undefined) out.delay_min_sec = b.delayMinSec;
    if (b.delayMaxSec !== undefined) out.delay_max_sec = b.delayMaxSec;
    if (b.warmup !== undefined) out.warmup = b.warmup ? 1 : 0;
    if (b.smtp !== undefined) {
      // A blank password on edit keeps the saved one.
      const prev = existing ? JSON.parse(ctx.sealer.open(existing.smtp_enc) ?? 'null') : null;
      out.smtp_enc = b.smtp ? ctx.sealer.seal(JSON.stringify({ ...b.smtp, pass: b.smtp.pass || prev?.pass || '' })) : null;
    }
    const min = out.delay_min_sec ?? existing?.delay_min_sec;
    const max = out.delay_max_sec ?? existing?.delay_max_sec;
    if (min != null && max != null && min > max) throw new HttpError(400, 'Minimum delay must not exceed the maximum');
    return out;
  };

  // Email goes through mailboxes now: SMTP set on an account (older API clients) becomes, or updates, the
  // account's legacy mailbox right away instead of waiting for the next restart's migration.
  const syncLegacyMailbox = (accountId: number) => {
    const a = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [accountId])!;
    const smtp = a.smtp_enc ? JSON.parse(ctx.sealer.open(a.smtp_enc) ?? 'null') : null;
    if (!smtp?.host) return;
    const sealed = ctx.sealer.seal(JSON.stringify({ host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, pass: smtp.pass }));
    if (!ctx.db.run('UPDATE mailboxes SET smtp_enc = ? WHERE legacy_account_id = ?', [sealed, a.id]).changes) ensureLegacyMailboxes(ctx);
  };

  app.get('/api/accounts', async (req) => {
    return ctx.db.all<AccountRow>('SELECT * FROM accounts WHERE workspace_id = ? ORDER BY id', [user(req).workspace_id]).map((a) => serializeAccount(ctx, a));
  });

  app.get('/api/accounts/:id', async (req) => serializeAccount(ctx, load(req)));

  app.post('/api/accounts', async (req) => {
    requireWriter(req);
    const body = parse(accountBody, req.body);
    if (body.driver === 'playwright' && !body.liAt) throw new HttpError(400, 'A LinkedIn session cookie (li_at) is required');
    const ws = user(req).workspace_id;
    const id = withPlanLock(ctx, ws, () => {
      assertWithinPlan(ctx, ws, 'linkedinAccounts');
      return ctx.db.insert('accounts', { workspace_id: ws, created_at: ctx.clock.now(), ...columns(body) });
    });
    if (body.smtp) syncLegacyMailbox(id);
    return serializeAccount(ctx, ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [id])!);
  });

  app.patch('/api/accounts/:id', async (req) => {
    requireWriter(req);
    const a = load(req);
    const body = parse(accountBody.partial(), req.body);
    ctx.db.update('accounts', a.id, columns(body, a));
    if (body.smtp) syncLegacyMailbox(a.id);
    return serializeAccount(ctx, ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [a.id])!);
  });

  app.delete('/api/accounts/:id', async (req) => {
    requireWriter(req);
    const a = load(req);
    await ctx.drivers.drop(a.id);
    // Only campaigns left without any sender pause; the others carry on from their remaining accounts.
    ctx.db.tx(() => {
      retireAccount(ctx, a.id);
      ctx.db.run('DELETE FROM accounts WHERE id = ?', [a.id]);
      ctx.db.run('DELETE FROM sim_people WHERE account_id = ?', [a.id]);
    });
    return { ok: true };
  });

  app.post('/api/accounts/:id/pause', async (req) => {
    requireWriter(req);
    const a = load(req);
    ctx.db.tx(() => {
      ctx.db.run("UPDATE accounts SET status = 'paused' WHERE id = ?", [a.id]);
      // Leads it hasn't contacted yet can go out from the campaign's other senders meanwhile (not those connected to it).
      releaseUnstartedLeads(ctx, a.id);
    });
    return { ok: true };
  });

  app.post('/api/accounts/:id/resume', async (req) => {
    requireWriter(req);
    const a = load(req);
    if (a.driver === 'playwright' && !a.session_enc) throw new HttpError(400, 'Add a LinkedIn session cookie first');
    ctx.db.run("UPDATE accounts SET status = 'active', status_message = NULL, cooldowns = '{}' WHERE id = ?", [a.id]);
    return { ok: true };
  });

  // Opens LinkedIn with the saved session and records whose account it is (on the instance that holds the
  // LinkedIn sessions, see callLinkedIn).
  app.post('/api/accounts/:id/check', async (req) => {
    const a = load(req);
    return callLinkedIn(ctx, a.workspace_id, { op: 'check', accountId: a.id });
  });

  app.post('/api/accounts/:id/sync', async (req) => {
    const a = load(req);
    return callLinkedIn(ctx, a.workspace_id, { op: 'sync', accountId: a.id });
  });
}
