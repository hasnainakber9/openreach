import { z } from 'zod';
import type { Ctx } from '../context.js';
import { clampNote, unknownVariables, VARIABLE_NAMES } from '../engine/template.js';
import { ProviderError } from '../providers/http.js';
import type { LeadRow } from '../types.js';
import { completeJson } from './complete.js';
import { writerRequest, type WriterBrief, type WriterChannel } from './prompts.js';

export interface Draft {
  note?: string;
  text?: string;
  subject?: string;
  body?: string;
}

// Hard limits per channel (what the sequence schema and the networks accept) and a target per length.
const CHANNEL_MAX: Record<WriterChannel, number> = { connect: 300, message: 8000, inmail: 1900, email: 20000, sms: 320 };
const SUBJECT_MAX: Partial<Record<WriterChannel, number>> = { inmail: 200, email: 300 };
const LENGTH_CHARS = { short: 400, medium: 800, long: 1500 };

const draftSchema = z.object({
  drafts: z
    .array(z.object({ text: z.string().optional(), subject: z.string().optional(), body: z.string().optional() }).passthrough())
    .min(1),
});

// Single braces are spintax in our templates, so only well-formed {{variable}} tokens survive.
export function cleanTemplate(text: string): string {
  const tokens: string[] = [];
  const kept = text.replace(/\{\{\s*((?:ai:)?[\w.]+)\s*(\|[^{}]*)?\}\}/g, (m) => {
    tokens.push(m);
    return `\u0000${tokens.length - 1}\u0000`;
  });
  return kept
    .replace(/[{}]/g, '')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)])
    .trim();
}

// Drafts message text for a sequence step. Never sends anything: the user inserts what they like.
export async function writeDrafts(
  ctx: Ctx,
  workspaceId: number,
  o: { nodeType: WriterChannel; brief: WriterBrief; variants: number; lead?: LeadRow | null; noteLimit?: number; aiNames?: string[] },
): Promise<{ drafts: Draft[]; simulated: boolean; warnings: string[] }> {
  const hardMax = o.nodeType === 'connect' ? Math.min(CHANNEL_MAX.connect, o.noteLimit ?? 300) : CHANNEL_MAX[o.nodeType];
  const maxChars = o.nodeType === 'connect' || o.nodeType === 'sms' ? hardMax : Math.min(hardMax, LENGTH_CHARS[o.brief.length]);
  const subjectMax = SUBJECT_MAX[o.nodeType];
  const aiNames = o.aiNames ?? [];
  const variables = [...VARIABLE_NAMES.filter((v) => v !== 'email'), ...aiNames.map((n) => `ai:${n}`)];
  const req = writerRequest({ channel: o.nodeType, brief: o.brief, variants: o.variants, maxChars, subjectMax: subjectMax ? Math.min(120, subjectMax) : undefined, variables, lead: o.lead });
  const { data, out } = await completeJson(ctx, workspaceId, req, draftSchema);

  const warnings = new Set<string>();
  const fit = (raw: string | undefined, limit: number, what: string) => {
    const text = cleanTemplate(raw ?? '');
    if (text.length <= limit) return text;
    warnings.add(`A ${what} was longer than ${limit} characters and was shortened.`);
    return cleanTemplate(clampNote(text, limit));
  };
  const drafts: Draft[] = data.drafts.slice(0, o.variants).map((d: any) => {
    // Models sometimes answer {text} for an email or {body} for a note; take whichever came back.
    const text = d.text ?? d.body ?? '';
    if (subjectMax) return { subject: fit(d.subject || 'Quick question', subjectMax, 'subject'), body: fit(d.body ?? d.text, hardMax, 'message') };
    if (o.nodeType === 'connect') return { note: fit(text, hardMax, 'note') };
    return { text: fit(text, hardMax, 'message') };
  });
  const usable = drafts.filter((d) => Object.values(d).every((v) => v));
  if (!usable.length) throw new ProviderError('BAD_REQUEST', 'The AI returned empty drafts. Try again or add more detail to the brief.');
  if (usable.length < o.variants) warnings.add(`Only ${usable.length} of ${o.variants} drafts came back.`);
  for (const d of usable) {
    const unknown = Object.values(d).flatMap((t) => unknownVariables(t!, VARIABLE_NAMES, aiNames));
    if (unknown.length) warnings.add(`Drafts use ${[...new Set(unknown)].map((u) => `{{${u}}}`).join(', ')}, which leads don't have unless you import a column with that name.`);
  }
  if (o.nodeType === 'connect') warnings.add('Notes are measured before variables are filled in; a long name or company can push one over the limit, and it is shortened when sent.');
  if (out.simulated) warnings.add('Written by the built-in simulator. Add an AI provider under Settings → Integrations for real drafts.');
  return { drafts: usable, simulated: out.simulated, warnings: [...warnings] };
}
