import nodemailer from 'nodemailer';

// Account-level SMTP settings from before mailboxes existed (accounts.smtp_enc). `from` is the sender line.
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

// How to reach an SMTP server. `secure` = TLS from the start (port 465); otherwise STARTTLS when offered.
export interface SmtpTransport {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface OutgoingEmail {
  from: string; // "Name <address>" or a bare address
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
  messageId: string; // "<id@domain>"
  inReplyTo?: string;
  references?: string[];
}

export type SendStatus = 'sent' | 'simulated';

// AUTH: the server refused the login (the mailbox needs attention). RECIPIENT: the server refused this
// address (treated like a bounce). TRANSIENT: anything else (connection, timeouts); the step retries.
export type MailErrorCode = 'AUTH' | 'RECIPIENT' | 'TRANSIENT';
export class MailError extends Error {
  constructor(public readonly code: MailErrorCode, message: string) {
    super(message);
  }
}

export interface Mailer {
  // Without a transport (simulated mailbox, account without SMTP) the email is recorded but not delivered.
  send(transport: SmtpTransport | null, msg: OutgoingEmail): Promise<{ status: SendStatus; messageId: string }>;
  // Logs in and says whether the server accepts the settings (the mailbox's Test button). Sends nothing.
  verify(transport: SmtpTransport): Promise<{ ok: boolean; message: string }>;
}

const TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 };

function transportFor(t: SmtpTransport) {
  return nodemailer.createTransport({
    host: t.host,
    port: t.port,
    secure: t.secure,
    // Port 587 and the like must upgrade to TLS; never send a password in clear text.
    requireTLS: !t.secure,
    auth: t.user ? { user: t.user, pass: t.pass } : undefined,
    ...TIMEOUTS,
  });
}

// Maps nodemailer's error codes onto ours. Messages never contain the password.
export function mailError(e: unknown): MailError {
  if (e instanceof MailError) return e;
  const err = e as { code?: string; responseCode?: number; command?: string; message?: string };
  const message = (err.message ?? 'SMTP error').slice(0, 300);
  if (err.code === 'EAUTH' || err.responseCode === 535 || err.responseCode === 534) return new MailError('AUTH', message);
  if (err.code === 'EENVELOPE' || (err.command === 'RCPT TO' && (err.responseCode ?? 0) >= 500)) return new MailError('RECIPIENT', message);
  return new MailError('TRANSIENT', message);
}

export const smtpMailer: Mailer = {
  async send(transport, msg) {
    if (!transport) return { status: 'simulated', messageId: msg.messageId };
    try {
      await transportFor(transport).sendMail({
        from: msg.from,
        to: msg.to,
        replyTo: msg.replyTo,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        headers: msg.headers,
        messageId: msg.messageId,
        inReplyTo: msg.inReplyTo,
        references: msg.references,
      });
    } catch (e) {
      throw mailError(e);
    }
    return { status: 'sent', messageId: msg.messageId };
  },
  async verify(transport) {
    try {
      await transportFor(transport).verify();
      return { ok: true, message: 'The SMTP server accepted the login' };
    } catch (e) {
      return { ok: false, message: mailError(e).message };
    }
  },
};
