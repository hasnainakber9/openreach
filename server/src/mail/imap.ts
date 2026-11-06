import { ImapFlow, type MessageStructureObject } from 'imapflow';
import { DAY, HOUR, MINUTE } from '../clock.js';
import type { Ctx } from '../context.js';
import { hashUnit, pick } from '../providers/hash.js';
import { MailError } from '../services/email.js';
import { pinMailServer } from '../services/hosts.js';
import type { EmailMessageRow, MailboxRow } from '../types.js';
import { emailDomain, isSimulated, serverSettings, type ServerSettings } from './mailboxes.js';
import { htmlToText } from './replyText.js';

// Reading replies and bounces. The engine only talks to ImapClient; ctx.imap builds the real one (imapflow)
// so tests inject fake inbox data, and simulated mailboxes answer from their own sent mail.

export interface InboundEmail {
  uid: number;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  from: string; // lower-cased address
  fromName: string;
  subject: string;
  date: number;
  text: string;
  // Set for automatic mail (Auto-Submitted header other than "no"): out-of-office replies and the like.
  autoSubmitted?: boolean;
  // A delivery status notification (multipart/report; report-type=delivery-status).
  report?: { recipients: string[]; originalMessageId: string | null; status: string | null; diagnostic: string | null } | null;
}

export interface FetchResult {
  uidValidity: string;
  lastUid: number;
  messages: InboundEmail[];
}

export interface ImapClient {
  // New INBOX mail after `lastUid` (all mail since `since` when starting over or when the UID validity
  // changed). Read-only: \Seen flags are never touched.
  fetchSince(lastUid: number, uidValidity: string | null, opts: { since: number; signal?: AbortSignal }): Promise<FetchResult>;
  test(): Promise<{ ok: boolean; message: string }>;
}

export type ImapFactory = (cfg: ServerSettings) => ImapClient;

// At most this many messages per sync; the next sync carries on from the last UID.
export const MAX_FETCH = 200;
// Bodies are cut here: classification only needs the start of a reply.
const MAX_TEXT = 20 * 1024;

export const normalizeMessageId = (id: string | null | undefined) => {
  const v = (id ?? '').trim();
  if (!v) return null;
  return v.startsWith('<') ? v : `<${v}>`;
};
export const splitReferences = (refs: string | null | undefined) => (refs ?? '').match(/<[^<>\s]+>/g) ?? [];

// ---- Real mailboxes (imapflow) ----------------------------------------------------------------

// Best effort, tested against fakes only: talks to the server through imapflow, INBOX only.
export const imapflowFactory: ImapFactory = (cfg) => {
  const connect = async () => {
    const client = new ImapFlow({
      host: cfg.address ?? cfg.host,
      // The certificate is checked against the name, not the address we connect to.
      servername: cfg.address ? cfg.host : undefined,
      port: cfg.port,
      secure: cfg.secure,
      // Without TLS from the start, insist on STARTTLS: imapflow would otherwise send LOGIN in clear text
      // when the server doesn't offer it (or someone on the path strips it), like SMTP's requireTLS.
      doSTARTTLS: cfg.secure ? undefined : true,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
    // Without a listener a dropped connection's 'error' event would crash the process.
    client.on('error', () => {});
    try {
      await client.connect();
    } catch (e) {
      client.close();
      throw imapError(e);
    }
    return client;
  };

  return {
    async test() {
      try {
        const c = await connect();
        await c.logout().catch(() => c.close());
        return { ok: true, message: 'The IMAP server accepted the login' };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },

    async fetchSince(lastUid, uidValidity, { since, signal }) {
      const c = await connect();
      const abort = () => c.close();
      signal?.addEventListener('abort', abort);
      try {
        const lock = await c.getMailboxLock('INBOX', { readOnly: true });
        try {
          const box = c.mailbox;
          const validity = box ? String(box.uidValidity) : '';
          const from = validity === uidValidity ? lastUid : 0;
          const found = (await c.search(from ? { uid: `${from + 1}:*` } : { since: new Date(since) }, { uid: true })) || [];
          // "n:*" returns the newest message even when it is older than n; keep only new UIDs.
          const uids = found.filter((u) => u > from).sort((a, b) => a - b).slice(0, MAX_FETCH);
          if (!uids.length) return { uidValidity: validity, lastUid: from, messages: [] };

          const raw: { uid: number; envelope: any; structure?: MessageStructureObject; headers: string; date: number }[] = [];
          for await (const m of c.fetch(uids.join(','), { uid: true, envelope: true, bodyStructure: true, internalDate: true, headers: ['references', ...AUTO_REPLY_HEADERS] }, { uid: true })) {
            raw.push({ uid: m.uid, envelope: m.envelope ?? {}, structure: m.bodyStructure, headers: m.headers?.toString('utf8') ?? '', date: new Date(m.internalDate ?? m.envelope?.date ?? Date.now()).getTime() });
          }
          // Bodies are downloaded after the fetch loop: imapflow can't run commands inside it.
          const messages: InboundEmail[] = [];
          for (const r of raw) {
            const parts = findParts(r.structure);
            // Without a text part, the HTML one as text: otherwise an HTML-only "remove me" would read as nothing.
            const text = parts.text ? await download(c, r.uid, parts.text) : parts.html ? htmlToText(await download(c, r.uid, parts.html)) : '';
            let report: InboundEmail['report'] = null;
            if (parts.deliveryStatus) {
              const dsn = parseDeliveryStatus(await download(c, r.uid, parts.deliveryStatus));
              const original = parts.originalHeaders ? parseHeaders(await download(c, r.uid, parts.originalHeaders)) : {};
              report = { ...dsn, originalMessageId: normalizeMessageId(original['message-id']) };
            }
            const headers = parseHeaders(r.headers);
            const fromAddr = r.envelope.from?.[0] ?? {};
            messages.push({
              uid: r.uid,
              messageId: normalizeMessageId(r.envelope.messageId) ?? `<uid-${validity}-${r.uid}@imap.invalid>`,
              inReplyTo: normalizeMessageId(r.envelope.inReplyTo),
              references: splitReferences(headers.references),
              from: String(fromAddr.address ?? '').toLowerCase(),
              fromName: String(fromAddr.name ?? ''),
              subject: String(r.envelope.subject ?? ''),
              date: r.date,
              text,
              autoSubmitted: isAutoReply(headers),
              report,
            });
          }
          return { uidValidity: validity, lastUid: uids[uids.length - 1], messages };
        } finally {
          lock.release();
        }
      } finally {
        signal?.removeEventListener('abort', abort);
        await c.logout().catch(() => c.close());
      }
    },
  };
};

export function imapError(e: unknown): MailError {
  const err = e as { authenticationFailed?: boolean; tlsFailed?: boolean; responseText?: string; message?: string };
  if (err.authenticationFailed) return new MailError('AUTH', `IMAP login refused${err.responseText ? `: ${err.responseText}` : ''}`.slice(0, 300));
  // Reported like a refused login: a settings problem the user must fix, so the mailbox needs attention.
  if (err.tlsFailed) return new MailError('AUTH', 'The IMAP server did not offer TLS, so the password was not sent. Turn on "TLS from the start" (port 993) or check the server.');
  return new MailError('TRANSIENT', (err.message ?? 'IMAP error').slice(0, 300));
}

async function download(c: ImapFlow, uid: number, part: string): Promise<string> {
  const d = await c.download(String(uid), part, { uid: true, maxBytes: MAX_TEXT });
  if (!('content' in d) || !d.content) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of d.content) {
    chunks.push(chunk as Buffer);
    size += (chunk as Buffer).length;
    if (size >= MAX_TEXT) break;
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, MAX_TEXT);
}

// The first text/plain part (and text/html, used when there is no plain one), and for delivery reports the
// status part and the returned headers.
export function findParts(s: MessageStructureObject | undefined): { text?: string; html?: string; deliveryStatus?: string; originalHeaders?: string } {
  const out: { text?: string; html?: string; deliveryStatus?: string; originalHeaders?: string } = {};
  const walk = (n: MessageStructureObject | undefined) => {
    if (!n) return;
    const type = n.type.toLowerCase();
    const part = n.part ?? '1';
    if (type === 'text/plain' && !out.text && n.disposition?.toLowerCase() !== 'attachment') out.text = part;
    else if (type === 'text/html' && !out.html && n.disposition?.toLowerCase() !== 'attachment') out.html = part;
    else if (type === 'message/delivery-status' || type === 'message/global-delivery-status') out.deliveryStatus ??= part;
    else if (type === 'text/rfc822-headers' || type === 'message/rfc822') out.originalHeaders ??= part;
    for (const child of n.childNodes ?? []) walk(child);
  };
  walk(s);
  return out;
}

// Header block → lower-cased name → value (folded lines joined).
// Headers that mark automatic mail: Auto-Submitted (RFC 3834) other than "no", the older X-Autoreply and
// X-Autorespond, and Precedence: auto_reply, bulk or junk (out-of-office replies and mailing lists).
export const AUTO_REPLY_HEADERS = ['auto-submitted', 'x-autoreply', 'x-autorespond', 'precedence'];

export function isAutoReply(headers: Record<string, string>): boolean {
  const auto = headers['auto-submitted']?.trim().toLowerCase();
  if (auto && auto !== 'no') return true;
  if (headers['x-autoreply'] != null || headers['x-autorespond'] != null) return true;
  return ['auto_reply', 'bulk', 'junk'].includes(headers.precedence?.trim().toLowerCase() ?? '');
}

export function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const head = block.split(/\r?\n\r?\n/)[0];
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!(name in out)) out[name] = line.slice(i + 1).trim();
  }
  return out;
}

// RFC 3464 delivery-status: per-recipient fields after the per-message block.
export function parseDeliveryStatus(text: string): { recipients: string[]; status: string | null; diagnostic: string | null } {
  const recipients: string[] = [];
  let status: string | null = null;
  let diagnostic: string | null = null;
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (name === 'final-recipient' || name === 'original-recipient') {
      const addr = m[2].split(';').pop()!.trim().toLowerCase();
      if (addr && !recipients.includes(addr)) recipients.push(addr);
    } else if (name === 'status') status ??= m[2].trim();
    else if (name === 'diagnostic-code') diagnostic ??= m[2].split(';').pop()!.trim().slice(0, 300);
  }
  return { recipients, status, diagnostic };
}

// ---- Simulated mailboxes ------------------------------------------------------------------------

const SIM_REPLIES = [
  'Thanks for reaching out. This sounds interesting, could you send a few more details?',
  'Happy to chat. Does Thursday afternoon work for a quick call?',
  'Not a priority for us right now, maybe check back next quarter.',
  'Thanks, but we are not interested.',
  'I am out of the office until Monday with limited access to email.',
  'Please remove me from your list.',
  'What would this cost for a team of our size?',
];

// Answers 25% of a simulated mailbox's emails (chosen by hash, 2 to 24 hours after sending) and
// bounces addresses whose local part contains "bounce" a few minutes after sending. Nothing leaves the app.
export function simulatedImap(ctx: Ctx, mb: MailboxRow): ImapClient {
  return {
    async test() {
      return { ok: true, message: 'Simulated mailbox: replies are made up from its own sent mail' };
    },
    async fetchSince(lastUid) {
      const now = ctx.clock.now();
      const sent = ctx.db.all<EmailMessageRow>(
        "SELECT * FROM email_messages WHERE mailbox_id = ? AND direction = 'out' AND status IN ('sent', 'simulated') AND sent_at >= ? ORDER BY id LIMIT 2000",
        [mb.id, now - 30 * DAY],
      );
      const messages: InboundEmail[] = [];
      for (const out of sent) {
        const local = out.to_email.split('@')[0] ?? '';
        const bounce = local.includes('bounce');
        const date = bounce ? out.sent_at + 5 * MINUTE : out.sent_at + 2 * HOUR + Math.floor(hashUnit('sim-reply-at', mb.id, out.id) * 22 * HOUR);
        if (date > now || (!bounce && hashUnit('sim-reply', mb.id, out.id) >= 0.25)) continue;
        const uid = out.id * 2 + (bounce ? 1 : 0);
        const messageId = `<sim-${bounce ? 'dsn' : 'reply'}-${out.id}@${bounce ? emailDomain(mb.from_email) || 'simulated.invalid' : emailDomain(out.to_email) || 'simulated.invalid'}>`;
        if (ctx.db.get('SELECT 1 FROM email_messages WHERE mailbox_id = ? AND message_id = ?', [mb.id, messageId])) continue;
        messages.push(
          bounce
            ? {
                uid,
                messageId,
                inReplyTo: null,
                references: [],
                from: `mailer-daemon@${emailDomain(mb.from_email) || 'simulated.invalid'}`,
                fromName: 'Mail Delivery System',
                subject: 'Undelivered Mail Returned to Sender',
                date,
                text: `Delivery to ${out.to_email} failed permanently.`,
                report: { recipients: [out.to_email], originalMessageId: out.message_id, status: '5.1.1', diagnostic: '550 5.1.1 The email account that you tried to reach does not exist (simulated)' },
              }
            : {
                uid,
                messageId,
                inReplyTo: out.message_id,
                references: [...splitReferences(out.refs), out.message_id],
                from: out.to_email.toLowerCase(),
                fromName: '',
                subject: `Re: ${out.subject.replace(/^re:\s*/i, '')}`,
                date,
                text: pick(SIM_REPLIES, 'sim-reply-text', mb.id, out.id),
              },
        );
      }
      return { uidValidity: 'simulated', lastUid: Math.max(lastUid, ...messages.map((m) => m.uid)), messages: messages.slice(0, MAX_FETCH) };
    },
  };
}

// The client for a mailbox, or null when it has no IMAP settings (replies then aren't detected).
export function imapFor(ctx: Ctx, mb: MailboxRow): ImapClient | null {
  if (isSimulated(mb)) return simulatedImap(ctx, mb);
  const cfg = serverSettings(ctx, mb.imap_enc);
  if (!cfg) return null;
  // The host is checked (hosted installs) and resolved right before each connection.
  const client = async () => ctx.imap(await pinMailServer(ctx, cfg));
  return {
    async test() {
      try {
        return await (await client()).test();
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    fetchSince: async (lastUid, uidValidity, opts) => (await client()).fetchSince(lastUid, uidValidity, opts),
  };
}
