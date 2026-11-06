import { beforeEach, describe, expect, it } from 'vitest';
import type { JobRow } from '../src/jobs/queue.js';
import { DEFAULT_CLOSE_DAYS, espoErrorDetail, limits, mergeEspoList } from '../src/providers/crm/espocrm.js';
import { ESPOCRM_MAPPING } from '../src/providers/crm/types.js';
import { ProviderError, RateLimiter } from '../src/providers/http.js';
import { createIntegration, loadIntegration, updateIntegration } from '../src/providers/store.js';
import { listStages, setStage } from '../src/services/pipeline.js';
import { handleInboundReply } from '../src/services/replies.js';
import type { LeadRow } from '../src/types.js';
import { addLeads, drainJobs, fakeFetch, makeApi, makeWorld, type FakeRoute, type World } from './helpers.js';

// EspoCRM (self-hosted, AGPL-3.0): contact search and upsert with merged email/phone lists, 409 duplicates, stream
// notes, opportunities with their required fields, record links, error mapping, the connection test, settings
// validation and hosts. Every HTTP call and DNS answer is a fake; nothing touches the network.

const KEY = 'espo-api-key-0123456789abcdef';
const BASE = 'http://127.0.0.1:8090';
const HOST = '127.0.0.1:8090';
const PUBLIC_IP = '93.184.216.34';
const QUIET = { triggers: { onReply: true, onStageChange: [], onCampaignFinished: false, onConnected: false, logMessages: false } };

const lead = (w: World, id: number) => w.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id])!;
const crmJobs = (w: World) => w.ctx.db.all<JobRow>("SELECT * FROM jobs WHERE type = 'crm.sync' ORDER BY id");

function leadWithEmail(w: World, email: string | null = 'jane@acme.dev') {
  const [id] = addLeads(w, 1, `p${w.ctx.clock.now()}${Math.floor(w.ctx.random() * 1e6)}`);
  w.ctx.db.run('UPDATE leads SET email = ?, first_name = ?, last_name = ?, title = ? WHERE id = ?', [email, 'Jane', 'Doe', 'CTO', id]);
  return id;
}

function reply(w: World, leadId: number, body = 'Thanks, tell me more') {
  const now = w.ctx.clock.now();
  const conv = w.ctx.db.insert('conversations', { workspace_id: w.workspaceId, account_id: w.accountId, lead_id: leadId, thread_id: `t-${leadId}-${now}`, participant_name: 'Lead', last_message_at: now });
  const msg = w.ctx.db.insert('messages', { conversation_id: conv, external_id: `in-${now}`, direction: 'in', body, sent_at: now });
  handleInboundReply(w.ctx, { lead: lead(w, leadId), channel: 'linkedin', conversationId: conv, messageId: msg, body });
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error('expected a failure');
};

const ALL_ACL = {
  table: {
    Contact: { create: 'yes', read: 'all', edit: 'all', delete: 'no', stream: 'all' },
    Opportunity: { create: 'yes', read: 'all', edit: 'all', delete: 'no', stream: 'all' },
  },
};

type Contact = Record<string, any>;
type Fail = { status: number; json?: unknown; text?: string; headers?: Record<string, string> };

// A tiny EspoCRM 10 at any address: contacts with email/phone lists, EspoCRM's 409 duplicate check (email or name),
// notes, opportunities with their required fields, and /App/user.
function fakeEspo(o: { contacts?: Record<string, Contact>; acl?: unknown } = {}) {
  const contacts = new Map<string, Contact>(Object.entries(o.contacts ?? {}));
  const bodies = { contacts: [] as any[], puts: [] as any[], notes: [] as any[], opps: [] as any[] };
  let n = 0;
  const newId = () => `6720a1b2c3d4e5f${(n++).toString(16).padStart(2, '0')}`;
  const state: { fail: Fail | null; blindSearch: boolean; user: unknown } = { fail: null, blindSearch: false, user: { user: { id: 'u1', name: 'OpenReach API', type: 'api' }, acl: o.acl ?? ALL_ACL } };
  const emails = (c: Contact): string[] => [...(c.emailAddressData ?? []).map((e: any) => e.emailAddress), ...(c.emailAddress ? [c.emailAddress] : [])].map((e) => e.toLowerCase());
  const record = (id: string, c: Contact) => ({
    id,
    name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
    ...c,
    emailAddressData: c.emailAddressData ?? (c.emailAddress ? [{ emailAddress: c.emailAddress, primary: true, optOut: false, invalid: false }] : []),
    phoneNumberData: c.phoneNumberData ?? (c.phoneNumber ? [{ phoneNumber: c.phoneNumber, type: 'Mobile', primary: true, optOut: false, invalid: false }] : []),
  });
  const idIn = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').pop()!);
  const route = (method: string, path: RegExp, reply: FakeRoute['reply']): FakeRoute => ({
    method,
    url: new RegExp(/^https?:\/\/[^/]+(?:\/[\w.-]+)*\/api\/v1/.source + path.source),
    reply: (req) => {
      if (state.fail) return state.fail;
      if (req.headers['x-api-key'] !== KEY) return { status: 401, text: '' };
      return reply(req);
    },
  });
  const fetch = fakeFetch([
    route('GET', /\/Contact\?/, (req) => {
      const q = new URL(req.url).searchParams;
      const attr = q.get('where[0][attribute]')!;
      const value = q.get('where[0][value]')!;
      const hit = state.blindSearch ? undefined : [...contacts].find(([, c]) => (attr === 'emailAddress' ? emails(c).includes(value.toLowerCase()) : c[attr] === value));
      return { json: { total: hit ? 1 : 0, list: hit ? [{ id: hit[0] }] : [] } };
    }),
    route('GET', /\/Contact\/[0-9a-f]+$/, (req) => {
      const c = contacts.get(idIn(req.url));
      return c ? { json: record(idIn(req.url), c) } : { status: 404, text: '', headers: { 'x-status-reason': 'Record not found' } };
    }),
    route('POST', /\/Contact$/, (req) => {
      const body = JSON.parse(req.body!);
      if (!body.lastName) return { status: 400, json: { messageTranslation: { label: 'validationFailure', scope: null, data: { field: 'lastName', type: 'required' } } } };
      if (req.headers['x-skip-duplicate-check'] !== 'true') {
        const name = `${body.firstName ?? ''} ${body.lastName}`.trim();
        const dups = [...contacts]
          .filter(([id, c]) => (body.emailAddress && emails(c).includes(body.emailAddress.toLowerCase())) || record(id, c).name === name)
          .map(([id, c]) => ({ id, name: record(id, c).name, emailAddress: c.emailAddress ?? c.emailAddressData?.find((e: any) => e.primary)?.emailAddress ?? null }));
        if (dups.length) return { status: 409, json: dups, headers: { 'x-status-reason': 'duplicate' } };
      }
      bodies.contacts.push(body);
      const id = newId();
      contacts.set(id, body);
      return { json: record(id, body) };
    }),
    route('PUT', /\/Contact\/[0-9a-f]+$/, (req) => {
      const id = idIn(req.url);
      if (!contacts.has(id)) return { status: 404, text: '' };
      const body = JSON.parse(req.body!);
      bodies.puts.push({ id, body });
      contacts.set(id, { ...contacts.get(id), ...body });
      return { json: record(id, contacts.get(id)!) };
    }),
    route('POST', /\/Note$/, (req) => {
      const body = JSON.parse(req.body!);
      bodies.notes.push(body);
      return { json: { id: `n0000000000000${bodies.notes.length.toString().padStart(3, '0')}`, ...body } };
    }),
    route('POST', /\/Opportunity$/, (req) => {
      const body = JSON.parse(req.body!);
      for (const field of ['name', 'amount', 'closeDate'])
        if (body[field] == null) return { status: 400, json: { messageTranslation: { label: 'validationFailure', data: { field, type: 'required' } } } };
      bodies.opps.push(body);
      return { json: { id: `0pp0000000000000${bodies.opps.length}`, ...body } };
    }),
    route('GET', /\/App\/user$/, () => ({ json: state.user })),
  ]);
  return { fetch, bodies, contacts, state, paths: (from = 0) => fetch.calls.slice(from).map((c) => `${c.method} ${new URL(c.url).pathname}`) };
}

function addEspo(w: World, settings: Record<string, unknown> = {}, credentials: Record<string, string> = { apiKey: KEY }) {
  return createIntegration(w.ctx, w.workspaceId, { kind: 'crm', provider: 'espocrm', credentials, settings: { ...QUIET, baseUrl: BASE, ...settings } });
}
const instance = (w: World, row: { id: number }) => w.ctx.providers.instance<'crm'>(loadIntegration(w.ctx, w.workspaceId, row.id)!)!;
const contact = { email: 'jane@acme.dev', firstName: 'Jane', lastName: 'Doe', company: 'Acme', title: 'CTO', phone: null, profileUrl: 'https://www.linkedin.com/in/jane/' };

beforeEach(() => {
  limits.espocrm = new RateLimiter(10_000, 10_000);
});

describe('EspoCRM sync', () => {
  it('creates a contact, posts the reply to its stream and opens an opportunity with the required fields', async () => {
    const w = makeWorld();
    const espo = fakeEspo();
    w.ctx.fetch = espo.fetch;
    // A pasted page address is trimmed to the base.
    const crm = addEspo(w, { baseUrl: `${BASE}/#Contact/list`, createDealOn: ['interested'], dealStage: 'Qualification', dealCurrency: 'eur' });
    expect(JSON.parse(crm.settings)).toMatchObject({ baseUrl: BASE, dealCurrency: 'EUR', dealCloseDays: DEFAULT_CLOSE_DAYS, fieldMapping: ESPOCRM_MAPPING });
    const id = leadWithEmail(w);
    w.ctx.db.run('UPDATE leads SET phone = ? WHERE id = ?', ['+14155550123', id]);
    setStage(w.ctx, lead(w, id), listStages(w.ctx, w.workspaceId).find((s) => s.slug === 'interested')!.id, { source: 'manual' });
    reply(w, id, 'Yes <please>\nCall me');
    await drainJobs(w);

    const search = new URL(espo.fetch.calls[0].url);
    expect(`${search.origin}${search.pathname}`).toBe(`${BASE}/api/v1/Contact`);
    expect(Object.fromEntries(search.searchParams)).toEqual({ 'where[0][type]': 'equals', 'where[0][attribute]': 'emailAddress', 'where[0][value]': 'jane@acme.dev', select: 'id', maxSize: '1' });
    for (const c of espo.fetch.calls) {
      expect(c.headers['x-api-key']).toBe(KEY);
      expect(c.url).not.toContain(KEY);
    }
    // No title by default: EspoCRM keeps a contact's title as its role at an Account, and the sync sets no Account.
    expect(espo.bodies.contacts).toEqual([{ firstName: 'Jane', lastName: 'Doe', emailAddress: 'jane@acme.dev', phoneNumber: '+14155550123' }]);
    const [contactId] = espo.contacts.keys();
    expect(contactId).toMatch(/^[0-9a-f]{17}$/);
    // Notes are plain text in EspoCRM: no HTML escaping.
    expect(espo.bodies.notes).toEqual([{ type: 'Post', parentType: 'Contact', parentId: contactId, post: 'Replied on LinkedIn:\n\nYes <please>\nCall me' }]);
    const closeDate = new Date(w.ctx.clock.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    expect(espo.bodies.opps).toEqual([{ name: 'Acme – Jane Doe', amount: 0, amountCurrency: 'EUR', closeDate, stage: 'Qualification', contactId, contactsIds: [contactId] }]);
    expect(w.ctx.db.all('SELECT object_type, external_id FROM crm_links WHERE lead_id = ? ORDER BY object_type', [id])).toEqual([
      { object_type: 'contact', external_id: contactId },
      { object_type: 'deal', external_id: '0pp00000000000001' },
    ]);

    const p = instance(w, crm);
    expect(p.recordUrl!('contact', contactId)).toBe(`${BASE}/#Contact/view/${contactId}`);
    expect(p.recordUrl!('deal', '0pp00000000000001')).toBe(`${BASE}/#Opportunity/view/0pp00000000000001`);
    expect(await p.test()).toEqual({ ok: true, message: `Connected to EspoCRM at ${HOST} as OpenReach API.` });
  });

  it('opens opportunities without a stage (EspoCRM picks its first) and with the configured close date', async () => {
    const w = makeWorld();
    const espo = fakeEspo();
    w.ctx.fetch = espo.fetch;
    const crm = addEspo(w, { dealCloseDays: '0', dealCurrency: '' });
    await instance(w, crm).createDeal('6720a1b2c3d4e5f00', { name: 'Acme – Jane Doe' });
    expect(espo.bodies.opps).toEqual([
      { name: 'Acme – Jane Doe', amount: 0, amountCurrency: 'USD', closeDate: new Date(w.ctx.clock.now()).toISOString().slice(0, 10), contactId: '6720a1b2c3d4e5f00', contactsIds: ['6720a1b2c3d4e5f00'] },
    ]);
    // A stage passed with the deal wins over the setting.
    await instance(w, crm).createDeal('6720a1b2c3d4e5f00', { name: 'X', stage: 'Proposal' });
    expect(espo.bodies.opps[1].stage).toBe('Proposal');
  });

  it('updates the contact a search finds, adding to its emails and phones instead of replacing them', async () => {
    const w = makeWorld();
    const home = { emailAddress: 'jane@home.example', primary: true, optOut: false, invalid: false };
    const work = { emailAddress: 'Jane@Acme.dev', primary: false, optOut: true, invalid: false };
    const mobile = { phoneNumber: '+1 415 555 0000', type: 'Mobile', primary: true, optOut: false, invalid: false };
    const espo = fakeEspo({ contacts: { '6720a1b2c3d4e5f99': { firstName: 'J.', lastName: 'Doe', emailAddressData: [home, work], phoneNumberData: [mobile] } } });
    w.ctx.fetch = espo.fetch;
    addEspo(w);
    const id = leadWithEmail(w);
    w.ctx.db.run('UPDATE leads SET phone = ? WHERE id = ?', ['+14155550123', id]);
    reply(w, id);
    await drainJobs(w);
    expect(espo.paths()).toEqual(['GET /api/v1/Contact', 'GET /api/v1/Contact/6720a1b2c3d4e5f99', 'PUT /api/v1/Contact/6720a1b2c3d4e5f99', 'POST /api/v1/Note']);
    expect(espo.bodies.contacts).toHaveLength(0);
    // The email is already there (case aside): not sent. The phone is added as a second, non-primary number.
    expect(espo.bodies.puts).toEqual([
      { id: '6720a1b2c3d4e5f99', body: { firstName: 'Jane', lastName: 'Doe', phoneNumberData: [mobile, { phoneNumber: '+14155550123', primary: false, type: 'Office' }] } },
    ]);

    // The next sync goes straight to the saved contact. One that lost its email gets ours as the primary one.
    espo.contacts.set('6720a1b2c3d4e5f99', { lastName: 'Doe', emailAddressData: [], phoneNumberData: espo.contacts.get('6720a1b2c3d4e5f99')!.phoneNumberData });
    const from = espo.fetch.calls.length;
    w.ctx.clock.advance(60_000);
    reply(w, id, 'Again');
    await drainJobs(w);
    expect(espo.paths(from)).toEqual(['GET /api/v1/Contact/6720a1b2c3d4e5f99', 'PUT /api/v1/Contact/6720a1b2c3d4e5f99', 'POST /api/v1/Note']);
    expect(espo.bodies.puts[1].body).toEqual({ firstName: 'Jane', lastName: 'Doe', emailAddressData: [{ emailAddress: 'jane@acme.dev', primary: true }] });
  });

  it('matches the mapped LinkedIn URL attribute (a "c" custom field) when the lead has no email', async () => {
    const w = makeWorld();
    const id = leadWithEmail(w, null);
    const url = lead(w, id).profile_url;
    const espo = fakeEspo({ contacts: { '6720a1b2c3d4e5f77': { lastName: 'Doe', cLinkedInUrl: url } } });
    w.ctx.fetch = espo.fetch;
    addEspo(w, { fieldMapping: { ...ESPOCRM_MAPPING, profileUrl: 'cLinkedInUrl' } });
    reply(w, id);
    await drainJobs(w);
    expect(espo.paths()).toEqual(['GET /api/v1/Contact', 'PUT /api/v1/Contact/6720a1b2c3d4e5f77', 'POST /api/v1/Note']);
    expect(new URL(espo.fetch.calls[0].url).searchParams.get('where[0][attribute]')).toBe('cLinkedInUrl');
    expect(new URL(espo.fetch.calls[0].url).searchParams.get('where[0][value]')).toBe(url);
    expect(espo.bodies.puts[0].body).toEqual({ firstName: 'Jane', lastName: 'Doe', cLinkedInUrl: url });

    // Neither email nor a mapped URL: no search, a new contact.
    const w2 = makeWorld();
    const espo2 = fakeEspo();
    w2.ctx.fetch = espo2.fetch;
    // A title goes to a custom field when one is mapped.
    const created = await instance(w2, addEspo(w2)).upsertContact({ ...contact, email: null, lastName: '', firstName: '' }, { ...ESPOCRM_MAPPING, title: 'cJobTitle' }, null);
    expect(created.created).toBe(true);
    expect(espo2.paths()).toEqual(['POST /api/v1/Contact']);
    // EspoCRM requires a last name: the full name, else the email, else a placeholder stands in.
    expect(espo2.bodies.contacts).toEqual([{ cJobTitle: 'CTO', lastName: 'LinkedIn lead' }]);
  });

  it('uses the duplicate EspoCRM names when it has the same email, and creates past a namesake', async () => {
    // Same email, which a search didn't return (created a moment ago elsewhere): updated, not created twice.
    const w = makeWorld();
    const espo = fakeEspo({ contacts: { '6720a1b2c3d4e5f55': { firstName: 'Janet', lastName: 'D', emailAddress: 'jane@acme.dev' } } });
    espo.state.blindSearch = true;
    w.ctx.fetch = espo.fetch;
    const p = instance(w, addEspo(w));
    expect(await p.upsertContact(contact, ESPOCRM_MAPPING, null)).toEqual({ id: '6720a1b2c3d4e5f55', created: false });
    expect(espo.paths()).toEqual(['GET /api/v1/Contact', 'POST /api/v1/Contact', 'GET /api/v1/Contact/6720a1b2c3d4e5f55', 'PUT /api/v1/Contact/6720a1b2c3d4e5f55']);
    expect(espo.bodies.contacts).toHaveLength(0);

    // A lead without a last name: the create attempt carries a stand-in (its first name), but the duplicate it
    // turns out to be keeps its own last name.
    const before = espo.fetch.calls.length;
    expect(await p.upsertContact({ ...contact, lastName: '' }, ESPOCRM_MAPPING, null)).toEqual({ id: '6720a1b2c3d4e5f55', created: false });
    expect(espo.paths(before)).toEqual(['GET /api/v1/Contact', 'POST /api/v1/Contact', 'GET /api/v1/Contact/6720a1b2c3d4e5f55', 'PUT /api/v1/Contact/6720a1b2c3d4e5f55']);
    expect(JSON.parse(espo.fetch.calls[before + 1].body!).lastName).toBe('Jane');
    expect(espo.bodies.puts.at(-1)!.body).toEqual({ firstName: 'Jane' });
    expect(espo.contacts.get('6720a1b2c3d4e5f55')!.lastName).toBe('Doe'); // from the sync above, not 'Jane'

    // Only the name matches: another person with the same name, so the contact is created anyway.
    const w2 = makeWorld();
    const espo2 = fakeEspo({ contacts: { '6720a1b2c3d4e5f56': { firstName: 'Jane', lastName: 'Doe', emailAddress: 'jane@other.example' } } });
    w2.ctx.fetch = espo2.fetch;
    const r = await instance(w2, addEspo(w2)).upsertContact(contact, ESPOCRM_MAPPING, null);
    expect(r.created).toBe(true);
    expect(r.id).not.toBe('6720a1b2c3d4e5f56');
    expect(espo2.paths()).toEqual(['GET /api/v1/Contact', 'POST /api/v1/Contact', 'POST /api/v1/Contact']);
    expect(espo2.fetch.calls[1].headers['x-skip-duplicate-check']).toBeUndefined();
    expect(espo2.fetch.calls[2].headers['x-skip-duplicate-check']).toBe('true');
    expect(espo2.contacts.size).toBe(2);

    // The same LinkedIn URL is the same person too.
    const w3 = makeWorld();
    const espo3 = fakeEspo({ contacts: { '6720a1b2c3d4e5f57': { firstName: 'Jane', lastName: 'Doe', cLinkedInUrl: contact.profileUrl } } });
    espo3.state.blindSearch = true;
    w3.ctx.fetch = espo3.fetch;
    // The fake's duplicate list carries id, name and emailAddress; give it the URL too for this case.
    const mapping = { ...ESPOCRM_MAPPING, profileUrl: 'cLinkedInUrl' };
    const orig = espo3.fetch;
    w3.ctx.fetch = (async (url: any, init: any) => {
      const res = await orig(url, init);
      if (res.status !== 409) return res;
      const list = (await res.json()) as any[];
      return new Response(JSON.stringify(list.map((d) => ({ ...d, cLinkedInUrl: espo3.contacts.get(d.id)!.cLinkedInUrl }))), { status: 409, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    expect(await instance(w3, addEspo(w3)).upsertContact({ ...contact, email: null }, mapping, null)).toEqual({ id: '6720a1b2c3d4e5f57', created: false });
  });

  it('finds the contact again when the saved one was deleted in EspoCRM', async () => {
    const w = makeWorld();
    const espo = fakeEspo();
    w.ctx.fetch = espo.fetch;
    addEspo(w);
    const id = leadWithEmail(w);
    reply(w, id);
    await drainJobs(w);
    const [first] = espo.contacts.keys();
    espo.contacts.delete(first);
    const from = espo.fetch.calls.length;
    w.ctx.clock.advance(60_000);
    reply(w, id, 'Again');
    await drainJobs(w);
    expect(espo.paths(from)).toEqual([`GET /api/v1/Contact/${first}`, 'GET /api/v1/Contact', 'POST /api/v1/Contact', 'POST /api/v1/Note']);
    const [second] = espo.contacts.keys();
    expect(w.ctx.db.get('SELECT external_id FROM crm_links WHERE lead_id = ? AND object_type = ?', [id, 'contact'])).toEqual({ external_id: second });
    expect(espo.bodies.notes.at(-1).parentId).toBe(second);
  });

  it('stops on a rejected key and marks the integration, without leaking the key', async () => {
    const w = makeWorld();
    const espo = fakeEspo();
    w.ctx.fetch = espo.fetch;
    const crm = addEspo(w, {}, { apiKey: 'wrong-espo-key-000000' });
    reply(w, leadWithEmail(w));
    await drainJobs(w);
    const [job] = crmJobs(w);
    expect(job).toMatchObject({ status: 'failed', attempts: 1 });
    const row = loadIntegration(w.ctx, w.workspaceId, crm.id)!;
    expect(row.last_status).toBe('error');
    expect(row.last_message).toContain(`EspoCRM at ${HOST} rejected the API key (401)`);
    expect(row.last_message).not.toContain('wrong-espo-key');
  });

  it('waits out a 429 with Retry-After and then syncs', async () => {
    const w = makeWorld();
    const espo = fakeEspo();
    espo.state.fail = { status: 429, text: '', headers: { 'retry-after': '20' } };
    w.ctx.fetch = espo.fetch;
    addEspo(w);
    reply(w, leadWithEmail(w));
    await drainJobs(w);
    expect(crmJobs(w)[0]).toMatchObject({ status: 'queued', attempts: 0, run_at: w.ctx.clock.now() + 20_000 });
    espo.state.fail = null;
    w.ctx.clock.advance(20_000);
    await drainJobs(w);
    expect(crmJobs(w)[0].status).toBe('done');
    expect(espo.bodies.notes).toHaveLength(1);
  });
});

describe('EspoCRM errors', () => {
  const setup = (fail: Fail | null = null) => {
    const w = makeWorld();
    const espo = fakeEspo();
    espo.state.fail = fail;
    w.ctx.fetch = espo.fetch;
    return { w, espo, p: instance(w, addEspo(w)) };
  };

  it('maps each status to an error code with EspoCRM\'s reason, never the key', async () => {
    const cases: [Fail, ProviderError['code'], RegExp][] = [
      [{ status: 401, text: '' }, 'AUTH', /^EspoCRM at 127\.0\.0\.1:8090 rejected the API key \(401\)\. Check the key under Administration → API Users/],
      [{ status: 403, text: '', headers: { 'x-status-reason': 'No access to Opportunity' } }, 'AUTH', /^The EspoCRM API user may not do this \(403: No access to Opportunity\)\. Give its role/],
      [{ status: 400, json: { messageTranslation: { label: 'validationFailure', data: { field: 'amount', type: 'required' } } } }, 'BAD_REQUEST', /^EspoCRM at 127\.0\.0\.1:8090 refused the request \(400: field "amount" is required\)\.$/],
      [{ status: 400, text: '', headers: { 'x-status-reason': `Bad key ${KEY}` } }, 'BAD_REQUEST', /\(400: Bad key ••••\)\.$/],
      [{ status: 409, text: '', headers: { 'x-status-reason': 'Conflict' } }, 'BAD_REQUEST', /\(409: Conflict\)/],
      [{ status: 404, text: '' }, 'NOT_FOUND', /404/],
      [{ status: 429, text: '', headers: { 'retry-after': '30' } }, 'RATE_LIMIT', /rate limiting/],
      [{ status: 500, text: 'PHP Fatal error', headers: { 'x-status-reason': 'Error while saving' } }, 'UNAVAILABLE', /server error \(500\): Error while saving/],
      [{ status: 503, text: '<html>' }, 'UNAVAILABLE', /server error \(503\)$/],
    ];
    for (const [fail, code, message] of cases) {
      const { p } = setup(fail);
      const e = await failure(p.addNote('6720a1b2c3d4e5f00', { body: 'x', timestamp: 0 }));
      expect(e, JSON.stringify(fail)).toBeInstanceOf(ProviderError);
      expect([e.code, e.status], JSON.stringify(fail)).toEqual([code, fail.status]);
      expect(e.message, JSON.stringify(fail)).toMatch(message);
      expect(e.message).not.toContain(KEY);
      if (code === 'RATE_LIMIT') expect(e.retryAfterMs).toBe(30_000);
    }
  });

  it('reports an unreachable server, a timeout and an answer without an id', async () => {
    const { w, p } = setup();
    w.ctx.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    let e = await failure(p.upsertContact(contact, ESPOCRM_MAPPING, null));
    expect([e.code, e.message]).toEqual(['UNAVAILABLE', `Could not reach EspoCRM at ${HOST}. Is it running?`]);

    w.ctx.fetch = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as typeof fetch;
    e = await failure(p.test());
    expect([e.code, e.message]).toEqual(['TIMEOUT', `EspoCRM at ${HOST} did not answer within 30 s.`]);

    w.ctx.fetch = fakeFetch([{ url: /./, reply: () => ({ json: { ok: true } }) }]);
    e = await failure(p.addNote('6720a1b2c3d4e5f00', { body: 'x', timestamp: 0 }));
    expect([e.code, e.message]).toEqual(['UNAVAILABLE', 'EspoCRM did not return a note id']);
    e = await failure(p.createDeal('6720a1b2c3d4e5f00', { name: 'x' }));
    expect(e.message).toBe('EspoCRM did not return an opportunity id');
  });

  it('reads the reason from X-Status-Reason or the failed field', () => {
    const h = (o: Record<string, string> = {}) => new Headers(o);
    expect(espoErrorDetail(null, h({ 'x-status-reason': 'duplicate' }))).toBe('duplicate');
    expect(espoErrorDetail({ messageTranslation: { label: 'validationFailure', data: { field: 'closeDate', type: 'required' } } }, h({ 'x-status-reason': 'x' }))).toBe('field "closeDate" is required');
    expect(espoErrorDetail({ messageTranslation: { data: { field: 'amount' } } }, h())).toBe('field "amount" is invalid');
    expect(espoErrorDetail({ message: 'x' }, h())).toBeNull();
    expect(espoErrorDetail([], h())).toBeNull();
  });

  it('merges emails and phones into the lists EspoCRM has', () => {
    expect(mergeEspoList('emailAddress', null, 'a@b.dev')).toEqual([{ emailAddress: 'a@b.dev', primary: true }]);
    expect(mergeEspoList('emailAddress', [{ emailAddress: 'A@B.dev', primary: true }], 'a@b.dev')).toBeUndefined();
    expect(mergeEspoList('emailAddress', [{ emailAddress: '', primary: true }, 'junk', null], 'a@b.dev')).toEqual([{ emailAddress: 'a@b.dev', primary: true }]);
    expect(mergeEspoList('phoneNumber', [{ phoneNumber: '+1 (415) 555-0123', primary: true, type: 'Mobile' }], '+14155550123')).toBeUndefined();
    expect(mergeEspoList('phoneNumber', [{ phoneNumber: '+1 415 555 0000', primary: true, type: 'Mobile' }], '+14155550123')).toEqual([
      { phoneNumber: '+1 415 555 0000', primary: true, type: 'Mobile' },
      { phoneNumber: '+14155550123', primary: false, type: 'Office' },
    ]);
  });

  it('takes a rate-limit token per request, keyed by the integration', async () => {
    const { p, w } = setup();
    const keys: unknown[] = [];
    limits.espocrm = { take: async (k: unknown) => void keys.push(k) } as any;
    await p.upsertContact(contact, ESPOCRM_MAPPING, null);
    const row = w.ctx.db.get<{ id: number }>("SELECT id FROM integrations WHERE provider = 'espocrm'")!;
    expect(keys).toEqual([row.id, row.id]);
  });
});

describe('EspoCRM connection test', () => {
  it('says who it connected as and what the API user\'s role may not do', async () => {
    const w = makeWorld();
    const espo = fakeEspo();
    w.ctx.fetch = espo.fetch;
    const crm = addEspo(w);
    expect(espo.paths()).toEqual([]);
    expect(await instance(w, crm).test()).toEqual({ ok: true, message: `Connected to EspoCRM at ${HOST} as OpenReach API.` });
    expect(espo.paths()).toEqual(['GET /api/v1/App/user']);

    espo.state.user = { user: { name: 'OpenReach API' }, acl: { table: { Contact: { ...ALL_ACL.table.Contact, stream: 'no' }, Opportunity: false } } };
    expect(await instance(w, crm).test()).toEqual({
      ok: true,
      message: `Connected to EspoCRM at ${HOST} as OpenReach API. Its role may not post notes to Contacts, create Opportunities, so deals and notes will fail; change it under Administration → Roles.`,
    });
    espo.state.user = { user: { name: 'OpenReach API' }, acl: { table: { Contact: { ...ALL_ACL.table.Contact, stream: 'no' } } } };
    expect((await instance(w, crm).test()).message).toMatch(/may not post notes to Contacts, so notes will fail/);
    espo.state.user = { user: { name: 'OpenReach API' }, acl: { table: { Contact: { ...ALL_ACL.table.Contact, create: 'no', edit: 'no' } } } };
    expect(await instance(w, crm).test()).toEqual({
      ok: false,
      message: `Connected to EspoCRM at ${HOST} as OpenReach API, but its role may not create Contacts, edit Contacts. Change the role under Administration → Roles.`,
    });
    // An answer without a role table is taken as is.
    espo.state.user = { user: { id: 'u1' } };
    expect(await instance(w, crm).test()).toEqual({ ok: true, message: `Connected to EspoCRM at ${HOST}.` });
  });

  it('says when the address is not an EspoCRM', async () => {
    const w = makeWorld();
    const espo = fakeEspo();
    w.ctx.fetch = espo.fetch;
    const p = instance(w, addEspo(w, { baseUrl: 'http://localhost/espocrm' }));
    espo.state.fail = { status: 404, text: 'Not Found' };
    let e = await failure(p.test());
    expect([e.code, e.message]).toEqual(['NOT_FOUND', 'No EspoCRM API at http://localhost/espocrm/api/v1: check the address (the one you open EspoCRM at).']);
    expect(espo.fetch.calls[0].url).toBe('http://localhost/espocrm/api/v1/App/user');
    espo.state.fail = { status: 200, text: '<!doctype html><title>Laragon</title>' };
    e = await failure(p.test());
    expect([e.code, e.message]).toEqual(['BAD_REQUEST', 'The server at localhost did not answer like EspoCRM: check the address.']);
  });
});

describe('EspoCRM settings and hosts', () => {
  it('validates and normalises the settings, masks the key and shows the mapping help', async () => {
    const api = await makeApi();
    await api.register();
    const add = (settings: Record<string, unknown>, credentials: Record<string, string> = { apiKey: KEY }) =>
      api.call('POST', '/api/integrations', { kind: 'crm', provider: 'espocrm', credentials, settings: { ...QUIET, ...settings } });
    for (const [baseUrl, saved] of [
      ['http://localhost/espocrm/api/v1/', 'http://localhost/espocrm'],
      ['  https://crm.example.com/#Contact/view/6720a1b2c3d4e5f00 ', 'https://crm.example.com'],
      ['http://espocrm.test///', 'http://espocrm.test'],
    ]) {
      const r = await add({ baseUrl });
      expect(r.status, baseUrl).toBe(200);
      expect(r.body.settings.baseUrl).toBe(saved);
      await api.call('DELETE', `/api/integrations/${r.body.id}`);
    }
    for (const baseUrl of ['ftp://crm.example.com', 'http://admin:pw@crm.example.com', 'http://crm.example.com/?entryPoint=x', 'crm.example.com', '']) {
      const r = await add({ baseUrl });
      expect(r.status, baseUrl).toBe(400);
      expect(r.body.error, baseUrl).toMatch(/^settings\.baseUrl: /);
    }
    expect((await add({})).status).toBe(400);
    expect((await add({ baseUrl: BASE }, {})).status).toBe(400);
    expect((await add({ baseUrl: BASE, dealCurrency: 'euro' })).body.error).toMatch(/^settings\.dealCurrency: /);
    expect((await add({ baseUrl: BASE, dealCloseDays: -1 })).status).toBe(400);
    const mapped = await add({ baseUrl: BASE, fieldMapping: { ...ESPOCRM_MAPPING, profileUrl: 'cLinkedInUrl', company: 'cCompany' } });
    expect(mapped.status).toBe(200);
    await api.call('DELETE', `/api/integrations/${mapped.body.id}`);

    const ok = await add({ baseUrl: BASE });
    const list = await api.call('GET', '/api/integrations');
    expect(list.raw).not.toContain(KEY);
    expect(list.body.find((i: any) => i.id === ok.body.id)).toMatchObject({ provider: 'espocrm', providerLabel: 'EspoCRM (self-hosted)', credentials: { apiKey: `••••${KEY.slice(-4)}` } });
    expect(ok.body.mappingHelp).toMatch(/custom fields start with "c".*cLinkedInUrl/);

    // The key is never sent to an address it wasn't entered for.
    const moved = await api.call('PATCH', `/api/integrations/${ok.body.id}`, { settings: { baseUrl: 'http://10.0.0.5/espocrm' } });
    expect([moved.status, moved.body.error]).toEqual([400, 'credentials.apiKey: Enter it again for the new baseUrl']);

    const providers = (await api.call('GET', '/api/integrations/providers')).body;
    const def = (providers.providers ?? providers).find((d: any) => d.kind === 'crm' && d.id === 'espocrm');
    expect(def.fields.map((f: any) => [f.key, f.type, !!f.secret, !!f.required])).toEqual([
      ['baseUrl', 'url', false, true],
      ['apiKey', 'password', true, true],
      ['dealStage', 'text', false, false],
      ['dealCurrency', 'text', false, false],
      ['dealCloseDays', 'number', false, false],
    ]);
  });

  it('forgets saved record ids when pointed at another EspoCRM', async () => {
    const w = makeWorld();
    const espo = fakeEspo();
    w.ctx.fetch = espo.fetch;
    const crm = addEspo(w);
    const id = leadWithEmail(w);
    reply(w, id);
    await drainJobs(w);
    const links = () => w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM crm_links WHERE integration_id = ?', [crm.id])!.n;
    expect(links()).toBe(1);
    updateIntegration(w.ctx, loadIntegration(w.ctx, w.workspaceId, crm.id)!, { settings: { dealStage: 'Proposal' } });
    expect(links()).toBe(1);
    updateIntegration(w.ctx, loadIntegration(w.ctx, w.workspaceId, crm.id)!, { settings: { baseUrl: 'http://127.0.0.1:8091' }, credentials: { apiKey: KEY } });
    expect(links()).toBe(0);
  });

  it('allows loopback and LAN addresses on self-hosted installs and refuses them on hosted ones', async () => {
    const api = await makeApi();
    await api.register('Hosted');
    api.w.ctx.stripe = {} as any;
    api.w.ctx.dns = { ...api.w.ctx.dns, lookup: async (h: string) => (h === 'crm.example.com' ? [{ address: PUBLIC_IP, family: 4 }] : [{ address: '127.0.0.1', family: 4 }]) } as any;
    for (const baseUrl of [BASE, 'http://localhost/espocrm', 'http://192.168.1.20', 'http://[::1]:8080', 'http://169.254.169.254', 'http://espocrm.test']) {
      const r = await api.call('POST', '/api/integrations', { kind: 'crm', provider: 'espocrm', credentials: { apiKey: KEY }, settings: { baseUrl } });
      expect(r.status, baseUrl).toBe(400);
      expect(r.body.error).toMatch(/^settings\.baseUrl: .*private or local network/);
    }
    const ok = await api.call('POST', '/api/integrations', { kind: 'crm', provider: 'espocrm', credentials: { apiKey: KEY }, settings: { baseUrl: 'https://crm.example.com' } });
    expect(ok.status).toBe(200);

    const self = await makeApi();
    await self.register('Self-hosted');
    const local = await self.call('POST', '/api/integrations', { kind: 'crm', provider: 'espocrm', credentials: { apiKey: KEY }, settings: { baseUrl: 'http://localhost/espocrm' } });
    expect(local.status).toBe(200);
  });

  it('checks the host before every request on a hosted install and pins every request to the checked address', async () => {
    const w = makeWorld();
    const espo = fakeEspo();
    const inits: any[] = [];
    w.ctx.fetch = (async (url: any, init: any) => {
      inits.push({ method: init.method, pinned: init.pinnedAddresses });
      return espo.fetch(url, init);
    }) as typeof fetch;
    const crm = addEspo(w, { baseUrl: 'https://crm.example.com' });
    w.ctx.stripe = {} as any;
    let address = PUBLIC_IP;
    w.ctx.dns = { ...w.ctx.dns, lookup: async () => [{ address, family: 4 }] } as any;
    await instance(w, crm).upsertContact(contact, ESPOCRM_MAPPING, null);
    expect(inits).toEqual([
      { method: 'GET', pinned: [{ address: PUBLIC_IP, family: 4 }] },
      { method: 'POST', pinned: [{ address: PUBLIC_IP, family: 4 }] },
    ]);

    // The name now points at the server's own network (DNS rebinding): refused before any request.
    address = '10.0.0.7';
    const e = await failure(instance(w, crm).addNote('6720a1b2c3d4e5f00', { body: 'x', timestamp: 0 }));
    expect(e.code).toBe('AUTH');
    expect(e.message).toMatch(/private or local network/);
    expect((await failure(instance(w, crm).test())).code).toBe('AUTH');
    expect(inits).toHaveLength(2);

    // A saved loopback address on an install that turned billing on never connects either.
    const w2 = makeWorld();
    const espo2 = fakeEspo();
    w2.ctx.fetch = espo2.fetch;
    const local = addEspo(w2);
    w2.ctx.stripe = {} as any;
    expect((await failure(instance(w2, local).test())).code).toBe('AUTH');
    expect(espo2.fetch.calls).toHaveLength(0);
  });
});
