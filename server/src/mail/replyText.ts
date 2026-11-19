import { isSuppressCategory, keywordCategory, SUPPRESS_MIN_CONFIDENCE, type Classification } from '../ai/categories.js';
import { decodeEntities, stripTags } from '../providers/data/website.js';

// What a person wrote in a reply, apart from the history, signature and boilerplate their mail client
// added. Used by inbound mail (the stored body, opt-out detection) and by the classifier's fallback rules.

// Splits a reply around its quoted history ("> ..." lines, an "On ... wrote:" line above them, and
// everything after an "On ... wrote:" or "Original Message" line with unquoted history under it): what was
// written above the first quoted block, and what was written after one (a bottom-posted or inline reply, or
// a footer the mail server appended under the quote).
function splitQuoted(text: string): { above: string[]; below: string[] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const above: string[] = [];
  const below: string[] = [];
  let quoted = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(t)) break;
    if (/^On .{4,200}wrote:\s*$/.test(t)) {
      if (/^\s*>/.test(lines.slice(i + 1).find((l) => l.trim()) ?? '')) {
        quoted = true;
        continue;
      }
      break;
    }
    if (/^\s*>/.test(lines[i])) {
      quoted = true;
      continue;
    }
    (quoted ? below : above).push(lines[i]);
  }
  return { above, below };
}

// Drops quoted history so the inbox and the classifier see what the person actually wrote. Text after a
// quoted block (a bottom-posted or inline reply) is kept. When they wrote above the quote, what comes under it
// stops at a signature or legal notice: that is what a mail server appends under the whole message ("If you
// are not the intended recipient...", "To unsubscribe from..."), and it must not read as part of the reply
// once the quote between them is gone. Empty when the person wrote nothing of their own: the quote is never
// the reply.
export function stripQuoted(text: string): string {
  const { above, below } = splitQuoted(text);
  const top = above.join('\n').trim();
  const rest = below.join('\n').trim();
  return [top, top ? upToSignature(rest) : rest].filter(Boolean).join('\n').trim();
}

// The first line of a quoted header block, in the languages mail clients write it in (Outlook quotes the
// original under "From: Name / Sent: ... / Subject: ..." with no "> " in front).
const HEADER_FROM = /^(from|de|von|van|da|fr[aå]n|fra|od|av):\s/i;
// Any "Name: value" header line (Sent:, Date:, Verzonden:, Inviato:, ...).
const HEADER_LINE = /^[\p{L}][\p{L} .-]{1,24}:\s/u;
// The opening of our own footer: a reply can only contain it as quoted history.
const OUR_FOOTER = /^don['’]t want to hear from me again\?/i;
// Signatures and legal notices that tend to mention unsubscribing ("To unsubscribe from our newsletter...").
const BOILERPLATE =
  /^(this (e-?mail|message)\b.{0,80}\b(confidential|intended)|confidential(ity)?\b|disclaimer\b|to unsubscribe from\b|if you (are|were) not the intended\b|if you (have )?received this\b)/i;

// Lines up to a quoted header block, a separator line or our footer, which a reply can only hold as history.
function upToHistory(lines: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    // "From: x@y", or "From: Name" followed by another header line.
    const header = HEADER_FROM.test(t) && (t.includes('@') || HEADER_LINE.test(lines.slice(i + 1).find((l) => l.trim())?.trim() ?? ''));
    if (/^_{5,}$/.test(t) || OUR_FOOTER.test(t) || header) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

// Text up to a signature or a legal notice (they tend to mention unsubscribing).
function upToSignature(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (line.trimEnd() === '--' || /^(sent from my|get outlook for)\b/i.test(t) || BOILERPLATE.test(t)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

// What the person wrote, for the classifier: no quoted history (empty when there is nothing else, so our own
// footer quoted back never counts), and nothing from a quoted header block, a separator line or our footer on.
// Signatures and legal notices the person wrote above the quote stay: they can be the reply itself ("This
// email was intended for my former colleague..."). Works on a raw reply and on one stripQuoted already stored.
export function writtenText(text: string): string {
  return upToHistory(stripQuoted(text).split('\n'));
}

// Only what the person typed, for the short rule-based opt-out check: what they wrote, with nothing from the
// signature or a legal notice on.
export function ownText(text: string): string {
  return upToSignature(writtenText(text));
}

// Longer replies only mention an opt-out in passing ("I'd unsubscribe from the newsletter if..."), so they
// are left to the classifier.
export const OPT_OUT_MAX = 200;

// A sure opt-out by the keyword rules alone (an unsubscribe, or a firm "not interested"), read from the
// person's own short text. Null when unsure, which leaves the reply to the AI.
export function ruleOptOut(text: string): Classification | null {
  const own = ownText(text);
  if (!own || own.length > OPT_OUT_MAX) return null;
  const c = keywordCategory(own);
  return isSuppressCategory(c.category) && c.confidence >= SUPPRESS_MIN_CONFIDENCE[c.category] ? c : null;
}

// A readable version of an HTML-only email (some phone apps send no text part): the quoted history
// (blockquotes, Gmail's and Outlook's quote blocks) dropped, line breaks kept, tags and entities gone.
export function htmlToText(html: string): string {
  let s = html.replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  // Greedy to the last closing tag, so nested quotes go with it.
  s = s.replace(/<blockquote\b[\s\S]*<\/blockquote\s*>/gi, ' ');
  // Gmail and Outlook mark where the quoted original starts; all of it is history.
  s = s.replace(/<div\b[^>]*(\bclass="[^"]*\bgmail_quote\b|\bid="(divRplyFwdMsg|appendonsend)")[\s\S]*$/i, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n');
  return decodeEntities(stripTags(s))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
