import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertWithinPlan } from '../billing/limits.js';
import type { Ctx } from '../context.js';
import { isValidTimezone } from '../engine/limits.js';
import { HttpError, idParam, notFound, parse, requireAdmin, requireWriter, user } from '../http.js';
import { checkDomain, isHostname } from '../mail/deliverability.js';
import { imapFor } from '../mail/imap.js';
import { syncJobKey } from '../mail/inbound.js';
import {
  emailDomain,
  isSimulated,
  MAILBOX_PRESETS,
  needsPublicUrl,
  releaseUnstartedMailboxLeads,
  retireMailbox,
  serializeMailbox,
  serverSettings,
  smtpTransport,
  type ServerSettings,
} from '../mail/mailboxes.js';
import { hostProblem, pinMailServer } from '../services/hosts.js';
import type { MailboxRow } from '../types.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const email = z
  .string()
  .trim()
  .max(320)
  .regex(/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/, 'Not an email address')
  .transform((s) => s.toLowerCase());
// Hostnames or IPv4 addresses only: no URLs, credentials or paths (these hosts are user-supplied).
const host = z
  .string()
  .trim()
  .toLowerCase()
  .refine((h) => isHostname(h) || h === 'localhost' || /^(\d{1,3}\.){3}\d{1,3}$/.test(h), 'Use a host name such as smtp.example.com');
const server = z.object({
  host,
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(false),
  user: z.string().trim().max(320).default(''),
  // Blank or omitted keeps the saved password; null clears it.
  pass: z.string().max(500).nullable().optional(),
});

const mailboxBody = z.object({
  name: z.string().trim().min(1).max(100),
  provider: z.enum(['smtp', 'simulated']).default('smtp'),
  preset: z.enum(['gmail', 'outlook', 'custom']).default('custom'),
  fromName: z.string().trim().max(100).default(''),
  fromEmail: email,
  replyTo: email.nullable().optional(),
  signature: z.string().max(2000).default(''),
  smtp: server.nullable().optional(),
  imap: server.nullable().optional(),
  timezone: z.string().refine(isValidTimezone, 'Unknown time zone').default('UTC'),
  workDays: z.array(z.number().int().min(0).max(6)).max(7).default([1, 2, 3, 4, 5]),
  workStart: hhmm.default('08:00'),
  workEnd: hhmm.default('18:00'),
  dailyLimit: z.number().int().min(1).max(500).default(40),
  warmup: z.boolean().default(true),
  warmupDays: z.number().int().min(1).max(60).default(14),
  warmupStart: z.number().int().min(1).max(500).default(5),
  gapMinSec: z.number().int().min(30).max(3600).default(120),
  gapMaxSec: z.number().int().min(30).max(7200).default(420),
});
type MailboxBody = z.infer<typeof mailboxBody>;

export function mailboxRoutes(app: FastifyInstance, ctx: Ctx) {
  const load = (req: any): MailboxRow => {
    const { id } = parse(idParam, req.params);
    return ctx.db.get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ? AND workspace_id = ?', [id, user(req).workspace_id]) ?? notFound('Mailbox');
  };
  const reload = (id: number) => serializeMailbox(ctx, ctx.db.get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', [id])!);

  // Seals server settings; a blank password keeps the saved one, but only for the same server and user:
  // otherwise an admin who only sees the masked password could point the host elsewhere and collect it.
  const sealServer = (label: 'smtp' | 'imap', next: z.infer<typeof server> | null | undefined, saved: string | null): string | null | undefined => {
    if (next === undefined) return undefined;
    if (next === null) return null;
    const prev = serverSettings(ctx, saved);
    let pass = next.pass ?? '';
    if (next.pass !== null && !pass && prev?.pass) {
      if (prev.host.toLowerCase() !== next.host || prev.port !== next.port || prev.user !== next.user) throw new HttpError(400, `${label}: Enter the password again for the new server or user`);
      pass = prev.pass;
    }
    const s: ServerSettings = { host: next.host, port: next.port, secure: next.secure, user: next.user, pass };
    return ctx.sealer.seal(JSON.stringify(s));
  };

  const columns = (b: Partial<MailboxBody>, existing?: MailboxRow) => {
    const out: Record<string, any> = {};
    if (b.name !== undefined) out.name = b.name;
    if (b.provider !== undefined) out.provider = b.provider;
    if (b.preset !== undefined) out.preset = b.preset;
    if (b.fromName !== undefined) out.from_name = b.fromName;
    if (b.fromEmail !== undefined) out.from_email = b.fromEmail;
    if (b.replyTo !== undefined) out.reply_to = b.replyTo;
    if (b.signature !== undefined) out.signature = b.signature;
    const smtp = sealServer('smtp', b.smtp, existing?.smtp_enc ?? null);
    if (smtp !== undefined) out.smtp_enc = smtp;
    const imap = sealServer('imap', b.imap, existing?.imap_enc ?? null);
    if (imap !== undefined) {
      out.imap_enc = imap;
      // Another server (or account) has its own UIDs: start reading from now on.
      const before = serverSettings(ctx, existing?.imap_enc ?? null);
      const after = serverSettings(ctx, imap);
      if (before?.host !== after?.host || before?.user !== after?.user) Object.assign(out, { imap_uid_validity: null, imap_last_uid: 0 });
    }
    if (b.timezone !== undefined) out.timezone = b.timezone;
    if (b.workDays !== undefined) out.work_days = JSON.stringify([...new Set(b.workDays)].sort());
    if (b.workStart !== undefined) out.work_start = b.workStart;
    if (b.workEnd !== undefined) out.work_end = b.workEnd;
    if (b.dailyLimit !== undefined) out.daily_limit = b.dailyLimit;
    if (b.warmup !== undefined) out.warmup = b.warmup ? 1 : 0;
    if (b.warmupDays !== undefined) out.warmup_days = b.warmupDays;
    if (b.warmupStart !== undefined) out.warmup_start = b.warmupStart;
    if (b.gapMinSec !== undefined) out.gap_min_sec = b.gapMinSec;
    if (b.gapMaxSec !== undefined) out.gap_max_sec = b.gapMaxSec;
    const min = out.gap_min_sec ?? existing?.gap_min_sec;
    const max = out.gap_max_sec ?? existing?.gap_max_sec;
    if (min != null && max != null && min > max) throw new HttpError(400, 'The shortest gap must not exceed the longest');
    return out;
  };

  app.get('/api/mailboxes/presets', async () => MAILBOX_PRESETS.map(({ id, label, smtp, imap, help }) => ({ id, label, smtp, imap, help })));

  app.get('/api/mailboxes', async (req) => {
    const u = requireWriter(req);
    return ctx.db.all<MailboxRow>('SELECT * FROM mailboxes WHERE workspace_id = ? ORDER BY id', [u.workspace_id]).map((m) => serializeMailbox(ctx, m));
  });

  app.get('/api/mailboxes/:id', async (req) => {
    requireWriter(req);
    return serializeMailbox(ctx, load(req));
  });

  // Hosted installs: mail servers on the server's own network are refused (checked again before each connection).
  const checkServers = async (b: Partial<MailboxBody>) => {
    for (const label of ['smtp', 'imap'] as const) {
      const s = b[label];
      const problem = s && (await hostProblem(ctx, s.host));
      if (problem) throw new HttpError(400, `${label}: ${problem}`);
    }
  };

  app.post('/api/mailboxes', async (req) => {
    const u = requireAdmin(req);
    const body = parse(mailboxBody, req.body);
    if (body.provider === 'smtp' && !body.smtp) throw new HttpError(400, 'smtp: Add the SMTP server settings');
    await checkServers(body);
    assertWithinPlan(ctx, u.workspace_id, 'mailboxes');
    const id = ctx.db.insert('mailboxes', { workspace_id: u.workspace_id, created_at: ctx.clock.now(), status: 'active', ...columns(body) });
    return reload(id);
  });

  app.patch('/api/mailboxes/:id', async (req) => {
    requireAdmin(req);
    const mb = load(req);
    const body = parse(mailboxBody.partial(), req.body);
    await checkServers(body);
    ctx.db.update('mailboxes', mb.id, columns(body, mb));
    return reload(mb.id);
  });

  app.delete('/api/mailboxes/:id', async (req) => {
    requireAdmin(req);
    const mb = load(req);
    ctx.db.tx(() => {
      retireMailbox(ctx, mb.id);
      ctx.db.run('DELETE FROM mailboxes WHERE id = ?', [mb.id]);
      // A mailbox migrated from an account's SMTP settings takes them along, or the next start would bring it back.
      if (mb.legacy_account_id) ctx.db.run('UPDATE accounts SET smtp_enc = NULL WHERE id = ? AND workspace_id = ?', [mb.legacy_account_id, mb.workspace_id]);
    });
    return { ok: true };
  });

  // Logs in to SMTP and IMAP without sending anything.
  app.post('/api/mailboxes/:id/test', async (req) => {
    requireAdmin(req);
    const mb = load(req);
    if (isSimulated(mb)) return { smtp: { ok: true, message: 'Simulated mailbox: nothing is delivered' }, imap: await imapFor(ctx, mb)!.test() };
    const transport = smtpTransport(ctx, mb);
    const smtp = transport
      ? await pinMailServer(ctx, transport).then(
          (t) => ctx.mailer.verify(t),
          (e: Error) => ({ ok: false, message: e.message }),
        )
      : { ok: false, message: 'No SMTP settings' };
    const imapClient = imapFor(ctx, mb);
    const imap = imapClient ? await imapClient.test() : { ok: false, message: 'No IMAP settings: replies and bounces are not detected' };
    return { smtp, imap };
  });

  app.post('/api/mailboxes/:id/pause', async (req) => {
    requireAdmin(req);
    const mb = load(req);
    ctx.db.tx(() => {
      ctx.db.run("UPDATE mailboxes SET status = 'paused' WHERE id = ?", [mb.id]);
      // Leads it hasn't emailed yet can go out from the campaign's other mailboxes meanwhile.
      releaseUnstartedMailboxLeads(ctx, mb.id);
    });
    return reload(mb.id);
  });

  app.post('/api/mailboxes/:id/resume', async (req) => {
    requireAdmin(req);
    const mb = load(req);
    if (!ctx.config.publicUrl && needsPublicUrl(mb)) throw new HttpError(409, 'Set PUBLIC_URL on the server first: campaign emails must carry a working unsubscribe link');
    if (!isSimulated(mb) && !mb.smtp_enc) throw new HttpError(400, 'Add SMTP settings first');
    ctx.db.run("UPDATE mailboxes SET status = 'active', status_message = NULL WHERE id = ?", [mb.id]);
    return reload(mb.id);
  });

  app.post('/api/mailboxes/:id/sync', async (req) => {
    requireWriter(req);
    const mb = load(req);
    if (!isSimulated(mb) && !mb.imap_enc) throw new HttpError(400, 'Add IMAP settings to read replies from this mailbox');
    const jobId = ctx.jobs.enqueue('email.sync', { mailboxId: mb.id }, { workspaceId: mb.workspace_id, dedupeKey: syncJobKey(mb.id) });
    return { jobId };
  });

  app.post('/api/deliverability/check', async (req) => {
    const u = requireWriter(req);
    const body = parse(
      z.object({
        domain: z.string().trim().toLowerCase().max(253).optional(),
        mailboxId: z.number().int().positive().optional(),
        dkimSelector: z
          .string()
          .trim()
          .max(63)
          .regex(/^[a-z0-9]([a-z0-9-_.]*[a-z0-9])?$/i, 'Use the selector name only, e.g. google')
          .optional()
          .or(z.literal('')),
      }),
      req.body,
    );
    const mb = body.mailboxId ? (ctx.db.get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ? AND workspace_id = ?', [body.mailboxId, u.workspace_id]) ?? notFound('Mailbox')) : undefined;
    const domain = body.domain || (mb ? emailDomain(mb.from_email) : '');
    if (!isHostname(domain)) throw new HttpError(400, 'domain: Use a domain name such as example.com');
    return checkDomain(ctx.dns, domain, { dkimSelector: body.dkimSelector || null, preset: mb?.preset ?? null });
  });
}
