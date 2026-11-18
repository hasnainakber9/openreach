import { z } from 'zod';
import { httpJson, ProviderError, RateLimiter } from '../http.js';
import type { ProviderDef } from '../registry.js';
import { crmFieldValue, crmSettingsSchema, mappedProperties, noteHtml, PIPEDRIVE_MAPPING, type CrmProvider } from './types.js';

// Pipedrive API v1 with a personal API token (https://developers.pipedrive.com/docs/api/v1)
//   Search:  GET  /persons/search?term&fields=email&exact_match=true   (custom_fields for the LinkedIn URL)
//   Create:  POST /persons    { name, email: [{ value, primary }], phone: [...], <custom field key>: value }
//   Update:  GET  /persons/{id} (current emails/phones, merged into), then PUT /persons/{id}
//   Notes:   POST /notes      { content, person_id, add_time }
//   Deals:   POST /deals      { title, person_id, stage_id? }
//   Test:    GET  /users/me
// The token goes in the x-api-token header rather than the api_token query parameter, so it never sits
// in a URL. Follows Pipedrive's public docs; tested only against fakes, never against the live API.

// Pipedrive limits by token budget per company; a few requests a second is far below it.
const limiter = new RateLimiter(5);

// The domain is interpolated into https://{x}.pipedrive.com, so only a bare subdomain is accepted
// (a pasted "https://acme.pipedrive.com/" is trimmed to "acme" first). Nothing else can send the token elsewhere.
export const companyDomain = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/\.pipedrive\.com\/?$/, '')
      : v,
  z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Use your company domain, e.g. "acme" for acme.pipedrive.com'),
);

const credentials = z.object({ apiToken: z.string().trim().min(10).max(200) });
const settings = crmSettingsSchema(PIPEDRIVE_MAPPING).extend({
  companyDomain,
  dealStageId: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
});
type Settings = z.infer<typeof settings>;

// Pipedrive stores emails and phones as lists of labelled values, and a PUT replaces the whole list.
interface MultiValue {
  value: string;
  primary: boolean;
  label?: string;
}
const MULTI_FIELDS = ['email', 'phone'] as const;
const multi = (value: string): MultiValue[] => [{ value, primary: true, label: 'work' }];
const same = (field: string, a: string, b: string) => (field === 'phone' ? a.replace(/\D/g, '') === b.replace(/\D/g, '') : a.trim().toLowerCase() === b.trim().toLowerCase());

// The person's list with our value added: entries someone added in Pipedrive and their primary flag stay.
// Undefined when the value is already there (nothing to send). Pipedrive returns [{ value: '' }] for "none".
export function mergeMulti(field: string, current: unknown, value: string): MultiValue[] | undefined {
  const kept = (Array.isArray(current) ? current : [])
    .filter((e): e is { value: string; primary?: boolean; label?: string } => !!e && typeof e.value === 'string' && e.value.trim() !== '')
    .map((e) => ({ value: e.value, primary: !!e.primary, ...(e.label ? { label: e.label } : {}) }));
  if (kept.some((e) => same(field, e.value, value))) return undefined;
  return [...kept, { value, primary: !kept.some((e) => e.primary), label: 'work' }];
}

export const pipedriveCrm: ProviderDef<'crm'> = {
  id: 'pipedrive',
  kind: 'crm',
  label: 'Pipedrive',
  description: 'Creates and updates Pipedrive persons, logs replies and messages as notes, and can open deals.',
  docsUrl: 'https://pipedrive.readme.io/docs/how-to-find-the-api-token',
  fields: [
    { key: 'apiToken', label: 'API token', type: 'password', secret: true, required: true, help: 'Pipedrive → Personal preferences → API.' },
    { key: 'companyDomain', label: 'Company domain', type: 'text', required: true, placeholder: 'acme', help: 'The part before .pipedrive.com in your Pipedrive address.' },
    { key: 'dealStageId', label: 'Deal stage id', type: 'number', placeholder: '1', help: 'Optional. New deals start in the first stage of your default pipeline otherwise.' },
  ],
  credentials,
  settings,
  accountSettings: ['companyDomain'],
  create(ctx, cfg): CrmProvider {
    const s = cfg.settings as Partial<Settings>;
    const token: string = cfg.credentials.apiToken ?? '';
    const base = () => {
      if (!token) throw new ProviderError('AUTH', 'Add the Pipedrive API token', { integrationId: cfg.integrationId });
      if (!s.companyDomain) throw new ProviderError('BAD_REQUEST', 'Add your Pipedrive company domain', { integrationId: cfg.integrationId });
      return `https://${s.companyDomain}.pipedrive.com/api/v1`;
    };
    const call = <T>(method: string, path: string, body?: unknown) =>
      httpJson<T>(ctx, `${base()}${path}`, { method, body, headers: { 'x-api-token': token }, secrets: [token], integrationId: cfg.integrationId, limiter, limitKey: cfg.integrationId ?? 'pipedrive' });
    const idOf = (r: { data?: { id?: number | string } } | null, what: string) => {
      const id = r?.data?.id;
      if (id == null) throw new ProviderError('UNAVAILABLE', `Pipedrive did not return a ${what} id`, { integrationId: cfg.integrationId });
      return String(id);
    };
    const search = async (term: string, field: 'email' | 'custom_fields') => {
      if (term.length < 2) return null;
      const q = new URLSearchParams({ term, fields: field, exact_match: 'true', limit: '1' });
      const r = await call<{ data?: { items?: { item?: { id?: number } }[] } }>('GET', `/persons/search?${q}`);
      const id = r?.data?.items?.[0]?.item?.id;
      return id == null ? null : String(id);
    };
    return {
      providerId: 'pipedrive',
      simulated: false,
      async test() {
        const r = await call<{ data?: { name?: string; company_name?: string } }>('GET', '/users/me');
        return { ok: true, message: `Connected to Pipedrive${r?.data?.company_name ? ` (${r.data.company_name})` : ''}${r?.data?.name ? ` as ${r.data.name}` : ''}.` };
      },
      async upsertContact(c, mapping, existingId) {
        const props: Record<string, unknown> = mappedProperties(c, mapping);
        const update = async (id: string) => {
          const path = `/persons/${encodeURIComponent(id)}`;
          const body = { ...props };
          // Emails and phones are merged into the person's current lists, never sent as replacements.
          if (MULTI_FIELDS.some((f) => typeof body[f] === 'string')) {
            const cur = await call<{ data?: Record<string, unknown> }>('GET', path);
            for (const f of MULTI_FIELDS) {
              if (typeof body[f] !== 'string') continue;
              const merged = mergeMulti(f, cur?.data?.[f], body[f] as string);
              if (merged) body[f] = merged;
              else delete body[f];
            }
          }
          if (Object.keys(body).length) await call('PUT', path, body);
          return { id, created: false };
        };
        if (existingId) {
          try {
            return await update(existingId);
          } catch (e) {
            if (!(e instanceof ProviderError && e.code === 'NOT_FOUND')) throw e;
          }
        }
        const found = (c.email ? await search(c.email, 'email') : null) ?? (mapping.profileUrl && c.profileUrl ? await search(crmFieldValue(c, 'profileUrl'), 'custom_fields') : null);
        if (found) return update(found);
        for (const f of MULTI_FIELDS) if (typeof props[f] === 'string') props[f] = multi(props[f] as string);
        // A person needs a name.
        props.name ??= crmFieldValue(c, 'fullName') || c.email || c.profileUrl || 'LinkedIn lead';
        return { id: idOf(await call('POST', '/persons', props), 'person'), created: true };
      },
      async addNote(contactId, note) {
        // Pipedrive wants UTC "YYYY-MM-DD HH:MM:SS".
        const addTime = new Date(note.timestamp).toISOString().slice(0, 19).replace('T', ' ');
        return { id: idOf(await call('POST', '/notes', { content: noteHtml(note.body), person_id: Number(contactId), add_time: addTime }), 'note') };
      },
      async createDeal(contactId, deal) {
        const stage = deal.stage ? Number(deal.stage) : s.dealStageId;
        return { id: idOf(await call('POST', '/deals', { title: deal.name, person_id: Number(contactId), ...(stage ? { stage_id: stage } : {}) }), 'deal') };
      },
      recordUrl(objectType, id) {
        return s.companyDomain ? `https://${s.companyDomain}.pipedrive.com/${objectType === 'deal' ? 'deal' : 'person'}/${encodeURIComponent(id)}` : null;
      },
    };
  },
};
