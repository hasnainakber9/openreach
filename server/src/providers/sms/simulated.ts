import { z } from 'zod';
import { hashId } from '../hash.js';
import { SIMULATOR_TEST, type ProviderDef } from '../registry.js';
import type { SmsProvider } from './types.js';

// Records nothing and transmits nothing; the caller stores the message in the inbox.
export const simulatedSms: ProviderDef<'sms'> = {
  id: 'simulated',
  kind: 'sms',
  label: 'Built-in simulator',
  description: 'Pretends to send SMS and WhatsApp messages. Nothing is transmitted.',
  simulated: true,
  fields: [],
  credentials: z.object({}),
  settings: z.object({}),
  create(_ctx, cfg): SmsProvider {
    return {
      providerId: 'simulated',
      simulated: true,
      test: async () => SIMULATOR_TEST,
      async send(msg) {
        return { externalId: hashId('sim', cfg.workspaceId, msg.channel, msg.to, msg.body) };
      },
      // Accepting any signature here would be a public backdoor, since this is every workspace's default.
      verifySignature: () => false,
    };
  },
};
