import { isSuppressCategory, keywordCategory, SUPPRESS_MIN_CONFIDENCE, type Classification } from '../ai/categories.js';
import { decodeEntities, stripTags } from '../providers/data/website.js';

// What a person wrote in a reply, apart from the history, signature and boilerplate their mail client
// added. Used by inbound mail (the stored body, opt-out detection) and by the classifier's fallback rules.

// Drops quoted history ("> ..." lines and everything after "On ... wrote:") so the inbox and the
// classifier see what the person actually wrote.
export function stripQuoted(text: string): string {
  return withoutQuotes(text) || text.trim();
}

function withoutQuotes(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .{4,200}wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

// The first line of a quoted header block, in the languages mail clients write it in (Outlook quotes the
// original under "From: Name / Sent: ... / Subject: ..." with no "> " in front).
const HEADER_FROM = /^(from|de|von|van|da|fr[aå]n|fra|od|av):\s/i;
// Any "Name: value" header line (Sent:, Date:, Verzonden:, Inviato:, ...).
const HEADER_LINE = /^[\p{L}][\p{L} .-]{1,24}:\s/u;
// The opening of our own footer: a reply can only contain it as quoted history.
const OUR_FOOTER = /^don['’]t want to hear from me again\?/i;
// Signatures and legal notices that tend to mention unsubscribing ("To unsubscribe from our newsletter...").
const BOILERPLATE = /^(this (e-?mail|message)\b.{0,80}\b(confidential|intended)|confidentiality notice|disclaimer\b|to unsubscribe from\b)/i;

// Only what the person typed: no quoted history (empty when there is nothing else, unlike stripQuoted, so
// our own footer quoted back never counts), and nothing from the signature, a quoted header block, our
// footer or a legal notice on.
export function ownText(text: string): string {
  const lines = withoutQuotes(text).split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (lines[i].trimEnd() === '--' || /^_{5,}$/.test(t) || /^(sent from my|get outlook for)\b/i.test(t) || OUR_FOOTER.test(t) || BOILERPLATE.test(t)) break;
    // "From: x@y", or "From: Name" followed by another header line.
    if (HEADER_FROM.test(t) && (t.includes('@') || HEADER_LINE.test(lines.slice(i + 1).find((l) => l.trim())?.trim() ?? ''))) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
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
