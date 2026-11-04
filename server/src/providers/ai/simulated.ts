import { z } from 'zod';
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

const tokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…');

function drafts(req: AiRequest) {
  const channel = field(req.prompt, 'channel', 'message');
  const n = Math.max(1, Math.min(5, Number(field(req.prompt, 'variants', '1')) || 1));
  const max = Number(field(req.prompt, 'max_chars', '600')) || 600;
  const offer = field(req.prompt, 'offer', 'what we do').replace(/[.!\s]+$/, '');
  const out = Array.from({ length: n }, (_, i) => {
    const parts = [pick(DRAFT_OPENERS, req.prompt, i, 'o'), pick(DRAFT_HOOKS, req.prompt, i, 'h'), `We help with ${offer}.`, pick(DRAFT_ASKS, req.prompt, i, 'a')];
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
        if (req.purpose === 'classify') text = '{"category":"other","confidence":0.5}';
        // Writer requests (they carry a "channel:" line) want JSON drafts; anything else gets a greeting.
        else if (req.purpose === 'write' && /^\s*channel\s*:/im.test(req.prompt)) text = drafts(req);
        else if (req.purpose === 'personalize') text = fill(LINES[Math.floor(hashUnit(req.prompt) * LINES.length)]) + '.';
        else text = [fill(pick(OPENERS, req.prompt, 'o')), fill(pick(BODIES, req.prompt, 'b')), pick(CLOSERS, req.prompt, 'c')].join(' ');
        return { text, model: 'simulated', inputTokens: tokens(req.system + req.prompt), outputTokens: tokens(text) };
      },
    };
  },
};
