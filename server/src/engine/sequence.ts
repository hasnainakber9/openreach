import { z } from 'zod';
import { REPLY_CATEGORIES, SUPPRESS_CATEGORIES } from '../ai/categories.js';

// A campaign sequence is a tree of nodes. Action and wait nodes have one `next`;
// condition nodes branch to `yes` / `no`. A null pointer ends the sequence for that lead.

export const ACTION_TYPES = [
  'view_profile',
  'follow',
  'endorse',
  'like_post',
  'connect',
  'message',
  'email',
  'withdraw_invite',
  'inmail',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

// Nodes the engine advances on its own (they only read the database), whatever the account's hours or limits.
// A task holds the lead until someone completes or skips it (or it is skipped automatically); find_email
// holds it while the email waterfall runs in the background (at most maxWaitHours).
export const FREE_NODE_TYPES = ['wait', 'condition', 'task', 'find_email'] as const;

// Steps sent by the messaging runner through the workspace's SMS provider, not by a LinkedIn account.
export const CHANNEL_NODE_TYPES = ['sms', 'whatsapp'] as const;
export type ChannelNodeType = (typeof CHANNEL_NODE_TYPES)[number];

export const TASK_KINDS = ['call', 'manual_linkedin', 'manual_email', 'custom'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
// Twilio splits long texts into segments; 1,600 characters is the most it accepts in one message.
export const SMS_MAX = 1600;

// reply_sentiment branches on the category of the lead's latest reply in this campaign (see engine walk()).
// email_verified: the lead has an email whose status is valid (or risky, when the workspace accepts risky ones).
export const CONDITION_KINDS = ['is_connected', 'accepted_within', 'has_email', 'replied', 'is_open_profile', 'reply_sentiment', 'email_verified'] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

const ptr = z.string().min(1).nullable().default(null);

// A/B testing: connect, message, email, InMail and SMS steps can hold 2–5 variants with ids A–E. The single-text
// fields stay required and hold variant A, so sequences saved before variants existed keep working.
export const VARIANT_IDS = ['A', 'B', 'C', 'D', 'E'] as const;
export type VariantId = (typeof VARIANT_IDS)[number];
export const VARIANT_NODE_TYPES = ['connect', 'message', 'email', 'inmail', 'sms'] as const;
export const INMAIL_VIA = ['profile', 'sales_navigator'] as const;
export const AB_METRICS = ['accepted', 'replied'] as const;
export type AbMetric = (typeof AB_METRICS)[number];

const variantList = <T extends z.ZodRawShape>(shape: T) =>
  z
    .array(z.object({ id: z.enum(VARIANT_IDS), ...shape }))
    .min(2, 'An A/B test needs at least 2 variants')
    .max(5, 'An A/B test can have at most 5 variants')
    .refine((vs) => new Set(vs.map((v) => v.id)).size === vs.length, 'Each variant needs its own letter')
    .optional();

// `autoPickAfter`: once the step has sent this many times, the best variant gets every later lead.
const abtest = z
  .object({ autoPickAfter: z.number().int().min(20).max(10000).nullable().default(null), metric: z.enum(AB_METRICS).optional() })
  .optional();

export const NodeSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('view_profile'), next: ptr }),
  z.object({ id: z.string(), type: z.literal('follow'), next: ptr }),
  z.object({ id: z.string(), type: z.literal('endorse'), count: z.number().int().min(1).max(5).default(3), next: ptr }),
  z.object({ id: z.string(), type: z.literal('like_post'), next: ptr }),
  z.object({
    id: z.string(),
    type: z.literal('connect'),
    note: z.string().max(2000).default(''),
    variants: variantList({ note: z.string().max(2000).default('') }),
    abtest,
    next: ptr,
  }),
  z.object({
    id: z.string(),
    type: z.literal('message'),
    text: z.string().min(1).max(8000),
    variants: variantList({ text: z.string().min(1).max(8000) }),
    abtest,
    next: ptr,
  }),
  z.object({
    id: z.string(),
    type: z.literal('email'),
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(20000),
    variants: variantList({ subject: z.string().min(1).max(300), body: z.string().min(1).max(20000) }),
    abtest,
    // Send as a reply to the lead's previous email from the same mailbox ("Re: <first subject>"), threaded
    // with In-Reply-To/References. Only campaigns with mailboxes thread; the legacy account path ignores it.
    replyInThread: z.boolean().optional(),
    next: ptr,
  }),
  z.object({ id: z.string(), type: z.literal('withdraw_invite'), next: ptr }),
  // LinkedIn caps InMail subjects at 200 characters and bodies at 1,900.
  z.object({
    id: z.string(),
    type: z.literal('inmail'),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(1900),
    via: z.enum(INMAIL_VIA).default('profile'),
    variants: variantList({ subject: z.string().min(1).max(200), body: z.string().min(1).max(1900) }),
    abtest,
    next: ptr,
  }),
  // A to-do for a person (a call, a manual LinkedIn or email touch). The lead waits at this step until the task
  // is completed or skipped; `autoSkipAfterDays` skips it that many days after it is due.
  z.object({
    id: z.string(),
    type: z.literal('task'),
    kind: z.enum(TASK_KINDS).default('call'),
    title: z.string().trim().min(1).max(200),
    instructions: z.string().max(4000).default(''),
    dueAfterHours: z.number().min(0).max(720).default(0),
    assigneeId: z.number().int().positive().nullable().default(null),
    autoSkipAfterDays: z.number().int().min(1).max(60).nullable().default(null),
    next: ptr,
  }),
  z.object({
    id: z.string(),
    type: z.literal('sms'),
    text: z.string().min(1).max(SMS_MAX),
    variants: variantList({ text: z.string().min(1).max(SMS_MAX) }),
    abtest,
    next: ptr,
  }),
  // Outside a 24-hour window after the person last wrote, WhatsApp only delivers business-initiated messages
  // from an approved template (`contentSid`, with its variables); `text` is sent otherwise.
  z.object({
    id: z.string(),
    type: z.literal('whatsapp'),
    text: z.string().min(1).max(SMS_MAX),
    contentSid: z.string().trim().regex(/^HX[0-9a-fA-F]{32}$/, 'A Twilio content template id starts with HX').optional(),
    contentVariables: z.record(z.string().regex(/^\w{1,30}$/), z.string().max(500)).optional(),
    next: ptr,
  }),
  // Looks up (and verifies) the lead's work email with the workspace's finders before going on. Leads that
  // already have a usable address pass straight through; the lead goes on after `maxWaitHours` either way.
  z.object({
    id: z.string(),
    type: z.literal('find_email'),
    verify: z.boolean().default(true),
    maxWaitHours: z.number().min(1).max(48).default(6),
    next: ptr,
  }),
  z.object({
    id: z.string(),
    type: z.literal('wait'),
    days: z.number().min(0).max(90).default(1),
    hours: z.number().min(0).max(23).default(0),
    next: ptr,
  }),
  z.object({
    id: z.string(),
    type: z.literal('condition'),
    kind: z.enum(CONDITION_KINDS),
    withinDays: z.number().min(0.1).max(90).default(7),
    // reply_sentiment only: the reply categories that go down Yes.
    categories: z.array(z.enum(REPLY_CATEGORIES)).max(REPLY_CATEGORIES.length).optional(),
    yes: ptr,
    no: ptr,
  }),
]);
export type SeqNode = z.infer<typeof NodeSchema>;

export const SequenceSchema = z.object({
  start: z.string().nullable(),
  nodes: z.record(z.string(), NodeSchema),
});
export type Sequence = z.infer<typeof SequenceSchema>;

// An AI personalization variable: templates use {{ai:name}}, generated per lead from its profile before
// the step runs. `fallback` is sent when generation fails or isn't allowed (may be '': then the
// template's own {{ai:name|...}} fallback applies).
export const AiVariableSchema = z.object({
  name: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,30}$/, 'Use a letter, then letters, digits or _ (up to 31 characters)'),
  instruction: z.string().trim().min(1).max(1000),
  fallback: z.string().max(300).default(''),
  maxChars: z.number().int().min(20).max(500).default(250),
});
export type AiVariable = z.infer<typeof AiVariableSchema>;

export const CampaignSettingsSchema = z.object({
  stopOnReply: z.boolean().default(true),
  skipIfInOtherCampaign: z.boolean().default(true),
  skipAlreadyConnected: z.boolean().default(false),
  noteLimit: z.number().int().min(100).max(300).default(300),
  aiVariables: z
    .array(AiVariableSchema)
    .max(10, 'A campaign can have at most 10 AI variables')
    .refine((vs) => new Set(vs.map((v) => v.name)).size === vs.length, 'Each AI variable needs its own name')
    .default([]),
  // With stopOnReply: replies in these categories hold the lead until classified, then let the sequence go on
  // (other replies stop it). Empty keeps the plain stop-on-any-reply behaviour. Opt-outs always stop.
  continueOnCategories: z
    .array(z.enum(REPLY_CATEGORIES))
    .max(REPLY_CATEGORIES.length)
    .refine((cs) => !cs.some((c) => SUPPRESS_CATEGORIES.includes(c)), 'Not interested and unsubscribe replies always stop the lead')
    .default([]),
  // Email open (pixel) and click (redirect) tracking; off by default for privacy. Needs PUBLIC_URL.
  trackOpens: z.boolean().default(false),
  trackClicks: z.boolean().default(false),
});
export type CampaignSettings = z.infer<typeof CampaignSettingsSchema>;

export type VariantNode = Extract<SeqNode, { type: (typeof VARIANT_NODE_TYPES)[number] }>;
// One variant's content, whatever the step type (only the fields of that type are set).
export type VariantContent = { id: VariantId; note?: string; text?: string; subject?: string; body?: string };

export function isVariantNode(n: SeqNode): n is VariantNode {
  return (VARIANT_NODE_TYPES as readonly string[]).includes(n.type);
}

// The step's variants; a plain step is a single variant A made of its own fields.
export function nodeVariants(n: VariantNode): VariantContent[] {
  if (n.variants?.length) return [...(n.variants as VariantContent[])].sort((a, b) => a.id.localeCompare(b.id));
  if (n.type === 'connect') return [{ id: 'A', note: n.note }];
  if (n.type === 'message' || n.type === 'sms') return [{ id: 'A', text: n.text }];
  return [{ id: 'A', subject: n.subject, body: n.body }];
}

export const isAbTest = (n: SeqNode): n is VariantNode => isVariantNode(n) && (n.variants?.length ?? 0) >= 2;

// What a step's variants are judged on: acceptance for invitations, replies for everything else.
export function abMetric(n: VariantNode): AbMetric {
  return n.abtest?.metric ?? (n.type === 'connect' ? 'accepted' : 'replied');
}

// The step as it is sent with one variant's content in its single-text fields.
export function withVariant<T extends VariantNode>(n: T, id: VariantId | null): T {
  const v = id ? (n.variants as VariantContent[] | undefined)?.find((x) => x.id === id) : undefined;
  if (!v) return n;
  const node: VariantNode = n;
  if (node.type === 'connect') return { ...n, note: v.note ?? '' };
  if (node.type === 'message' || node.type === 'sms') return { ...n, text: v.text ?? node.text };
  return { ...n, subject: v.subject ?? node.subject, body: v.body ?? node.body };
}

export function successors(n: SeqNode): (string | null)[] {
  return n.type === 'condition' ? [n.yes, n.no] : [n.next];
}

// Whether every lead reaching node `id` has passed a step of type `type` on the way from the start.
export function precededBy(seq: Sequence, id: string, type: SeqNode['type']): boolean {
  // Draft sequences may loop or share nodes; visiting each node once keeps this linear (valid ones are trees).
  const visited = new Set<string>();
  const find = (cur: string | null, seen: boolean): boolean | null => {
    if (!cur || !seq.nodes[cur] || visited.has(cur)) return null;
    if (cur === id) return seen;
    visited.add(cur);
    const n = seq.nodes[cur];
    for (const s of successors(n)) {
      const r = find(s, seen || n.type === type);
      if (r != null) return r;
    }
    return null;
  };
  return find(seq.start, false) ?? false;
}

// Returns a list of problems; empty means the sequence can run.
export function validateSequence(seq: Sequence): string[] {
  const errors: string[] = [];
  for (const [key, n] of Object.entries(seq.nodes)) {
    if (key !== n.id) errors.push(`Node key "${key}" does not match its id "${n.id}"`);
    for (const s of successors(n)) {
      if (s && !seq.nodes[s]) errors.push(`Node "${n.id}" points to missing node "${s}"`);
    }
  }
  if (seq.start && !seq.nodes[seq.start]) errors.push(`Start node "${seq.start}" is missing`);

  // Must be a tree reachable from start: no cycles, no node with two parents.
  const seen = new Set<string>();
  const walk = (id: string | null, path: Set<string>) => {
    if (!id || !seq.nodes[id]) return;
    if (path.has(id)) return void errors.push(`Sequence loops back to "${id}"`);
    if (seen.has(id)) return void errors.push(`Node "${id}" is reached from two places`);
    seen.add(id);
    path.add(id);
    for (const s of successors(seq.nodes[id])) walk(s, path);
    path.delete(id);
  };
  walk(seq.start, new Set());

  for (const n of Object.values(seq.nodes)) {
    if (isVariantNode(n) && n.type !== 'connect' && n.abtest?.metric === 'accepted') {
      errors.push(`Step "${n.id}" can only be judged on replies: acceptance applies to invitations`);
    }
  }

  const reachable = (t: SeqNode['type']) => [...seen].some((id) => seq.nodes[id].type === t);
  for (const id of seen) {
    const n = seq.nodes[id];
    if (n.type === 'condition' && n.kind === 'accepted_within' && !reachable('connect')) {
      errors.push('An "accepted invite" condition needs a Connect step before it');
    }
    if (n.type === 'condition' && n.kind === 'reply_sentiment' && !n.categories?.length) {
      errors.push('A "reply is" condition needs at least one reply category');
    }
  }
  return errors;
}

// The default starting point for new campaigns, matching the classic "warm then invite" flow.
export function defaultSequence(): Sequence {
  return {
    start: 'n1',
    nodes: {
      n1: { id: 'n1', type: 'view_profile', next: 'n2' },
      n2: { id: 'n2', type: 'wait', days: 1, hours: 0, next: 'n3' },
      n3: { id: 'n3', type: 'connect', note: 'Hi {{firstName}}, {I came across|I noticed} your work at {{company|your company}} and would love to connect.', next: 'n4' },
      n4: { id: 'n4', type: 'condition', kind: 'accepted_within', withinDays: 7, yes: 'n5', no: 'n8' },
      n5: { id: 'n5', type: 'message', text: 'Thanks for connecting, {{firstName}}! {Quick question|Curious}: how is your team handling outreach today?', next: 'n6' },
      n6: { id: 'n6', type: 'wait', days: 3, hours: 0, next: 'n7' },
      n7: { id: 'n7', type: 'message', text: 'Hi {{firstName}}, just bumping this in case it got buried.', next: null },
      n8: { id: 'n8', type: 'withdraw_invite', next: null },
    },
  };
}
