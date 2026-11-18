import { isIP } from 'node:net';
import { z } from 'zod';
import { checkHost, HostCheckError } from '../../services/hosts.js';
import { httpJson, ProviderError, RateLimiter, type HttpJsonOptions } from '../http.js';
import type { ProviderDef } from '../registry.js';
import { crmFieldValue, crmSettingsSchema, ESPOCRM_MAPPING, mappedProperties, type CrmProvider } from './types.js';

// EspoCRM (https://www.espocrm.com, AGPL-3.0), self-hosted, REST API v1 with an API user's key in X-Api-Key
// (Administration → API Users; https://docs.espocrm.com/development/api/).
//   Search:  GET  {base}/api/v1/Contact?where[0][type]=equals&where[0][attribute]=emailAddress&where[0][value]=…
//            (else the same on the mapped LinkedIn URL attribute) → { total, list: [{ id }] }
//   Create:  POST {base}/api/v1/Contact   { lastName (the only required field), firstName, emailAddress, phoneNumber, … }
//            An existing email or name answers 409 with the duplicates as a JSON array (X-Status-Reason: duplicate);
//            resending with X-Skip-Duplicate-Check: true creates it anyway.
//   Update:  GET  {base}/api/v1/Contact/{id} (current emails/phones, merged into), then PUT {base}/api/v1/Contact/{id}
//   Notes:   POST {base}/api/v1/Note        { type: 'Post', parentType: 'Contact', parentId, post } (plain text)
//   Deals:   POST {base}/api/v1/Opportunity { name, amount, amountCurrency, closeDate (YYYY-MM-DD), stage?, contactId, contactsIds }
//            name, amount and closeDate are required.
//   Test:    GET  {base}/api/v1/App/user
// Errors carry their reason in the X-Status-Reason header; a 400 body says which field failed validation.
// Request shapes were checked against a live EspoCRM 10.0.11; this provider is tested against fakes.

// A self-hosted PHP app on someone's laptop: a few requests a second at most, per integration. Exposed for tests.
export const limits = { espocrm: new RateLimiter(4) };
// The first request after PHP has been idle can be slow on a laptop.
const TIMEOUT_MS = 30_000;
export const DEFAULT_CLOSE_DAYS = 30;

// The address people open EspoCRM at. A pasted page (…/#Contact/view/…) or API URL (…/api/v1) is trimmed to it.
export const espoUrlSchema = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .trim()
          .replace(/#.*$/, '')
          .replace(/\/+$/, '')
          .replace(/\/api\/v1$/i, '')
          .replace(/\/+$/, '')
      : v,
  z
    .string()
    .max(300)
    .url('Enter your EspoCRM address, e.g. http://localhost/espocrm')
    .refine((v) => {
      // Runs after a failed .url() too, so an unparsable value must not throw here.
      let u: URL;
      try {
        u = new URL(v);
      } catch {
        return true;
      }
      return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.search;
    }, 'Use an http(s) address without a user name, password or query'),
);

const blankToUndefined = (v: unknown) => (typeof v === 'string' && !v.trim() ? undefined : v);

const credentials = z.object({ apiKey: z.string().trim().min(8).max(200) });
const settings = crmSettingsSchema(ESPOCRM_MAPPING).extend({
  baseUrl: espoUrlSchema,
  dealStage: z.preprocess(blankToUndefined, z.string().trim().max(100).optional()),
  dealCurrency: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, 'A 3-letter currency code such as USD')
      .default('USD'),
  ),
  dealCloseDays: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(3650).default(DEFAULT_CLOSE_DAYS)),
});
type Settings = z.infer<typeof settings>;

// Emails and phones are lists; a PUT with emailAddressData / phoneNumberData replaces the whole list.
const MULTI = {
  emailAddress: { list: 'emailAddressData', value: 'emailAddress', same: (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase(), extra: {} },
  phoneNumber: { list: 'phoneNumberData', value: 'phoneNumber', same: (a: string, b: string) => a.replace(/\D/g, '') === b.replace(/\D/g, ''), extra: { type: 'Office' } },
} as const;
type MultiField = keyof typeof MULTI;

// The contact's list with our value added: entries someone added in EspoCRM keep their primary, opt-out and
// invalid flags. Undefined when the value is already there (nothing to send).
export function mergeEspoList(field: MultiField, current: unknown, value: string): Record<string, unknown>[] | undefined {
  const m = MULTI[field];
  const kept = (Array.isArray(current) ? current : []).filter(
    (e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as Record<string, unknown>)[m.value] === 'string' && ((e as Record<string, unknown>)[m.value] as string).trim() !== '',
  );
  if (kept.some((e) => m.same(e[m.value] as string, value))) return undefined;
  return [...kept, { [m.value]: value, primary: !kept.some((e) => e.primary === true), ...m.extra }];
}

// The reason EspoCRM gives for a refused request: the X-Status-Reason header and, for a 400, the failed field.
export function espoErrorDetail(data: any, headers: Headers): string | null {
  const parts: string[] = [];
  const reason = (headers.get('x-status-reason') ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  const v = data && typeof data === 'object' && !Array.isArray(data) ? data.messageTranslation?.data : null;
  if (v && typeof v.field === 'string') parts.push(`field "${v.field}"${typeof v.type === 'string' ? ` is ${v.type}` : ' is invalid'}`);
  else if (reason) parts.push(reason);
  return parts.length ? parts.join('; ') : null;
}

type Duplicates = { duplicates: Record<string, unknown>[] };
const isDuplicates = (r: unknown): r is Duplicates => !!r && typeof r === 'object' && Array.isArray((r as Duplicates).duplicates);

export const espocrmCrm: ProviderDef<'crm'> = {
  id: 'espocrm',
  kind: 'crm',
  label: 'EspoCRM (self-hosted)',
  description: 'Free and open source (AGPL-3.0): creates and updates contacts in your own EspoCRM, logs replies and messages to their stream, and can open opportunities.',
  docsUrl: 'https://docs.espocrm.com/administration/api-users/',
  fields: [
    {
      key: 'baseUrl',
      label: 'EspoCRM address',
      type: 'url',
      required: true,
      placeholder: 'http://localhost/espocrm',
      help: 'The address you open EspoCRM at (without /api/v1).',
    },
    {
      key: 'apiKey',
      label: 'API key',
      type: 'password',
      secret: true,
      required: true,
      help: 'Administration → API Users → Create API User, authentication method API Key, with a role that can create, read and edit Contacts and Opportunities and read their stream. The key shows after saving.',
    },
    { key: 'dealStage', label: 'Opportunity stage', type: 'text', placeholder: 'Prospecting', help: 'Optional. The stage new opportunities start in, e.g. Prospecting, Qualification or Proposal.' },
    { key: 'dealCurrency', label: 'Opportunity currency', type: 'text', placeholder: 'USD', help: 'A currency enabled in EspoCRM (Administration → Currency). Opportunities open with an amount of 0.' },
    { key: 'dealCloseDays', label: 'Close date (days ahead)', type: 'number', placeholder: String(DEFAULT_CLOSE_DAYS), help: 'EspoCRM needs a close date; new opportunities get today plus this many days.' },
  ],
  credentials,
  settings,
  accountSettings: ['baseUrl'],
  hostSettings: ['baseUrl'],
  mappingHelp: 'EspoCRM uses attribute names such as firstName, emailAddress or phoneNumber; custom fields start with "c" (a field named LinkedIn URL is cLinkedInUrl, see Administration → Entity Manager → Contact → Fields). The built-in Title of a contact is their role at an Account, which this sync never sets, so map Title to a custom field such as cJobTitle.',
  create(ctx, cfg): CrmProvider {
    const s = cfg.settings as Partial<Settings>;
    const key: string = cfg.credentials.apiKey ?? '';
    const base = s.baseUrl ?? '';
    const host = (() => {
      try {
        return new URL(base).host;
      } catch {
        return 'EspoCRM';
      }
    })();
    const fail = (code: ProviderError['code'], message: string, status?: number) => new ProviderError(code, message, { integrationId: cfg.integrationId, status });

    // Hosted installs (billing on): the address must be a public host, checked when saved and again before every
    // request, and every request (reads and writes) connects only to the checked address. Self-hosted installs skip this, so EspoCRM on localhost
    // or the LAN works. A private host is a settings problem, shown on the integration's card (AUTH).
    const guard = async () => {
      if (!key) throw fail('AUTH', 'Add the EspoCRM API key');
      if (!base) throw fail('BAD_REQUEST', 'Add your EspoCRM address');
      try {
        const address = await checkHost(ctx, new URL(base).hostname);
        return address ? [{ address, family: isIP(address) || 4 }] : undefined;
      } catch (e) {
        if (e instanceof HostCheckError) throw fail(e.code === 'BLOCKED' ? 'AUTH' : 'UNAVAILABLE', e.message);
        throw e;
      }
    };

    // httpJson's errors, said in EspoCRM's terms. Codes stay the same (NOT_FOUND still means "gone").
    const call = async <T>(method: string, path: string, body?: unknown, extra: Pick<HttpJsonOptions<T>, 'headers' | 'readError'> = {}): Promise<T> => {
      const pinned = await guard();
      try {
        return await httpJson<T>(ctx, `${base}/api/v1${path}`, {
          method,
          body,
          headers: { 'x-api-key': key, ...extra.headers },
          readError: extra.readError,
          errorDetail: espoErrorDetail,
          secrets: [key],
          integrationId: cfg.integrationId,
          limiter: limits.espocrm,
          limitKey: cfg.integrationId ?? `espocrm:${base}`,
          timeoutMs: TIMEOUT_MS,
          ...(pinned ? { pinnedAddresses: pinned } : {}),
        });
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        const why = e.message.match(/\(\d{3}\): (.*)$/)?.[1];
        const reason = why ? `: ${why}` : '';
        if (e.status === 401) throw fail('AUTH', `EspoCRM at ${host} rejected the API key (401). Check the key under Administration → API Users and that the user is active.`, 401);
        if (e.status === 403)
          throw fail('AUTH', `The EspoCRM API user may not do this (403${reason}). Give its role create, read and edit access to Contacts and Opportunities, and stream access to Contacts.`, 403);
        if (e.code === 'TIMEOUT') throw fail('TIMEOUT', `EspoCRM at ${host} did not answer within ${TIMEOUT_MS / 1000} s.`);
        if (e.code === 'UNAVAILABLE' && e.status == null) throw fail('UNAVAILABLE', `Could not reach EspoCRM at ${host}. Is it running?`);
        if (e.code === 'BAD_REQUEST' && e.status) throw fail('BAD_REQUEST', `EspoCRM at ${host} refused the request (${e.status}${reason}).`, e.status);
        throw e;
      }
    };
    const idOf = (r: unknown, what: string) => {
      const id = r && typeof r === 'object' ? (r as { id?: unknown }).id : undefined;
      if (typeof id !== 'string' || !id) throw fail('UNAVAILABLE', `EspoCRM did not return ${what} id`);
      return id;
    };
    const search = async (attribute: string, value: string) => {
      const q = new URLSearchParams({ 'where[0][type]': 'equals', 'where[0][attribute]': attribute, 'where[0][value]': value, select: 'id', maxSize: '1' });
      const r = await call<{ list?: { id?: string }[] }>('GET', `/Contact?${q}`);
      const id = r && typeof r === 'object' ? r.list?.[0]?.id : undefined;
      return typeof id === 'string' && id ? id : null;
    };
    const update = async (id: string, props: Record<string, unknown>) => {
      const path = `/Contact/${encodeURIComponent(id)}`;
      const body: Record<string, unknown> = { ...props };
      // Emails and phones are added to the contact's lists, never sent as replacements of its primary one.
      const multi = (Object.keys(MULTI) as MultiField[]).filter((f) => typeof body[f] === 'string');
      if (multi.length) {
        const cur = await call<Record<string, unknown> | null>('GET', path);
        for (const f of multi) {
          const merged = mergeEspoList(f, cur && typeof cur === 'object' ? cur[MULTI[f].list] : null, body[f] as string);
          delete body[f];
          if (merged) body[MULTI[f].list] = merged;
        }
      }
      if (Object.keys(body).length) await call('PUT', path, body);
      return { id, created: false };
    };
    return {
      providerId: 'espocrm',
      simulated: false,
      async test() {
        let r: any;
        try {
          r = await call('GET', '/App/user');
        } catch (e) {
          if (e instanceof ProviderError && e.code === 'NOT_FOUND') throw fail('NOT_FOUND', `No EspoCRM API at ${base}/api/v1: check the address (the one you open EspoCRM at).`, 404);
          throw e;
        }
        const user = r && typeof r === 'object' ? r.user : null;
        if (!user || typeof user !== 'object') throw fail('BAD_REQUEST', `The server at ${host} did not answer like EspoCRM: check the address.`);
        const name = typeof user.name === 'string' && user.name ? ` as ${user.name}` : '';
        // The API user's role, when EspoCRM says: what the sync needs and the role doesn't allow.
        const table = r.acl?.table;
        const denied = (scope: string, action: string) => {
          const t = table?.[scope];
          return t === false || (t && typeof t === 'object' && t[action] === 'no');
        };
        const missing = table && typeof table === 'object' ? [['Contact', 'read'], ['Contact', 'create'], ['Contact', 'edit'], ['Contact', 'stream'], ['Opportunity', 'create']].filter(([sc, a]) => denied(sc, a)) : [];
        const what = missing.map(([sc, a]) => (a === 'stream' ? 'post notes to Contacts' : `${a} ${sc === 'Opportunity' ? 'Opportunities' : 'Contacts'}`)).join(', ');
        if (missing.some(([sc, a]) => sc === 'Contact' && a !== 'stream'))
          return { ok: false, message: `Connected to EspoCRM at ${host}${name}, but its role may not ${what}. Change the role under Administration → Roles.` };
        const warn = missing.length ? ` Its role may not ${what}, so ${missing.some(([sc]) => sc === 'Opportunity') ? 'deals' : 'notes'}${missing.length > 1 ? ' and notes' : ''} will fail; change it under Administration → Roles.` : '';
        return { ok: true, message: `Connected to EspoCRM at ${host}${name}.${warn}` };
      },
      async upsertContact(c, mapping, existingId) {
        const props: Record<string, unknown> = mappedProperties(c, mapping);
        if (existingId) {
          try {
            return await update(existingId, props);
          } catch (e) {
            // Deleted in EspoCRM since the last sync: find it again or create it.
            if (!(e instanceof ProviderError && e.code === 'NOT_FOUND')) throw e;
          }
        }
        const urlAttr = mapping.profileUrl;
        const url = crmFieldValue(c, 'profileUrl').trim();
        const email = (c.email ?? '').trim();
        const found = (email ? await search('emailAddress', email) : null) ?? (urlAttr && url ? await search(urlAttr, url) : null);
        if (found) return update(found, props);

        // A new contact needs a last name. Only the create bodies get this stand-in: an existing contact found
        // through the 409 below keeps its own last name.
        const createBody = { ...props, lastName: props.lastName ?? (c.lastName.trim() || crmFieldValue(c, 'fullName').trim() || email || 'LinkedIn lead') };
        const readError = (status: number, text: string): Duplicates | undefined => {
          if (status !== 409) return undefined;
          try {
            const list = JSON.parse(text);
            return Array.isArray(list) ? { duplicates: list.filter((d) => d && typeof d === 'object') } : undefined;
          } catch {
            return undefined;
          }
        };
        const r = await call<unknown>('POST', '/Contact', createBody, { readError });
        if (!isDuplicates(r)) return { id: idOf(r, 'a contact'), created: true };
        // EspoCRM's duplicate check matches on email or name. The same email (created since our search) or the same
        // LinkedIn URL is this person; a name alone may be someone else, so then the contact is created anyway.
        const same = r.duplicates.find(
          (d) =>
            typeof d.id === 'string' &&
            ((email && typeof d.emailAddress === 'string' && MULTI.emailAddress.same(d.emailAddress, email)) || (urlAttr && url && typeof d[urlAttr] === 'string' && (d[urlAttr] as string).trim() === url)),
        );
        if (same) return update(same.id as string, props);
        const again = await call<unknown>('POST', '/Contact', createBody, { headers: { 'x-skip-duplicate-check': 'true' } });
        return { id: idOf(again, 'a contact'), created: true };
      },
      async addNote(contactId, note) {
        // The stream shows when the note was synced; EspoCRM sets createdAt itself.
        const r = await call<unknown>('POST', '/Note', { type: 'Post', parentType: 'Contact', parentId: contactId, post: note.body });
        return { id: idOf(r, 'a note') };
      },
      async createDeal(contactId, deal) {
        const days = s.dealCloseDays ?? DEFAULT_CLOSE_DAYS;
        const closeDate = new Date(ctx.clock.now() + days * 86_400_000).toISOString().slice(0, 10);
        const stage = deal.stage ?? s.dealStage;
        const r = await call<unknown>('POST', '/Opportunity', {
          name: deal.name,
          amount: 0,
          amountCurrency: s.dealCurrency ?? 'USD',
          closeDate,
          ...(stage ? { stage } : {}),
          contactId,
          contactsIds: [contactId],
        });
        return { id: idOf(r, 'an opportunity') };
      },
      recordUrl(objectType, id) {
        return base ? `${base}/#${objectType === 'deal' ? 'Opportunity' : 'Contact'}/view/${encodeURIComponent(id)}` : null;
      },
    };
  },
};
