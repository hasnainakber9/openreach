import { describe, expect, it } from 'vitest';
import { DAY } from '../src/clock.js';
import { buildApp } from '../src/app.js';
import { Engine } from '../src/engine/engine.js';
import { csvToLeads } from '../src/routes/leads.js';
import { makeWorld, runFor } from './helpers.js';

async function setup() {
  const w = makeWorld({ acceptRate: 1, replyRate: 1, acceptHours: [1, 3], replyHours: [1, 3] });
  // makeWorld seeds a workspace directly; the API test registers its own through HTTP.
  w.ctx.db.run('DELETE FROM workspaces');
  const app = await buildApp(w.ctx);
  let cookie = '';
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as any, url, payload: payload as any, headers: cookie ? { cookie } : {} });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set[0] : set).split(';')[0];
    return { status: res.statusCode, body: res.headers['content-type']?.includes('json') ? res.json() : res.body };
  };
  return { w, app, call, engine: new Engine(w.ctx) };
}

describe('HTTP API', () => {
  it('requires a session', async () => {
    const { call } = await setup();
    expect((await call('GET', '/api/campaigns')).status).toBe(401);
    expect((await call('GET', '/api/auth/status')).body).toEqual({ needsSetup: true, allowSignup: true });
  });

  it('runs the whole flow: sign up, account, CSV import, campaign, inbox, analytics, export', async () => {
    const { w, call } = await setup();
    const reg = await call('POST', '/api/auth/register', { name: 'Ana', email: 'ana@example.com', password: 'correct-horse', workspace: 'Acme' });
    expect(reg.status).toBe(200);

    const acc = await call('POST', '/api/accounts', { name: 'Demo seat', driver: 'simulator', timezone: 'UTC', warmup: false, delayMinSec: 30, delayMaxSec: 60 });
    expect(acc.status).toBe(200);
    expect(acc.body.hasSession).toBe(false);
    expect((await call('POST', `/api/accounts/${acc.body.id}/check`)).body.ok).toBe(true);

    const list = await call('POST', '/api/lists', { name: 'Founders' });
    const csv = 'Full Name,LinkedIn URL,Company,Favourite Tool\nJane Roe,https://www.linkedin.com/in/jane-roe/,Acme,Notion\nJohn Poe,linkedin.com/in/john-poe,Globex,Figma\nBad Row,https://example.com/x,Nope,\n';
    const imp = await call('POST', '/api/leads/import/csv', { listId: list.body.id, csv });
    expect(imp.body).toMatchObject({ rows: 3, added: 2, invalid: 1, duplicates: 0 });

    const leads = await call('GET', `/api/leads?listId=${list.body.id}`);
    expect(leads.body.total).toBe(2);
    expect(leads.body.items.find((l: any) => l.publicId === 'jane-roe')).toMatchObject({ firstName: 'Jane', lastName: 'Roe', custom: { favouriteTool: 'Notion' } });

    const camp = await call('POST', '/api/campaigns', { name: 'Founders Q1', accountId: acc.body.id });
    expect(camp.body.problems).toEqual([]);
    const preview = await call('POST', '/api/templates/preview', { template: 'Hi {{firstName}}, love {{favouriteTool}}', leadId: leads.body.items[0].id });
    expect(preview.body.unknown).toEqual([]);

    const added = await call('POST', `/api/campaigns/${camp.body.id}/leads`, { listId: list.body.id });
    expect(added.body.added).toBe(2);
    expect((await call('POST', `/api/campaigns/${camp.body.id}/start`)).body.status).toBe('active');

    await runFor(w, 6 * DAY, 5 * 60_000);

    const detail = await call('GET', `/api/campaigns/${camp.body.id}`);
    expect(detail.body.stats.funnel).toMatchObject({ invited: 2, accepted: 2, replied: 2 });
    expect(detail.body.stats.replied).toBe(2);

    const inbox = await call('GET', '/api/inbox');
    expect(inbox.body).toHaveLength(2);
    expect(inbox.body[0].unread).toBe(1);
    const thread = await call('GET', `/api/inbox/${inbox.body[0].id}`);
    expect(thread.body.messages.map((m: any) => m.direction)).toEqual(['out', 'in']);
    expect((await call('POST', `/api/inbox/${inbox.body[0].id}/reply`, { text: 'Great, talk soon!' })).body.ok).toBe(true);

    const analytics = await call('GET', '/api/analytics?days=7');
    expect(analytics.body.funnel).toMatchObject({ invited: 2, accepted: 2, replied: 2 });
    expect(analytics.body.replyRate).toBe(100);

    const exported = await call('GET', `/api/leads/export.csv?campaignId=${camp.body.id}`);
    expect(String(exported.body).split('\n')[0]).toContain('favouriteTool');
    expect(String(exported.body)).toContain('connected');
  });

  it('rejects invalid sequences when starting', async () => {
    const { call } = await setup();
    await call('POST', '/api/auth/register', { name: 'Ana', email: 'ana@example.com', password: 'correct-horse' });
    const acc = await call('POST', '/api/accounts', { name: 'Seat', driver: 'simulator' });
    const camp = await call('POST', '/api/campaigns', {
      name: 'Broken',
      accountId: acc.body.id,
      sequence: { start: 'a', nodes: { a: { id: 'a', type: 'condition', kind: 'accepted_within', yes: null, no: null } } },
    });
    const start = await call('POST', `/api/campaigns/${camp.body.id}/start`);
    expect(start.status).toBe(400);
    expect(start.body.error).toMatch(/Connect step/);
  });

  it('keeps workspaces apart and closes sign-up after the first user', async () => {
    const { call, w } = await setup();
    await call('POST', '/api/auth/register', { name: 'Ana', email: 'ana@example.com', password: 'correct-horse' });
    w.ctx.config.allowSignup = false;
    const second = await call('POST', '/api/auth/register', { name: 'Eve', email: 'eve@example.com', password: 'correct-horse' });
    expect(second.status).toBe(403);
    const added = await call('POST', '/api/team', { name: 'Bo', email: 'bo@example.com', password: 'correct-horse' });
    expect(added.status).toBe(200);
    expect((await call('GET', '/api/team')).body).toHaveLength(2);
  });

  it('maps common CSV headers', () => {
    const rows = csvToLeads('﻿First Name,Last Name,Profile URL,Job Title,Email Address,Tags\nA,B,https://linkedin.com/in/ab,CEO,a@b.co,vip;warm\n');
    expect(rows[0]).toMatchObject({ firstName: 'A', lastName: 'B', title: 'CEO', email: 'a@b.co', tags: ['vip', 'warm'] });
  });
});
