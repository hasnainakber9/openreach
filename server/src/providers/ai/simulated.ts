import { z } from 'zod';
import { pick } from '../hash.js';
import { SIMULATOR_TEST, type ProviderDef } from '../registry.js';
import type { AiProvider, AiRequest } from './types.js';

const OPENERS = ['Hi {name},', 'Hello {name},', 'Hey {name},'];
const BODIES = [
  'I noticed your work at {company} and thought it would be good to connect.',
  'your background at {company} caught my eye, and I would love to swap notes.',
  'I have been following what {company} is building and wanted to say hello.',
];
const CLOSERS = ['Best,', 'Cheers,', 'Thanks,'];

// Pulls "firstName: X" / "company: Y" style lines out of a prompt's lead data block.
function field(prompt: string, name: string, fallback: string) {
  const m = new RegExp(`${name}\\s*[:=]\\s*"?([^"\\n]+)`, 'i').exec(prompt);
  return m?.[1].trim() || fallback;
}

const tokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

// Offline stand-in: templated text chosen by a hash of the prompt, so the same prompt always
// gives the same answer. Its output is never sent through a real channel (later steps enforce this).
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
        const fill = (s: string) => s.replace('{name}', name).replace('{company}', company);
        const text =
          req.purpose === 'classify'
            ? '{"category":"other","confidence":0.5}'
            : [fill(pick(OPENERS, req.prompt, 'o')), fill(pick(BODIES, req.prompt, 'b')), pick(CLOSERS, req.prompt, 'c')].join(' ');
        return { text, model: 'simulated', inputTokens: tokens(req.system + req.prompt), outputTokens: tokens(text) };
      },
    };
  },
};
