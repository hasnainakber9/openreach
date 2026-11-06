import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { buildApp, CLIENT_ALLOWED } from '../src/app.js';
import { parseTrustProxy } from '../src/config.js';
import { DB } from '../src/db/db.js';
import { MIGRATIONS } from '../src/db/schema.js';
import { BrandingInput } from '../src/services/branding.js';
import { hashPassword } from '../src/services/crypto.js';
import { hashToken } from '../src/services/invites.js';
import { resolveSession } from '../src/services/memberships.js';
import { makeApi, makeWorld, mailerOf } from './helpers.js';

type Api = Awaited<ReturnType<typeof makeApi>>;
const cookieOf = (res: { headers: Record<string, any> }) => String([res.headers['set-cookie']].flat()[0]).split(';')[0];

// Signs in through the public endpoint and returns the session cookie.
async function signIn(api: Api, email: string, password = 'correct-horse') {
  const res = await api.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  return { status: res.statusCode, cookie: cookieOf(res), body: res.json() };
}

// Invites `email` to the current user's workspace and returns the token from the link.
async function invite(api: Api, email: string, role = 'member') {
  const r = await api.call('POST', '/api/invites', { email, role });
  expect(r.status).toBe(200);
  return { ...r.body, token: String(r.body.link).split('/invite/')[1] };
}

const accept = (api: Api, token: string, payload: Record<string, unknown>, cookie?: string) =>
  api.app.inject({ method: 'POST', url: `/api/public/invites/${token}/accept`, payload, headers: cookie ? { cookie } : {} });

// An agency owner with two client workspaces.
async function agencySetup() {
  const api = await makeApi();
  const owner = await api.register('Agency');
  expect((await api.call('POST', '/api/agency/enable')).body.user.features).toEqual({ agency: true });
  const a = (await api.call('POST', '/api/agency/clients', { name: 'Client A' })).body.id as number;
  const b = (await api.call('POST', '/api/agency/clients', { name: 'Client B' })).body.id as number;
  return { api, owner, a, b };
}

describe('memberships', () => {
  it.skipIf(new DB(':memory:', { migrateTo: 1 }).dialect !== 'sqlite')('moves existing users into memberships without breaking their sessions', () => {
    // Just before the g5-agency entry (later steps append entries after it).
    const db = new DB(':memory:', { migrateTo: MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE memberships')) });
    const ws = db.insert('workspaces', { name: 'W', created_at: 1 });
    const owner = db.insert('users', { workspace_id: ws, email: 'o@example.com', name: 'O', password_hash: 'x', role: 'owner', created_at: 1 });
    const admin = db.insert('users', { workspace_id: ws, email: 'a@example.com', name: 'A', password_hash: 'x', role: 'admin', created_at: 1 });
    db.insert('sessions', { token: 'tok', user_id: admin, expires_at: Date.now() + 60_000 });
    db.migrate();
    expect(db.all('SELECT user_id, workspace_id, role FROM memberships ORDER BY user_id')).toEqual([
      { user_id: owner, workspace_id: ws, role: 'owner' },
      { user_id: admin, workspace_id: ws, role: 'admin' },
    ]);
    expect(db.get('SELECT kind, parent_id FROM workspaces')).toEqual({ kind: 'standard', parent_id: null });
    const w = makeWorld();
    expect(resolveSession({ ...w.ctx, db }, 'tok')).toMatchObject({ id: admin, workspace_id: ws, role: 'admin' });
  });

  it('gives registered, team-added and directly inserted users a membership', async () => {
    const api = await makeApi();
    const owner = await api.register();
    const member = await api.addUser('member');
    const rows = api.w.ctx.db.all('SELECT user_id, role FROM memberships WHERE workspace_id = ? ORDER BY user_id', [owner.workspaceId]);
    expect(rows).toEqual([
      { user_id: owner.id, role: 'owner' },
      { user_id: member.id, role: 'member' },
    ]);
    // Seed scripts from before memberships wrote users only; signing in adds the membership.
    api.w.ctx.db.insert('users', { workspace_id: owner.workspaceId, email: 'legacy@example.com', name: 'Legacy', password_hash: hashPassword('correct-horse'), role: 'admin', created_at: 0 });
    const legacy = await signIn(api, 'legacy@example.com');
    expect(legacy.status).toBe(200);
    expect(legacy.body.user).toMatchObject({ role: 'admin', workspace_id: owner.workspaceId });
    expect((await api.call('GET', '/api/team', undefined, legacy)).body.map((u: any) => u.role)).toEqual(['owner', 'member', 'admin']);
  });

  it('lets a user in two workspaces switch and see only the active one', async () => {
    const api = await makeApi();
    const alice = await api.register('Alpha');
    await api.call('POST', '/api/lists', { name: 'Alpha list' });
    await api.register('Beta');
    await api.call('POST', '/api/lists', { name: 'Beta list' });
    const inv = await invite(api, 'owner1@example.com', 'member');
    // Alice is signed in already, so accepting needs no password.
    const res = await accept(api, inv.token, {}, alice.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ workspace_name: 'Beta', role: 'member' });

    api.as(alice);
    const list = (await api.call('GET', '/api/workspaces')).body;
    expect(list.map((w: any) => [w.name, w.role, w.active])).toEqual([
      ['Alpha', 'owner', false],
      ['Beta', 'member', true],
    ]);
    expect((await api.call('GET', '/api/lists')).body.map((l: any) => l.name)).toEqual(['Beta list']);
    // A member can't do admin things in Beta, though she owns Alpha.
    expect((await api.call('POST', '/api/invites', { email: 'x@example.com' })).status).toBe(403);

    const back = await api.call('POST', '/api/workspaces/switch', { workspaceId: alice.workspaceId });
    expect(back.body.user).toMatchObject({ workspace_name: 'Alpha', role: 'owner' });
    expect((await api.call('GET', '/api/lists')).body.map((l: any) => l.name)).toEqual(['Alpha list']);
    // A workspace she doesn't belong to is a 404 like any other row.
    const other = api.w.ctx.db.insert('workspaces', { name: 'Gamma', created_at: 0 });
    expect((await api.call('POST', '/api/workspaces/switch', { workspaceId: other })).status).toBe(404);
  });

  it("refuses calls from a tab that still shows the workspace another tab switched away from", async () => {
    const { api, owner, a, b } = await agencySetup();
    const inA = (method: string, url: string, payload?: unknown) =>
      api.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie: owner.cookie, 'x-workspace-id': String(a) } });
    await api.call('POST', '/api/workspaces/switch', { workspaceId: a });
    expect((await inA('POST', '/api/lists', { name: 'A leads' })).statusCode).toBe(200);
    // Another tab switches the session to client B; the first tab still shows A.
    await api.call('POST', '/api/workspaces/switch', { workspaceId: b });
    const stale = await inA('POST', '/api/lists', { name: 'meant for A' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().details).toEqual({ code: 'workspace_changed', workspaceId: b });
    expect((await inA('GET', '/api/campaigns')).statusCode).toBe(409);
    expect(api.w.ctx.db.get('SELECT COUNT(*) AS n FROM lead_lists WHERE name = ?', ['meant for A'])).toEqual({ n: 0 });
    // What the tab needs to catch up still works, and calls without the header act in the active workspace.
    expect((await inA('GET', '/api/auth/me')).json().user.workspace_id).toBe(b);
    expect((await inA('GET', '/api/workspaces')).statusCode).toBe(200);
    expect((await inA('POST', '/api/workspaces/switch', { workspaceId: a })).statusCode).toBe(200);
    expect((await inA('POST', '/api/lists', { name: 'A again' })).statusCode).toBe(200);
    expect((await api.call('GET', '/api/lists')).body.map((l: any) => l.name)).toEqual(['A again', 'A leads']);
  });

  it('edits roles, keeps one owner and removes memberships without deleting other workspaces', async () => {
    const api = await makeApi();
    const owner = await api.register('Alpha');
    const admin = await api.addUser('admin');
    const member = await api.addUser('member');
    // The last owner can't be demoted, and only owners make owners.
    expect((await api.call('PATCH', `/api/team/${owner.id}`, { role: 'admin' })).status).toBe(409);
    api.as(admin);
    expect((await api.call('PATCH', `/api/team/${member.id}`, { role: 'owner' })).status).toBe(403);
    expect((await api.call('PATCH', `/api/team/${member.id}`, { role: 'client' })).status).toBe(200);
    api.as(member);
    expect((await api.call('PATCH', `/api/team/${admin.id}`, { role: 'member' })).status).toBe(403);
    api.as(owner);
    expect((await api.call('PATCH', `/api/team/${admin.id}`, { role: 'owner' })).status).toBe(200);
    expect((await api.call('PATCH', `/api/team/${owner.id}`, { role: 'admin' })).status).toBe(200);
    expect((await api.call('GET', '/api/auth/me')).body.user.role).toBe('admin');

    // Someone with a second workspace keeps their account when removed from this one.
    api.as(member);
    await api.call('POST', '/api/workspaces/switch', { workspaceId: owner.workspaceId });
    const other = api.w.ctx.db.insert('workspaces', { name: 'Other', created_at: 0 });
    api.w.ctx.db.insert('memberships', { user_id: member.id, workspace_id: other, role: 'owner', created_at: 0 });
    api.as(admin);
    expect((await api.call('DELETE', `/api/team/${member.id}`)).status).toBe(200);
    expect(api.w.ctx.db.get('SELECT workspace_id FROM users WHERE id = ?', [member.id])).toEqual({ workspace_id: other });
    // Their live session falls back to the workspace they still have.
    api.as(member);
    expect((await api.call('GET', '/api/auth/me')).body.user).toMatchObject({ workspace_id: other, role: 'owner' });
  });
});

describe('agency and client workspaces', () => {
  it('gives agency admins inherited access to clients, and takes it away when they leave the agency', async () => {
    const { api, owner, a, b } = await agencySetup();
    const admin = await api.addUser('admin');
    const member = await api.addUser('member');
    api.as(admin);
    const ws = (await api.call('GET', '/api/workspaces')).body;
    expect(ws.map((w: any) => [w.name, w.kind, w.role, w.inherited])).toEqual([
      ['Agency', 'agency', 'admin', false],
      ['Client A', 'client', 'admin', true],
      ['Client B', 'client', 'admin', true],
    ]);
    // Members of the agency don't reach its clients.
    api.as(member);
    expect((await api.call('POST', '/api/workspaces/switch', { workspaceId: a })).status).toBe(404);
    expect((await api.call('GET', '/api/agency/overview')).status).toBe(403);

    api.as(admin);
    const inA = await api.call('POST', '/api/workspaces/switch', { workspaceId: a });
    expect(inA.body.user).toMatchObject({ workspace_kind: 'client', role: 'admin', agency: { name: 'Agency' }, features: { agency: true } });
    await api.call('POST', '/api/lists', { name: 'A list' });
    // Nothing was copied into the client.
    expect(api.w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memberships WHERE workspace_id IN (?, ?)', [a, b])!.n).toBe(0);

    // Removed from the agency, they lose every client at once (they keep their own workspace).
    const own = api.w.ctx.db.insert('workspaces', { name: 'Own', created_at: 0 });
    api.w.ctx.db.insert('memberships', { user_id: admin.id, workspace_id: own, role: 'owner', created_at: 0 });
    api.as(owner);
    expect((await api.call('DELETE', `/api/team/${admin.id}`)).status).toBe(200);
    api.as(admin);
    expect((await api.call('GET', '/api/auth/me')).body.user).toMatchObject({ workspace_id: own, role: 'owner' });
    expect((await api.call('GET', '/api/workspaces')).body.map((w: any) => w.name)).toEqual(['Own']);
    expect((await api.call('POST', '/api/workspaces/switch', { workspaceId: a })).status).toBe(404);
    // A member removed from their only workspace is deleted, and the session signs out.
    api.as(owner);
    expect((await api.call('DELETE', `/api/team/${member.id}`)).status).toBe(200);
    api.as(member);
    expect((await api.call('GET', '/api/lists')).status).toBe(401);
  });

  it('keeps client workspaces apart', async () => {
    const { api, a, b } = await agencySetup();
    await api.call('POST', '/api/workspaces/switch', { workspaceId: a });
    const listA = (await api.call('POST', '/api/lists', { name: 'A only' })).body.id;
    const clientA = await api.addUser('client');
    await api.call('POST', '/api/workspaces/switch', { workspaceId: b });
    expect((await api.call('GET', '/api/lists')).body).toEqual([]);
    expect((await api.call('PATCH', `/api/lists/${listA}`, { name: 'hijack' })).status).toBe(404);

    // Client A's user sees A only and can't switch to B or reach the agency.
    api.as(clientA);
    expect((await api.call('GET', '/api/workspaces')).body.map((w: any) => w.name)).toEqual(['Client A']);
    expect((await api.call('POST', '/api/workspaces/switch', { workspaceId: b })).status).toBe(404);
    expect((await api.call('GET', '/api/agency/overview')).status).toBe(403);

    // Another agency can't touch these clients.
    const other = await api.register('Rival agency');
    await api.call('POST', '/api/agency/enable');
    expect((await api.call('PATCH', `/api/agency/clients/${a}`, { name: 'Mine now' })).status).toBe(404);
    expect((await api.call('DELETE', `/api/agency/clients/${a}`, { confirm: 'Client A' })).status).toBe(404);
    expect((await api.call('GET', '/api/agency/overview')).body.clients).toEqual([]);
    expect((await api.call('POST', '/api/workspaces/switch', { workspaceId: a })).status).toBe(404);
    expect(other.workspaceId).not.toBe(a);
  });

  it('summarizes each client in the overview', async () => {
    const { api, a, b } = await agencySetup();
    const db = api.w.ctx.db;
    const now = api.w.ctx.clock.now();
    const lead = (ws: number, pid: string, extra: Record<string, any> = {}) =>
      db.insert('leads', { workspace_id: ws, public_id: pid, profile_url: `https://www.linkedin.com/in/${pid}/`, created_at: now, ...extra });
    const l1 = lead(a, 'one', { reply_category: 'meeting_booked', reply_category_at: now });
    const l2 = lead(a, 'two');
    lead(b, 'three');
    for (const l of [l1, l2]) db.insert('activity', { workspace_id: a, lead_id: l, type: 'connect', status: 'ok', day: '2026-01-05', created_at: now });
    db.insert('activity', { workspace_id: a, lead_id: l1, type: 'replied', status: 'ok', day: '2026-01-05', created_at: now });
    db.insert('accounts', { workspace_id: a, name: 'Seat', status: 'needs_login', created_at: now });
    db.insert('campaigns', { workspace_id: a, name: 'C', status: 'active', sequence: '{}', created_at: now });

    const o = (await api.call('GET', '/api/agency/overview?days=7')).body;
    expect(o.clients.map((c: any) => c.name)).toEqual(['Client A', 'Client B']);
    expect(o.clients[0]).toMatchObject({ accounts: 1, accountsNeedingAttention: 1, activeCampaigns: 1, contacted: 2, replies: 1, meetings: 1, replyRate: 50, lastActivityAt: now });
    expect(o.clients[1]).toMatchObject({ accounts: 0, contacted: 0, replies: 0, meetings: 0, lastActivityAt: null });
  });

  it('deletes a client with everything in it, only for the agency owner and with its name typed', async () => {
    const { api, owner, a, b } = await agencySetup();
    const db = api.w.ctx.db;
    const acc = db.insert('accounts', { workspace_id: a, name: 'Seat', created_at: 0 });
    db.insert('sim_people', { account_id: acc, public_id: 'p' });
    db.insert('activity', { workspace_id: a, account_id: acc, type: 'connect', day: '2026-01-05', created_at: 0 });
    db.insert('conversations', { workspace_id: a, account_id: null, channel: 'email', thread_id: 't' });
    db.insert('imports', { workspace_id: a, list_id: 1, source: 'x', created_at: 0 });
    db.insert('activity', { workspace_id: b, type: 'connect', day: '2026-01-05', created_at: 0 });

    const admin = await api.addUser('admin');
    api.as(admin);
    await api.call('POST', '/api/workspaces/switch', { workspaceId: a });
    expect((await api.call('DELETE', `/api/agency/clients/${a}`, { confirm: 'Client A' })).status).toBe(403);
    // A client user whose only workspace this is goes with it.
    api.as(owner);
    await api.call('POST', '/api/workspaces/switch', { workspaceId: a });
    const client = await api.addUser('client');
    await api.call('POST', '/api/workspaces/switch', { workspaceId: owner.workspaceId });
    expect((await api.call('DELETE', `/api/agency/clients/${a}`, { confirm: 'Client' })).status).toBe(400);
    expect((await api.call('DELETE', `/api/agency/clients/${a}`, { confirm: 'Client A' })).status).toBe(200);

    for (const t of ['activity', 'conversations', 'imports', 'accounts']) expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE workspace_id = ?`, [a])!.n).toBe(0);
    expect(db.get('SELECT 1 FROM sim_people WHERE account_id = ?', [acc])).toBeUndefined();
    expect(db.get('SELECT 1 FROM users WHERE id = ?', [client.id])).toBeUndefined();
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM activity WHERE workspace_id = ?', [b])!.n).toBe(1);
    // The agency admin who was inside the client is back in the agency.
    api.as(admin);
    expect((await api.call('GET', '/api/auth/me')).body.user.workspace_kind).toBe('agency');
  });
});

describe('client role', () => {
  async function clientSetup() {
    const { api, a } = await agencySetup();
    await api.call('POST', '/api/workspaces/switch', { workspaceId: a });
    const client = await api.addUser('client');
    api.as(client);
    return { api, client, a };
  }

  it('may only call the read-only allowlist', async () => {
    const { api } = await clientSetup();
    const routes = api.app.apiRoutes.filter((r) => r.url.startsWith('/api/') && !r.url.startsWith('/api/public/') && r.method !== 'HEAD' && r.method !== 'OPTIONS');
    // Public routes run without a session; logout would end this one (it is allowed, checked last).
    const skip = ['/api/auth/status', '/api/auth/login', '/api/auth/register', '/api/health', '/api/branding', '/api/auth/logout'];
    let checked = 0;
    for (const r of routes) {
      if (skip.includes(r.url)) continue;
      const url = r.url.replace(/:[a-zA-Z]+/g, '1');
      const res = await api.call(r.method, url, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
      const allowed = CLIENT_ALLOWED.has(`${r.method} ${r.url}`);
      if (allowed) expect(res.status, `${r.method} ${r.url}`).not.toBe(403);
      else expect(res.status, `${r.method} ${r.url}`).toBe(403);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
    // Spot checks of reads that must stay closed: settings, secrets, other people's data.
    for (const path of ['/api/integrations', '/api/mailboxes', '/api/accounts', '/api/team', '/api/webhooks', '/api/leads/export.csv', '/api/invites', '/api/agency/branding']) {
      expect((await api.call('GET', path)).status, path).toBe(403);
    }
    expect((await api.call('GET', '/api/campaigns')).status).toBe(200);
    expect((await api.call('GET', '/api/pipeline/board')).status).toBe(200);
    expect((await api.call('POST', '/api/auth/logout', {})).status).toBe(200);
  });

  it('reads inbox threads without marking them read', async () => {
    const { api, a } = await clientSetup();
    const conv = api.w.ctx.db.insert('conversations', { workspace_id: a, channel: 'email', thread_id: 't', participant_name: 'Lead', unread: 1, last_message_at: 1 });
    const r = await api.call('GET', `/api/inbox/${conv}`);
    expect(r.status).toBe(200);
    expect(api.w.ctx.db.get('SELECT unread FROM conversations WHERE id = ?', [conv])).toEqual({ unread: 1 });
  });
});

describe('invites', () => {
  it('creates an account for a new person, single use, and stores only a hash of the token', async () => {
    const api = await makeApi();
    const owner = await api.register('Alpha');
    const inv = await invite(api, 'New.Person@Example.com', 'client');
    expect(inv.emailed).toBe(false);
    expect(inv.link).toMatch(/^http:\/\/localhost:8787\/invite\/[\w-]{40,}$/);
    const row = api.w.ctx.db.get<{ email: string; token_hash: string }>('SELECT email, token_hash FROM invites WHERE id = ?', [inv.id])!;
    expect(row).toEqual({ email: 'new.person@example.com', token_hash: hashToken(inv.token) });
    expect(JSON.stringify(api.w.ctx.db.all('SELECT * FROM invites'))).not.toContain(inv.token);

    const page = await api.app.inject({ method: 'GET', url: `/api/public/invites/${inv.token}` });
    expect(page.json()).toMatchObject({ workspaceName: 'Alpha', email: 'new.person@example.com', role: 'client', existingUser: false, branding: { productName: 'OpenReach' } });
    expect((await accept(api, inv.token, { name: 'New', password: 'short' })).statusCode).toBe(400);
    const res = await accept(api, inv.token, { name: 'New Person', password: 'correct-horse' });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ name: 'New Person', role: 'client', workspace_id: owner.workspaceId });
    expect((await api.call('GET', '/api/campaigns', undefined, { cookie: cookieOf(res) })).status).toBe(200);
    // Used: the link is dead.
    expect((await accept(api, inv.token, { name: 'Again', password: 'correct-horse' })).statusCode).toBe(404);
    expect((await api.app.inject({ method: 'GET', url: `/api/public/invites/${inv.token}` })).statusCode).toBe(404);
    expect((await api.call('GET', '/api/invites')).body.items).toEqual([]);
  });

  it('asks an existing user for their password (throttled), and rejects expired and revoked links', async () => {
    const api = await makeApi();
    await api.register('Alpha');
    await api.register('Beta');
    const inv = await invite(api, 'owner1@example.com', 'admin');
    expect((await api.app.inject({ method: 'GET', url: `/api/public/invites/${inv.token}` })).json()).toMatchObject({ existingUser: true, signedIn: false });
    expect((await accept(api, inv.token, { password: 'wrong-password' })).statusCode).toBe(401);
    const ok = await accept(api, inv.token, { password: 'correct-horse' });
    expect(ok.json().user).toMatchObject({ workspace_name: 'Beta', role: 'admin' });

    // Ten wrong passwords lock the address for a while, like sign-in.
    api.w.ctx.db.run('DELETE FROM memberships WHERE user_id = ? AND workspace_id = ?', [ok.json().user.id, ok.json().user.workspace_id]);
    const second = await invite(api, 'owner1@example.com', 'member');
    for (let i = 0; i < 10; i++) await accept(api, second.token, { password: 'nope-nope' });
    expect((await accept(api, second.token, { password: 'correct-horse' })).statusCode).toBe(429);

    const expired = await invite(api, 'late@example.com');
    api.w.ctx.db.run('UPDATE invites SET expires_at = ? WHERE id = ?', [Date.now() - 1, expired.id]);
    expect((await accept(api, expired.token, { name: 'Late', password: 'correct-horse' })).statusCode).toBe(404);
    expect((await api.call('GET', '/api/invites')).body.items.find((i: any) => i.id === expired.id).expired).toBe(true);

    const revoked = await invite(api, 'gone@example.com');
    expect((await api.call('DELETE', `/api/invites/${revoked.id}`)).status).toBe(200);
    expect((await accept(api, revoked.token, { name: 'Gone', password: 'correct-horse' })).statusCode).toBe(404);
    // Inviting the same address again replaces the old link.
    const first = await invite(api, 'twice@example.com');
    await invite(api, 'twice@example.com');
    expect((await accept(api, first.token, { name: 'Twice', password: 'correct-horse' })).statusCode).toBe(404);
  });

  it('refuses form posts to the invite link, also through a percent-encoded /api path', async () => {
    const api = await makeApi();
    await api.register('Attacker');
    const victim = await api.register('Victim');
    api.as(await signIn(api, 'owner1@example.com'));
    const inv = await invite(api, 'owner2@example.com');
    const form = (url: string) =>
      api.app.inject({ method: 'POST', url, payload: 'x=1', headers: { cookie: victim.cookie, 'content-type': 'application/x-www-form-urlencoded' } });
    expect((await form(`/api/public/invites/${inv.token}/accept`)).statusCode).toBe(415);
    // The router decodes /%61pi to /api: the checks follow the route, not the raw URL.
    expect((await form(`/%61pi/public/invites/${inv.token}/accept`)).statusCode).toBe(415);
    expect((await api.call('GET', '/api/auth/me', undefined, victim)).body.user.workspace_name).toBe('Victim');
    expect((await api.app.inject({ method: 'GET', url: '/%61pi/campaigns' })).statusCode).toBe(401);
    expect((await api.call('GET', '/%61pi/campaigns', undefined, victim)).status).toBe(200);
  });

  it("can't touch another workspace's invites, and refuses members", async () => {
    const api = await makeApi();
    await api.register('Alpha');
    const inv = await invite(api, 'someone@example.com');
    const beta = await api.register('Beta');
    expect((await api.call('DELETE', `/api/invites/${inv.id}`)).status).toBe(404);
    expect((await api.call('GET', '/api/invites')).body.items).toEqual([]);
    expect((await api.call('POST', '/api/invites', { email: 'owner2@example.com' })).status).toBe(409);
    expect((await api.call('POST', '/api/invites', { email: 'x@example.com', role: 'owner' })).status).toBe(400);
    const member = await api.addUser('member');
    api.as(member);
    expect((await api.call('POST', '/api/invites', { email: 'y@example.com' })).status).toBe(403);
    expect(beta.workspaceId).toBeGreaterThan(0);
  });

  it('emails the link through the installation mailer when SMTP_URL and PUBLIC_URL are set', async () => {
    const w = makeWorld();
    w.ctx.config.smtpUrl = 'smtp://mailer%40agency.test:p4ss@smtp.agency.test:2525';
    w.ctx.config.mailFrom = 'Agency <hello@agency.test>';
    const api = await makeApi(w);
    await api.register('Alpha');
    const inv = await invite(api, 'friend@example.com');
    expect(inv.emailed).toBe(true);
    // The queued job never holds the token in clear.
    expect(JSON.stringify(w.ctx.db.all('SELECT payload FROM jobs'))).not.toContain(inv.token);
    await w.ctx.jobs.drain();
    const sent = mailerOf(w).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].transport).toMatchObject({ host: 'smtp.agency.test', port: 2525, secure: false, user: 'mailer@agency.test', pass: 'p4ss' });
    expect(sent[0].msg).toMatchObject({ to: 'friend@example.com', from: { name: 'OpenReach', address: 'hello@agency.test' } });
    expect(sent[0].msg.text).toContain(inv.link);
  });
});

describe('white-label branding', () => {
  it('serves branding by custom domain, by workspace and by default, with client overrides', async () => {
    const { api, a } = await agencySetup();
    api.w.ctx.config.customDomains = ['*.agency.test'];
    const put = (body: Record<string, unknown>) => api.call('PUT', '/api/agency/branding', body);
    expect((await put({ logoUrl: 'http://cdn.agency.test/logo.png' })).status).toBe(400);
    expect((await put({ primaryColor: 'blue' })).status).toBe(400);
    expect((await put({ customDomain: 'not a host' })).status).toBe(400);
    const saved = await put({ productName: 'Reachly', primaryColor: '#12AB34', logoUrl: 'https://cdn.agency.test/logo.png', supportEmail: 'help@agency.test', customDomain: 'App.Agency.test' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ productName: 'Reachly', primaryColor: '#12ab34', customDomain: 'app.agency.test', inherited: null });

    const branding = (host: string, cookie?: string) => api.app.inject({ method: 'GET', url: '/api/branding', headers: { host, ...(cookie ? { cookie } : {}) } }).then((r) => r.json());
    expect(await branding('app.agency.test:443')).toMatchObject({ productName: 'Reachly', primaryColor: '#12ab34', source: 'domain' });
    expect(await branding('elsewhere.test')).toEqual({ productName: 'OpenReach', logoUrl: null, primaryColor: null, supportEmail: null, source: 'default' });

    // A client inherits the agency's branding and can override single fields.
    await api.call('POST', '/api/workspaces/switch', { workspaceId: a });
    const client = await api.addUser('client');
    expect(await branding('localhost', client.cookie)).toMatchObject({ productName: 'Reachly', supportEmail: 'help@agency.test', source: 'workspace' });
    const override = await put({ productName: 'Client Portal' });
    expect(override.body).toMatchObject({ productName: 'Client Portal', inherited: { productName: 'Reachly' }, effective: { productName: 'Client Portal', primaryColor: '#12ab34' } });
    expect(await branding('localhost', client.cookie)).toMatchObject({ productName: 'Client Portal', primaryColor: '#12ab34' });
    // '' clears the override again.
    await put({ productName: '' });
    expect(await branding('localhost', client.cookie)).toMatchObject({ productName: 'Reachly' });
    // Clients can't edit branding.
    api.as(client);
    expect((await put({ productName: 'Mine' })).status).toBe(403);

    // Another agency can't claim the same domain, and standard workspaces have no branding.
    await api.register('Standard');
    expect((await put({ productName: 'X' })).status).toBe(409);
    await api.call('POST', '/api/agency/enable');
    expect((await put({ customDomain: 'app.agency.test' })).status).toBe(409);
  });

  it('reads X-Forwarded-Host only behind a trusted proxy', async () => {
    const { api } = await agencySetup();
    api.w.ctx.config.customDomains = ['portal.agency.test'];
    await api.call('PUT', '/api/agency/branding', { productName: 'Proxied', customDomain: 'portal.agency.test' });
    const ask = (app: typeof api.app) => app.inject({ method: 'GET', url: '/api/branding', headers: { host: 'internal:8787', 'x-forwarded-host': 'portal.agency.test' } }).then((r) => r.json().productName);
    expect(await ask(api.app)).toBe('OpenReach');
    api.w.ctx.config.trustProxy = 1;
    expect(await ask(await buildApp(api.w.ctx))).toBe('Proxied');
  });

  it("only lets the agency owner pick a custom domain, never the server's own host", async () => {
    const { api, owner, a } = await agencySetup();
    const cfg = api.w.ctx.config;
    const put = (body: Record<string, unknown>) => api.call('PUT', '/api/agency/branding', body);
    cfg.publicUrl = 'https://reach.example.net';
    // Open signup without an operator list: no custom domains at all.
    expect((await put({ customDomain: 'app.agency.test' })).status).toBe(400);
    cfg.allowSignup = false;
    expect((await put({ customDomain: 'reach.example.net' })).status).toBe(400);
    expect((await put({ customDomain: 'reach.localhost' })).status).toBe(400);
    expect((await put({ customDomain: 'app.agency.test' })).body).toMatchObject({ customDomain: 'app.agency.test', canEditDomain: true });
    cfg.customDomains = ['*.agency.test'];
    expect((await put({ customDomain: 'evil.example.com' })).status).toBe(400);
    // Saved before PUBLIC_URL pointed there: ignored rather than served.
    api.w.ctx.db.run('UPDATE branding SET custom_domain = ?', ['reach.example.net']);
    const branding = (host: string, cookie?: string) => api.app.inject({ method: 'GET', url: '/api/branding', headers: { host, ...(cookie ? { cookie } : {}) } }).then((r) => r.json());
    expect(await branding('reach.example.net')).toMatchObject({ source: 'default' });
    expect((await put({ productName: 'Reachly', customDomain: 'app.agency.test' })).status).toBe(200);

    // A client's own admin and an agency admin can brand, but not move the domain.
    await api.call('POST', '/api/workspaces/switch', { workspaceId: a });
    const clientAdmin = await api.addUser('admin');
    await api.call('POST', '/api/workspaces/switch', { workspaceId: owner.workspaceId });
    const agencyAdmin = await api.addUser('admin');
    api.as(clientAdmin);
    expect((await api.call('GET', '/api/agency/branding')).body.canEditDomain).toBe(false);
    expect((await put({ customDomain: 'client.agency.test' })).status).toBe(403);
    expect((await put({ productName: 'Client', customDomain: '' })).status).toBe(200);
    api.as(agencyAdmin);
    expect((await put({ customDomain: 'other.agency.test' })).status).toBe(403);
    expect((await put({ productName: 'Agency Co', customDomain: 'app.agency.test' })).status).toBe(200);

    // Someone from another workspace keeps their own branding on this domain.
    cfg.allowSignup = true;
    const rival = await api.register('Rival');
    expect(await branding('app.agency.test')).toMatchObject({ productName: 'Agency Co', source: 'domain' });
    expect(await branding('app.agency.test', rival.cookie)).toMatchObject({ productName: 'OpenReach', source: 'workspace' });
    expect(await branding('app.agency.test', clientAdmin.cookie)).toMatchObject({ productName: 'Agency Co', source: 'domain' });
  });

  it("never takes the server's own host from the request, so without PUBLIC_URL there are no custom domains", async () => {
    const { api, owner } = await agencySetup();
    const cfg = api.w.ctx.config;
    cfg.customDomains = ['*.corp.test'];
    const put = (host: string) =>
      api.app.inject({ method: 'PUT', url: '/api/agency/branding', payload: { productName: 'Evil', customDomain: 'app.corp.test' }, headers: { cookie: owner.cookie, host } });
    const signInPage = () => api.app.inject({ method: 'GET', url: '/api/branding', headers: { host: 'app.corp.test' } }).then((r) => r.json());
    cfg.publicUrl = undefined;
    // The server runs at app.corp.test; a spoofed Host must not make that look like someone else's domain.
    expect((await put('app.corp.test')).statusCode).toBe(400);
    const spoofed = await put('x.corp.test');
    expect(spoofed.statusCode).toBe(400);
    expect(spoofed.json().error).toMatch(/PUBLIC_URL/);
    // Saved anyway (before this rule): not served without PUBLIC_URL.
    api.w.ctx.db.run("INSERT INTO branding (workspace_id, product_name, custom_domain, updated_at) VALUES (?, 'Evil', 'app.corp.test', 0)", [owner.workspaceId]);
    expect(await signInPage()).toMatchObject({ productName: 'OpenReach', source: 'default' });
    cfg.publicUrl = 'https://app.corp.test';
    expect(await signInPage()).toMatchObject({ source: 'default' });
    api.w.ctx.db.run('DELETE FROM branding');
    expect((await put('x.corp.test')).json().error).toMatch(/own address/);
  });
});

describe('agency access inside client workspaces', () => {
  it('keeps the agency role when an agency admin also has a lower membership in a client', async () => {
    const { api, a } = await agencySetup();
    const admin = await api.addUser('admin');
    const email = api.w.ctx.db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [admin.id])!.email;
    // Already reaching the client through the agency, so an invite is refused...
    await api.call('POST', '/api/workspaces/switch', { workspaceId: a });
    expect((await api.call('POST', '/api/invites', { email, role: 'member' })).status).toBe(409);
    // ...and a lower row of their own (say, an older invite) doesn't demote them.
    api.as(admin);
    for (const role of ['member', 'client']) {
      api.w.ctx.db.run('DELETE FROM memberships WHERE user_id = ? AND workspace_id = ?', [admin.id, a]);
      api.w.ctx.db.insert('memberships', { user_id: admin.id, workspace_id: a, role, created_at: 0 });
      expect((await api.call('POST', '/api/workspaces/switch', { workspaceId: a })).body.user).toMatchObject({ role: 'admin' });
      expect((await api.call('GET', '/api/invites')).status).toBe(200);
      expect((await api.call('GET', '/api/workspaces')).body.find((w: any) => w.id === a)).toMatchObject({ role: 'admin' });
    }
  });

  it('lets agency admins own leads and take tasks in a client, and lets go of them when they leave the agency', async () => {
    const { api, owner, a } = await agencySetup();
    const admin = await api.addUser('admin');
    await api.call('POST', '/api/workspaces/switch', { workspaceId: a });
    const lead = api.w.ctx.db.insert('leads', { workspace_id: a, public_id: 'p1', profile_url: 'https://www.linkedin.com/in/p1/', created_at: 0 });
    expect((await api.call('GET', '/api/team')).body.map((m: any) => [m.id, m.role, m.inherited])).toEqual([
      [owner.id, 'owner', true],
      [admin.id, 'admin', true],
    ]);
    // Inherited people are managed in the agency, not here.
    expect((await api.call('PATCH', `/api/team/${admin.id}`, { role: 'member' })).status).toBe(404);
    expect((await api.call('PATCH', `/api/leads/${lead}`, { ownerId: admin.id })).status).toBe(200);
    const task = await api.call('POST', '/api/tasks', { leadId: lead, title: 'Call', dueAt: Date.now() + 60_000, assigneeId: admin.id });
    expect(task.body.assignee).toMatchObject({ id: admin.id });
    // Client users can't own leads.
    const client = await api.addUser('client');
    expect((await api.call('PATCH', `/api/leads/${lead}`, { ownerId: client.id })).status).toBe(404);

    await api.call('POST', '/api/workspaces/switch', { workspaceId: owner.workspaceId });
    expect((await api.call('DELETE', `/api/team/${admin.id}`)).status).toBe(200);
    expect(api.w.ctx.db.get('SELECT owner_id FROM leads WHERE id = ?', [lead])).toEqual({ owner_id: null });
    expect(api.w.ctx.db.get('SELECT assignee_id FROM tasks WHERE id = ?', [task.body.id])).toEqual({ assignee_id: null });
  });
});

describe('sender address and proxy trust', () => {
  it('keeps the product name out of the invite sender address', async () => {
    expect(BrandingInput.safeParse({ productName: 'ceo@bank.com, x' }).success).toBe(false);
    expect(BrandingInput.safeParse({ productName: 'A "B" <c>' }).success).toBe(false);
    expect(BrandingInput.safeParse({ productName: 'Reachly & Co.' }).success).toBe(true);

    // Even a name saved before the rule: the address stays the installation's.
    const w = makeWorld();
    w.ctx.config.smtpUrl = 'smtp://mailer%40agency.test:p4ss@smtp.agency.test:2525';
    w.ctx.config.mailFrom = 'no-reply@inst.test';
    const api = await makeApi(w);
    const owner = await api.register('Alpha');
    await api.call('POST', '/api/agency/enable');
    w.ctx.db.insert('branding', { workspace_id: owner.workspaceId, product_name: 'ceo@bank.com, x', updated_at: 0 });
    await invite(api, 'friend@example.com');
    await w.ctx.jobs.drain();
    const msg = mailerOf(w).sent[0].msg;
    expect(msg.from).toEqual({ name: 'ceo@bank.com, x', address: 'no-reply@inst.test' });
    // What nodemailer makes of it, built locally (no network).
    const built = await nodemailer.createTransport({ jsonTransport: true }).sendMail({ from: msg.from, to: msg.to, text: 'x' });
    expect(built.envelope.from).toBe('no-reply@inst.test');
  });

  it('trusts only the proxy hops it is told to, so a spoofed X-Forwarded-For does not reset the throttle', async () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('true')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('10.0.0.0/8, loopback')).toEqual(['10.0.0.0/8', 'loopback']);

    const w = makeWorld();
    w.ctx.config.trustProxy = parseTrustProxy('true');
    const api = await makeApi(w);
    await api.register('Alpha');
    const login = (spoofed: string, password: string) =>
      api.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner1@example.com', password }, headers: { 'x-forwarded-for': `${spoofed}, 203.0.113.9` } });
    for (let i = 0; i < 10; i++) expect((await login(`1.2.3.${i}`, 'wrong-password')).statusCode).toBe(401);
    expect((await login('9.9.9.9', 'correct-horse')).statusCode).toBe(429);
  });
});
