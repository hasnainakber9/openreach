import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SIMULATOR_TEST, type ProviderDef } from '../registry.js';
import { DEFAULT_SMS_POLICY, type SmsProvider } from './types.js';

// Transmits nothing; the messaging runner stores the message in the inbox as if it went out.
export const simulatedSms: ProviderDef<'sms'> = {
  id: 'simulated',
  kind: 'sms',
  label: 'Built-in simulator',
  description: 'Pretends to send SMS and WhatsApp messages (100 a day each, 09:00–19:00 UTC). Nothing is transmitted.',
  simulated: true,
  fields: [],
  credentials: z.object({}),
  settings: z.object({}),
  create(): SmsProvider {
    return {
      providerId: 'simulated',
      simulated: true,
      policy: DEFAULT_SMS_POLICY,
      test: async () => SIMULATOR_TEST,
      // A fresh id per send, like a real provider: the same text to the same number twice is two messages.
      async send() {
        return { externalId: `sim_${randomUUID()}` };
      },
      // Accepting any signature here would be a public backdoor, since this is every workspace's default.
      verifySignature: () => false,
    };
  },
};
