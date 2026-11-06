import { describe, expect, it } from 'vitest';
import { crmSyncJob } from '../src/crm/sync.js';
import { wantsEvent } from '../src/crm/triggers.js';
import type { JobRow } from '../src/jobs/queue.js';
import { crmSettingsSchema, HUBSPOT_MAPPING, mappedProperties, noteHtml } from '../src/providers/crm/types.js';
import { createIntegration, loadIntegration, updateIntegration } from '../src/providers/store.js';
import { handleInboundReply } from '../src/services/replies.js';
import { deleteStage, listStages, moveLeadsToStage, setStage } from '../src/services/pipeline.js';
import type { LeadRow } from '../src/types.js';
import { HOUR } from '../src/clock.js';
import type { Sequence } from '../src/engine/sequence.js';
import { addLeads, drainJobs, fakeFetch, makeApi, makeCampaign, makeWorld, runFor, type FakeRoute, type World } from './helpers.js';

const HS_TOKEN = 'pat-na1-test-token-0000-1111';
const PD_TOKEN = 'pipedrive-test-token-98765';

const lead = (w: World, id: number) => w.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id])!;
const crmJobs = (w: World) => w.ctx.db.all<JobRow>("SELECT * FROM jobs WHERE type = 'crm.sync' ORDER BY id");
const logRows = (w: World) => w.ctx.db.all<{ operation: string; status: string; error: string | null; external_id: string | null; event: string }>('SELECT * FROM crm_sync_log ORDER BY id');
// No automatic stage notes unless a test asks for them, so replies only add their own note.
const QUIET = { triggers: { onReply: true, onStageChange: [], onCampaignFinished: false, onConnected: false, logMessages: false } };

function leadWithEmail(w: World, email = 'jane@acme.dev') {
  const [id] = addLeads(w, 1, `p${w.ctx.clock.now()}${Math.floor(w.ctx.random() * 1e6)}`);
  w.ctx.db.run('UPDATE leads SET email = ?, first_name = ?, last_name = ?, title = ? WHERE id = ?', [email, 'Jane', 'Doe', 'CTO', id]);
  return id;
}

// A LinkedIn thread with one inbound reply, through the normal reply path.
function reply(w: World, leadId: number, body = 'Thanks, tell me more') {
  const now = w.ctx.clock.now();
  const conv = w.ctx.db.insert('conversations', { workspace_id: w.workspaceId, account_id: w.accountId, lead_id: leadId, thread_id: `t-${leadId}-${now}`, participant_name: 'Lead', last_message_at: now });
  const msg = w.ctx.db.insert('messages', { conversation_id: conv, external_id: `in-${now}`, direction: 'in', body, sent_at: now });
  handleInboundReply(w.ctx, { lead: lead(w, leadId), channel: 'linkedin', conversationId: conv, messageId: msg, body });
  return msg;
}

// A tiny HubSpot: contacts searchable by email, notes and deals with their associations.
function fakeHubspot(o: { existing?: Record<string, string>; fail?: { status: number; headers?: Record<string, string> } | null } = {}) {
  const contacts = new Map<string, Record<string, string>>(Object.entries(o.existing ?? {}).map(([email, id]) => [id, { email }]));
  const notes: any[] = [];
  const deals: any[] = [];
  let next = 500;
  const state = { fail: o.fail ?? null };
  const guard = (fn: (req: any) => any) => (req: any) => (state.fail ? { status: state.fail.status, json: { message: `nope ${HS_TOKEN}` }, headers: state.fail.headers } : fn(req));
  const routes: FakeRoute[] = [
    {
      method: 'POST',
      url: /^https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/contacts\/search$/,
      reply: guard((req) => {
        const f = JSON.parse(req.body).filterGroups[0].filters[0];
        const hit = [...contacts].find(([, p]) => p[f.propertyName] === f.value);
        return { json: { total: hit ? 1 : 0, results: hit ? [{ id: hit[0] }] : [] } };
      }),
    },
    {
      method: 'POST',
      url: /^https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/contacts$/,
      reply: guard((req) => {
        const id = String(next++);
        contacts.set(id, JSON.parse(req.body).properties);
        return { status: 201, json: { id } };
      }),
    },
    {
      method: 'PATCH',
      url: /^https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/contacts\/\d+$/,
      reply: guard((req) => {
        const id = req.url.split('/').pop()!;
        if (!contacts.has(id)) return { status: 404, json: { message: 'Object not found' } };
        contacts.set(id, { ...contacts.get(id), ...JSON.parse(req.body).properties });
        return { json: { id } };
      }),
    },
    { method: 'POST', url: /^https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/notes$/, reply: guard((req) => (notes.push(JSON.parse(req.body)), { status: 201, json: { id: `n${notes.length}` } })) },
    { method: 'POST', url: /^https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/deals$/, reply: guard((req) => (deals.push(JSON.parse(req.body)), { status: 201, json: { id: `d${deals.length}` } })) },
    { method: 'GET', url: /^https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/contacts\?limit=1$/, reply: guard(() => ({ json: { results: [] } })) },
  ];
  const fetch = fakeFetch(routes);
  return { fetch, contacts, notes, deals, state, writes: () => fetch.calls.filter((c) => c.method !== 'GET' && !c.url.endsWith('/search')) };
}

function addHubspot(w: World, settings: Record<string, unknown> = QUIET) {
  return createIntegration(w.ctx, w.workspaceId, { kind: 'crm', provider: 'hubspot', credentials: { accessToken: HS_TOKEN }, settings });
}

describe('HubSpot sync', () => {
  it('finds a contact by email and updates it, then reuses the stored id (no duplicates)', async () => {
    const w = makeWorld();
    const hs = fakeHubspot({ existing: { 'jane@acme.dev': '42' } });
    w.ctx.fetch = hs.fetch;
    const crm = addHubspot(w);
    const id = leadWithEmail(w);
    reply(w, id);
    await drainJobs(w);
    expect(hs.contacts.size).toBe(1);
    expect(hs.contacts.get('42')).toMatchObject({ email: 'jane@acme.dev', firstname: 'Jane', lastname: 'Doe', jobtitle: 'CTO', company: 'Acme' });
    expect(hs.fetch.calls[0].headers.authorization).toBe(`Bearer ${HS_TOKEN}`);
    expect(w.ctx.db.get('SELECT external_id FROM crm_links WHERE lead_id = ? AND integration_id = ? AND object_type = ?', [id, crm.id, 'contact'])).toEqual({ external_id: '42' });

    // The next event goes straight to the stored contact: no search, no create.
    const before = hs.fetch.calls.length;
    w.ctx.clock.advance(60_000);
    reply(w, id, 'Second reply');
    await drainJobs(w);
    const later = hs.fetch.calls.slice(before);
    expect(later.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['PATCH /crm/v3/objects/contacts/42', 'POST /crm/v3/objects/notes']);
    expect(hs.contacts.size).toBe(1);
    expect(hs.notes).toHaveLength(2);
  });

  it('creates a missing contact and adds the reply as a note on it, once', async () => {
    const w = makeWorld();
    const hs = fakeHubspot();
    w.ctx.fetch = hs.fetch;
    addHubspot(w);
    const id = leadWithEmail(w);
    reply(w, id, 'Sure <b>call</b> me\nTomorrow');
    await drainJobs(w);
    expect([...hs.contacts.values()]).toEqual([expect.objectContaining({ email: 'jane@acme.dev' })]);
    expect(hs.notes).toHaveLength(1);
    expect(hs.notes[0]).toMatchObject({
      properties: { hs_note_body: 'Replied on LinkedIn:<br><br>Sure &lt;b&gt;call&lt;/b&gt; me<br>Tomorrow', hs_timestamp: new Date(w.ctx.clock.now()).toISOString() },
      associations: [{ to: { id: '500' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }],
    });

    // The same job running again (a crash, a manual retry) updates the contact but adds no second note.
    const job = crmJobs(w)[0];
    await crmSyncJob({ id: job.id, workspaceId: w.workspaceId, payload: JSON.parse(job.payload), attempts: 2 }, { ctx: w.ctx, progress: () => {}, signal: new AbortController().signal });
    expect(hs.notes).toHaveLength(1);
    expect(hs.contacts.size).toBe(1);
    expect(logRows(w).slice(-2)).toMatchObject([
      { operation: 'upsert_contact', status: 'ok', external_id: '500' },
      { operation: 'add_note', status: 'skipped', error: 'Already in the CRM' },
    ]);
  });

  it('searches the mapped LinkedIn URL property when the lead has no email', async () => {
    const w = makeWorld();
    const hs = fakeHubspot();
    w.ctx.fetch = hs.fetch;
    addHubspot(w, { ...QUIET, fieldMapping: { ...HUBSPOT_MAPPING, profileUrl: 'linkedin_url' } });
    const [id] = addLeads(w, 1, 'nomail');
    hs.contacts.set('77', { linkedin_url: lead(w, id).profile_url });
    reply(w, id);
    await drainJobs(w);
    const search = JSON.parse(hs.fetch.calls.find((c) => c.url.endsWith('/search'))!.body!);
    expect(search.filterGroups[0].filters[0]).toEqual({ propertyName: 'linkedin_url', operator: 'EQ', value: lead(w, id).profile_url });
    expect(hs.contacts.size).toBe(1);
    expect(hs.notes[0].associations[0].to.id).toBe('77');
  });

  it('opens a deal on "interested" only when configured, once per lead', async () => {
    const w = makeWorld();
    const hs = fakeHubspot();
    w.ctx.fetch = hs.fetch;
    const crm = addHubspot(w, { ...QUIET, triggers: { ...QUIET.triggers, onReply: false }, createDealOn: ['interested'] });
    const id = leadWithEmail(w);
    const stages = listStages(w.ctx, w.workspaceId);
    const to = (slug: string) => setStage(w.ctx, lead(w, id), stages.find((s) => s.slug === slug)!.id, { source: 'manual' });

    to('replied');
    await drainJobs(w);
    expect(crmJobs(w)).toHaveLength(0);

    to('interested');
    await drainJobs(w);
    expect(hs.deals).toEqual([
      {
        properties: { dealname: 'Acme – Jane Doe', pipeline: 'default', dealstage: 'appointmentscheduled' },
        associations: [{ to: { id: '500' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] }],
      },
    ]);
    // A deal stage without a note trigger adds no note.
    expect(hs.notes).toHaveLength(0);
    expect(w.ctx.db.get('SELECT external_id FROM crm_links WHERE lead_id = ? AND integration_id = ? AND object_type = ?', [id, crm.id, 'deal'])).toEqual({ external_id: 'd1' });

    // Back and forth: the lead already has a deal.
    to('replied');
    to('interested');
    await drainJobs(w);
    expect(hs.deals).toHaveLength(1);

    // Without createDealOn nothing is opened.
    const w2 = makeWorld();
    const hs2 = fakeHubspot();
    w2.ctx.fetch = hs2.fetch;
    addHubspot(w2, { triggers: { ...QUIET.triggers, onStageChange: ['interested'] } });
    const id2 = leadWithEmail(w2);
    setStage(w2.ctx, lead(w2, id2), listStages(w2.ctx, w2.workspaceId).find((s) => s.slug === 'interested')!.id, { source: 'manual' });
    await drainJobs(w2);
    expect(hs2.deals).toHaveLength(0);
    expect(hs2.notes).toHaveLength(1);
    expect(hs2.notes[0].properties.hs_note_body).toBe('Pipeline stage: New → Interested');
  });

  it('uses the id HubSpot names when a create hits an existing email (search lags behind writes)', async () => {
    const w = makeWorld();
    const hs = fakeHubspot();
    hs.contacts.set('88', { email: 'other@acme.dev' });
    // Search finds nothing yet, but the create says the address is taken.
    const routes: FakeRoute[] = [
      { method: 'POST', url: /\/contacts\/search$/, reply: () => ({ json: { total: 0, results: [] } }) },
      { method: 'POST', url: /\/objects\/contacts$/, reply: () => ({ status: 409, json: { message: 'Contact already exists. Existing ID: 88' } }) },
    ];
    const conflict = fakeFetch(routes);
    w.ctx.fetch = (async (input: any, init: any) => (/\/contacts(\/search)?$/.test(String(input)) && init?.method === 'POST' ? conflict(input, init) : hs.fetch(input, init))) as typeof fetch;
    const crm = addHubspot(w, { ...QUIET, portalId: '123456' });
    const id = leadWithEmail(w);
    reply(w, id);
    await drainJobs(w);
    expect(crmJobs(w)[0].status).toBe('done');
    expect(hs.contacts.get('88')).toMatchObject({ email: 'jane@acme.dev', firstname: 'Jane' });
    expect(w.ctx.providers.instance<'crm'>(loadIntegration(w.ctx, w.workspaceId, crm.id)!)!.recordUrl!('contact', '88')).toBe('https://app.hubspot.com/contacts/123456/record/0-1/88');
  });

  it('waits out a 429 with Retry-After without using up an attempt', async () => {
    const w = makeWorld();
    const hs = fakeHubspot({ fail: { status: 429, headers: { 'retry-after': '30' } } });
    w.ctx.fetch = hs.fetch;
    addHubspot(w);
    reply(w, leadWithEmail(w));
    await drainJobs(w);
    const [job] = crmJobs(w);
    expect(job).toMatchObject({ status: 'queued', attempts: 0, run_at: w.ctx.clock.now() + 30_000 });
    expect(logRows(w)).toEqual([expect.objectContaining({ operation: 'upsert_contact', status: 'error', error: expect.stringContaining('will retry in 30 s') })]);

    hs.state.fail = null;
    w.ctx.clock.advance(30_000);
    await drainJobs(w);
    expect(crmJobs(w)[0].status).toBe('done');
    expect(hs.notes).toHaveLength(1);
  });

  it('stops on a rejected token and marks the integration, without leaking the token', async () => {
    const w = makeWorld();
    const hs = fakeHubspot({ fail: { status: 401 } });
    w.ctx.fetch = hs.fetch;
    const crm = addHubspot(w);
    reply(w, leadWithEmail(w));
    await drainJobs(w);
    const [job] = crmJobs(w);
    expect(job).toMatchObject({ status: 'failed', attempts: 1 });
    expect(job.last_error).not.toContain(HS_TOKEN);
    const row = loadIntegration(w.ctx, w.workspaceId, crm.id)!;
    expect(row).toMatchObject({ last_status: 'error' });
    expect(row.last_message).toContain('rejected the credentials (401)');
    expect(row.last_message).not.toContain(HS_TOKEN);
    expect(logRows(w)[0]).toMatchObject({ status: 'error' });
    expect(logRows(w)[0].error).not.toContain(HS_TOKEN);
  });
});

describe('Pipedrive sync', () => {
  // A tiny Pipedrive on any company subdomain: persons searchable by email, with list-valued emails/phones.
  function fakePipedrive(o: { people?: Record<number, Record<string, any>> } = {}) {
    const bodies: Record<string, any[]> = { persons: [], notes: [], deals: [], put: [] };
    const people = new Map<number, Record<string, any>>(Object.entries(o.people ?? {}).map(([id, p]) => [Number(id), p]));
    let next = 9;
    const route = (method: string, path: RegExp, reply: FakeRoute['reply']): FakeRoute => ({ method, url: new RegExp(/^https:\/\/[a-z0-9-]+\.pipedrive\.com\/api\/v1/.source + path.source), reply });
    const idIn = (url: string) => Number(new URL(url).pathname.split('/').pop());
    const fetch = fakeFetch([
      route('GET', /\/persons\/search\?/, (req) => {
        const term = new URL(req.url).searchParams.get('term');
        const hit = [...people].find(([, p]) => (p.email ?? []).some((e: any) => e.value === term));
        return { json: { success: true, data: { items: hit ? [{ item: { id: hit[0] } }] : [] } } };
      }),
      route('GET', /\/persons\/\d+$/, (req) => {
        const p = people.get(idIn(req.url));
        return p ? { json: { success: true, data: { id: idIn(req.url), ...p } } } : { status: 404, json: { success: false, error: 'Person not found' } };
      }),
      route('POST', /\/persons$/, (req) => {
        const body = JSON.parse(req.body!);
        bodies.persons.push(body);
        people.set(next, body);
        return { status: 201, json: { success: true, data: { id: next++ } } };
      }),
      route('PUT', /\/persons\/\d+$/, (req) => {
        const id = idIn(req.url);
        if (!people.has(id)) return { status: 404, json: { success: false, error: 'Person not found' } };
        const body = JSON.parse(req.body!);
        bodies.put.push(body);
        // Like Pipedrive, a list given in the body replaces the stored one.
        people.set(id, { ...people.get(id), ...body });
        return { json: { success: true, data: { id } } };
      }),
      route('POST', /\/notes$/, (req) => (bodies.notes.push(JSON.parse(req.body!)), { status: 201, json: { success: true, data: { id: 31 } } })),
      route('POST', /\/deals$/, (req) => (bodies.deals.push(JSON.parse(req.body!)), { status: 201, json: { success: true, data: { id: 51 } } })),
      route('GET', /\/users\/me$/, () => ({ json: { success: true, data: { name: 'Pat', company_name: 'Acme Inc' } } })),
    ]);
    return { fetch, bodies, people };
  }

  const addPipedrive = (w: World, settings: Record<string, unknown> = {}) =>
    createIntegration(w.ctx, w.workspaceId, { kind: 'crm', provider: 'pipedrive', credentials: { apiToken: PD_TOKEN }, settings: { ...QUIET, companyDomain: 'acme', ...settings } });

  it('creates a person, adds the note and opens a deal on the company domain', async () => {
    const w = makeWorld();
    const pd = fakePipedrive();
    w.ctx.fetch = pd.fetch;
    // A pasted address is trimmed to the subdomain.
    const crm = createIntegration(w.ctx, w.workspaceId, {
      kind: 'crm',
      provider: 'pipedrive',
      credentials: { apiToken: PD_TOKEN },
      settings: { ...QUIET, companyDomain: 'https://Acme.pipedrive.com/', createDealOn: ['interested'], dealStageId: 4 },
    });
    expect(JSON.parse(crm.settings).companyDomain).toBe('acme');
    const id = leadWithEmail(w);
    w.ctx.db.run('UPDATE leads SET phone = ? WHERE id = ?', ['+14155550123', id]);
    setStage(w.ctx, lead(w, id), listStages(w.ctx, w.workspaceId).find((s) => s.slug === 'interested')!.id, { source: 'manual' });
    reply(w, id, 'Yes please');
    await drainJobs(w);

    const search = new URL(pd.fetch.calls[0].url);
    expect(Object.fromEntries(search.searchParams)).toEqual({ term: 'jane@acme.dev', fields: 'email', exact_match: 'true', limit: '1' });
    for (const c of pd.fetch.calls) {
      expect(c.headers['x-api-token']).toBe(PD_TOKEN);
      expect(c.url).not.toContain(PD_TOKEN);
    }
    expect(pd.bodies.persons).toEqual([{ name: 'Jane Doe', email: [{ value: 'jane@acme.dev', primary: true, label: 'work' }], phone: [{ value: '+14155550123', primary: true, label: 'work' }] }]);
    expect(pd.bodies.notes).toEqual([{ content: 'Replied on LinkedIn:<br><br>Yes please', person_id: 9, add_time: new Date(w.ctx.clock.now()).toISOString().slice(0, 19).replace('T', ' ') }]);
    expect(pd.bodies.deals).toEqual([{ title: 'Acme – Jane Doe', person_id: 9, stage_id: 4 }]);
    expect(await w.ctx.providers.instance<'crm'>(loadIntegration(w.ctx, w.workspaceId, crm.id)!)!.test()).toEqual({ ok: true, message: 'Connected to Pipedrive (Acme Inc) as Pat.' });
  });

  it('updates the person a search finds', async () => {
    const w = makeWorld();
    const pd = fakePipedrive({ people: { 12: { name: 'J. Doe', email: [{ value: 'jane@acme.dev', primary: true, label: 'work' }] } } });
    w.ctx.fetch = pd.fetch;
    addPipedrive(w);
    reply(w, leadWithEmail(w));
    await drainJobs(w);
    expect(pd.bodies.persons).toHaveLength(0);
    expect(pd.bodies.put).toEqual([{ name: 'Jane Doe' }]);
    expect(pd.fetch.calls.find((c) => c.method === 'PUT')!.url).toBe('https://acme.pipedrive.com/api/v1/persons/12');
    expect(pd.bodies.notes[0].person_id).toBe(12);
  });

  it('adds to the emails and phones someone entered in Pipedrive instead of replacing them', async () => {
    const w = makeWorld();
    const work = { value: 'jane@acme.dev', primary: false, label: 'work' };
    const home = { value: 'jane@home.example', primary: true, label: 'home' };
    const pd = fakePipedrive({ people: { 12: { name: 'Jane Doe', email: [work, home], phone: [{ value: '+1 415 555 0000', primary: true, label: 'mobile' }] } } });
    w.ctx.fetch = pd.fetch;
    addPipedrive(w);
    const id = leadWithEmail(w);
    w.ctx.db.run('UPDATE leads SET phone = ? WHERE id = ?', ['+14155550123', id]);
    reply(w, id);
    await drainJobs(w);
    // Both emails survive (ours is already there, so the list isn't sent); the new phone is appended, not primary.
    expect(pd.people.get(12)!.email).toEqual([work, home]);
    expect(pd.bodies.put[0].email).toBeUndefined();
    expect(pd.people.get(12)!.phone).toEqual([
      { value: '+1 415 555 0000', primary: true, label: 'mobile' },
      { value: '+14155550123', primary: false, label: 'work' },
    ]);

    // A stored person with no email gets ours as the primary one; Pipedrive's "none" placeholder is dropped.
    pd.people.set(12, { name: 'Jane Doe', email: [{ value: '', primary: true }], phone: pd.people.get(12)!.phone });
    w.ctx.clock.advance(60_000);
    reply(w, id, 'Again');
    await drainJobs(w);
    expect(pd.people.get(12)!.email).toEqual([{ value: 'jane@acme.dev', primary: true, label: 'work' }]);
    expect(pd.bodies.put[1].phone).toBeUndefined();
  });

  it('forgets saved record ids when the integration is pointed at another account', async () => {
    const w = makeWorld();
    const pd = fakePipedrive();
    w.ctx.fetch = pd.fetch;
    const crm = addPipedrive(w);
    const id = leadWithEmail(w);
    reply(w, id);
    await drainJobs(w);
    expect(w.ctx.db.all('SELECT object_type, external_id FROM crm_links WHERE integration_id = ?', [crm.id])).toEqual([{ object_type: 'contact', external_id: '9' }]);
    const count = (table: string) => w.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE integration_id = ?`, [crm.id])!.n;
    const paths = (from: number) => pd.fetch.calls.slice(from).map((c) => `${c.method} ${new URL(c.url).host}${new URL(c.url).pathname}`);
    const update = (patch: Parameters<typeof updateIntegration>[2]) => updateIntegration(w.ctx, loadIntegration(w.ctx, w.workspaceId, crm.id)!, patch);

    // Saving other settings, or the same token again, keeps the links.
    update({ settings: { dealStageId: 3 }, credentials: { apiToken: PD_TOKEN } });
    expect([count('crm_links'), count('crm_items')]).toEqual([1, 1]);

    // Another company domain: the old person id is not reused there; the next sync searches first.
    update({ settings: { companyDomain: 'acme-prod' } });
    expect([count('crm_links'), count('crm_items')]).toEqual([0, 0]);
    let from = pd.fetch.calls.length;
    w.ctx.clock.advance(60_000);
    reply(w, id, 'Second');
    await drainJobs(w);
    expect(paths(from)[0]).toBe('GET acme-prod.pipedrive.com/api/v1/persons/search');

    // A new token is treated the same way.
    update({ credentials: { apiToken: 'another-pipedrive-token-1' } });
    expect(count('crm_links')).toBe(0);
    from = pd.fetch.calls.length;
    w.ctx.clock.advance(60_000);
    reply(w, id, 'Third');
    await drainJobs(w);
    expect(paths(from)[0]).toBe('GET acme-prod.pipedrive.com/api/v1/persons/search');
  });

  it('runs syncs of different leads side by side and syncs of one lead one after another', async () => {
    const w = makeWorld();
    const pd = fakePipedrive();
    w.ctx.fetch = pd.fetch;
    addPipedrive(w, { triggers: { ...QUIET.triggers, onStageChange: ['interested'] } });
    const id = leadWithEmail(w);
    const other = leadWithEmail(w, 'sam@acme.dev');
    setStage(w.ctx, lead(w, id), listStages(w.ctx, w.workspaceId).find((s) => s.slug === 'interested')!.id, { source: 'manual' });
    reply(w, id);
    reply(w, other);
    expect(crmJobs(w)).toHaveLength(3);
    // One tick claims all three; the two for Jane still create her only once.
    await w.ctx.jobs.tick();
    expect(crmJobs(w).map((j) => j.status)).toEqual(['done', 'done', 'done']);
    expect(pd.bodies.persons.map((p) => p.email[0].value).sort()).toEqual(['jane@acme.dev', 'sam@acme.dev']);
    expect(pd.bodies.notes).toHaveLength(3);
  });

  it('only accepts a bare company subdomain, so the token cannot be sent elsewhere', () => {
    const w = makeWorld();
    for (const bad of ['evil.com#', 'acme.evil.com', 'a/b', '-acme', '']) {
      expect(() => createIntegration(w.ctx, w.workspaceId, { kind: 'crm', provider: 'pipedrive', credentials: { apiToken: PD_TOKEN }, settings: { companyDomain: bad } })).toThrow(/companyDomain/);
    }
  });
});

describe('triggers', () => {
  const defaults = crmSettingsSchema({}).parse({});

  it('picks events from the settings', () => {
    expect(wantsEvent(defaults, { event: 'reply', ref: 'message:1' })).toBe(true);
    expect(wantsEvent(defaults, { event: 'connected', ref: 'connected:1:1' })).toBe(false);
    expect(wantsEvent(defaults, { event: 'message', ref: 'activity:1' })).toBe(false);
    expect(wantsEvent(defaults, { event: 'finished', ref: 'finished:1' })).toBe(false);
    expect(wantsEvent(defaults, { event: 'stage', ref: 'stage:1', stage: 'meeting' })).toBe(true);
    expect(wantsEvent(defaults, { event: 'stage', ref: 'stage:1', stage: 'replied' })).toBe(false);
    expect(wantsEvent({ ...defaults, createDealOn: ['won'] }, { event: 'stage', ref: 'stage:1', stage: 'won' })).toBe(true);
  });

  it('queues syncs only for configured CRMs whose triggers match (reply on, connected off)', async () => {
    const w = makeWorld();
    const id = leadWithEmail(w);
    // No CRM: nothing is queued (there is no simulated fallback for CRMs).
    reply(w, id);
    expect(crmJobs(w)).toHaveLength(0);

    const crm = createIntegration(w.ctx, w.workspaceId, { kind: 'crm', provider: 'simulated', settings: QUIET });
    w.ctx.webhooks.emit(w.workspaceId, 'lead.connected', { lead: { id }, account: { id: w.accountId, name: 'Sim Seat' } });
    expect(crmJobs(w)).toHaveLength(0);

    w.ctx.clock.advance(1000);
    const msg = reply(w, id);
    expect(crmJobs(w).map((j) => JSON.parse(j.payload))).toEqual([{ integrationId: crm.id, leadId: id, event: 'reply', ref: `message:${msg}` }]);
    // The same event twice is one job.
    w.ctx.webhooks.emit(w.workspaceId, 'lead.replied', { lead: { id } });
    expect(crmJobs(w)).toHaveLength(1);

    // A turned-off CRM gets nothing.
    w.ctx.db.run('UPDATE integrations SET enabled = 0 WHERE id = ?', [crm.id]);
    w.ctx.clock.advance(1000);
    reply(w, id, 'Again');
    expect(crmJobs(w)).toHaveLength(1);
  });

  it('queues the same per-lead stage syncs for a bulk move as for single moves', () => {
    const w = makeWorld();
    const ids = addLeads(w, 5);
    const crm = createIntegration(w.ctx, w.workspaceId, { kind: 'crm', provider: 'simulated', settings: { triggers: { ...QUIET.triggers, onStageChange: ['interested'] } } });
    const st = (slug: string) => listStages(w.ctx, w.workspaceId).find((s) => s.slug === slug)!;
    // A stage the CRM doesn't watch queues nothing.
    moveLeadsToStage(w.ctx, w.workspaceId, st('contacted'), { sql: `id IN (${ids.join(',')})`, params: [] }, { source: 'manual' });
    expect(crmJobs(w)).toHaveLength(0);
    deleteStage(w.ctx, w.workspaceId, st('contacted'), st('interested'), null);
    const history = w.ctx.db.all<{ id: number; lead_id: number }>('SELECT id, lead_id FROM lead_stage_history WHERE to_stage_id = ? ORDER BY lead_id', [st('interested').id]);
    expect(history).toHaveLength(5);
    expect(crmJobs(w).map((j) => JSON.parse(j.payload)).sort((a, b) => a.leadId - b.leadId)).toEqual(history.map((h) => ({ integrationId: crm.id, leadId: h.lead_id, event: 'stage', ref: `stage:${h.id}` })));
  });

  it('adds a note when a lead finishes a campaign, if asked', async () => {
    const w = makeWorld();
    const id = leadWithEmail(w);
    const crm = createIntegration(w.ctx, w.workspaceId, { kind: 'crm', provider: 'simulated', settings: { triggers: { ...QUIET.triggers, onReply: false, onCampaignFinished: true } } });
    const seq: Sequence = { start: 'w', nodes: { w: { id: 'w', type: 'wait', days: 0, hours: 1, next: null } } } as Sequence;
    const c = makeCampaign(w, seq, {}, [id]);
    await runFor(w, 2 * HOUR);
    const cl = w.ctx.db.get<{ id: number; state: string }>('SELECT id, state FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?', [c.id, id])!;
    expect(cl.state).toBe('done');
    await drainJobs(w);
    expect(w.ctx.db.all('SELECT item_key FROM crm_items WHERE integration_id = ?', [crm.id])).toEqual([{ item_key: `finished:${cl.id}` }]);
  });

  it('logs sent messages and connections when asked, through the simulated CRM', async () => {
    const w = makeWorld();
    const id = leadWithEmail(w);
    const crm = createIntegration(w.ctx, w.workspaceId, { kind: 'crm', provider: 'simulated', settings: { triggers: { ...QUIET.triggers, onReply: false, onConnected: true, logMessages: true } } });
    const act = w.ctx.db.insert('activity', { workspace_id: w.workspaceId, account_id: w.accountId, lead_id: id, type: 'message', status: 'ok', detail: 'Hi Jane', day: '2026-01-05', created_at: w.ctx.clock.now() });
    w.ctx.webhooks.emit(w.workspaceId, 'action.performed', { type: 'message', lead: { id } });
    w.ctx.webhooks.emit(w.workspaceId, 'action.performed', { type: 'connect', lead: { id } });
    w.ctx.webhooks.emit(w.workspaceId, 'lead.connected', { lead: { id }, account: { id: w.accountId, name: 'Sim Seat' } });
    expect(crmJobs(w).map((j) => JSON.parse(j.payload).ref)).toEqual([`activity:${act}`, `connected:${id}:${w.accountId}`]);
    await drainJobs(w);
    expect(logRows(w).filter((r) => r.operation === 'add_note').map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(w.ctx.db.all('SELECT item_key FROM crm_items WHERE integration_id = ? ORDER BY item_key', [crm.id])).toEqual([{ item_key: `activity:${act}` }, { item_key: `connected:${id}:${w.accountId}` }]);
    // Simulated calls are counted as free usage.
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM usage_events WHERE kind = 'crm' AND provider = 'simulated'")!.n).toBe(4);
  });
});

describe('field mapping', () => {
  it('maps our fields to CRM properties and leaves empty values out', () => {
    const c = { email: null, firstName: 'Jane', lastName: 'Doe', company: '', title: 'CTO', phone: null, profileUrl: 'https://www.linkedin.com/in/jane/', stage: 'Interested' };
    expect(mappedProperties(c, { ...HUBSPOT_MAPPING, profileUrl: 'linkedin_url', stage: 'lead_stage', fullName: 'full' })).toEqual({
      firstname: 'Jane',
      lastname: 'Doe',
      jobtitle: 'CTO',
      linkedin_url: 'https://www.linkedin.com/in/jane/',
      lead_stage: 'Interested',
      full: 'Jane Doe',
    });
    expect(noteHtml('a & b\n<c>')).toBe('a &amp; b<br>&lt;c&gt;');
  });
});

describe('CRM API', () => {
  async function setup() {
    const api = await makeApi();
    const owner = await api.register();
    const hs = fakeHubspot({ fail: { status: 500 } });
    api.w.ctx.fetch = hs.fetch;
    const created = await api.call('POST', '/api/integrations', { kind: 'crm', provider: 'hubspot', credentials: { accessToken: HS_TOKEN }, settings: QUIET });
    expect(created.status).toBe(200);
    const leadId = api.w.ctx.db.insert('leads', {
      workspace_id: owner.workspaceId,
      public_id: 'jane',
      profile_url: 'https://www.linkedin.com/in/jane/',
      first_name: 'Jane',
      last_name: 'Doe',
      email: 'jane@acme.dev',
      created_at: api.w.ctx.clock.now(),
    });
    return { api, owner, hs, crmId: created.body.id as number, leadId };
  }

  it('masks the token, validates the mapping and saves trigger settings', async () => {
    const { api, crmId } = await setup();
    const list = await api.call('GET', '/api/integrations');
    expect(list.raw).not.toContain(HS_TOKEN);
    expect(list.body.find((i: any) => i.id === crmId)).toMatchObject({ credentials: { accessToken: `••••${HS_TOKEN.slice(-4)}` }, settings: { triggers: { onReply: true }, createDealOn: [] } });
    expect(api.w.ctx.db.get<{ credentials_enc: string }>('SELECT credentials_enc FROM integrations WHERE id = ?', [crmId])!.credentials_enc).not.toContain(HS_TOKEN);
    expect((await api.call('PATCH', `/api/integrations/${crmId}`, { settings: { fieldMapping: { shoeSize: 'shoe' } } })).status).toBe(400);
    expect((await api.call('PATCH', `/api/integrations/${crmId}`, { settings: { fieldMapping: { email: 'bad name!' } } })).status).toBe(400);
    const ok = await api.call('PATCH', `/api/integrations/${crmId}`, { settings: { createDealOn: ['meeting'], triggers: { ...QUIET.triggers, onCampaignFinished: true } } });
    expect(ok.body.settings).toMatchObject({ createDealOn: ['meeting'], triggers: { onCampaignFinished: true, onReply: true } });
  });

  it('pushes leads, shows the log with errors and retries a failed sync', async () => {
    const { api, hs, crmId, leadId } = await setup();
    const pushed = await api.call('POST', '/api/crm/push', { integrationId: crmId, leadIds: [leadId, leadId, 999_999] });
    expect(pushed.body).toEqual({ queued: 1 });
    // A server error is retried by the queue with backoff; give up quickly for the test.
    api.w.ctx.db.run("UPDATE jobs SET max_attempts = 1 WHERE type = 'crm.sync'");
    await api.w.ctx.jobs.drain();
    const log = await api.call('GET', `/api/crm/log?integrationId=${crmId}&status=error`);
    expect(log.body).toMatchObject({
      total: 1,
      items: [{ leadId, leadName: 'Jane Doe', event: 'manual', operation: 'upsert_contact', status: 'error', integration: 'HubSpot', jobStatus: 'failed', resolved: false }],
    });
    expect(log.body.items[0].message).toContain('server error (500)');
    expect(log.raw).not.toContain(HS_TOKEN);

    hs.state.fail = null;
    const retried = await api.call('POST', `/api/crm/log/${log.body.items[0].id}/retry`);
    expect(retried.status).toBe(200);
    await api.w.ctx.jobs.drain();
    expect((await api.call('GET', `/api/crm/log?status=ok`)).body.items.map((i: any) => i.operation)).toEqual(['upsert_contact']);
    // The manual retry (a new job) got past the error, so it no longer offers Retry.
    expect((await api.call('GET', `/api/crm/log?status=error`)).body.items).toEqual([expect.objectContaining({ jobStatus: 'failed', resolved: true })]);
    const links = await api.call('GET', `/api/crm/leads/${leadId}`);
    expect(links.body).toEqual({
      crms: [{ id: crmId, label: 'HubSpot', provider: 'hubspot', simulated: false }],
      links: [{ integrationId: crmId, integration: 'HubSpot', provider: 'hubspot', objectType: 'contact', externalId: '500', url: null, syncedAt: api.w.ctx.clock.now() }],
    });
  });

  it('marks an error that the queue retried past as resolved', async () => {
    const { api, hs, crmId, leadId } = await setup();
    hs.state.fail = { status: 503 };
    await api.call('POST', '/api/crm/push', { integrationId: crmId, leadIds: [leadId] });
    await api.w.ctx.jobs.drain();
    const pending = (await api.call('GET', '/api/crm/log?status=error')).body.items;
    expect(pending).toEqual([expect.objectContaining({ jobStatus: 'queued', resolved: false })]);

    // The next attempt of the same job works.
    hs.state.fail = null;
    api.w.ctx.clock.advance(HOUR);
    await api.w.ctx.jobs.drain();
    const items = (await api.call('GET', '/api/crm/log')).body.items;
    expect(items.map((i: any) => [i.status, i.jobId])).toEqual([
      ['ok', pending[0].jobId],
      ['error', pending[0].jobId],
    ]);
    expect(items[1]).toMatchObject({ jobStatus: 'done', resolved: true });
    // Still resolved once the queue has cleaned the job up.
    api.w.ctx.db.run('DELETE FROM jobs WHERE id = ?', [pending[0].jobId]);
    expect((await api.call('GET', '/api/crm/log?status=error')).body.items[0]).toMatchObject({ jobStatus: null, resolved: true });
  });

  it('spreads a bulk push out so it does not hold up other workspaces', async () => {
    const { api, owner } = await setup();
    const crmId = (await api.call('GET', '/api/integrations')).body.find((i: any) => i.kind === 'crm').id;
    const now = api.w.ctx.clock.now();
    const ids = [1, 2, 3].map((n) =>
      api.w.ctx.db.insert('leads', { workspace_id: owner.workspaceId, public_id: `bulk${n}`, profile_url: `https://www.linkedin.com/in/bulk${n}/`, first_name: 'B', last_name: String(n), created_at: now }),
    );
    expect((await api.call('POST', '/api/crm/push', { integrationId: crmId, leadIds: ids })).body).toEqual({ queued: 3 });
    expect(api.w.ctx.db.all<{ run_at: number }>("SELECT run_at FROM jobs WHERE type = 'crm.sync' ORDER BY id").map((j) => j.run_at - now)).toEqual([0, 500, 1000]);
  });

  it('keeps logs and pushes inside the workspace and checks roles', async () => {
    const { api, owner, crmId, leadId } = await setup();
    await api.call('POST', '/api/crm/push', { integrationId: crmId, leadIds: [leadId] });
    api.w.ctx.db.run("UPDATE jobs SET max_attempts = 1 WHERE type = 'crm.sync'");
    await api.w.ctx.jobs.drain();
    const logId = (await api.call('GET', '/api/crm/log')).body.items[0].id;

    const member = await api.addUser('member');
    const client = await api.addUser('client');
    api.as(member);
    expect((await api.call('GET', '/api/crm/log')).status).toBe(403);
    expect((await api.call('POST', `/api/crm/log/${logId}/retry`)).status).toBe(403);
    expect((await api.call('POST', '/api/crm/push', { integrationId: crmId, leadIds: [leadId] })).body).toEqual({ queued: 1 });
    expect((await api.call('GET', `/api/crm/leads/${leadId}`)).status).toBe(200);
    api.as(client);
    expect((await api.call('POST', '/api/crm/push', { integrationId: crmId, leadIds: [leadId] })).status).toBe(403);
    expect((await api.call('GET', `/api/crm/leads/${leadId}`)).status).toBe(403);

    await api.register('Other');
    expect((await api.call('GET', '/api/crm/log')).body).toMatchObject({ total: 0, items: [] });
    expect((await api.call('POST', `/api/crm/log/${logId}/retry`)).status).toBe(404);
    expect((await api.call('POST', '/api/crm/push', { integrationId: crmId, leadIds: [leadId] })).status).toBe(404);
    expect((await api.call('GET', `/api/crm/leads/${leadId}`)).status).toBe(404);
    api.as(owner);
    expect((await api.call('GET', '/api/crm/log')).body.total).toBe(1);
  });
});
