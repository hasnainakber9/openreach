// What an inbound reply means for the sequence. Classified by the ai.classify job (AI provider, or keyword
// heuristics in the simulator) and set by hand from the inbox.

export const REPLY_CATEGORIES = [
  'interested',
  'meeting_booked',
  'question',
  'not_now',
  'not_interested',
  'out_of_office',
  'wrong_person',
  'unsubscribe',
  'other',
] as const;
export type ReplyCategory = (typeof REPLY_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ReplyCategory, string> = {
  interested: 'Interested',
  meeting_booked: 'Meeting booked',
  question: 'Question',
  not_now: 'Not now',
  not_interested: 'Not interested',
  out_of_office: 'Out of office',
  wrong_person: 'Wrong person',
  unsubscribe: 'Unsubscribe',
  other: 'Other',
};

// The pipeline stage a reply suggests. g5-pipeline turns this hint into a real stage change.
export const SUGGESTED_STAGE: Partial<Record<ReplyCategory, 'interested' | 'meeting' | 'lost'>> = {
  interested: 'interested',
  meeting_booked: 'meeting',
  not_interested: 'lost',
};

// Replies that put the person on the do-not-contact list and never let a sequence go on. Suppression needs
// a minimum confidence, since a wrong guess silently drops a real prospect and is only undone by hand. An
// explicit opt-out is final even when polite ("stop messaging me, but thanks"), so it only has to be more
// likely than not; "not interested" is often conditional, so it needs a confident answer.
export type SuppressCategory = 'unsubscribe' | 'not_interested';
export const SUPPRESS_CATEGORIES: readonly ReplyCategory[] = ['unsubscribe', 'not_interested'] satisfies SuppressCategory[];
export const SUPPRESS_MIN_CONFIDENCE: Record<SuppressCategory, number> = { unsubscribe: 0.5, not_interested: 0.7 };
export const isSuppressCategory = (c: ReplyCategory): c is SuppressCategory => SUPPRESS_CATEGORIES.includes(c);

export const isReplyCategory = (v: unknown): v is ReplyCategory => typeof v === 'string' && (REPLY_CATEGORIES as readonly string[]).includes(v);

// One-line descriptions for the classifier prompt (and tooltips).
export const CATEGORY_HINTS: Record<ReplyCategory, string> = {
  interested: 'wants to talk, see a demo or learn more',
  meeting_booked: 'confirmed or booked a meeting time',
  question: 'asks something before deciding',
  not_now: 'open to it, but later',
  not_interested: 'declines',
  out_of_office: 'an automatic away or out-of-office reply',
  wrong_person: 'not the right contact, or has left the company',
  unsubscribe: 'asks not to be contacted again',
  other: 'none of the above',
};

export interface Classification {
  category: ReplyCategory;
  confidence: number;
}

// Offline classifier used by the simulated AI provider: first matching rule wins, so the order matters
// (auto-replies first, because their footers often mention "unsubscribe" or "call"). Unambiguous phrases
// score 0.9; negated opt-outs, and a "not interested" that is qualified or sits next to a positive phrase,
// stay under SUPPRESS_MIN_CONFIDENCE so nobody is suppressed on a guess. "We're all set" only declines when
// nothing but a thank-you follows it: "we're all set for Tuesday" confirms a meeting.
const RULES: [ReplyCategory, RegExp][] = [
  [
    'out_of_office',
    /\b(out of (the )?office|auto(matic)?[- ]?reply|automated (reply|response)|on (annual |parental |maternity |paternity |sick )?leave|on (vacation|holiday)|away from (my|the) (desk|office)|limited access to (my )?e-?mail|i('m| am) (currently )?(away|travell?ing) (until|till|and)|will (be back|return) on)\b/,
  ],
  [
    'unsubscribe',
    /\b(unsubscribe|remove (me|my (e-?mail|address|details|name|contact|data|info(rmation)?)|this (e-?mail|address))|take me off|opt (me )?out|stop (messaging|contacting|emailing|sending|writing)|(do not|don't|never|(do not|don't) ever) (contact|message|e-?mail|call|write to) me|leave me alone|delete my (data|details|info(rmation)?|e-?mail|address|contact))\b|^\W*(please )?(stop|remove)\W*$/,
  ],
  ['not_interested', /\b(not interested|no,? thanks|no,? thank you|not for us|not a (good )?fit|we('re| are) (all )?(set|good)( here)?(?=(,? (thanks?|thank you))?\W*$)|i('ll| will) pass|pass on this|not looking for)\b/],
  ['wrong_person', /\b(wrong person|no longer (at|with|work)|not the right (person|contact)|left the company|don't work (at|for)|not my (area|department)|not responsible for|(reach|speak) (out )?to my colleague)\b/],
  [
    'meeting_booked',
    /\b(booked (a|the|it|in|us|our|some|you)|confirmed( for| the)?|see you (on|then|tomorrow|next|at)|(accepted|sent) (the|your) (calendar )?invite|looking forward to (our|the) (call|meeting|chat)|i('ve| have) (scheduled|booked)|scheduled (a|the|our) (call|meeting))\b/,
  ],
  [
    'not_now',
    /\b(next (quarter|year|month)|not (right )?now|not a (priority|good time)|maybe later|later (this|next) year|circle back|reach out (again )?(in|later)|check back|follow up (in|later)|too busy|bad time|in a (few|couple of) (months|weeks)|after (the )?(summer|holidays|q[1-4]))\b/,
  ],
  [
    'interested',
    /\b(let'?s talk|let'?s (chat|connect|set (something|it) up)|happy to (chat|talk|connect|hop on)|sounds (good|great|interesting)|(i'm|i am|we're|we are) interested|book a (call|time|meeting)|schedule (a|some) (call|time)|calendar|set up a call|(quick|short) call|tell me more|would love to|keen to)\b/,
  ],
];

// Words that make a decline conditional: "not interested in X, but...", "not interested at the moment".
const QUALIFIERS = /\b(but|however|unless|though|although|except|yet|maybe|perhaps)\b/;
const TIMING = /\b(right now|at the moment|at this (time|stage|point)|for now|this (year|quarter|month)|currently)\b/;
// "n't" has no word boundary in front of it ("don't", "wouldn't"), so it stands outside the \b group. A
// question is no negation: "why won't you stop emailing me?", "can't you just remove me?" are opt-outs.
const NEGATED = /(\b(not|never|no longer)|n't)\s+(?!you\b)(\w+\s+){0,3}$/;
const POSITIVE = RULES.filter(([c]) => c === 'meeting_booked' || c === 'interested').map(([, re]) => re);

export function keywordCategory(text: string): Classification {
  const t = text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
  for (const [category, re] of RULES) {
    const m = re.exec(t);
    if (!m) continue;
    if (category === 'unsubscribe' || category === 'not_interested') {
      const before = t.slice(0, m.index);
      const after = t.slice(m.index + m[0].length);
      // "I'm not saying unsubscribe me", "I wouldn't say not interested": under every suppression threshold.
      if (NEGATED.test(before)) return { category, confidence: 0.4 };
      // "No need to remove me, I'm interested": next to a positive phrase it is no sure opt-out.
      if (category === 'unsubscribe' && POSITIVE.some((p) => p.test(t))) return { category, confidence: 0.4 };
      // Only "not interested" can be conditional; "stop messaging me, but thanks" is still an opt-out.
      if (category === 'not_interested') {
        if (TIMING.test(after)) return { category: 'not_now', confidence: 0.65 };
        // "not interested in X, but happy to look at Y", or a decline next to "let's talk"
        if (QUALIFIERS.test(after) || /^ in (?!(this|it|that|your|the (offer|product|service)))\w/.test(after) || POSITIVE.some((p) => p.test(t))) return { category, confidence: 0.55 };
      }
    }
    return { category, confidence: 0.9 };
  }
  if (t.includes('?')) return { category: 'question', confidence: 0.6 };
  return { category: 'other', confidence: 0.5 };
}
