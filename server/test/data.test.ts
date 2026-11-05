import { describe, expect, it } from 'vitest';
import { HOUR, MINUTE } from '../src/clock.js';
import type { Sequence } from '../src/engine/sequence.js';
import { setCampaignMailboxes } from '../src/mail/mailboxes.js';
import { apolloStatus } from '../src/providers/data/apollo.js';
import { hunterStatus } from '../src/providers/data/hunter.js';
import { neverBounceStatus } from '../src/providers/data/neverbounce.js';
import { zeroBounceStatus } from '../src/providers/data/zerobounce.js';
import { createIntegration } from '../src/providers/store.js';
import { emailVerified, enrichmentSettings, EnrichmentSettingsSchema, findEmailWaterfall, startEnrichmentRun } from '../src/services/enrichment.js';
import { setSetting } from '../src/services/settings.js';
import { monthlyUsage } from '../src/services/usage.js';
import type { JobRow } from '../src/jobs/queue.js';
import type { CampaignLeadRow, EnrichmentRunRow, LeadRow } from '../src/types.js';
import { addLeads, drainJobs, fakeFetch, mailerOf, makeApi, makeCampaign, makeWorld, type FakeRoute, type World } from './helpers.js';

const HUNTER_KEY = 'hunter-test-key-1234567';
const APOLLO_KEY = 'apollo-test-key-7654321';
const ZB_KEY = 'zerobounce-test-key-111';
const NB_KEY = 'neverbounce-test-key-222';

const lead = (w: World, id: number) => w.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id])!;
const cl = (w: World, campaignId: number, leadId: number) => w.ctx.db.get<CampaignLeadRow>('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?', [campaignId, leadId])!;
const run = (w: World, id: number) => w.ctx.db.get<EnrichmentRunRow>('SELECT * FROM enrichment_runs WHERE id = ?', [id])!;

function addFinder(w: World, provider: 'hunter' | 'apollo', key = provider === 'hunter' ? HUNTER_KEY : APOLLO_KEY) {
  return createIntegration(w.ctx, w.workspaceId, { kind: 'email_finder', provider, credentials: { apiKey: key } });
}
function addVerifier(w: World, provider: 'hunter' | 'zerobounce' | 'neverbounce', key: string) {
  return createIntegration(w.ctx, w.workspaceId, { kind: 'email_verifier', provider, credentials: { apiKey: key } });
}

// Fake vendor endpoints. Hunter misses unless `hunterEmail` is set; Apollo finds a verified address.
function vendors(o: { hunterEmail?: string | null; hunterStatus?: string; apolloEmail?: string | null; apolloStatus?: string; zb?: string | ((email: string) => string); nb?: string; hunter429?: boolean } = {}) {
  const routes: FakeRoute[] = [
    {
      url: /^https:\/\/api\.hunter\.io\/v2\/email-finder\?/,
      reply: () =>
        o.hunter429
          ? { status: 429, json: { errors: [{ details: 'Too many requests' }] }, headers: { 'retry-after': '30' } }
          : { json: { data: { email: o.hunterEmail ?? null, score: 91, verification: { status: o.hunterStatus ?? null } } } },
    },
    { method: 'POST', url: /^https:\/\/api\.apollo\.io\/api\/v1\/people\/match$/, reply: () => ({ json: { person: o.apolloEmail === null ? null : { email: o.apolloEmail ?? 'first0.last@acme.dev', email_status: o.apolloStatus ?? 'verified', title: 'CTO', city: 'Austin', country: 'United States', organization: { name: 'Acme', primary_domain: 'acme.dev', estimated_num_employees: 120, industry: 'Software' } } } }) },
    {
      url: /^https:\/\/api\.zerobounce\.net\/v2\/validate\?/,
      reply: (req) => ({ json: { status: typeof o.zb === 'function' ? o.zb(new URL(req.url).searchParams.get('email')!) : (o.zb ?? 'valid'), sub_status: '' } }),
    },
    { url: /^https:\/\/api\.neverbounce\.com\/v4\.2\/single\/check\?/, reply: () => ({ json: { status: 'success', result: o.nb ?? 'valid' } }) },
  ];
  return fakeFetch(routes);
}

describe('status mapping per vendor', () => {
  it('maps each vendor’s verdicts to valid / risky / invalid / unknown', () => {
    expect(['valid', 'invalid', 'disposable', 'accept_all', 'webmail', 'unknown', undefined].map(hunterStatus)).toEqual(['valid', 'invalid', 'invalid', 'risky', 'risky', 'unknown', 'unknown']);
    expect(['valid', 'invalid', 'catch-all', 'spamtrap', 'abuse', 'do_not_mail', 'unknown'].map(zeroBounceStatus)).toEqual(['valid', 'invalid', 'risky', 'invalid', 'invalid', 'invalid', 'unknown']);
    expect(['valid', 'invalid', 'disposable', 'catchall', 'unknown'].map(neverBounceStatus)).toEqual(['valid', 'invalid', 'invalid', 'risky', 'unknown']);
    expect(['verified', 'guessed', 'unavailable', null].map(apolloStatus)).toEqual(['valid', 'unknown', 'unknown', 'unknown']);
  });

  it('turns key errors that come back as HTTP 200 into auth errors, without the key', async () => {
    const w = makeWorld();
    const zb = addVerifier(w, 'zerobounce', ZB_KEY);
    const nb = addVerifier(w, 'neverbounce', NB_KEY);
    w.ctx.fetch = fakeFetch([
      { url: /zerobounce\.net\/v2\/validate/, reply: () => ({ json: { error: `Invalid API key or your account ran out of credits: ${ZB_KEY}` } }) },
      { url: /neverbounce\.com\/v4\.2\/single\/check/, reply: () => ({ json: { status: 'auth_failure', message: 'Invalid API key' } }) },
    ]);
    const zbErr = await w.ctx.providers.instance<'email_verifier'>(zb)!.verify('a@b.dev').catch((e) => e);
    expect(zbErr).toMatchObject({ code: 'AUTH', integrationId: zb.id });
    expect(zbErr.message).not.toContain(ZB_KEY);
    expect(await w.ctx.providers.instance<'email_verifier'>(nb)!.verify('a@b.dev').catch((e) => e)).toMatchObject({ code: 'AUTH', message: 'NeverBounce: Invalid API key' });
  });
});

describe('email waterfall', () => {
  it('tries finders in their order until one finds a verified address', async () => {
    const w = makeWorld();
    const [id] = addLeads(w, 1);
    addFinder(w, 'hunter');
    addFinder(w, 'apollo');
    const fetch = vendors();
    w.ctx.fetch = fetch;
    const r = await findEmailWaterfall(w.ctx, w.workspaceId, lead(w, id), { verify: true, settings: enrichmentSettings(w.ctx, w.workspaceId) });
    expect(fetch.calls.map((c) => new URL(c.url).host)).toEqual(['api.hunter.io', 'api.apollo.io']);
    // Without a real verifier, the finder's own check stands (the simulator never judges a real address).
    expect(r).toMatchObject({ email: 'first0.last@acme.dev', status: 'valid', source: 'apollo', accepted: true });
    expect(fetch.calls[0].url).toContain('first_name=First0');
    expect(fetch.calls[0].url).toContain('company=Acme');
    expect(fetch.calls[1].headers['x-api-key']).toBe(APOLLO_KEY);

    // Reordered: Apollo first, and Hunter is never asked.
    const rows = w.ctx.db.all<{ id: number }>("SELECT id FROM integrations WHERE kind = 'email_finder' ORDER BY priority");
    w.ctx.db.run('UPDATE integrations SET priority = 5 WHERE id = ?', [rows[0].id]);
    fetch.calls.length = 0;
    await findEmailWaterfall(w.ctx, w.workspaceId, lead(w, id), { verify: true, settings: enrichmentSettings(w.ctx, w.workspaceId) });
    expect(fetch.calls.map((c) => new URL(c.url).host)).toEqual(['api.apollo.io']);
  });

  it('verifies what finders return, skips invalid ones and stops at risky only when risky is accepted', async () => {
    const w = makeWorld();
    const [id] = addLeads(w, 1);
    addFinder(w, 'hunter');
    addFinder(w, 'apollo');
    addVerifier(w, 'zerobounce', ZB_KEY);
    w.ctx.fetch = vendors({ hunterEmail: 'f.last@acme.dev', hunterStatus: 'valid', zb: 'catch-all', apolloEmail: null });
    const settings = () => enrichmentSettings(w.ctx, w.workspaceId);

    // Our verifier overrules Hunter's "valid": catch-all is risky, so Apollo is asked too (and has nothing).
    let r = await findEmailWaterfall(w.ctx, w.workspaceId, lead(w, id), { verify: true, settings: settings() });
    expect(r).toMatchObject({ email: 'f.last@acme.dev', status: 'risky', accepted: false });
    expect(r.tried.map((t) => t.result)).toEqual(['found', 'not_found']);

    setSetting(w.ctx, w.workspaceId, 'enrichment', EnrichmentSettingsSchema, { acceptRisky: true });
    const fetch = vendors({ hunterEmail: 'f.last@acme.dev', zb: 'catch-all' });
    w.ctx.fetch = fetch;
    r = await findEmailWaterfall(w.ctx, w.workspaceId, lead(w, id), { verify: true, settings: settings() });
    expect(r).toMatchObject({ status: 'risky', accepted: true });
    expect(fetch.calls.some((c) => c.url.includes('apollo'))).toBe(false);

    // Invalid addresses are dropped and the next finder is tried.
    w.ctx.fetch = vendors({ hunterEmail: 'nobody@acme.dev', zb: (e) => (e === 'nobody@acme.dev' ? 'spamtrap' : 'valid'), apolloEmail: 'real@acme.dev', apolloStatus: 'verified' });
    setSetting(w.ctx, w.workspaceId, 'enrichment', EnrichmentSettingsSchema, { acceptRisky: false });
    const calls: string[] = [];
    const inner = w.ctx.fetch;
    w.ctx.fetch = (async (u: any, i: any) => (calls.push(String(u)), inner(u, i))) as typeof fetch;
    r = await findEmailWaterfall(w.ctx, w.workspaceId, lead(w, id), { verify: true, settings: settings() });
    expect(r.tried.map((t) => t.result)).toEqual(['invalid', 'found']);
    // Apollo's address was verified by ZeroBounce too ("valid" from the fake).
    expect(r).toMatchObject({ email: 'real@acme.dev', status: 'valid', source: 'apollo', accepted: true });
    expect(calls.filter((c) => c.includes('zerobounce'))).toHaveLength(2);

    // trustFinderStatus skips our own check when the finder already verified the address.
    setSetting(w.ctx, w.workspaceId, 'enrichment', EnrichmentSettingsSchema, { trustFinderStatus: true });
    const trusting = vendors({ hunterEmail: 'f.last@acme.dev', hunterStatus: 'valid', zb: 'invalid' });
    w.ctx.fetch = trusting;
    r = await findEmailWaterfall(w.ctx, w.workspaceId, lead(w, id), { verify: true, settings: settings() });
    expect(r).toMatchObject({ email: 'f.last@acme.dev', status: 'valid', accepted: true });
    expect(trusting.calls.some((c) => c.url.includes('zerobounce'))).toBe(false);
  });

  it('carries on past a finder with a bad key and flags that integration', async () => {
    const w = makeWorld();
    const [id] = addLeads(w, 1);
    const hunter = addFinder(w, 'hunter');
    addFinder(w, 'apollo');
    w.ctx.fetch = fakeFetch([
      { url: /api\.hunter\.io/, reply: () => ({ status: 401, json: { errors: [{ details: `No user found for the API key ${HUNTER_KEY}` }] } }) },
      { url: /api\.apollo\.io/, reply: () => ({ json: { person: { email: 'x@acme.dev', email_status: 'verified' } } }) },
    ]);
    const r = await findEmailWaterfall(w.ctx, w.workspaceId, lead(w, id), { verify: true, settings: enrichmentSettings(w.ctx, w.workspaceId) });
    expect(r).toMatchObject({ email: 'x@acme.dev', source: 'apollo' });
    const row = w.ctx.db.get<{ last_status: string; last_message: string }>('SELECT last_status, last_message FROM integrations WHERE id = ?', [hunter.id])!;
    expect(row.last_status).toBe('error');
    expect(row.last_message).not.toContain(HUNTER_KEY);
  });
});

describe('enrich jobs', () => {
  it('never replaces an address people entered unless asked, and only re-checks its status', async () => {
    const w = makeWorld();
    const [csv, typed, none] = addLeads(w, 3);
    w.ctx.db.run("UPDATE leads SET email = 'mine@acme.dev', email_source = 'csv' WHERE id = ?", [csv]);
    w.ctx.db.run("UPDATE leads SET email = 'old@acme.dev', email_source = NULL WHERE id = ?", [typed]);
    addFinder(w, 'apollo');
    addVerifier(w, 'neverbounce', NB_KEY);
    const fetch = vendors({ apolloEmail: 'found@acme.dev', nb: 'catchall' });
    w.ctx.fetch = fetch;

    startEnrichmentRun(w.ctx, w.workspaceId, null, [csv, typed, none], { find: true, verify: true, company: false, overwrite: false });
    await drainJobs(w);
    expect(lead(w, csv)).toMatchObject({ email: 'mine@acme.dev', email_source: 'csv', email_status: 'risky', enrichment_status: 'done' });
    expect(lead(w, typed)).toMatchObject({ email: 'old@acme.dev', email_source: null, email_status: 'risky' });
    // Apollo was only asked for the lead without an address; risky is kept because it had none.
    expect(fetch.calls.filter((c) => c.url.includes('apollo'))).toHaveLength(1);
    expect(lead(w, none)).toMatchObject({ email: 'found@acme.dev', email_source: 'apollo', email_status: 'risky', email_found_at: w.ctx.clock.now() });

    // With overwrite, a better (valid) address replaces the CSV one; risky ones never replace an address.
    w.ctx.clock.advance(20 * MINUTE);
    w.ctx.fetch = vendors({ apolloEmail: 'better@acme.dev', nb: 'valid' });
    startEnrichmentRun(w.ctx, w.workspaceId, null, [csv], { find: true, verify: true, company: false, overwrite: true });
    await drainJobs(w);
    expect(lead(w, csv)).toMatchObject({ email: 'better@acme.dev', email_source: 'apollo', email_status: 'valid' });
  });

  it('never brings back a bounced address when a finder returns it again', async () => {
    const w = makeWorld();
    const [only, both] = addLeads(w, 2);
    for (const id of [only, both]) w.ctx.db.run("UPDATE leads SET email = 'f.last@acme.dev', email_source = 'hunter', email_status = 'invalid', email_status_reason = 'Bounced' WHERE id = ?", [id]);
    addFinder(w, 'hunter');
    // Hunter calls the bounced address valid; with no real verifier, its own check would stand.
    w.ctx.fetch = vendors({ hunterEmail: 'F.Last@acme.dev', hunterStatus: 'valid' });
    startEnrichmentRun(w.ctx, w.workspaceId, null, [only], { find: true, verify: true, company: false, overwrite: false });
    await drainJobs(w);
    expect(lead(w, only)).toMatchObject({ email: 'f.last@acme.dev', email_source: 'hunter', email_status: 'invalid', email_status_reason: 'Bounced' });

    // The next finder's different address does replace it.
    addFinder(w, 'apollo');
    w.ctx.fetch = vendors({ hunterEmail: 'f.last@acme.dev', hunterStatus: 'valid', apolloEmail: 'first.last@acme.dev' });
    startEnrichmentRun(w.ctx, w.workspaceId, null, [both], { find: true, verify: true, company: false, overwrite: false });
    await drainJobs(w);
    expect(lead(w, both)).toMatchObject({ email: 'first.last@acme.dev', email_source: 'apollo', email_status: 'valid' });
  });

  it('keeps what changed on the lead while its lookup was running', async () => {
    const w = makeWorld();
    const [typed, bounced] = addLeads(w, 2);
    w.ctx.db.run("UPDATE leads SET email = 'x@acme.dev', email_source = 'csv' WHERE id = ?", [bounced]);
    addFinder(w, 'apollo');
    createIntegration(w.ctx, w.workspaceId, { kind: 'enrichment', provider: 'apollo', credentials: { apiKey: APOLLO_KEY } });
    addVerifier(w, 'zerobounce', ZB_KEY);
    const inner = vendors({ apolloEmail: 'found@acme.dev', zb: 'valid' });
    // Someone types an address and a title while Apollo is being asked; a bounce lands during the check.
    w.ctx.fetch = (async (u: any, i: any) => {
      if (String(u).includes('apollo')) w.ctx.db.run("UPDATE leads SET email = 'mine@acme.dev', email_source = 'user', title = 'Founder' WHERE id = ?", [typed]);
      if (String(u).includes('zerobounce')) w.ctx.db.run("UPDATE leads SET email_status = 'invalid' WHERE id = ?", [bounced]);
      return inner(u, i);
    }) as typeof fetch;
    startEnrichmentRun(w.ctx, w.workspaceId, null, [typed], { find: true, verify: true, company: true, overwrite: false });
    startEnrichmentRun(w.ctx, w.workspaceId, null, [bounced], { find: false, verify: true, company: false, overwrite: false });
    await drainJobs(w);
    // Blank fields Apollo knew are still filled in; the ones typed meanwhile are kept.
    expect(lead(w, typed)).toMatchObject({ email: 'mine@acme.dev', email_source: 'user', email_status: null, title: 'Founder', location: 'Austin, United States', enrichment_status: 'done' });
    expect(lead(w, bounced)).toMatchObject({ email: 'x@acme.dev', email_status: 'invalid' });
  });

  it('never spends paid verifier credits on made-up addresses', async () => {
    const w = makeWorld();
    const ids = addLeads(w, 6);
    const [madeUp] = addLeads(w, 1, 'made');
    w.ctx.db.run("UPDATE leads SET email = 'first0.last@acme.example', email_source = 'simulated' WHERE id = ?", [madeUp]);
    // A real verifier with no finder (to check CSV emails): the simulated finder fills in.
    addVerifier(w, 'zerobounce', ZB_KEY);
    const fetch = vendors();
    w.ctx.fetch = fetch;
    startEnrichmentRun(w.ctx, w.workspaceId, null, ids, { find: true, verify: true, company: false, overwrite: false });
    startEnrichmentRun(w.ctx, w.workspaceId, null, [madeUp], { find: false, verify: true, company: false, overwrite: false });
    await drainJobs(w);
    expect(fetch.calls).toEqual([]);
    const found = ids.map((id) => lead(w, id)).filter((l) => l.email);
    expect(found.length).toBeGreaterThan(0);
    for (const l of found) expect(l.email_status_reason).toMatch(/^Simulated/);
    expect(lead(w, madeUp).email_status_reason).toMatch(/^Simulated/);
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM usage_events WHERE provider = 'zerobounce'")!.n).toBe(0);
  });

  it('never replaces a real address with a made-up one, even with overwrite', async () => {
    const w = makeWorld();
    const ids = addLeads(w, 8);
    for (const id of ids) w.ctx.db.run("UPDATE leads SET email = ?, email_source = 'csv' WHERE id = ?", [`real${id}@acme.dev`, id]);
    startEnrichmentRun(w.ctx, w.workspaceId, null, ids, { find: true, verify: true, company: false, overwrite: true });
    await drainJobs(w);
    for (const id of ids) expect(lead(w, id)).toMatchObject({ email: `real${id}@acme.dev`, email_source: 'csv' });
    // The simulated finder did come up with addresses; they were just not used.
    const kept = w.ctx.db.all<{ detail: string }>("SELECT detail FROM activity WHERE type = 'enrich'").filter((a) => /simulated finder's .* is made up/.test(a.detail));
    expect(kept.length).toBeGreaterThan(0);
  });

  it('records usage per provider and month, with no credits for simulated calls', async () => {
    const w = makeWorld();
    const [a, b] = addLeads(w, 2);
    addFinder(w, 'hunter');
    addVerifier(w, 'zerobounce', ZB_KEY);
    w.ctx.fetch = vendors({ hunterEmail: 'f@acme.dev', zb: 'valid' });
    startEnrichmentRun(w.ctx, w.workspaceId, null, [a], { find: true, verify: true, company: true, overwrite: false });
    await drainJobs(w);
    const rows = monthlyUsage(w.ctx, w.workspaceId, '2026-01');
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'email_finder', provider: 'hunter', operation: 'finder.find', calls: 1, credits: 1 }),
        expect.objectContaining({ kind: 'email_verifier', provider: 'zerobounce', operation: 'verifier.verify', calls: 1, credits: 1 }),
        // No enrichment integration: the simulator answered and costs nothing.
        expect.objectContaining({ kind: 'enrichment', provider: 'simulated', operation: 'enrich.person', calls: 1, credits: 0 }),
      ]),
    );
    // The simulated enricher's made-up facts stay in the facts panel, never in real lead fields.
    expect(lead(w, a)).toMatchObject({ location: '', company_domain: null });
    expect(JSON.parse(lead(w, a).enrichment)).toMatchObject({ simulated: true, source: 'simulated' });
    expect(monthlyUsage(w.ctx, w.workspaceId, '2026-02')).toEqual([]);
    void b;
  });

  it('waits and retries after a 429 without using up an attempt', async () => {
    const w = makeWorld();
    const [id] = addLeads(w, 1);
    addFinder(w, 'hunter');
    w.ctx.fetch = vendors({ hunter429: true });
    startEnrichmentRun(w.ctx, w.workspaceId, null, [id], { find: true, verify: false, company: false, overwrite: false });
    await w.ctx.jobs.tick();
    const job = w.ctx.db.get<JobRow>("SELECT * FROM jobs WHERE type = 'enrich.lead'")!;
    expect(job).toMatchObject({ status: 'queued', attempts: 0, run_at: w.ctx.clock.now() + 30_000 });
    expect(lead(w, id).enrichment_status).toBe('queued');

    w.ctx.fetch = vendors({ hunterEmail: 'f@acme.dev', hunterStatus: 'valid' });
    w.ctx.clock.advance(31_000);
    await drainJobs(w);
    expect(lead(w, id)).toMatchObject({ email: 'f@acme.dev', email_status: 'valid', enrichment_status: 'done' });
  });

  it('counts a bulk run’s progress, and two overlapping runs over the same leads both finish', async () => {
    const w = makeWorld();
    const ids = addLeads(w, 6);
    const first = startEnrichmentRun(w.ctx, w.workspaceId, null, ids, { find: true, verify: true, company: false, overwrite: false });
    const second = startEnrichmentRun(w.ctx, w.workspaceId, null, ids.slice(0, 3), { find: true, verify: true, company: false, overwrite: false });
    expect(run(w, first.runId)).toMatchObject({ total: 6, done: 0, status: 'running' });
    await w.ctx.jobs.tick();
    expect(run(w, first.runId).done + run(w, second.runId).done).toBeGreaterThan(0);
    await drainJobs(w);
    const r1 = run(w, first.runId);
    expect(r1).toMatchObject({ status: 'done', done: 6 });
    expect(run(w, second.runId)).toMatchObject({ status: 'done', done: 3 });
    // The simulated finder only ever makes up .example addresses, tagged as simulated.
    const found = ids.map((id) => lead(w, id)).filter((l) => l.email);
    expect(r1.found).toBe(found.length);
    expect(r1.verified).toBe(found.filter((l) => l.email_status === 'valid').length);
    for (const l of found) expect(l).toMatchObject({ email_source: 'simulated', email: expect.stringMatching(/@acme\.example$/) });
    // The second run reused the first's results instead of looking the same leads up again.
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM usage_events WHERE operation = 'finder.find'")!.n).toBe(6);
  });
});

describe('find_email step and email_verified condition', () => {
  const seq: Sequence = {
    start: 'f',
    nodes: {
      f: { id: 'f', type: 'find_email', verify: true, maxWaitHours: 6, next: 'c' },
      c: { id: 'c', type: 'condition', kind: 'email_verified', withinDays: 7, yes: 'y', no: 'n' },
      y: { id: 'y', type: 'wait', days: 30, hours: 0, next: null },
      n: { id: 'n', type: 'wait', days: 30, hours: 0, next: null },
    },
  };

  it('holds leads while their email is looked up, then branches on whether it was verified', async () => {
    const w = makeWorld();
    const ids = addLeads(w, 8);
    const [given] = ids;
    w.ctx.db.run("UPDATE leads SET email = 'ok@acme.example', email_source = 'csv', email_status = 'valid' WHERE id = ?", [given]);
    const c = makeCampaign(w, seq, {}, ids);
    w.engine.advanceFreeSteps();
    // A lead with a verified address goes straight on, without a lookup.
    expect(cl(w, c.id, given).node_id).toBe('y');
    const held = cl(w, c.id, ids[1]);
    expect(held).toMatchObject({ node_id: 'f', hold_reason: 'enrich', next_run_at: held.node_entered_at + 6 * HOUR });
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = 'enrich.lead'")!.n).toBe(7);

    // Spurious wake-ups re-hold without a second lookup or a new deadline.
    w.ctx.db.run("UPDATE campaign_leads SET next_run_at = ? WHERE campaign_id = ? AND state = 'active'", [w.ctx.clock.now(), c.id]);
    w.engine.advanceFreeSteps();
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = 'enrich.lead'")!.n).toBe(7);
    expect(cl(w, c.id, ids[1]).next_run_at).toBe(held.next_run_at);

    await drainJobs(w);
    expect(cl(w, c.id, ids[1])).toMatchObject({ hold_reason: null, next_run_at: w.ctx.clock.now() });
    w.engine.advanceFreeSteps();
    const settings = enrichmentSettings(w.ctx, w.workspaceId);
    const branches = ids.map((id) => [cl(w, c.id, id).node_id, emailVerified(lead(w, id), settings) ? 'y' : 'n']);
    for (const [at, expected] of branches) expect(at).toBe(expected);
    expect(new Set(branches.map((b) => b[0]))).toEqual(new Set(['y', 'n']));
  });

  it('goes on after maxWaitHours when no lookup comes back', async () => {
    const w = makeWorld();
    const [id] = addLeads(w, 1);
    const c = makeCampaign(w, seq, {}, [id]);
    w.engine.advanceFreeSteps();
    expect(cl(w, c.id, id).hold_reason).toBe('enrich');
    w.ctx.clock.advance(6 * HOUR);
    w.engine.advanceFreeSteps();
    expect(cl(w, c.id, id)).toMatchObject({ node_id: 'n', hold_reason: null });
    expect(w.ctx.db.get<{ detail: string }>("SELECT detail FROM activity WHERE type = 'enrich' AND status = 'skipped'")!.detail).toMatch(/within 6 hours/);
  });
});

describe('simulated addresses and real mailboxes', () => {
  it('never sends to an address made up by the simulated finder from a real mailbox', async () => {
    const w = makeWorld();
    const [made, real] = addLeads(w, 2);
    w.ctx.db.run("UPDATE leads SET email = 'first0.last@acmecorp.com', email_source = 'simulated' WHERE id = ?", [made]);
    w.ctx.db.run("UPDATE leads SET email = 'first1.last@acmecorp.com', email_source = 'csv' WHERE id = ?", [real]);
    const mb = w.ctx.db.insert('mailboxes', {
      workspace_id: w.workspaceId,
      name: 'Box',
      provider: 'smtp',
      from_name: 'Sara',
      from_email: 'sara@sender.dev',
      work_days: '[0,1,2,3,4,5,6]',
      daily_limit: 40,
      warmup: 0,
      gap_min_sec: 1,
      gap_max_sec: 2,
      smtp_enc: w.ctx.sealer.seal(JSON.stringify({ host: 'smtp.sender.dev', port: 465, secure: true, user: 'sara@sender.dev', pass: 'app-password-1234' })),
      created_at: w.ctx.clock.now(),
    });
    const c = makeCampaign(w, { start: 'e', nodes: { e: { id: 'e', type: 'email', subject: 'Hi', body: 'Hello {{firstName}}', next: null } } }, {}, [made, real], []);
    setCampaignMailboxes(w.ctx, c.id, [mb]);
    for (let i = 0; i < 30; i++) {
      w.ctx.clock.advance(2 * MINUTE);
      await w.engine.tick();
    }
    expect(mailerOf(w).sent.map((s) => s.msg.to)).toEqual(['first1.last@acmecorp.com']);
    expect(w.ctx.db.get<{ detail: string }>("SELECT detail FROM activity WHERE type = 'email' AND status = 'skipped' AND lead_id = ?", [made])!.detail).toMatch(/simulated email finder/);
  });
});

describe('enrichment API', () => {
  it('starts runs and single lookups for writers, keeps settings admin-only and workspaces apart', async () => {
    const { call, register, addUser, as, w } = await makeApi();
    const owner = await register('Acme');
    const list = (await call('POST', '/api/lists', { name: 'L' })).body.id;
    await call('POST', '/api/leads/import/csv', { listId: list, csv: 'Profile URL,First Name,Last Name,Company,Email\nhttps://www.linkedin.com/in/ann/,Ann,Lee,Acme,ann@acme.dev\nhttps://www.linkedin.com/in/bob/,Bob,Ray,Acme,\n' });
    const leads = (await call('GET', `/api/leads?listId=${list}`)).body.items;
    const ann = leads.find((l: any) => l.firstName === 'Ann');
    const bob = leads.find((l: any) => l.firstName === 'Bob');
    expect(ann).toMatchObject({ emailSource: 'csv', enrichmentStatus: null, emailStatus: null });

    const started = await call('POST', '/api/leads/enrich', { listId: list, company: true });
    expect(started.body).toEqual({ runId: expect.any(Number), total: 2 });
    expect((await call('GET', `/api/leads?enrichment=queued`)).body.total).toBe(2);
    await drainJobs(w);
    expect((await call('GET', `/api/enrichment/runs/${started.body.runId}`)).body).toMatchObject({ status: 'done', total: 2, done: 2, options: { find: true, verify: true, company: true, overwrite: false } });
    const after = (await call('GET', `/api/leads/${ann.id}`)).body;
    // A real-looking CSV address is left alone and can't be checked by the simulator: unknown, with the reason.
    expect(after).toMatchObject({ email: 'ann@acme.dev', emailSource: 'csv', emailStatus: 'unknown', enrichmentStatus: 'done', enrichment: { simulated: true } });
    expect(after.emailStatusReason).toMatch(/connect an email verifier/);
    expect(after.activity.some((a: any) => a.type === 'enrich')).toBe(true);
    expect((await call('GET', '/api/leads?emailStatus=unknown')).body.items.map((l: any) => l.id)).toContain(ann.id);
    const missing = (await call('GET', '/api/leads?emailStatus=missing')).body.items.map((l: any) => l.id);
    expect(missing.includes(bob.id)).toBe(!(await call('GET', `/api/leads/${bob.id}`)).body.email);

    expect((await call('POST', `/api/leads/${bob.id}/enrich`, { find: false, verify: false, company: false })).status).toBe(400);
    expect((await call('POST', `/api/leads/${bob.id}/enrich`, {})).body).toEqual({ jobId: expect.any(Number) });
    expect((await call('POST', '/api/leads/enrich', { leadIds: [ann.id], listId: list })).status).toBe(400);

    // Settings: everyone reads, admins change.
    expect((await call('GET', '/api/settings/enrichment')).body).toEqual({ verifyFound: true, acceptRisky: false, trustFinderStatus: false, autoEnrichOnImport: false, enrichCompany: true });
    expect((await call('PUT', '/api/settings/enrichment', { acceptRisky: true })).body).toMatchObject({ acceptRisky: true, verifyFound: true });
    const member = await addUser('member');
    as(member);
    expect((await call('PUT', '/api/settings/enrichment', { acceptRisky: false })).status).toBe(403);
    expect((await call('GET', '/api/settings/enrichment')).body.acceptRisky).toBe(true);
    expect((await call('POST', `/api/leads/${ann.id}/enrich`, {})).status).toBe(200);

    // Another workspace sees none of it.
    await register('Other');
    expect((await call('POST', `/api/leads/${ann.id}/enrich`, {})).status).toBe(404);
    expect((await call('GET', `/api/enrichment/runs/${started.body.runId}`)).status).toBe(404);
    expect((await call('POST', '/api/leads/enrich', { listId: list })).status).toBe(404);
    expect((await call('POST', '/api/leads/enrich', { leadIds: [ann.id, bob.id] })).body).toMatchObject({ total: 0 });
    expect((await call('GET', '/api/enrichment/runs')).body.map((x: any) => x.id)).not.toContain(started.body.runId);
    expect((await call('GET', '/api/settings/enrichment')).body.acceptRisky).toBe(false);
    void owner;
  });

  it('marks typed addresses as the user’s own and auto-enriches imports when asked', async () => {
    const { call, register, w } = await makeApi();
    await register();
    const list = (await call('POST', '/api/lists', { name: 'L' })).body.id;
    const r = await call('POST', '/api/leads/import/csv', { listId: list, autoEnrich: true, csv: 'Profile URL,First Name,Last Name,Company\nhttps://www.linkedin.com/in/cy/,Cy,Moe,Initech\n' });
    expect(r.body).toMatchObject({ added: 1, enrichRunId: expect.any(Number) });
    expect(r.body.addedIds).toBeUndefined();
    await drainJobs(w);
    const cy = (await call('GET', `/api/leads?listId=${list}`)).body.items[0];
    expect(cy.enrichmentStatus).toMatch(/done|not_found/);
    await call('PATCH', `/api/leads/${cy.id}`, { email: 'cy@initech.dev' });
    expect((await call('GET', `/api/leads/${cy.id}`)).body).toMatchObject({ email: 'cy@initech.dev', emailSource: 'user', emailStatus: null, emailFoundAt: null });
    const single = await call('POST', '/api/leads', { listId: list, profileUrl: 'https://www.linkedin.com/in/dee/', email: 'dee@initech.dev' });
    expect((await call('GET', `/api/leads/${single.body.id}`)).body.emailSource).toBe('user');
  });
});
