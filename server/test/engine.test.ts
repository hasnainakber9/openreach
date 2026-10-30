import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '../src/clock.js';
import { DriverError, type LinkedInDriver } from '../src/drivers/types.js';
import { localParts } from '../src/engine/limits.js';
import { defaultSequence, type Sequence } from '../src/engine/sequence.js';
import { addLeads, counts, makeCampaign, makeWorld, runFor, states } from './helpers.js';

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

describe('campaign engine', () => {
  it('runs the default sequence end to end when everyone accepts', async () => {
    const w = makeWorld({ acceptRate: 1, replyRate: 0, acceptHours: [1, 4] });
    const leads = addLeads(w, 5);
    const { id, added } = makeCampaign(w, defaultSequence(), {}, leads);
    expect(added.added).toBe(5);

    await runFor(w, 12 * DAY, 5 * 60_000);

    expect(states(w, id)).toEqual({ done: 5 });
    const c = counts(w, id);
    expect(c['view_profile:ok']).toBe(5);
    expect(c['connect:ok']).toBe(5);
    expect(c['accepted:ok']).toBe(5);
    expect(c['message:ok']).toBe(10);
    expect(c['withdraw_invite:ok']).toBeUndefined();

    // Messages were rendered with lead data and landed in the inbox.
    const msgs = w.ctx.db.all<{ body: string }>("SELECT body FROM messages WHERE direction = 'out'");
    expect(msgs).toHaveLength(10);
    expect(msgs.some((m) => /Thanks for connecting, First\d!/.test(m.body))).toBe(true);
  });

  it('takes the "not accepted" branch after the deadline and withdraws the invite', async () => {
    const w = makeWorld({ acceptRate: 0 });
    const { id } = makeCampaign(w, defaultSequence(), {}, addLeads(w, 3));
    await runFor(w, 12 * DAY, 10 * 60_000);
    expect(states(w, id)).toEqual({ done: 3 });
    const c = counts(w, id);
    expect(c['withdraw_invite:ok']).toBe(3);
    expect(c['message:ok']).toBeUndefined();
  });

  it('never exceeds the daily connection limit', async () => {
    const w = makeWorld({ acceptRate: 0 }, { limits: JSON.stringify({ connect: 4 }), delay_min_sec: 30, delay_max_sec: 60 });
    const { id } = makeCampaign(w, inviteThenMessage, {}, addLeads(w, 30));
    await runFor(w, 3 * DAY, 2 * 60_000);
    const perDay = w.ctx.db.all<{ day: string; n: number }>("SELECT day, COUNT(*) AS n FROM activity WHERE campaign_id = ? AND type = 'connect' AND status = 'ok' GROUP BY day", [id]);
    expect(perDay.length).toBe(3);
    for (const d of perDay) expect(d.n).toBe(4);
  });

  it('only acts during working hours', async () => {
    const w = makeWorld({ acceptRate: 0.5 }, { work_start: '10:00', work_end: '12:00', work_days: '[1,2,3,4,5]' });
    makeCampaign(w, defaultSequence(), {}, addLeads(w, 40));
    await runFor(w, 7 * DAY, 5 * 60_000);
    const acts = w.ctx.db.all<{ created_at: number; type: string }>("SELECT created_at, type FROM activity WHERE type NOT IN ('accepted', 'replied')");
    expect(acts.length).toBeGreaterThan(20);
    for (const a of acts) {
      const p = localParts(a.created_at, 'UTC');
      expect(p.weekday).toBeGreaterThanOrEqual(1);
      expect(p.weekday).toBeLessThanOrEqual(5);
      expect(p.minutes).toBeGreaterThanOrEqual(600);
      expect(p.minutes).toBeLessThan(720);
    }
  });

  it('spaces actions by the account delay', async () => {
    const w = makeWorld({ acceptRate: 0 }, { delay_min_sec: 300, delay_max_sec: 600 });
    makeCampaign(w, { start: 'v', nodes: { v: { id: 'v', type: 'view_profile', next: null } } }, {}, addLeads(w, 20));
    await runFor(w, 4 * HOUR, 60_000);
    const times = w.ctx.db.all<{ created_at: number }>("SELECT created_at FROM activity WHERE type = 'view_profile' ORDER BY created_at").map((r) => r.created_at);
    expect(times.length).toBeGreaterThan(5);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(300_000);
  });

  it('stops the sequence when the lead replies', async () => {
    const w = makeWorld({ acceptRate: 1, replyRate: 1, acceptHours: [1, 2], replyHours: [1, 2] });
    const { id } = makeCampaign(w, inviteThenMessage, { stopOnReply: true }, addLeads(w, 4));
    await runFor(w, 8 * DAY, 5 * 60_000);
    expect(states(w, id)).toEqual({ replied: 4 });
    const c = counts(w, id);
    expect(c['message:ok']).toBe(4); // the follow-up never went out
    expect(c['replied:ok']).toBe(4);
    const inbound = w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in'")!;
    expect(inbound.n).toBe(4);
    expect(w.ctx.webhooks.sent.filter((s) => s.event === 'lead.replied')).toHaveLength(0); // no hooks registered
  });

  it('keeps going after a reply when stop-on-reply is off', async () => {
    const w = makeWorld({ acceptRate: 1, replyRate: 1, acceptHours: [1, 2], replyHours: [1, 2] });
    const { id } = makeCampaign(w, inviteThenMessage, { stopOnReply: false }, addLeads(w, 2));
    await runFor(w, 8 * DAY, 5 * 60_000);
    expect(states(w, id)).toEqual({ done: 2 });
    expect(counts(w, id)['message:ok']).toBe(4);
  });

  it('skips blacklisted leads and leads busy in another campaign', async () => {
    const w = makeWorld();
    const leads = addLeads(w, 4);
    w.ctx.db.insert('blacklist', { workspace_id: w.workspaceId, kind: 'profile', value: 'https://www.linkedin.com/in/lead-0/', created_at: 0 });
    const first = makeCampaign(w, inviteThenMessage, {}, leads.slice(0, 2));
    expect(first.added).toMatchObject({ added: 1, blacklisted: 1 });
    const second = makeCampaign(w, inviteThenMessage, { skipIfInOtherCampaign: true }, leads);
    expect(second.added).toMatchObject({ added: 2, inOtherCampaign: 1, blacklisted: 1 });

    // Blacklisting after the lead was added still stops the next action.
    w.ctx.db.insert('blacklist', { workspace_id: w.workspaceId, kind: 'company', value: 'acme', created_at: 0 });
    await runFor(w, 2 * HOUR);
    expect(states(w, second.id)).toEqual({ skipped: 2 });
  });

  it('pauses the account when the LinkedIn session expires', async () => {
    const w = makeWorld();
    w.ctx.drivers.factory = () =>
      new Proxy({} as LinkedInDriver, {
        get: () => async () => {
          throw new DriverError('SESSION_EXPIRED', 'cookie expired');
        },
      });
    const { id } = makeCampaign(w, inviteThenMessage, {}, addLeads(w, 2));
    await runFor(w, 2 * HOUR);
    expect(w.account().status).toBe('needs_login');
    expect(states(w, id)).toEqual({ active: 2 });
  });

  it('backs off for a day when LinkedIn refuses invitations', async () => {
    const w = makeWorld();
    let calls = 0;
    w.ctx.drivers.factory = () =>
      ({
        recentConnections: async () => [],
        inbox: async () => [],
        connect: async () => {
          calls++;
          throw new DriverError('LIMIT_REACHED', 'weekly limit');
        },
        close: async () => {},
      }) as unknown as LinkedInDriver;
    const { id } = makeCampaign(w, inviteThenMessage, {}, addLeads(w, 3));
    await runFor(w, 8 * HOUR);
    expect(calls).toBe(1);
    expect(states(w, id)).toEqual({ active: 3 });
    expect(JSON.parse(w.account().cooldowns).connect).toBeGreaterThan(w.ctx.clock.now());
  });

  it('retries transient failures, then gives up on the lead', async () => {
    const w = makeWorld();
    w.ctx.drivers.factory = () =>
      ({
        recentConnections: async () => [],
        inbox: async () => [],
        follow: async () => {
          throw new DriverError('TRANSIENT', 'timeout');
        },
        close: async () => {},
      }) as unknown as LinkedInDriver;
    const { id } = makeCampaign(w, { start: 'f', nodes: { f: { id: 'f', type: 'follow', next: null } } }, {}, addLeads(w, 1));
    await runFor(w, 6 * HOUR);
    expect(states(w, id)).toEqual({ failed: 1 });
    expect(counts(w, id)['follow:failed']).toBe(3);
  });

  it('branches on email availability and sends email without SMTP as a dry run', async () => {
    const w = makeWorld({ acceptRate: 0 });
    const leads = addLeads(w, 2);
    w.ctx.db.run('UPDATE leads SET email = ? WHERE id = ?', ['a@example.com', leads[0]]);
    const { id } = makeCampaign(
      w,
      {
        start: 'q',
        nodes: {
          q: { id: 'q', type: 'condition', kind: 'has_email', withinDays: 7, yes: 'e', no: 'f' },
          e: { id: 'e', type: 'email', subject: 'Hi {{firstName}}', body: 'Hello', next: null },
          f: { id: 'f', type: 'follow', next: null },
        },
      },
      {},
      leads,
    );
    await runFor(w, 2 * HOUR);
    const c = counts(w, id);
    expect(c['email:ok']).toBe(1);
    expect(c['follow:ok']).toBe(1);
    expect(w.ctx.db.get<{ detail: string }>("SELECT detail FROM activity WHERE type = 'email'")!.detail).toMatch(/not delivered/);
  });
});
