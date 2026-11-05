import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { httpJson, ProviderError, RateLimiter } from '../http.js';
import type { ProviderConfig, ProviderDef } from '../registry.js';
import { crmSettingsSchema, crmFieldValue, HUBSPOT_MAPPING, mappedProperties, noteHtml, type CrmProvider } from './types.js';

// HubSpot CRM v3 with a private app access token (https://developers.hubspot.com/docs/api/crm/contacts)
//   Search:  POST /crm/v3/objects/contacts/search   (filter on email, else on the mapped LinkedIn URL property)
//   Create:  POST /crm/v3/objects/contacts          { properties }
//   Update:  PATCH /crm/v3/objects/contacts/{id}    { properties }
//   Notes:   POST /crm/v3/objects/notes             { properties: { hs_note_body, hs_timestamp }, associations } (note → contact: type 202)
//   Deals:   POST /crm/v3/objects/deals             { properties: { dealname, pipeline, dealstage }, associations } (deal → contact: type 3)
//   Test:    GET  /crm/v3/objects/contacts?limit=1
// Follows HubSpot's public docs; tested only against fakes, never against the live API.

const API = 'https://api.hubapi.com';
// Private apps get about 10 requests/s, and search has a lower limit of its own; stay under both.
const limiter = new RateLimiter(8);
const searchLimiter = new RateLimiter(4);

const blankToUndefined = (v: unknown) => (typeof v === 'string' && !v.trim() ? undefined : v);

const credentials = z.object({ accessToken: z.string().trim().min(10).max(500) });
const settings = crmSettingsSchema(HUBSPOT_MAPPING).extend({
  dealPipeline: z.preprocess(blankToUndefined, z.string().trim().max(100).default('default')),
  dealStage: z.preprocess(blankToUndefined, z.string().trim().max(100).default('appointmentscheduled')),
  portalId: z.preprocess(blankToUndefined, z.string().trim().regex(/^\d{1,12}$/, 'Your HubSpot account id (digits only)').optional()),
});
type Settings = z.infer<typeof settings>;

const NOTE_TO_CONTACT = 202;
const DEAL_TO_CONTACT = 3;

function client(ctx: Ctx, cfg: ProviderConfig) {
  const token: string = cfg.credentials.accessToken ?? '';
  const common = { headers: { authorization: `Bearer ${token}` }, secrets: [token], integrationId: cfg.integrationId, limiter, limitKey: cfg.integrationId ?? 'hubspot' };
  return {
    ready() {
      if (!token) throw new ProviderError('AUTH', 'Add the HubSpot private app access token', { integrationId: cfg.integrationId });
    },
    call<T>(method: string, path: string, body?: unknown, search = false) {
      return httpJson<T>(ctx, `${API}${path}`, { ...common, ...(search ? { limiter: searchLimiter } : {}), method, body });
    },
  };
}

// HubSpot answers 409 with "Contact already exists. Existing ID: 123" when an email is taken (search
// results lag behind writes by a few seconds), so the id is read from the message.
const existingIdIn = (e: unknown) => (e instanceof ProviderError && e.status === 409 ? /Existing ID:\s*(\d+)/i.exec(e.message)?.[1] ?? null : null);

export const hubspotCrm: ProviderDef<'crm'> = {
  id: 'hubspot',
  kind: 'crm',
  label: 'HubSpot',
  description: 'Creates and updates HubSpot contacts, logs replies and messages as notes, and can open deals.',
  docsUrl: 'https://developers.hubspot.com/docs/api/private-apps',
  fields: [
    {
      key: 'accessToken',
      label: 'Private app access token',
      type: 'password',
      secret: true,
      required: true,
      placeholder: 'pat-…',
      help: 'HubSpot → Settings → Integrations → Private apps. Scopes: crm.objects.contacts.read/write and crm.objects.deals.read/write.',
    },
    { key: 'portalId', label: 'Account id (Hub ID)', type: 'text', placeholder: '12345678', help: 'Optional. Lets OpenReach link to the contact in HubSpot.' },
    { key: 'dealPipeline', label: 'Deal pipeline', type: 'text', placeholder: 'default', help: 'Internal id of the pipeline new deals go into.' },
    { key: 'dealStage', label: 'Deal stage', type: 'text', placeholder: 'appointmentscheduled', help: 'Internal id of the stage new deals start in.' },
  ],
  credentials,
  settings,
  create(ctx, cfg): CrmProvider {
    const s = cfg.settings as Partial<Settings>;
    const api = client(ctx, cfg);
    const search = async (property: string, value: string) => {
      const r = await api.call<{ results?: { id: string }[] }>(
        'POST',
        '/crm/v3/objects/contacts/search',
        { filterGroups: [{ filters: [{ propertyName: property, operator: 'EQ', value }] }], properties: [property], limit: 1 },
        true,
      );
      return r?.results?.[0]?.id ?? null;
    };
    const update = async (id: string, properties: Record<string, string>) => {
      await api.call('PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(id)}`, { properties });
      return { id, created: false };
    };
    return {
      providerId: 'hubspot',
      simulated: false,
      async test() {
        api.ready();
        await api.call('GET', '/crm/v3/objects/contacts?limit=1');
        return { ok: true, message: 'Connected to HubSpot: contacts can be read.' };
      },
      async upsertContact(c, mapping, existingId) {
        api.ready();
        const properties = mappedProperties(c, mapping);
        if (existingId) {
          try {
            return await update(existingId, properties);
          } catch (e) {
            // Deleted or merged in HubSpot since the last sync: find it again or create it.
            if (!(e instanceof ProviderError && e.code === 'NOT_FOUND')) throw e;
          }
        }
        const urlProp = mapping.profileUrl;
        const found = (c.email ? await search('email', c.email) : null) ?? (urlProp && c.profileUrl ? await search(urlProp, crmFieldValue(c, 'profileUrl')) : null);
        if (found) return update(found, properties);
        try {
          const r = await api.call<{ id?: string }>('POST', '/crm/v3/objects/contacts', { properties });
          if (!r?.id) throw new ProviderError('UNAVAILABLE', 'HubSpot did not return a contact id', { integrationId: cfg.integrationId });
          return { id: String(r.id), created: true };
        } catch (e) {
          const id = existingIdIn(e);
          if (id) return update(id, properties);
          throw e;
        }
      },
      async addNote(contactId, note) {
        api.ready();
        const r = await api.call<{ id?: string }>('POST', '/crm/v3/objects/notes', {
          properties: { hs_note_body: noteHtml(note.body), hs_timestamp: new Date(note.timestamp).toISOString() },
          associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }] }],
        });
        if (!r?.id) throw new ProviderError('UNAVAILABLE', 'HubSpot did not return a note id', { integrationId: cfg.integrationId });
        return { id: String(r.id) };
      },
      async createDeal(contactId, deal) {
        api.ready();
        const r = await api.call<{ id?: string }>('POST', '/crm/v3/objects/deals', {
          properties: { dealname: deal.name, pipeline: s.dealPipeline ?? 'default', dealstage: deal.stage ?? s.dealStage ?? 'appointmentscheduled' },
          associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: DEAL_TO_CONTACT }] }],
        });
        if (!r?.id) throw new ProviderError('UNAVAILABLE', 'HubSpot did not return a deal id', { integrationId: cfg.integrationId });
        return { id: String(r.id) };
      },
      recordUrl(objectType, id) {
        if (!s.portalId) return null;
        return `https://app.hubspot.com/contacts/${s.portalId}/record/${objectType === 'deal' ? '0-3' : '0-1'}/${encodeURIComponent(id)}`;
      },
    };
  },
};
