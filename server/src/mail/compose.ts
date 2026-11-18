import { randomBytes } from 'node:crypto';
import type { OutgoingEmail } from '../services/email.js';

// Builds the email a step sends: Message-ID, threading headers, a plain-text body with a minimal HTML
// twin, the signature, the unsubscribe footer and List-Unsubscribe headers (RFC 2369 / RFC 8058), and
// the optional open pixel and click-tracked links. Without a public PUBLIC_URL there is no link: the footer
// asks people to reply "unsubscribe" (reply mode), and inbound mail detection honours that reply.

export function newMessageId(fromEmail: string | null | undefined, random: () => number = Math.random): string {
  const domain = (fromEmail ?? '').split('@')[1]?.replace(/[^a-z0-9.-]/gi, '') || 'openreach.invalid';
  // Random bytes plus a ctx.random component: unique in production, and still varied in seeded tests.
  const id = `${randomBytes(9).toString('hex')}.${Math.floor(random() * 1e9).toString(36)}`;
  return `<${id}@${domain}>`;
}

export interface ThreadRef {
  // Message-ID of the email this one answers, and the chain it belongs to (oldest first).
  inReplyTo: string;
  references: string[];
  // The thread's first subject; the reply is "Re: <subject>".
  subject: string;
}

export interface ComposeInput {
  from: string;
  fromEmail: string;
  replyTo?: string | null;
  to: string;
  subject: string;
  body: string; // rendered plain text
  signature?: string;
  messageId: string;
  thread?: ThreadRef | null;
  links?: {
    unsubscribe: string | null;
    openPixel?: string | null;
    click?: ((url: string) => string) | null;
  } | null;
  // Campaign emails carry the unsubscribe footer (link or reply mode); one-to-one replies from the inbox don't.
  footer?: boolean;
}

export const replySubject = (subject: string) => (/^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`);

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

// Escaped paragraphs with clickable links (tracked when click tracking is on).
function toHtml(text: string, click?: ((url: string) => string) | null): string {
  return text
    .split(/\n{2,}/)
    .map((para) => {
      let out = '';
      let last = 0;
      for (const m of para.matchAll(URL_RE)) {
        out += escapeHtml(para.slice(last, m.index));
        const href = click ? click(m[0]) : m[0];
        out += `<a href="${escapeHtml(href)}">${escapeHtml(m[0])}</a>`;
        last = m.index! + m[0].length;
      }
      out += escapeHtml(para.slice(last));
      return `<p>${out.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
}

export function composeEmail(input: ComposeInput): OutgoingEmail {
  const subject = input.thread ? replySubject(input.thread.subject) : input.subject.trim();
  const signature = input.signature?.trim();
  const footer = input.footer !== false;
  const unsubscribe = footer ? (input.links?.unsubscribe ?? null) : null;
  const mailto = `mailto:${input.fromEmail}?subject=unsubscribe`;

  // A reply always works as well (the List-Unsubscribe mailto sends the same word), so the opt-out still
  // works for someone whose mail client hides links. Without a link it is the only way, said in full.
  // With a Reply-To elsewhere a reply never reaches this mailbox, so people are asked to email the sender.
  const elsewhere = !!input.replyTo && input.replyTo.trim().toLowerCase() !== input.fromEmail.trim().toLowerCase();
  let text = input.body.trim();
  if (signature) text += `\n\n-- \n${signature}`;
  if (unsubscribe) text += `\n\nDon't want to hear from me again? Unsubscribe: ${unsubscribe}${elsewhere ? '' : ' or just reply "unsubscribe".'}`;
  else if (footer && elsewhere) text += `\n\nDon't want to hear from me again? Email ${input.fromEmail} with the subject "unsubscribe" and I won't contact you again.`;
  else if (footer) text += `\n\nDon't want to hear from me again? Just reply "unsubscribe" and I won't contact you again.`;

  let html = toHtml(input.body.trim(), input.links?.click);
  if (signature) html += `\n<p style="color:#555">${escapeHtml(signature).replace(/\n/g, '<br>')}</p>`;
  if (unsubscribe) html += `\n<p style="color:#888;font-size:12px">Don't want to hear from me again? <a href="${escapeHtml(unsubscribe)}">Unsubscribe</a>${elsewhere ? '' : ' or just reply &quot;unsubscribe&quot;.'}</p>`;
  else if (footer && elsewhere) html += `\n<p style="color:#888;font-size:12px">Don't want to hear from me again? Email <a href="${escapeHtml(mailto)}">${escapeHtml(input.fromEmail)}</a> with the subject &quot;unsubscribe&quot; and I won't contact you again.</p>`;
  else if (footer) html += `\n<p style="color:#888;font-size:12px">Don't want to hear from me again? Just reply &quot;unsubscribe&quot; and I won't contact you again.</p>`;
  if (input.links?.openPixel) html += `\n<img src="${escapeHtml(input.links.openPixel)}" width="1" height="1" alt="" style="display:block;border:0">`;

  const headers: Record<string, string> = {};
  if (footer) {
    headers['List-Unsubscribe'] = unsubscribe ? `<${unsubscribe}>, <${mailto}>` : `<${mailto}>`;
    if (unsubscribe) headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  return {
    from: input.from,
    to: input.to,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    subject,
    text,
    html: `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">\n${html}\n</body></html>`,
    headers,
    messageId: input.messageId,
    ...(input.thread ? { inReplyTo: input.thread.inReplyTo, references: [...input.thread.references] } : {}),
  };
}
