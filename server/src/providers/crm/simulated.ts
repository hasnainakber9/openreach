import { z } from 'zod';
import { hashId } from '../hash.js';
import { SIMULATOR_TEST, type ProviderDef } from '../registry.js';
import { crmSettingsSchema, SIMULATED_MAPPING, type CrmProvider } from './types.js';

// Never a fallback (see SIMULATED_FALLBACK): it only runs when someone adds it, to demo CRM sync.
// Ids are derived from hashes; nothing is stored or sent anywhere (the sync log and lead links are ours).
export const simulatedCrm: ProviderDef<'crm'> = {
  id: 'simulated',
  kind: 'crm',
  label: 'Simulated CRM',
  description: 'Pretends to sync contacts, notes and deals so you can try CRM sync. Nothing leaves OpenReach.',
  simulated: true,
  fields: [],
  credentials: z.object({}),
  settings: crmSettingsSchema(SIMULATED_MAPPING),
  create(_ctx, cfg): CrmProvider {
    return {
      providerId: 'simulated',
      simulated: true,
      test: async () => SIMULATOR_TEST,
      async upsertContact(c, _mapping, existingId) {
        return { id: existingId || hashId('contact', cfg.workspaceId, c.email ?? c.profileUrl), created: !existingId };
      },
      async addNote(contactId, note) {
        return { id: hashId('note', contactId, note.timestamp, note.body) };
      },
      async createDeal(contactId, deal) {
        return { id: hashId('deal', contactId, deal.name) };
      },
    };
  },
};
