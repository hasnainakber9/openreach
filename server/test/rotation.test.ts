import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE } from '../src/clock.js';
import { DB } from '../src/db/db.js';
import { SimulatorDriver } from '../src/drivers/simulator.js';
import { DriverError, type LinkedInDriver } from '../src/drivers/types.js';
import type { Sequence } from '../src/engine/sequence.js';
import { syncAccount } from '../src/engine/sync.js';
import { campaignStats } from '../src/routes/campaigns.js';
import { chooseSender, connectionWith, releaseUnstartedLeads, setCampaignAccounts, setConnection } from '../src/services/rotation.js';
import type { CampaignLeadRow, CampaignRow, LeadRow } from '../src/types.js';
import { addAccount, addLeads, makeApi, makeCampaign, makeWorld, runFor, type World } from './helpers.js';

const inviteThenMessage: Sequence = {
  start: 'c',
  nodes: {
    c: { id: 'c', type: 'connect', note: 'Hi {{firstName}}', next: 'q' },
    q: { id: 'q', type: 'condition', kind: 'accepted_within', withinDays: 7, yes: 'm1', no: null },
    m1: { id: 'm1', type: 'message', text: 'Thanks {{firstName}}!', next: 'w' },
    w: { id: 'w', type: 'wait', days: 3, hours: 0, next: 'm2' },
    m2: { id: 'm2', type: 'message', text: 'Following up', next: null },
  },
};
const inviteThenWait: Sequence = {
  start: 'c',
  nodes: {
    c: { id: 'c', type: 'connect', note: '', next: 'w' },
    w: { id: 'w', type: 'wait', days: 20, hours: 0, next: null },
  },
};
const messageOnly: Sequence = { start: 'm', nodes: { m: { id: 'm', type: 'message', text: 'Hello {{firstName}}', next: null } } };

const invitesBy = (w: World, campaignId: number) =>
  Object.fromEntries(
    w.ctx.db
      .all<{ account_id: number; n: number }>("SELECT account_id, COUNT(*) AS n FROM activity WHERE campaign_id = ? AND type = 'connect' AND status = 'ok' GROUP BY account_id", [campaignId])
      .map((r) => [r.account_id, r.n]),
  );
const campaignLead = (w: World, campaignId: number, leadId: number) =>
  w.ctx.db.get<CampaignLeadRow>('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?', [campaignId, leadId])!;
const lead = (w: World, id: number) => w.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id])!;
const publicId = (w: World, id: number) => lead(w, id).public_id;
// Puts a person into one simulated account's network as an existing connection.
const simConnect = (w: World, accountId: number, leadId: number) =>
  w.ctx.db.run('INSERT INTO sim_people (account_id, public_id, invite_sent_at, accept_at, connected) VALUES (?, ?, ?, ?, 1)', [accountId, publicId(w, leadId), 0, 0]);

describe('sender rotation', () => {
  it('spreads invites over the senders without letting any of them pass its own limit', async () => {
    const w = makeWorld({ acceptRate: 0 }, { limits: JSON.stringify({ connect: 3 }), delay_min_sec: 30, delay_max_sec: 60 });
    const b = addAccount(w, { limits: JSON.stringify({ connect: 3 }), delay_min_sec: 30, delay_max_sec: 60 });
    const leads = addLeads(w, 12);
    const { id } = makeCampaign(w, inviteThenWait, {}, leads, [w.accountId, b.id]);

    await runFor(w, 16 * HOUR);
    const day1 = invitesBy(w, id);
    expect(day1[w.accountId]).toBe(3);
    expect(day1[b.id]).toBe(3);

    // Day two: still never more than 3 per sender per day; the rest wait unassigned.
    await runFor(w, DAY);
    const perDay = w.ctx.db.all<{ account_id: number; day: string; n: number }>(
      "SELECT account_id, day, COUNT(*) AS n FROM activity WHERE type = 'connect' AND status = 'ok' GROUP BY account_id, day",
    );
    expect(perDay).toHaveLength(4);
    for (const d of perDay) expect(d.n).toBeLessThanOrEqual(3);
    const unassigned = w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? AND account_id IS NULL', [id])!.n;
    expect(unassigned).toBe(0); // 12 leads, 12 invites over two days
    expect(Object.values(invitesBy(w, id)).reduce((a, n) => a + n, 0)).toBe(12);

    const bySender = campaignStats(w.ctx, id).bySender;
    expect(bySender.map((s) => [s.accountId, s.invited, s.leads])).toEqual([
      [w.accountId, 6, 6],
      [b.id, 6, 6],
    ]);
  });

  it('keeps each lead with the account that invited it for every follow-up', async () => {
    const w = makeWorld({ acceptRate: 1, replyRate: 0, acceptHours: [1, 2] });
    const b = addAccount(w);
    const events: { event: string; data: any }[] = [];
    w.ctx.webhooks.subscribe((_ws, event, data) => events.push({ event, data }));
    const leads = addLeads(w, 6);
    const { id } = makeCampaign(w, inviteThenMessage, {}, leads, [w.accountId, b.id]);

    await runFor(w, 6 * DAY, 5 * 60_000);

    expect(w.ctx.db.all("SELECT state FROM campaign_leads WHERE campaign_id = ? AND state != 'done'", [id])).toEqual([]);
    const senders = new Set<number>();
    for (const l of leads) {
      const acts = w.ctx.db.all<{ account_id: number; type: string }>(
        "SELECT account_id, type FROM activity WHERE lead_id = ? AND status = 'ok' AND type IN ('connect', 'accepted', 'message')",
        [l],
      );
      expect(acts.filter((a) => a.type === 'message')).toHaveLength(2);
      const accounts = new Set(acts.map((a) => a.account_id));
      expect(accounts.size).toBe(1);
      expect(campaignLead(w, id, l).account_id).toBe([...accounts][0]);
      senders.add([...accounts][0]);
      // The inbox thread lives under the same sender.
      expect(w.ctx.db.all<{ account_id: number }>('SELECT account_id FROM conversations WHERE lead_id = ?', [l]).map((c) => c.account_id)).toEqual([...accounts]);
    }
    expect(senders).toEqual(new Set([w.accountId, b.id]));

    const performed = events.filter((e) => e.event === 'action.performed');
    expect(performed.length).toBe(18);
    for (const e of performed) expect(campaignLead(w, id, e.data.lead.id).account_id).toBe(e.data.account.id);
    expect(events.find((e) => e.event === 'lead.connected')!.data.account.id).toBeTypeOf('number');
  });

  it('assigns a lead that is already connected to one sender to that sender', async () => {
    const w = makeWorld({ acceptRate: 0 });
    const b = addAccount(w);
    const leads = addLeads(w, 4);
    simConnect(w, b.id, leads[2]);
    setConnection(w.ctx, leads[2], b.id, 'connected');
    const seq: Sequence = {
      start: 'q',
      nodes: {
        q: { id: 'q', type: 'condition', kind: 'is_connected', withinDays: 7, yes: 'm', no: 'f' },
        m: { id: 'm', type: 'message', text: 'Hi again', next: null },
        f: { id: 'f', type: 'follow', next: null },
      },
    };
    const { id } = makeCampaign(w, seq, {}, leads, [w.accountId, b.id]);
    await runFor(w, 3 * HOUR);

    expect(campaignLead(w, id, leads[2])).toMatchObject({ account_id: b.id, state: 'done' });
    expect(w.ctx.db.get("SELECT account_id, status FROM activity WHERE lead_id = ? AND type = 'message'", [leads[2]])).toEqual({ account_id: b.id, status: 'ok' });
    // Nobody else was connected, so they were followed by whichever sender had room.
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE type = 'follow' AND status = 'ok'")!.n).toBe(3);

    // Same rule for unassigned leads waiting at an action: the connected sender wins.
    const camp = w.ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [id])!;
    expect(chooseSender(w.ctx, camp, lead(w, leads[2]), 'message', new Map())).toBe(b.id);
  });

  it('records a second sender’s own connection to a lead the first is already connected to', async () => {
    const w = makeWorld();
    const b = addAccount(w);
    const [l] = addLeads(w, 1);
    setConnection(w.ctx, l, w.accountId, 'connected');
    expect(lead(w, l).connection_status).toBe('connected');
    expect(connectionWith(w.ctx, lead(w, l), b.id)).toBe('none');

    simConnect(w, b.id, l);
    const events: string[] = [];
    w.ctx.webhooks.subscribe((_ws, event) => events.push(event));
    const r = await syncAccount(w.ctx, b.row());
    expect(r.accepted).toBe(1);
    expect(connectionWith(w.ctx, lead(w, l), b.id)).toBe('connected');
    expect(w.ctx.db.get("SELECT account_id FROM activity WHERE type = 'accepted' AND lead_id = ?", [l])).toEqual({ account_id: b.id });
    // The lead was already connected to the workspace, so no second lead.connected event.
    expect(events).not.toContain('lead.connected');
    // A second sync doesn't record it again.
    expect((await syncAccount(w.ctx, b.row())).accepted).toBe(0);
  });

  it('withdrawing one sender’s invite keeps the lead connected through another', async () => {
    const w = makeWorld();
    const b = addAccount(w);
    const [l] = addLeads(w, 1);
    w.ctx.db.run('INSERT INTO sim_people (account_id, public_id, invite_sent_at) VALUES (?, ?, ?)', [w.accountId, publicId(w, l), w.ctx.clock.now()]);
    setConnection(w.ctx, l, w.accountId, 'pending');
    setConnection(w.ctx, l, b.id, 'connected');
    const { id } = makeCampaign(w, { start: 'x', nodes: { x: { id: 'x', type: 'withdraw_invite', next: null } } }, {}, [l], [w.accountId]);

    await runFor(w, 2 * HOUR);
    expect(w.ctx.db.get("SELECT account_id, status FROM activity WHERE campaign_id = ? AND type = 'withdraw_invite'", [id])).toEqual({ account_id: w.accountId, status: 'ok' });
    expect(connectionWith(w.ctx, lead(w, l), w.accountId)).toBe('none');
    expect(lead(w, l).connection_status).toBe('connected');

    // With no other connection left, withdrawing clears the aggregate too.
    setConnection(w.ctx, l, b.id, 'none');
    expect(lead(w, l).connection_status).toBe('none');
  });

  it('hands a logged-out sender’s unstarted leads to the others and keeps its conversations', async () => {
    const w = makeWorld({ acceptRate: 0 }, { limits: JSON.stringify({ connect: 2 }) });
    const b = addAccount(w, { limits: JSON.stringify({ connect: 2 }) });
    const leads = addLeads(w, 8);
    const { id } = makeCampaign(w, inviteThenWait, {}, leads, [w.accountId, b.id]);
    await runFor(w, 16 * HOUR);
    expect(invitesBy(w, id)).toEqual({ [w.accountId]: 2, [b.id]: 2 });

    // Two more leads queued for A (pinned, not yet contacted), then A's session expires overnight.
    const queued = w.ctx.db.all<{ id: number; lead_id: number }>('SELECT id, lead_id FROM campaign_leads WHERE campaign_id = ? AND account_id IS NULL ORDER BY id LIMIT 2', [id]);
    for (const q of queued) w.ctx.db.run('UPDATE campaign_leads SET account_id = ? WHERE id = ?', [w.accountId, q.id]);
    const contactedByA = w.ctx.db.all<{ lead_id: number }>('SELECT lead_id FROM campaign_leads WHERE campaign_id = ? AND account_id = ? AND contacted_at IS NOT NULL', [id, w.accountId]).map((r) => r.lead_id);
    expect(contactedByA).toHaveLength(2);

    await w.ctx.drivers.drop(w.accountId);
    w.ctx.drivers.factory = (a) =>
      a.id === w.accountId
        ? (new Proxy({} as LinkedInDriver, {
            get: (_t, prop) => (prop === 'close' ? async () => {} : async () => {
              throw new DriverError('SESSION_EXPIRED', 'cookie expired');
            }),
          }) as LinkedInDriver)
        : new SimulatorDriver(w.ctx.db, a.id, a.name, w.ctx.clock, w.ctx.drivers.simOptions);

    await runFor(w, DAY);
    expect(w.account().status).toBe('needs_login');
    // A keeps only the leads it already invited, still active and waiting for it.
    const pinnedToA = w.ctx.db.all<{ lead_id: number; state: string }>('SELECT lead_id, state FROM campaign_leads WHERE campaign_id = ? AND account_id = ? ORDER BY lead_id', [id, w.accountId]);
    expect(pinnedToA).toEqual(contactedByA.sort((x, y) => x - y).map((l) => ({ lead_id: l, state: 'active' })));
    // B took two more on day two, and at least one was released from A.
    expect(invitesBy(w, id)).toEqual({ [w.accountId]: 2, [b.id]: 4 });
    const tookOver = queued.filter((q) => campaignLead(w, id, q.lead_id).account_id === b.id);
    expect(tookOver.length).toBeGreaterThan(0);
  });

  it('releases unstarted leads when a sender is removed from a campaign; its conversations finish from it', async () => {
    const w = makeWorld({ acceptRate: 0 });
    const b = addAccount(w);
    const [l1, l2] = addLeads(w, 2);
    const { id } = makeCampaign(w, messageOnly, {}, [l1, l2], [w.accountId, b.id]);
    // l1 is mid-conversation with B; l2 was only queued for B.
    simConnect(w, b.id, l1);
    setConnection(w.ctx, l1, b.id, 'connected');
    w.ctx.db.run('UPDATE campaign_leads SET account_id = ?, contacted_at = ? WHERE campaign_id = ? AND lead_id = ?', [b.id, w.ctx.clock.now(), id, l1]);
    w.ctx.db.run('UPDATE campaign_leads SET account_id = ? WHERE campaign_id = ? AND lead_id = ?', [b.id, id, l2]);

    setCampaignAccounts(w.ctx, id, [w.accountId]);
    expect(campaignLead(w, id, l1).account_id).toBe(b.id);
    expect(campaignLead(w, id, l2).account_id).toBeNull();
    expect(w.ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [id])!.account_id).toBe(w.accountId);

    await runFor(w, 2 * HOUR);
    expect(w.ctx.db.get("SELECT account_id, status FROM activity WHERE lead_id = ? AND type = 'message'", [l1])).toEqual({ account_id: b.id, status: 'ok' });
    // l2 isn't connected to A, so A's message is skipped, but it was A that handled it.
    expect(w.ctx.db.get("SELECT account_id FROM activity WHERE lead_id = ? AND type = 'message'", [l2])).toEqual({ account_id: w.accountId });
  });

  it('freezes a paused sender’s waiting leads but lets unassigned ones move on', async () => {
    const w = makeWorld();
    const b = addAccount(w);
    const [l1, l2] = addLeads(w, 2);
    const seq: Sequence = { start: 'w', nodes: { w: { id: 'w', type: 'wait', days: 0, hours: 1, next: 'f' }, f: { id: 'f', type: 'follow', next: null } } };
    const { id } = makeCampaign(w, seq, {}, [l1, l2], [w.accountId, b.id]);
    w.ctx.db.run('UPDATE campaign_leads SET account_id = ? WHERE campaign_id = ? AND lead_id = ?', [b.id, id, l1]);
    w.ctx.db.run("UPDATE accounts SET status = 'paused' WHERE id = ?", [b.id]);

    await runFor(w, 3 * HOUR);
    expect(campaignLead(w, id, l1)).toMatchObject({ node_id: 'w', state: 'active', account_id: b.id });
    expect(campaignLead(w, id, l2)).toMatchObject({ state: 'done', account_id: w.accountId });
  });

  it('keeps a lead released mid-action away from other senders and pinned to the one that contacted it', async () => {
    const w = makeWorld({ acceptRate: 0 });
    const b = addAccount(w);
    const [l] = addLeads(w, 1);
    const { id } = makeCampaign(w, inviteThenWait, {}, [l], [w.accountId, b.id]);
    w.ctx.db.run('UPDATE campaign_leads SET account_id = ? WHERE campaign_id = ?', [w.accountId, id]);

    // A's invite hangs (a slow browser) until the test lets it finish.
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    w.ctx.drivers.factory = (a) => {
      const sim = new SimulatorDriver(w.ctx.db, a.id, a.name, w.ctx.clock, w.ctx.drivers.simOptions);
      if (a.id !== w.accountId) return sim;
      return new Proxy(sim, {
        get: (t, prop, r) =>
          prop === 'connect'
            ? async (url: string, note: string) => {
                started();
                await gate;
                return t.connect(url, note);
              }
            : Reflect.get(t, prop, r),
      });
    };

    w.ctx.clock.advance(65 * MINUTE); // into working hours
    const first = w.engine.tick();
    await inFlight;
    // The user pauses A while its invite is being sent: the lead is released...
    w.ctx.db.run("UPDATE accounts SET status = 'paused' WHERE id = ?", [w.accountId]);
    releaseUnstartedLeads(w.ctx, w.accountId);
    expect(campaignLead(w, id, l).account_id).toBeNull();
    // ...but B doesn't send a second invite while A's is still in flight.
    for (let i = 0; i < 3; i++) {
      w.ctx.clock.advance(2 * MINUTE);
      await w.engine.tick();
    }
    expect(invitesBy(w, id)).toEqual({});

    finish();
    await first;
    expect(invitesBy(w, id)).toEqual({ [w.accountId]: 1 });
    // A contacted them, so the lead is A's again and stays A's.
    expect(campaignLead(w, id, l)).toMatchObject({ account_id: w.accountId, node_id: 'w' });
    expect(campaignLead(w, id, l).contacted_at).not.toBeNull();
    await runFor(w, 2 * HOUR);
    expect(invitesBy(w, id)).toEqual({ [w.accountId]: 1 });
  });

  it('credits a legacy connection (no per-account record) to the campaign’s first sender only', async () => {
    const w = makeWorld({ acceptRate: 0 });
    const b = addAccount(w);
    const [l] = addLeads(w, 1);
    simConnect(w, w.accountId, l);
    w.ctx.db.run("UPDATE leads SET connection_status = 'connected', connected_at = 1 WHERE id = ?", [l]);
    const { id } = makeCampaign(w, messageOnly, {}, [l], [w.accountId, b.id]);
    const camp = w.ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [id])!;

    expect(connectionWith(w.ctx, lead(w, l), w.accountId, camp.account_id)).toBe('connected');
    expect(connectionWith(w.ctx, lead(w, l), b.id, camp.account_id)).toBe('none');
    expect(chooseSender(w.ctx, camp, lead(w, l), 'message', new Map())).toBe(w.accountId);

    await runFor(w, 2 * HOUR);
    expect(w.ctx.db.get("SELECT account_id, status FROM activity WHERE lead_id = ? AND type = 'message'", [l])).toEqual({ account_id: w.accountId, status: 'ok' });
  });
});

describe('sender rotation API', () => {
  async function setup() {
    const api = await makeApi();
    const owner = await api.register();
    const mk = async (name: string) => (await api.call('POST', '/api/accounts', { name, driver: 'simulator', warmup: false })).body.id as number;
    return { ...api, owner, a: await mk('Seat A'), b: await mk('Seat B') };
  }

  it('lets members choose several senders, validates them and keeps the single-account field working', async () => {
    const { call, addUser, as, register, owner, a, b } = await setup();
    const legacy = await call('POST', '/api/campaigns', { name: 'Legacy', accountId: a });
    expect(legacy.body).toMatchObject({ accountId: a, accountIds: [a], account: { id: a, name: 'Seat A' } });

    const member = await addUser('member');
    as(member);
    const patched = await call('PATCH', `/api/campaigns/${legacy.body.id}`, { accountIds: [b, a] });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ accountIds: [b, a], accountId: b, accounts: [{ id: b }, { id: a }] });
    expect((await call('POST', `/api/campaigns/${legacy.body.id}/start`)).body.status).toBe('active');
    // Senders can change while running, but not to none.
    expect((await call('PATCH', `/api/campaigns/${legacy.body.id}`, { accountIds: [a] })).body.accountIds).toEqual([a]);
    expect((await call('PATCH', `/api/campaigns/${legacy.body.id}`, { accountIds: [] })).status).toBe(409);
    expect((await call('PATCH', `/api/campaigns/${legacy.body.id}`, { accountIds: Array.from({ length: 21 }, (_, i) => i + 1) })).status).toBe(400);

    const created = await call('POST', '/api/campaigns', { name: 'Multi', accountIds: [a, b] });
    expect(created.body.accountIds).toEqual([a, b]);
    const dup = await call('POST', `/api/campaigns/${created.body.id}/duplicate`, {});
    expect((await call('GET', `/api/campaigns/${dup.body.id}`)).body.accountIds).toEqual([a, b]);

    // Another workspace's account is not found, and neither is this campaign from there.
    await register('Other');
    const foreign = (await call('POST', '/api/accounts', { name: 'Theirs', driver: 'simulator' })).body.id;
    expect((await call('GET', `/api/campaigns/${created.body.id}`)).status).toBe(404);
    expect((await call('PATCH', `/api/campaigns/${created.body.id}`, { accountIds: [a] })).status).toBe(404);
    as(owner);
    expect((await call('PATCH', `/api/campaigns/${created.body.id}`, { accountIds: [a, foreign] })).status).toBe(404);
    expect((await call('POST', '/api/campaigns', { name: 'X', accountId: foreign })).status).toBe(404);
    expect((await call('GET', `/api/campaigns/${created.body.id}`)).body.accountIds).toEqual([a, b]);
  });

  it('shows each lead’s sender and per-sender results', async () => {
    const { w, call, a, b } = await setup();
    w.ctx.drivers.simOptions = { ...w.ctx.drivers.simOptions, acceptRate: 1, acceptHours: [1, 2], replyRate: 0 };
    const list = await call('POST', '/api/lists', { name: 'People' });
    const csv = 'LinkedIn URL\n' + Array.from({ length: 6 }, (_, i) => `https://www.linkedin.com/in/rot-${i}/`).join('\n');
    await call('POST', '/api/leads/import/csv', { listId: list.body.id, csv });
    const camp = await call('POST', '/api/campaigns', { name: 'Rotating', accountIds: [a, b], sequence: inviteThenMessage });
    await call('POST', `/api/campaigns/${camp.body.id}/leads`, { listId: list.body.id });
    await call('POST', `/api/campaigns/${camp.body.id}/start`);

    await runFor(w, 3 * DAY, 5 * 60_000);
    const leads = (await call('GET', `/api/campaigns/${camp.body.id}/leads`)).body.items;
    expect(leads).toHaveLength(6);
    for (const l of leads) expect([a, b]).toContain(l.sender.id);
    expect(new Set(leads.map((l: any) => l.sender.name))).toEqual(new Set(['Seat A', 'Seat B']));

    const stats = (await call('GET', `/api/campaigns/${camp.body.id}`)).body.stats;
    expect(stats.bySender.map((s: any) => s.accountId)).toEqual([a, b]);
    expect(stats.bySender.reduce((n: number, s: any) => n + s.invited, 0)).toBe(6);
    expect(stats.bySender.reduce((n: number, s: any) => n + s.leads, 0)).toBe(6);
    for (const s of stats.bySender) expect(s).toMatchObject({ acceptanceRate: 100, name: s.accountId === a ? 'Seat A' : 'Seat B' });
  });

  it('deleting one of two senders keeps the campaign running; a campaign left without senders pauses', async () => {
    const { w, call, a, b } = await setup();
    const list = await call('POST', '/api/lists', { name: 'People' });
    await call('POST', '/api/leads/import/csv', { listId: list.body.id, csv: 'LinkedIn URL\nhttps://www.linkedin.com/in/d-0/\nhttps://www.linkedin.com/in/d-1/\nhttps://www.linkedin.com/in/d-2/\n' });
    const multi = (await call('POST', '/api/campaigns', { name: 'Multi', accountIds: [a, b] })).body.id;
    const single = (await call('POST', '/api/campaigns', { name: 'Single', accountIds: [a] })).body.id;
    await call('POST', `/api/campaigns/${multi}/leads`, { listId: list.body.id });
    await call('POST', `/api/campaigns/${multi}/start`);
    await call('POST', `/api/campaigns/${single}/start`);
    const [cl1, cl2, cl3] = w.ctx.db.all<{ id: number }>('SELECT id FROM campaign_leads WHERE campaign_id = ? ORDER BY id', [multi]).map((r) => r.id);
    w.ctx.db.run('UPDATE campaign_leads SET account_id = ?, contacted_at = 1 WHERE id = ?', [a, cl1]);
    w.ctx.db.run('UPDATE campaign_leads SET account_id = ? WHERE id = ?', [a, cl2]);
    w.ctx.db.run('UPDATE campaign_leads SET account_id = ? WHERE id = ?', [b, cl3]);
    // One person is connected only through A, another through A and invited by B.
    const [onlyA, both] = w.ctx.db.all<{ id: number }>("SELECT id FROM leads WHERE public_id IN ('d-0', 'd-1') ORDER BY public_id").map((r) => r.id);
    setConnection(w.ctx, onlyA, a, 'connected');
    setConnection(w.ctx, both, a, 'connected');
    setConnection(w.ctx, both, b, 'pending');

    expect((await call('DELETE', `/api/accounts/${a}`)).status).toBe(200);
    // A's connections go with it, so B treats the first person as new and invites them itself.
    expect(w.ctx.db.all('SELECT lead_id, account_id, status FROM lead_connections ORDER BY lead_id')).toEqual([{ lead_id: both, account_id: b, status: 'pending' }]);
    const leadRow = (id: number) => w.ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id])!;
    expect(leadRow(onlyA).connection_status).toBe('none');
    expect(connectionWith(w.ctx, leadRow(onlyA), b)).toBe('none');
    expect(leadRow(both).connection_status).toBe('pending');
    expect((await call('GET', `/api/campaigns/${multi}`)).body).toMatchObject({ status: 'active', accountIds: [b], accountId: b });
    expect((await call('GET', `/api/campaigns/${single}`)).body).toMatchObject({ status: 'paused', accountIds: [], accountId: null });
    const rows = w.ctx.db.all<{ state: string; account_id: number | null; last_error: string | null }>('SELECT state, account_id, last_error FROM campaign_leads WHERE campaign_id = ? ORDER BY id', [multi]);
    expect(rows).toEqual([
      { state: 'skipped', account_id: null, last_error: 'Sender account was removed' },
      { state: 'active', account_id: null, last_error: null },
      { state: 'active', account_id: b, last_error: null },
    ]);
  });

  it('pausing a sender releases its unstarted leads', async () => {
    const { w, call, a, b } = await setup();
    const list = await call('POST', '/api/lists', { name: 'People' });
    await call('POST', '/api/leads/import/csv', { listId: list.body.id, csv: 'LinkedIn URL\nhttps://www.linkedin.com/in/p-0/\nhttps://www.linkedin.com/in/p-1/\n' });
    const camp = (await call('POST', '/api/campaigns', { name: 'Multi', accountIds: [a, b] })).body.id;
    await call('POST', `/api/campaigns/${camp}/leads`, { listId: list.body.id });
    w.ctx.db.run('UPDATE campaign_leads SET account_id = ? WHERE campaign_id = ?', [a, camp]);
    w.ctx.db.run('UPDATE campaign_leads SET contacted_at = 1 WHERE id = (SELECT MIN(id) FROM campaign_leads WHERE campaign_id = ?)', [camp]);
    await call('POST', `/api/accounts/${a}/pause`);
    expect(w.ctx.db.all('SELECT account_id FROM campaign_leads WHERE campaign_id = ? ORDER BY id', [camp])).toEqual([{ account_id: a }, { account_id: null }]);
  });
});

describe('rotation migration', () => {
  const probe = new DB(':memory:', { migrateTo: 2 });
  it.skipIf(probe.dialect !== 'sqlite')('moves single-account campaigns and contacted leads over', () => {
    const db = new DB(':memory:', { migrateTo: 2 });
    const ws = db.insert('workspaces', { name: 'W', created_at: 1 });
    const acc = db.insert('accounts', { workspace_id: ws, name: 'Seat', created_at: 1 });
    const camp = db.insert('campaigns', { workspace_id: ws, account_id: acc, name: 'C', status: 'active', sequence: '{}', created_at: 2 });
    db.insert('campaigns', { workspace_id: ws, account_id: null, name: 'No seat', sequence: '{}', created_at: 2 });
    const invited = db.insert('leads', { workspace_id: ws, public_id: 'a', profile_url: 'https://www.linkedin.com/in/a/', connection_status: 'pending', created_at: 1 });
    const fresh = db.insert('leads', { workspace_id: ws, public_id: 'b', profile_url: 'https://www.linkedin.com/in/b/', created_at: 1 });
    // Before per-account tracking, a profile view that saw a 1st-degree badge marked a lead connected.
    const viewed = db.insert('leads', { workspace_id: ws, public_id: 'c', profile_url: 'https://www.linkedin.com/in/c/', connection_status: 'connected', created_at: 1 });
    for (const l of [invited, fresh, viewed]) db.insert('campaign_leads', { campaign_id: camp, lead_id: l, node_entered_at: 1, next_run_at: 1, added_at: 1 });
    db.insert('activity', { workspace_id: ws, account_id: acc, campaign_id: camp, lead_id: invited, type: 'view_profile', day: '2026-01-01', created_at: 5 });
    db.insert('activity', { workspace_id: ws, account_id: acc, campaign_id: camp, lead_id: invited, type: 'connect', day: '2026-01-01', created_at: 7 });
    db.insert('activity', { workspace_id: ws, account_id: acc, campaign_id: camp, lead_id: viewed, type: 'view_profile', day: '2026-01-01', created_at: 6 });
    // A later view by another seat doesn't take the invite over from the account that sent it.
    const other = db.insert('accounts', { workspace_id: ws, name: 'Other seat', created_at: 1 });
    db.insert('activity', { workspace_id: ws, account_id: other, lead_id: invited, type: 'view_profile', day: '2026-01-02', created_at: 9 });

    db.migrate();

    expect(db.all('SELECT campaign_id, account_id FROM campaign_accounts')).toEqual([{ campaign_id: camp, account_id: acc }]);
    expect(db.all('SELECT lead_id, account_id, contacted_at FROM campaign_leads ORDER BY lead_id')).toEqual([
      { lead_id: invited, account_id: acc, contacted_at: 7 },
      { lead_id: fresh, account_id: null, contacted_at: null },
      { lead_id: viewed, account_id: acc, contacted_at: null },
    ]);
    expect(db.all('SELECT lead_id, account_id, status FROM lead_connections ORDER BY lead_id')).toEqual([
      { lead_id: invited, account_id: acc, status: 'pending' },
      { lead_id: viewed, account_id: acc, status: 'connected' },
    ]);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  });
});
