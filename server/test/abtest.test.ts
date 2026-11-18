import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '../src/clock.js';
import { DB } from '../src/db/db.js';
import { logActivity } from '../src/services/activity.js';
import { setConnection } from '../src/services/rotation.js';
import { SequenceSchema, validateSequence, type Sequence, type VariantNode } from '../src/engine/sequence.js';
import { assignVariant, bestVariant, maybePickWinner, nodeStats, setWinner, variantIndex, variantStats, winnerOf, zScore, type VariantRow } from '../src/engine/variants.js';
import type { CampaignLeadRow, CampaignRow } from '../src/types.js';
import { addLeads, makeApi, makeCampaign, makeWorld, runFor, type World } from './helpers.js';

const abInvite = (autoPickAfter: number | null = null): Sequence => ({
  start: 'c',
  nodes: {
    c: {
      id: 'c',
      type: 'connect',
      note: 'Hi {{firstName}}, A here',
      variants: [
        { id: 'A', note: 'Hi {{firstName}}, A here' },
        { id: 'B', note: 'Hello {{firstName}}, B here' },
      ],
      abtest: { autoPickAfter, metric: 'accepted' },
      next: 'w',
    },
    w: { id: 'w', type: 'wait', days: 30, hours: 0, next: null },
  },
});

const campaignRow = (w: World, id: number) => w.ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [id])!;
const campaignLeads = (w: World, id: number) => w.ctx.db.all<CampaignLeadRow>('SELECT * FROM campaign_leads WHERE campaign_id = ? ORDER BY id', [id]);
const nodeOf = (seq: Sequence, id: string) => SequenceSchema.parse(seq).nodes[id] as VariantNode;
// Records an ok invite from the world's account, as the engine would.
const sent = (w: World, campaignId: number, leadId: number, variant: string, nodeId = 'c') =>
  logActivity(w.ctx, { workspaceId: w.workspaceId, accountId: w.accountId, campaignId, leadId, type: 'connect', nodeId, variant });

describe('A/B variant assignment', () => {
  it('gives the same lead the same variant every time and splits leads evenly', () => {
    expect(variantIndex(7, 'n3', 42, 2)).toBe(variantIndex(7, 'n3', 42, 2));
    const counts = [0, 0];
    for (let lead = 1; lead <= 200; lead++) counts[variantIndex(7, 'n3', lead, 2)]++;
    expect(counts[0]).toBeGreaterThanOrEqual(60);
    expect(counts[1]).toBeGreaterThanOrEqual(60);
    // Another step of the same campaign splits independently.
    const same = Array.from({ length: 200 }, (_, i) => variantIndex(7, 'n3', i, 2) === variantIndex(7, 'n4', i, 2)).filter(Boolean).length;
    expect(same).toBeLessThan(140);

    const w = makeWorld();
    const leads = addLeads(w, 10);
    const { id } = makeCampaign(w, abInvite(), {}, leads);
    const c = campaignRow(w, id);
    const node = nodeOf(abInvite(), 'c');
    const first = campaignLeads(w, id).map((cl) => assignVariant(w.ctx, c, cl, node));
    const again = campaignLeads(w, id).map((cl) => assignVariant(w.ctx, c, cl, node));
    expect(again).toEqual(first);
    expect(new Set(first)).toEqual(new Set(['A', 'B']));
    expect(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM campaign_lead_variants')!.n).toBe(10);
  });

  it('reassigns a lead whose variant was removed, and plain steps get no variant', () => {
    const w = makeWorld();
    const leads = addLeads(w, 30);
    const seq = abInvite();
    const { id } = makeCampaign(w, seq, {}, leads);
    const c = campaignRow(w, id);
    const cls = campaignLeads(w, id);
    const before = cls.map((cl) => assignVariant(w.ctx, c, cl, nodeOf(seq, 'c')));
    expect(before).toContain('B');

    // B is replaced by C: B's leads move to A or C; A's leads keep A.
    const edited = nodeOf(seq, 'c');
    edited.variants = [
      { id: 'A', note: 'A' },
      { id: 'C', note: 'C' },
    ] as any;
    const after = cls.map((cl) => assignVariant(w.ctx, c, cl, edited));
    after.forEach((v, i) => {
      expect(v).not.toBe('B');
      if (before[i] === 'A') expect(v).toBe('A');
    });

    const plain = { ...nodeOf(seq, 'c'), variants: undefined };
    expect(assignVariant(w.ctx, c, cls[0], plain)).toBeNull();
  });
});

describe('A/B stats', () => {
  const rows = (variant: string, n: number, hits: number, metric: 'accepted' | 'replied' = 'replied'): VariantRow[] =>
    Array.from({ length: n }, (_, i) => ({ variant, accepted: metric === 'accepted' && i < hits ? 1 : 0, replied: metric === 'replied' && i < hits ? 1 : 0 }));

  it('computes sends, rates and a significant leader', () => {
    const stats = variantStats([...rows('A', 100, 30), ...rows('B', 100, 10)], 'replied', ['A', 'B']);
    expect(stats).toEqual([
      { id: 'A', sent: 100, accepted: 0, replied: 30, rate: 30, leader: true, significant: true },
      { id: 'B', sent: 100, accepted: 0, replied: 10, rate: 10, leader: false, significant: false },
    ]);
    expect(zScore(30, 100, 10, 100)).toBeCloseTo(3.536, 2);
    expect(bestVariant(stats, 'replied')).toBe('A');
  });

  it('uses the step metric and needs 20 sends per variant before calling it', () => {
    const stats = variantStats([...rows('A', 19, 2, 'accepted'), ...rows('B', 30, 20, 'accepted')], 'accepted', ['A', 'B']);
    expect(stats[1]).toMatchObject({ id: 'B', accepted: 20, rate: 66.7, leader: true, significant: false });
    // Close rates with plenty of sends are not significant either.
    const close = variantStats([...rows('A', 200, 50), ...rows('B', 200, 45)], 'replied');
    expect(close.find((s) => s.leader)).toMatchObject({ id: 'A', significant: false });
  });

  it('handles zero sends and ties', () => {
    const empty = variantStats([], 'replied', ['A', 'B', 'C']);
    expect(empty.map((s) => [s.sent, s.rate, s.leader])).toEqual([
      [0, 0, false],
      [0, 0, false],
      [0, 0, false],
    ]);
    expect(bestVariant(empty, 'replied')).toBeNull();
    expect(zScore(0, 0, 5, 10)).toBe(0);
    expect(zScore(0, 50, 0, 50)).toBe(0);

    const tie = variantStats([...rows('A', 40, 10), ...rows('B', 40, 10), ...rows('C', 10, 0)], 'replied', ['A', 'B', 'C']);
    expect(tie.some((s) => s.leader)).toBe(false);
    // Auto-pick needs a real leader: no pick on a tie, at 0% all round, or while a variant is unsent.
    expect(bestVariant(tie, 'replied')).toBeNull();
    expect(bestVariant(variantStats([...rows('A', 30, 0), ...rows('B', 30, 0)], 'replied'), 'replied')).toBeNull();
    expect(bestVariant(variantStats(rows('B', 3, 1), 'replied', ['A', 'B']), 'replied')).toBeNull();
    expect(bestVariant(variantStats([...rows('A', 10, 0), ...rows('B', 10, 1)], 'replied'), 'replied')).toBe('B');
    // The metric decides what counts as a result.
    expect(bestVariant(variantStats([...rows('A', 10, 0), ...rows('B', 10, 1)], 'replied'), 'accepted')).toBeNull();
  });

  it('counts acceptances on the sending account after the send, and replies after the send', () => {
    const w = makeWorld();
    const leads = addLeads(w, 4);
    const { id } = makeCampaign(w, abInvite(), {}, leads);
    const node = nodeOf(abInvite(), 'c');
    // A connection made before the invite doesn't count as an acceptance.
    setConnection(w.ctx, leads[3], w.accountId, 'connected');
    w.ctx.clock.advance(HOUR);
    sent(w, id, leads[0], 'A');
    sent(w, id, leads[1], 'A');
    sent(w, id, leads[2], 'B');
    sent(w, id, leads[3], 'B');
    // A retry logged twice still counts as one send.
    sent(w, id, leads[0], 'A');
    w.ctx.clock.advance(DAY);
    setConnection(w.ctx, leads[0], w.accountId, 'connected');
    setConnection(w.ctx, leads[2], w.accountId, 'connected');
    logActivity(w.ctx, { workspaceId: w.workspaceId, accountId: w.accountId, campaignId: id, leadId: leads[2], type: 'replied' });

    expect(nodeStats(w.ctx, id, node)).toEqual([
      { id: 'A', sent: 2, accepted: 1, replied: 0, rate: 50, leader: false, significant: false },
      { id: 'B', sent: 2, accepted: 1, replied: 1, rate: 50, leader: false, significant: false },
    ]);
  });
});

describe('automatic winner', () => {
  it('routes later leads to the best variant once N sends are in, while earlier leads keep theirs', () => {
    const w = makeWorld();
    const leads = addLeads(w, 30);
    const seq = abInvite(20);
    const { id } = makeCampaign(w, seq, {}, leads);
    const c = campaignRow(w, id);
    const node = nodeOf(seq, 'c');
    const cls = campaignLeads(w, id);

    // 20 leads get their split; B's invites are accepted, A's aren't.
    const early = cls.slice(0, 20).map((cl) => ({ cl, v: assignVariant(w.ctx, c, cl, node)! }));
    expect(winnerOf(w.ctx, id, 'c')).toBeUndefined();
    for (const { cl, v } of early) sent(w, id, cl.lead_id, v);
    w.ctx.clock.advance(DAY);
    for (const { cl, v } of early) if (v === 'B') setConnection(w.ctx, cl.lead_id, w.accountId, 'connected');

    const later = cls.slice(20).map((cl) => assignVariant(w.ctx, c, cl, node));
    expect(later.every((v) => v === 'B')).toBe(true);
    expect(winnerOf(w.ctx, id, 'c')).toMatchObject({ variant: 'B', decided_by: 'auto' });
    expect(w.ctx.db.get<{ detail: string; variant: string }>("SELECT detail, variant FROM activity WHERE type = 'ab_winner'")).toEqual({
      detail: 'Node c: variant B (picked automatically)',
      variant: 'B',
    });
    // Earlier leads keep what they were given; picking again changes nothing.
    expect(early.map(({ cl }) => assignVariant(w.ctx, c, cl, node))).toEqual(early.map((e) => e.v));
    expect(maybePickWinner(w.ctx, c, node)).toBeNull();
  });

  it('picks nothing while no variant has a result, then picks once one pulls ahead', () => {
    const w = makeWorld();
    const leads = addLeads(w, 40);
    const seq = abInvite(20);
    const { id } = makeCampaign(w, seq, {}, leads);
    const c = campaignRow(w, id);
    const node = nodeOf(seq, 'c');
    const cls = campaignLeads(w, id);

    // 20 invites out, none accepted yet: leads keep splitting by hash.
    const early = cls.slice(0, 20).map((cl) => ({ cl, v: assignVariant(w.ctx, c, cl, node)! }));
    for (const { cl, v } of early) sent(w, id, cl.lead_id, v);
    const mid = cls.slice(20, 30).map((cl) => assignVariant(w.ctx, c, cl, node));
    expect(winnerOf(w.ctx, id, 'c')).toBeUndefined();
    expect(mid).toEqual(cls.slice(20, 30).map((cl) => (['A', 'B'] as const)[variantIndex(id, 'c', cl.lead_id, 2)]));

    // One of A's invites is accepted: A is now ahead and wins.
    w.ctx.clock.advance(DAY);
    setConnection(w.ctx, early.find((e) => e.v === 'A')!.cl.lead_id, w.accountId, 'connected');
    expect(assignVariant(w.ctx, c, cls[30], node)).toBe('A');
    expect(winnerOf(w.ctx, id, 'c')).toMatchObject({ variant: 'A', decided_by: 'auto' });
  });

  it("keeps a user's split again even though auto-pick's threshold was reached", () => {
    const w = makeWorld();
    const leads = addLeads(w, 30);
    const seq = abInvite(20);
    const { id } = makeCampaign(w, seq, {}, leads);
    const c = campaignRow(w, id);
    const node = nodeOf(seq, 'c');
    const cls = campaignLeads(w, id);
    const early = cls.slice(0, 20).map((cl) => ({ cl, v: assignVariant(w.ctx, c, cl, node)! }));
    for (const { cl, v } of early) sent(w, id, cl.lead_id, v);
    w.ctx.clock.advance(DAY);
    for (const { cl, v } of early) if (v === 'B') setConnection(w.ctx, cl.lead_id, w.accountId, 'connected');
    expect(assignVariant(w.ctx, c, cls[20], node)).toBe('B');
    expect(winnerOf(w.ctx, id, 'c')).toMatchObject({ variant: 'B', decided_by: 'auto' });

    setWinner(w.ctx, c, 'c', null, 'user', 'Owner');
    const later = cls.slice(21).map((cl) => assignVariant(w.ctx, c, cl, node));
    expect(later).toEqual(cls.slice(21).map((cl) => (['A', 'B'] as const)[variantIndex(id, 'c', cl.lead_id, 2)]));
    expect(winnerOf(w.ctx, id, 'c')).toMatchObject({ variant: null, decided_by: 'user' });
    expect(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE type = 'ab_winner'")!.n).toBe(1);
  });

  it('runs end to end: sends each variant, logs it, then sends only the winner', async () => {
    // 20 invites a day, accepted within hours: day 1 splits, day 2 starts with the results in.
    const w = makeWorld({ acceptRate: 0.5, acceptHours: [1, 2] }, { limits: JSON.stringify({ connect: 20 }) });
    const leads = addLeads(w, 60);
    const { id } = makeCampaign(w, abInvite(20), {}, leads);

    await runFor(w, 3 * DAY);
    const acts = w.ctx.db.all<{ id: number; type: string; variant: string | null; node_id: string; detail: string; lead_id: number }>(
      "SELECT id, type, variant, node_id, detail, lead_id FROM activity WHERE campaign_id = ? AND type IN ('connect', 'ab_winner') ORDER BY id",
      [id],
    );
    const invites = acts.filter((a) => a.type === 'connect');
    expect(invites).toHaveLength(60);
    // The note sent is the variant's text, and it is logged with the step and variant.
    for (const a of invites) {
      expect(a.node_id).toBe('c');
      expect(a.detail).toBe(a.variant === 'A' ? `Hi First${leads.indexOf(a.lead_id)}, A here` : `Hello First${leads.indexOf(a.lead_id)}, B here`);
    }
    const winAt = acts.findIndex((a) => a.type === 'ab_winner');
    expect(winAt).toBe(20);
    const winner = acts[winAt].variant;
    expect(new Set(acts.slice(0, winAt).map((a) => a.variant))).toEqual(new Set(['A', 'B']));
    expect(acts.slice(winAt + 1).every((a) => a.variant === winner)).toBe(true);
    // The assignment table agrees with what was sent.
    const assigned = Object.fromEntries(
      w.ctx.db.all<{ lead_id: number; variant: string }>('SELECT cl.lead_id, v.variant FROM campaign_lead_variants v JOIN campaign_leads cl ON cl.id = v.campaign_lead_id').map((r) => [r.lead_id, r.variant]),
    );
    for (const a of invites) expect(assigned[a.lead_id]).toBe(a.variant);
  });
});

describe('backward compatibility', () => {
  const legacy: Sequence = {
    start: 'c',
    nodes: {
      c: { id: 'c', type: 'connect', note: 'Hi {{firstName}}', next: 'm' },
      m: { id: 'm', type: 'message', text: 'Thanks', next: null },
    },
  };

  it('runs sequences without variants and logs no variant', async () => {
    expect(validateSequence(SequenceSchema.parse(legacy))).toEqual([]);
    const w = makeWorld({ acceptRate: 0 });
    const leads = addLeads(w, 3);
    const { id } = makeCampaign(w, legacy, {}, leads);
    await runFor(w, 6 * HOUR);
    const rows = w.ctx.db.all<{ node_id: string; variant: string | null; detail: string }>("SELECT node_id, variant, detail FROM activity WHERE campaign_id = ? AND type = 'connect'", [id]);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.node_id === 'c' && r.variant === null && r.detail.startsWith('Hi First'))).toBe(true);
    expect(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM campaign_lead_variants')!.n).toBe(0);
  });

  it('rejects 1 or 6 variants, duplicate letters and an acceptance metric on messages', () => {
    const msg = (variants: unknown, abtest?: unknown) => SequenceSchema.safeParse({ start: 'm', nodes: { m: { id: 'm', type: 'message', text: 'Hi', variants, abtest, next: null } } });
    const v = (ids: string[]) => ids.map((id) => ({ id, text: `Text ${id}` }));
    expect(msg(v(['A'])).success).toBe(false);
    expect(msg(v(['A', 'B', 'C', 'D', 'E', 'A'])).success).toBe(false);
    expect(msg(v(['A', 'A'])).success).toBe(false);
    expect(msg(v(['A', 'F'])).success).toBe(false);
    expect(msg([{ id: 'A', text: 'x' }, { id: 'B', text: '' }]).success).toBe(false);
    expect(msg(v(['A', 'B', 'C', 'D', 'E'])).success).toBe(true);
    expect(msg(v(['A', 'B']), { autoPickAfter: 5 }).success).toBe(false);
    const parsed = msg(v(['A', 'B']), { autoPickAfter: 50, metric: 'accepted' });
    expect(parsed.success).toBe(true);
    expect(validateSequence(parsed.data!)).toEqual(['Step "m" can only be judged on replies: acceptance applies to invitations']);
  });
});

describe('migration M3', () => {
  const db0 = new DB(':memory:', { migrateTo: 3 });
  it.skipIf(db0.dialect !== 'sqlite')('keeps old activity rows with no step or variant and cascades assignments', () => {
    const db = new DB(':memory:', { migrateTo: 3 });
    const ws = db.insert('workspaces', { name: 'W', created_at: 1 });
    const old = db.insert('activity', { workspace_id: ws, type: 'connect', day: '2026-01-05', created_at: 1 });
    db.migrate();
    expect(db.get('SELECT node_id, variant FROM activity WHERE id = ?', [old])).toEqual({ node_id: null, variant: null });

    const camp = db.insert('campaigns', { workspace_id: ws, name: 'C', sequence: '{}', created_at: 1 });
    const lead = db.insert('leads', { workspace_id: ws, public_id: 'jane', profile_url: 'https://www.linkedin.com/in/jane/', created_at: 1 });
    const cl = db.insert('campaign_leads', { campaign_id: camp, lead_id: lead, node_entered_at: 1, next_run_at: 1, added_at: 1 });
    db.run('INSERT INTO campaign_lead_variants (campaign_lead_id, node_id, variant, assigned_at) VALUES (?, ?, ?, ?)', [cl, 'c', 'A', 1]);
    db.run('INSERT INTO campaign_node_winners (campaign_id, node_id, variant, decided_by, decided_at) VALUES (?, ?, ?, ?, ?)', [camp, 'c', 'A', 'user', 1]);
    db.run('DELETE FROM campaigns WHERE id = ?', [camp]);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM campaign_lead_variants')!.n).toBe(0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM campaign_node_winners')!.n).toBe(0);
  });

  it.skipIf(db0.dialect !== 'sqlite')('M3b keeps existing winners and allows a NULL "split again" row', () => {
    const db = new DB(':memory:', { migrateTo: 4 });
    const ws = db.insert('workspaces', { name: 'W', created_at: 1 });
    const camp = db.insert('campaigns', { workspace_id: ws, name: 'C', sequence: '{}', created_at: 1 });
    db.run('INSERT INTO campaign_node_winners (campaign_id, node_id, variant, decided_by, decided_at) VALUES (?, ?, ?, ?, ?)', [camp, 'c', 'B', 'auto', 5]);
    db.migrate();
    expect(db.get('SELECT variant, decided_by, decided_at FROM campaign_node_winners')).toEqual({ variant: 'B', decided_by: 'auto', decided_at: 5 });
    db.run('INSERT INTO campaign_node_winners (campaign_id, node_id, variant, decided_by, decided_at) VALUES (?, ?, NULL, ?, ?)', [camp, 'd', 'user', 6]);
    db.run('INSERT INTO campaign_variant_starts (campaign_id, node_id, variant, started_at) VALUES (?, ?, ?, ?)', [camp, 'c', 'B', 7]);
    db.run('DELETE FROM campaigns WHERE id = ?', [camp]);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM campaign_node_winners')!.n).toBe(0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM campaign_variant_starts')!.n).toBe(0);
  });
});

describe('A/B API', () => {
  it('reports per-variant results and lets writers pick or clear a winner', async () => {
    const { call, register, addUser, as } = await makeApi();
    const owner = await register();
    const seq = abInvite();
    (seq.nodes.c as any).variants.push({ id: 'C', note: 'Hey {{firstName}}' });
    const created = await call('POST', '/api/campaigns', { name: 'AB', sequence: seq });
    expect(created.status).toBe(200);
    const cid = created.body.id;

    const report = await call('GET', `/api/campaigns/${cid}/variants`);
    expect(report.body).toEqual({
      nodes: [
        {
          nodeId: 'c',
          nodeType: 'connect',
          metric: 'accepted',
          autoPickAfter: null,
          winner: null,
          decidedBy: null,
          decidedAt: null,
          variants: ['A', 'B', 'C'].map((id) => ({ id, sent: 0, accepted: 0, replied: 0, rate: 0, leader: false, significant: false })),
        },
      ],
    });

    const member = await addUser('member');
    as(member);
    const picked = await call('POST', `/api/campaigns/${cid}/nodes/c/winner`, { variant: 'C' });
    expect(picked.status).toBe(200);
    expect(picked.body.nodes[0]).toMatchObject({ winner: 'C', decidedBy: 'user' });
    expect((await call('POST', `/api/campaigns/${cid}/nodes/c/winner`, { variant: 'D' })).status).toBe(400);
    expect((await call('POST', `/api/campaigns/${cid}/nodes/w/winner`, { variant: 'A' })).status).toBe(404);
    expect((await call('POST', `/api/campaigns/${cid}/nodes/c/winner`, { variant: 'Z' })).status).toBe(400);
    const cleared = await call('POST', `/api/campaigns/${cid}/nodes/c/winner`, { variant: null });
    expect(cleared.body.nodes[0]).toMatchObject({ winner: null, decidedBy: 'user' });

    // Saving the sequence keeps a winner (it isn't stored in the sequence).
    as(owner);
    await call('POST', `/api/campaigns/${cid}/nodes/c/winner`, { variant: 'B' });
    await call('PATCH', `/api/campaigns/${cid}`, { sequence: seq });
    expect((await call('GET', `/api/campaigns/${cid}/variants`)).body.nodes[0].winner).toBe('B');

    // Other workspaces see nothing.
    await register('Other');
    expect((await call('GET', `/api/campaigns/${cid}/variants`)).status).toBe(404);
    expect((await call('POST', `/api/campaigns/${cid}/nodes/c/winner`, { variant: 'A' })).status).toBe(404);
  });

  it('drops a removed or edited winner and starts a reused or edited letter from zero', async () => {
    const w = makeWorld();
    const { call, register } = await makeApi(w);
    await register();
    const leads = addLeads(w, 3);
    const seq = (b: string | null, c = 'Hey {{firstName}}', autoPickAfter: number | null = null): Sequence => {
      const s = abInvite(autoPickAfter);
      const n = s.nodes.c as any;
      n.variants = [{ id: 'A', note: 'Hi {{firstName}}, A here' }, ...(b ? [{ id: 'B', note: b }] : []), { id: 'C', note: c }];
      return s;
    };
    const cid = (await call('POST', '/api/campaigns', { name: 'AB', sequence: seq('Old B') })).body.id;
    const report = async () => (await call('GET', `/api/campaigns/${cid}/variants`)).body.nodes[0];
    const sentBy = (r: any, v: string) => r.variants.find((x: any) => x.id === v)?.sent;
    sent(w, cid, leads[0], 'A');
    sent(w, cid, leads[1], 'B');
    sent(w, cid, leads[2], 'C');
    w.ctx.clock.advance(HOUR);
    await call('POST', `/api/campaigns/${cid}/nodes/c/winner`, { variant: 'B' });

    // B removed, then a new B added: it is not the winner and has none of the old B's sends.
    await call('PATCH', `/api/campaigns/${cid}`, { sequence: seq(null) });
    expect(await report()).toMatchObject({ winner: null, decidedBy: null });
    expect(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM campaign_node_winners')!.n).toBe(0);
    await call('PATCH', `/api/campaigns/${cid}`, { sequence: seq('New B') });
    let r = await report();
    expect(r.winner).toBeNull();
    expect([sentBy(r, 'A'), sentBy(r, 'B'), sentBy(r, 'C')]).toEqual([1, 0, 1]);

    // Removing B and adding it back in one save looks like an edit: same outcome.
    await call('POST', `/api/campaigns/${cid}/nodes/c/winner`, { variant: 'C' });
    await call('PATCH', `/api/campaigns/${cid}`, { sequence: seq('New B', 'Edited C') });
    r = await report();
    expect(r.winner).toBeNull();
    expect([sentBy(r, 'A'), sentBy(r, 'C')]).toEqual([1, 0]);

    // A user's "split again" survives saves until the auto-pick setting changes.
    await call('PATCH', `/api/campaigns/${cid}`, { sequence: seq('New B', 'Edited C', 20) });
    await call('POST', `/api/campaigns/${cid}/nodes/c/winner`, { variant: null });
    expect(await report()).toMatchObject({ winner: null, decidedBy: 'user' });
    await call('PATCH', `/api/campaigns/${cid}`, { sequence: seq('New B', 'Edited C', 20) });
    expect(await report()).toMatchObject({ winner: null, decidedBy: 'user' });
    await call('PATCH', `/api/campaigns/${cid}`, { sequence: seq('New B', 'Edited C', 50) });
    expect(await report()).toMatchObject({ winner: null, decidedBy: null });
  });
});
