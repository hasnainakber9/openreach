import { z } from 'zod';
import { isReplyCategory, keywordCategory, type ReplyCategory } from '../../ai/categories.js';
import { hashUnit, pick } from '../hash.js';
import { SIMULATOR_TEST, type ProviderDef } from '../registry.js';
import type { AiProvider, AiRequest } from './types.js';

const OPENERS = ['Hi {name},', 'Hello {name},', 'Hey {name},'];
const BODIES = [
  'I noticed your work at {company} and thought it would be good to connect.',
  'your background at {company} caught my eye, and I would love to swap notes.',
  'I have been following what {company} is building and wanted to say hello.',
];
const CLOSERS = ['Best,', 'Cheers,', 'Thanks,'];

// Per-lead lines for {{ai:...}} variables.
const LINES = [
  'Your work as {title} at {company} stood out to me',
  'I enjoyed seeing what {company} has been up to lately',
  'It is not every day I come across a {title} with your background',
  '{company} keeps coming up when people talk about doing this well',
  'Your path to {title} at {company} is an interesting one',
];

// Drafts use our template variables, like a real model is asked to.
const DRAFT_OPENERS = ['Hi {{firstName}},', 'Hello {{firstName}},', 'Hey {{firstName}},'];
const DRAFT_HOOKS = [
  'I came across your profile and liked what {{company|your team}} is working on.',
  'your work at {{company|your company}} caught my eye.',
  'I have been following {{company|your team}} for a while.',
];
const DRAFT_ASKS = ['Would you be open to a quick chat?', 'Worth a short call next week?', 'Happy to share more if it is useful.'];

// Pulls "first_name: X" / "company: Y" style lines out of a prompt's data block.
function field(prompt: string, name: string, fallback: string) {
  const m = new RegExp(`^\\s*${name}\\s*[:=]\\s*"?([^"\\n]+)`, 'im').exec(prompt);
  return m?.[1].trim() || fallback;
}

// Reply drafts per category of the prospect's last message; {name} is their first name.
const REPLY_DRAFTS: Record<ReplyCategory, string[]> = {
  interested: [
    'Great to hear, {name}! Would Tuesday or Thursday afternoon work for a 20-minute call?',
    'Thanks {name}, glad it is useful. What does your week look like? I can work around your schedule.',
    'Appreciate it, {name}. Happy to walk you through it on a short call. When suits you best?',
  ],
  meeting_booked: [
    'Perfect, {name}, see you then. I will send a short agenda beforehand.',
    'Thanks for booking, {name}! Looking forward to our chat.',
    'Great, it is in my calendar. Anything you would like me to prepare, {name}?',
  ],
  question: [
    'Good question, {name}. In short, we help teams like yours do this with less manual work. Happy to go into detail on a quick call.',
    'Thanks for asking, {name}! I can send over a short summary. Anything specific it should cover?',
    'Sure, {name}. What would be most useful to know first?',
  ],
  not_now: [
    'Totally understand, {name}. I will check back in a few months. All the best until then!',
    'No problem at all, {name}. Would it be all right if I reached out next quarter?',
    'Thanks for letting me know, {name}. Feel free to get in touch whenever the timing is better.',
  ],
  not_interested: [
    'Thanks for the honest answer, {name}. I will not follow up on this. All the best!',
    'Understood, {name}. Thanks for taking the time to reply.',
    'Appreciate you letting me know, {name}. Wishing you and the team a great quarter.',
  ],
  out_of_office: [
    'Thanks, {name}. I will follow up once you are back.',
    'No rush at all, {name}. Enjoy the time off.',
    'Thanks for the note, {name}. I will pick this up again when you return.',
  ],
  wrong_person: [
    'Thanks for letting me know, {name}! Could you point me to the right person?',
    'Appreciate it, {name}. Who would be best to speak to about this?',
    'Sorry for the mix-up, {name}. If you know who looks after this, an introduction would be much appreciated.',
  ],
  unsubscribe: ['Understood, {name}. I will not contact you again.', 'Sorry for the bother, {name}. You will not hear from me again.', 'Done, {name}. Apologies for the interruption.'],
  other: ['Thanks for getting back to me, {name}!', 'Appreciate the reply, {name}. Happy to help if anything comes up.', 'Thanks, {name}. Let me know if there is anything I can share.'],
};

// The text inside a prompt's <tag> block.
const block = (prompt: string, tag: string) => new RegExp(`<${tag}>([^]*?)</${tag}>`).exec(prompt)?.[1].trim() ?? '';

function replyDrafts(req: AiRequest, name: string) {
  const n = Math.max(1, Math.min(3, Number(field(req.prompt, 'count', '1')) || 1));
  const asked = field(req.prompt, 'category', '');
  const category = isReplyCategory(asked) ? asked : keywordCategory(block(req.prompt, 'latest_reply')).category;
  const options = REPLY_DRAFTS[category];
  const first = Math.floor(hashUnit(req.prompt) * options.length);
  const replies = Array.from({ length: n }, (_, i) => options[(first + i) % options.length].replace('{name}', name));
  return JSON.stringify({ replies });
}

const tokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…');

function drafts(req: AiRequest) {
  const channel = field(req.prompt, 'channel', 'message');
  const n = Math.max(1, Math.min(5, Number(field(req.prompt, 'variants', '1')) || 1));
  const max = Number(field(req.prompt, 'max_chars', '600')) || 600;
  const offer = field(req.prompt, 'offer', 'what we do').replace(/[.!\s]+$/, '');
  const out = Array.from({ length: n }, (_, i) => {
    const parts = [pick(DRAFT_OPENERS, req.prompt, i, 'o'), pick(DRAFT_HOOKS, req.prompt, i, 'h'), `What we do: ${offer}.`, pick(DRAFT_ASKS, req.prompt, i, 'a')];
    const text = cut(parts.join(' '), max);
    if (channel === 'email' || channel === 'inmail') return { subject: cut(`Idea for {{company|your team}}: ${offer}`, 120), body: cut(parts.join('\n\n'), max) };
    return { text };
  });
  return JSON.stringify({ drafts: out });
}

// Offline stand-in: templated text chosen by a hash of the prompt, so the same prompt always
// gives the same answer. Its output is never sent through a real channel (the engine uses fallbacks there).
export const simulatedAi: ProviderDef<'ai'> = {
  id: 'simulated',
  kind: 'ai',
  label: 'Built-in simulator',
  description: 'Writes short templated text from the lead data. Works offline; for trying features, not for real outreach.',
  simulated: true,
  fields: [],
  credentials: z.object({}),
  settings: z.object({}),
  create(): AiProvider {
    return {
      providerId: 'simulated',
      simulated: true,
      test: async () => SIMULATOR_TEST,
      async complete(req: AiRequest) {
        const name = field(req.prompt, 'first_?name', 'there');
        const company = field(req.prompt, 'company', 'your company');
        const title = field(req.prompt, 'title', 'leader');
        const fill = (s: string) => s.replace('{name}', name).replace('{company}', company).replace('{title}', title);
        let text: string;
        // Classification uses keyword rules on the latest reply, so demos branch the way a real model would.
        if (req.purpose === 'classify') text = JSON.stringify(keywordCategory(block(req.prompt, 'latest_reply') || req.prompt));
        else if (req.purpose === 'reply') text = replyDrafts(req, name);
        // Writer requests (they carry a "channel:" line) want JSON drafts; anything else gets a greeting.
        else if (req.purpose === 'write' && /^\s*channel\s*:/im.test(req.prompt)) text = drafts(req);
        else if (req.purpose === 'personalize') text = fill(LINES[Math.floor(hashUnit(req.prompt) * LINES.length)]) + '.';
        else text = [fill(pick(OPENERS, req.prompt, 'o')), fill(pick(BODIES, req.prompt, 'b')), pick(CLOSERS, req.prompt, 'c')].join(' ');
        return { text, model: 'simulated', inputTokens: tokens(req.system + req.prompt), outputTokens: tokens(text) };
      },
    };
  },
};
