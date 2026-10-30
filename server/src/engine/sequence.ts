import { z } from 'zod';

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
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const CONDITION_KINDS = ['is_connected', 'accepted_within', 'has_email', 'replied'] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

const ptr = z.string().min(1).nullable().default(null);

export const NodeSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('view_profile'), next: ptr }),
  z.object({ id: z.string(), type: z.literal('follow'), next: ptr }),
  z.object({ id: z.string(), type: z.literal('endorse'), count: z.number().int().min(1).max(5).default(3), next: ptr }),
  z.object({ id: z.string(), type: z.literal('like_post'), next: ptr }),
  z.object({ id: z.string(), type: z.literal('connect'), note: z.string().max(2000).default(''), next: ptr }),
  z.object({ id: z.string(), type: z.literal('message'), text: z.string().min(1).max(8000), next: ptr }),
  z.object({
    id: z.string(),
    type: z.literal('email'),
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(20000),
    next: ptr,
  }),
  z.object({ id: z.string(), type: z.literal('withdraw_invite'), next: ptr }),
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

export const CampaignSettingsSchema = z.object({
  stopOnReply: z.boolean().default(true),
  skipIfInOtherCampaign: z.boolean().default(true),
  skipAlreadyConnected: z.boolean().default(false),
  noteLimit: z.number().int().min(100).max(300).default(300),
});
export type CampaignSettings = z.infer<typeof CampaignSettingsSchema>;

export function successors(n: SeqNode): (string | null)[] {
  return n.type === 'condition' ? [n.yes, n.no] : [n.next];
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

  const reachable = (t: SeqNode['type']) => [...seen].some((id) => seq.nodes[id].type === t);
  for (const id of seen) {
    const n = seq.nodes[id];
    if (n.type === 'condition' && n.kind === 'accepted_within' && !reachable('connect')) {
      errors.push('An "accepted invite" condition needs a Connect step before it');
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
