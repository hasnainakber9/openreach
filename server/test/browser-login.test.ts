import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasDisplay } from '../src/config.js';
import type { LoginWindow } from '../src/drivers/browser-login.js';
import { PlaywrightLinkedInDriver, type ContextLauncher } from '../src/drivers/playwright/linkedin.js';
import { DriverError, SignInOpen, type LinkedInDriver } from '../src/drivers/types.js';
import { deleteWorkspace } from '../src/services/workspaces.js';
import type { AccountRow } from '../src/types.js';
import { makeApi, makeWorld, type World } from './helpers.js';

// "Sign in in a browser window" and browser-owned sessions. No browser starts: the sign-in window and the
// driver's browser context are fakes.

const until = async (ok: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

interface FakeWindow extends LoginWindow {
  tabs: string[];
  cookie: string | null;
  closed: boolean;
}

function fakeWindow(): FakeWindow {
  const win: FakeWindow = {
    tabs: ['https://www.linkedin.com/login'],
    cookie: null,
    closed: false,
    urls: () => (win.closed ? [] : win.tabs),
    liAt: async () => win.cookie,
    close: async () => void (win.closed = true),
  };
  return win;
}

// A driver whose session check succeeds; records when it was closed.
function fakeDriver(log: string[], name = 'Sam Sender'): LinkedInDriver {
  return {
    checkSession: async () => ({ name, profileUrl: 'https://www.linkedin.com/in/sam-sender/' }),
    close: async () => void log.push('driver closed'),
  } as unknown as LinkedInDriver;
}

async function setup(account: Record<string, unknown> = {}) {
  const w = makeWorld();
  // A laptop install: nobody else signs up, no billing.
  w.ctx.config.allowSignup = false;
  const api = await makeApi(w);
  const owner = await api.register();
  const id = w.ctx.db.insert('accounts', {
    workspace_id: owner.workspaceId,
    name: 'Real seat',
    driver: 'playwright',
    timezone: 'UTC',
    session_enc: w.ctx.sealer.seal('pasted-cookie'),
    session_origin: 'pasted',
    status: 'needs_login',
    status_message: 'LinkedIn keeps redirecting',
    created_at: w.ctx.clock.now(),
    ...account,
  });
  const log: string[] = [];
  const win = fakeWindow();
  const launches: { dir: string; headless: boolean | undefined; timezoneId?: string }[] = [];
  w.ctx.drivers.factory = () => fakeDriver(log);
  w.ctx.drivers.loginTiming = { pollMs: 5, timeoutMs: 3000 };
  w.ctx.drivers.loginWindow = async (dir, options) => {
    log.push('window opened');
    launches.push({ dir, headless: options.headless, timezoneId: options.timezoneId });
    return win;
  };
  const row = () => w.ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [id])!;
  const state = async () => (await api.call('GET', `/api/accounts/${id}`)).body.browserLogin;
  return { w, api, id, row, log, win, launches, state };
}

describe('Sign in in a browser window', () => {
  it('stores the session signed in in the window as browser-owned, closes the window and checks it', async () => {
    const t = await setup();
    // A browser already open for the account is closed before the window opens on the same profile.
    await t.w.ctx.drivers.use(t.row(), async () => {});
    const r = await t.api.call('POST', `/api/accounts/${t.id}/browser-login`);
    expect(r.status).toBe(200);
    expect(r.body.browserLogin).toMatchObject({ state: 'waiting' });
    await until(() => t.launches.length === 1);
    expect(t.log).toEqual(['driver closed', 'window opened']);
    expect(t.launches[0]).toMatchObject({ headless: false, timezoneId: 'UTC' });
    expect(t.launches[0].dir.replace(/\\/g, '/')).toMatch(new RegExp(`/browsers/${t.id}$`));

    // While the window is open: the engine's lease is held and no other browser starts on the profile.
    expect(t.row().busy_until).toBeGreaterThan(Date.now());
    await expect(t.w.ctx.drivers.use(t.row(), async () => 1)).rejects.toBeInstanceOf(SignInOpen);
    expect((await t.api.call('POST', `/api/accounts/${t.id}/browser-login`)).status).toBe(409);
    expect((await t.api.call('POST', `/api/accounts/${t.id}/check`)).status).toBe(422);

    // A cookie on the sign-in page is not enough: the user is still signing in.
    t.win.cookie = 'fresh-cookie';
    await new Promise((r) => setTimeout(r, 30));
    expect((await t.state()).state).toBe('waiting');
    t.win.tabs = ['https://www.linkedin.com/checkpoint/challenge/'];
    await new Promise((r) => setTimeout(r, 30));
    expect((await t.state()).state).toBe('waiting');

    t.win.tabs = ['https://www.linkedin.com/feed/'];
    await until(async () => (await t.state()).state !== 'waiting');
    expect(await t.state()).toMatchObject({ state: 'done', message: 'Signed in as Sam Sender.' });
    const a = t.row();
    expect(t.w.ctx.sealer.open(a.session_enc)).toBe('fresh-cookie');
    expect(a).toMatchObject({ session_origin: 'browser', status: 'active', status_message: null, busy_until: null, linkedin_name: 'Sam Sender' });
    expect(t.win.closed).toBe(true);
    expect(t.w.ctx.drivers.isHeld(t.id)).toBe(false);
    expect((await t.api.call('GET', `/api/accounts/${t.id}`)).body).toMatchObject({ sessionOrigin: 'browser', linkedinName: 'Sam Sender' });
  });

  it('keeps a paused account paused', async () => {
    const t = await setup({ status: 'paused' });
    await t.api.call('POST', `/api/accounts/${t.id}/browser-login`);
    await until(() => t.launches.length === 1);
    Object.assign(t.win, { cookie: 'fresh-cookie', tabs: ['https://www.linkedin.com/feed/'] });
    await until(async () => (await t.state()).state === 'done');
    expect(t.row()).toMatchObject({ status: 'paused', session_origin: 'browser' });
  });

  it('gives up when the window is closed, times out or is cancelled, leaving the account as it was', async () => {
    const t = await setup();
    const before = t.row();
    await t.api.call('POST', `/api/accounts/${t.id}/browser-login`);
    await until(() => t.launches.length === 1);
    t.win.closed = true;
    await until(async () => (await t.state()).state === 'failed');
    expect((await t.state()).message).toMatch(/window was closed before signing in finished/);
    expect(t.row()).toMatchObject({ session_enc: before.session_enc, session_origin: 'pasted', status: 'needs_login', busy_until: null });
    expect(t.w.ctx.drivers.isHeld(t.id)).toBe(false);

    // Nobody signs in in time.
    t.w.ctx.drivers.loginTiming = { pollMs: 5, timeoutMs: 60 };
    t.win.closed = false;
    t.win.tabs = ['https://www.linkedin.com/login'];
    await t.api.call('POST', `/api/accounts/${t.id}/browser-login`);
    await until(async () => (await t.state()).state === 'failed');
    expect((await t.state()).message).toMatch(/^Nobody finished signing in/);
    expect(t.win.closed).toBe(true);
    expect(t.row()).toMatchObject({ session_enc: before.session_enc, status: 'needs_login', busy_until: null });

    // Cancelled from the app.
    t.w.ctx.drivers.loginTiming = { pollMs: 5, timeoutMs: 3000 };
    t.win.closed = false;
    await t.api.call('POST', `/api/accounts/${t.id}/browser-login`);
    await until(() => t.launches.length === 3);
    const c = await t.api.call('POST', `/api/accounts/${t.id}/browser-login/cancel`);
    expect(c.status).toBe(200);
    expect(c.body.browserLogin).toMatchObject({ state: 'failed', message: 'Cancelled. The account is unchanged.' });
    await until(() => t.win.closed && !t.w.ctx.drivers.isHeld(t.id) && t.row().busy_until == null);
    expect(t.row().session_enc).toBe(before.session_enc);
    expect((await t.api.call('DELETE', `/api/accounts/${t.id}/browser-login`)).status).toBe(409);
  });

  it('waits for an engine run on the account to finish before opening the window', async () => {
    const t = await setup();
    const leased = Date.now() + 60_000;
    t.w.ctx.db.run('UPDATE accounts SET busy_until = ? WHERE id = ?', [leased, t.id]);
    await t.api.call('POST', `/api/accounts/${t.id}/browser-login`);
    await new Promise((r) => setTimeout(r, 40));
    expect(t.launches).toHaveLength(0);
    expect((await t.state()).message).toMatch(/Waiting for the LinkedIn action/);
    t.w.ctx.db.run('UPDATE accounts SET busy_until = NULL WHERE id = ?', [t.id]);
    await until(() => t.launches.length === 1);
    await t.api.call('POST', `/api/accounts/${t.id}/browser-login/cancel`);
  });

  it('is refused on installs that serve others, for simulated accounts and while a paste would race it', async () => {
    const t = await setup();
    t.w.ctx.config.allowSignup = true;
    const hosted = await t.api.call('POST', `/api/accounts/${t.id}/browser-login`);
    expect(hosted.status).toBe(403);
    expect(hosted.body.error).toMatch(/would open on the server/);
    expect((await t.api.call('GET', '/api/auth/me')).body.user.features.browserSignIn).toBeUndefined();
    t.w.ctx.config.allowSignup = false;
    expect((await t.api.call('GET', '/api/auth/me')).body.user.features.browserSignIn).toBe(true);

    const sim = (await t.api.call('POST', '/api/accounts', { name: 'Sim', driver: 'simulator' })).body.id;
    expect((await t.api.call('POST', `/api/accounts/${sim}/browser-login`)).status).toBe(400);
    expect(t.launches).toHaveLength(0);

    await t.api.call('POST', `/api/accounts/${t.id}/browser-login`);
    await until(() => t.launches.length === 1);
    expect((await t.api.call('PATCH', `/api/accounts/${t.id}`, { liAt: 'another-pasted-cookie' })).status).toBe(409);
    await t.api.call('POST', `/api/accounts/${t.id}/browser-login/cancel`);
  });

  it('creates a real account without a cookie as signed out, except where the window is not offered', async () => {
    const t = await setup();
    const r = await t.api.call('POST', '/api/accounts', { name: 'New seat', driver: 'playwright' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'needs_login', hasSession: false, sessionOrigin: null, browserLogin: null });
    expect(r.body.statusMessage).toMatch(/Sign in in a browser window/);
    expect((await t.api.call('POST', `/api/accounts/${r.body.id}/resume`)).status).toBe(400);

    t.w.ctx.config.allowSignup = true;
    const hosted = await t.api.call('POST', '/api/accounts', { name: 'Hosted seat', driver: 'playwright' });
    expect(hosted.status).toBe(400);
    expect(hosted.body.error).toMatch(/li_at/);
  });

  it('marks a pasted cookie as pasted, also over a browser-owned session', async () => {
    const t = await setup({ session_origin: 'browser', session_enc: t0Seal() });
    const created = await t.api.call('POST', '/api/accounts', { name: 'Pasted seat', driver: 'playwright', liAt: 'AQEDA-pasted-1' });
    expect(t.w.ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [created.body.id])).toMatchObject({ session_origin: 'pasted', status: 'active' });
    expect((await t.api.call('PATCH', `/api/accounts/${t.id}`, { liAt: 'AQEDA-pasted-2' })).status).toBe(200);
    expect(t.row()).toMatchObject({ session_origin: 'pasted', status: 'active' });
    expect(t.w.ctx.sealer.open(t.row().session_enc)).toBe('AQEDA-pasted-2');
  });
});

// A sealed value for setup() before the world exists (the test secret is fixed).
function t0Seal() {
  return makeWorld().ctx.sealer.seal('browser-cookie');
}

// A browser context holding a cookie jar for linkedin.com.
function fakeContext(jar: { liAt: string | null }, log: string[] = []) {
  const page = { isClosed: () => false, setDefaultTimeout() {} };
  return {
    cookies: async () => (jar.liAt ? [{ name: 'li_at', value: jar.liAt, domain: '.linkedin.com' }] : []),
    addCookies: async (cookies: { name: string; value: string }[]) => {
      log.push(`added ${cookies[0].value}`);
      jar.liAt = cookies[0].value;
    },
    pages: () => [page],
    newPage: async () => page,
    close: async () => void log.push('context closed'),
  };
}

const launcher = (ctx: ReturnType<typeof fakeContext>, count = { n: 0 }): ContextLauncher => async () => (count.n++, ctx as never);

describe('Browser-owned sessions in the driver', () => {
  const open = (d: PlaywrightLinkedInDriver) => (d as unknown as { open(): Promise<unknown> }).open();

  it('leaves the profile cookie of a browser-owned session alone and reports a newer one', async () => {
    const jar = { liAt: 'profile-cookie' as string | null };
    const log: string[] = [];
    const reported: string[] = [];
    const d = new PlaywrightLinkedInDriver({ liAt: 'stored-cookie', userDataDir: 'x', sessionOrigin: 'browser', launch: launcher(fakeContext(jar, log)), onSessionCookie: (v) => reported.push(v) });
    await open(d);
    expect(log).toEqual([]);
    expect(jar.liAt).toBe('profile-cookie');
    expect(reported).toEqual(['profile-cookie']);
    // LinkedIn rotated it while the browser was open: reported once on close.
    jar.liAt = 'rotated-cookie';
    await d.close();
    expect(reported).toEqual(['profile-cookie', 'rotated-cookie']);
  });

  it('puts the stored cookie into a profile that has none, and always for a pasted session', async () => {
    const empty = { liAt: null as string | null };
    const log: string[] = [];
    const reported: string[] = [];
    const d = new PlaywrightLinkedInDriver({ liAt: 'stored-cookie', userDataDir: 'x', sessionOrigin: 'browser', launch: launcher(fakeContext(empty, log)), onSessionCookie: (v) => reported.push(v) });
    await open(d);
    expect(log).toEqual(['added stored-cookie']);
    await d.close();
    expect(reported).toEqual([]);

    const jar = { liAt: 'old-profile-cookie' as string | null };
    const pastedLog: string[] = [];
    const pasted = new PlaywrightLinkedInDriver({ liAt: 'pasted-cookie', userDataDir: 'x', sessionOrigin: 'pasted', launch: launcher(fakeContext(jar, pastedLog)), onSessionCookie: (v) => reported.push(v) });
    await open(pasted);
    expect(pastedLog).toEqual(['added pasted-cookie']);
    jar.liAt = 'rotated';
    await pasted.close();
    // A pasted session is not the profile's own: nothing is reported back.
    expect(reported).toEqual([]);
  });

  it('suggests the sign-in window when LinkedIn rejects the session', async () => {
    const jar = { liAt: null as string | null };
    const ctx = fakeContext(jar);
    const page = {
      isClosed: () => false,
      setDefaultTimeout() {},
      goto: async () => {
        throw new Error('page.goto: net::ERR_TOO_MANY_REDIRECTS at https://www.linkedin.com/in/me/');
      },
    };
    ctx.pages = () => [page];
    const d = new PlaywrightLinkedInDriver({ liAt: 'pasted-cookie', userDataDir: 'x', launch: launcher(ctx), pace: 0 });
    const e = await d.checkSession().catch((err) => err);
    expect(e).toBeInstanceOf(DriverError);
    expect(e).toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(e.message).toMatch(/Sign in in a browser window/);
  });
});

describe('Driver pool and browser-owned sessions', () => {
  function realAccount(w: World, liAt: string, origin: 'pasted' | 'browser') {
    w.ctx.db.update('accounts', w.accountId, { driver: 'playwright', session_enc: w.ctx.sealer.seal(liAt), session_origin: origin });
  }
  const liAt = (w: World) => w.ctx.sealer.open(w.account().session_enc);
  const open = (w: World) => w.ctx.drivers.use(w.account(), (d) => (d as unknown as { open(): Promise<unknown> }).open());

  it('re-seals a rotated cookie without restarting the browser, and never over a cookie pasted meanwhile', async () => {
    const w = makeWorld();
    realAccount(w, 'v1', 'browser');
    const jar = { liAt: 'v2' as string | null };
    const log: string[] = [];
    const launches = { n: 0 };
    w.ctx.drivers.launch = launcher(fakeContext(jar, log), launches);

    await open(w);
    expect(liAt(w)).toBe('v2');
    // The pool's own re-seal changed session_enc; the same browser carries on.
    await open(w);
    await open(w);
    expect(launches.n).toBe(1);

    // Rotated while open: stored when the browser closes.
    jar.liAt = 'v3';
    await w.ctx.drivers.drop(w.accountId);
    expect(liAt(w)).toBe('v3');
    await open(w);
    expect(launches.n).toBe(2);
    expect(log).toEqual(['context closed']);

    // The user pastes a cookie while the browser is open and LinkedIn rotates the old session at the same time.
    w.ctx.db.update('accounts', w.accountId, { session_enc: w.ctx.sealer.seal('pasted'), session_origin: 'pasted' });
    jar.liAt = 'v4';
    await open(w);
    expect(launches.n).toBe(3);
    expect(liAt(w)).toBe('pasted');
    expect(jar.liAt).toBe('pasted');
  });

  it('closes an account browser for a sign-in only after its current call, and starts none until released', async () => {
    const w = makeWorld();
    const log: string[] = [];
    w.ctx.drivers.factory = () => fakeDriver(log);
    let finish!: () => void;
    const busy = w.ctx.drivers.use(w.account(), () => new Promise<void>((r) => (finish = r)));
    const held = w.ctx.drivers.hold(w.accountId);
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toEqual([]);
    await expect(w.ctx.drivers.use(w.account(), async () => 1)).rejects.toBeInstanceOf(SignInOpen);
    finish();
    await busy;
    const release = await held;
    expect(log).toEqual(['driver closed']);
    release();
    expect(await w.ctx.drivers.use(w.account(), async () => 2)).toBe(2);
  });
});

describe('Sign-in window edge cases', () => {
  it('hides Cancel once signed in, while the session is being checked', async () => {
    const t = await setup();
    let checked!: () => void;
    const gate = new Promise<void>((r) => (checked = r));
    t.w.ctx.drivers.factory = () =>
      ({ checkSession: async () => (await gate, { name: 'Sam Sender', profileUrl: 'https://www.linkedin.com/in/sam-sender/' }), close: async () => {} }) as unknown as LinkedInDriver;
    await t.api.call('POST', `/api/accounts/${t.id}/browser-login`);
    await until(() => t.launches.length === 1);
    expect(await t.state()).toMatchObject({ state: 'waiting', cancellable: true });
    Object.assign(t.win, { cookie: 'fresh-cookie', tabs: ['https://www.linkedin.com/feed/'] });
    await until(async () => (await t.state()).cancellable === false);
    expect(await t.state()).toMatchObject({ state: 'waiting', message: 'Signed in. Checking the session.' });
    const c = await t.api.call('POST', `/api/accounts/${t.id}/browser-login/cancel`);
    expect(c.status).toBe(409);
    expect(c.body.error).toMatch(/Already signed in/);
    checked();
    await until(async () => (await t.state()).state === 'done');
    expect(t.row().session_origin).toBe('browser');
  });

  it('forgets a failed sign-in once a check shows the session works', async () => {
    const t = await setup();
    await t.api.call('POST', `/api/accounts/${t.id}/browser-login`);
    await until(() => t.launches.length === 1);
    await t.api.call('POST', `/api/accounts/${t.id}/browser-login/cancel`);
    await until(() => !t.w.ctx.drivers.isHeld(t.id) && t.row().busy_until == null);
    expect((await t.state()).state).toBe('failed');
    expect((await t.api.call('POST', `/api/accounts/${t.id}/check`)).status).toBe(200);
    expect(await t.state()).toBeNull();
  });

  it('stores the browser-owned cookie the window cleared, so giving up leaves the account as it was', async () => {
    const t = await setup({ session_origin: 'browser', session_enc: t0Seal(), status: 'active', status_message: null });
    t.win.previousLiAt = 'newer-profile-cookie';
    await t.api.call('POST', `/api/accounts/${t.id}/browser-login`);
    await until(() => t.launches.length === 1);
    expect(t.w.ctx.sealer.open(t.row().session_enc)).toBe('newer-profile-cookie');
    await t.api.call('POST', `/api/accounts/${t.id}/browser-login/cancel`);
    await until(() => !t.w.ctx.drivers.isHeld(t.id));
    expect(t.row()).toMatchObject({ session_origin: 'browser', status: 'active' });

    // A pasted cookie is put back by the driver on every start anyway; the profile's copy is not stored.
    const p = await setup();
    p.win.previousLiAt = 'old-profile-cookie';
    await p.api.call('POST', `/api/accounts/${p.id}/browser-login`);
    await until(() => p.launches.length === 1);
    expect(p.w.ctx.sealer.open(p.row().session_enc)).toBe('pasted-cookie');
    await p.api.call('POST', `/api/accounts/${p.id}/browser-login/cancel`);
  });

  it('is not offered where no window can be shown (a server or Docker container)', async () => {
    const t = await setup();
    t.w.ctx.config.hasDisplay = false;
    expect((await t.api.call('GET', '/api/auth/me')).body.user.features.browserSignIn).toBeUndefined();
    const r = await t.api.call('POST', `/api/accounts/${t.id}/browser-login`);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/computer with a screen/);
    expect((await t.api.call('POST', '/api/accounts', { name: 'New seat', driver: 'playwright' })).status).toBe(400);
    expect(t.launches).toHaveLength(0);

    expect(hasDisplay('win32', {})).toBe(true);
    expect(hasDisplay('darwin', {})).toBe(true);
    expect(hasDisplay('linux', {})).toBe(false);
    expect(hasDisplay('linux', { DISPLAY: ':0' })).toBe(true);
    expect(hasDisplay('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
  });

  it('deleting an account closes its window, forgets the sign-in and removes the browser profile', async () => {
    const t = await setup();
    const dataDir = await mkdtemp(join(tmpdir(), 'openreach-profiles-'));
    t.w.ctx.config.dataDir = dataDir;
    const profile = t.w.ctx.drivers.userDataDir(t.id);
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'Cookies'), 'li_at and friends');
    await t.api.call('POST', `/api/accounts/${t.id}/browser-login`);
    await until(() => t.launches.length === 1);
    expect((await t.api.call('DELETE', `/api/accounts/${t.id}`)).status).toBe(200);
    expect(t.win.closed).toBe(true);
    expect(t.w.ctx.drivers.signIns.has(t.id)).toBe(false);
    expect(t.w.ctx.drivers.isHeld(t.id)).toBe(false);
    expect(existsSync(profile)).toBe(false);
    await rm(dataDir, { recursive: true, force: true });
  });

  it('deleting a workspace closes the sign-in windows of its accounts', async () => {
    const t = await setup();
    await t.api.call('POST', `/api/accounts/${t.id}/browser-login`);
    await until(() => t.launches.length === 1);
    await deleteWorkspace(t.w.ctx, t.row().workspace_id);
    expect(t.win.closed).toBe(true);
    expect(t.w.ctx.drivers.signIns.has(t.id)).toBe(false);
    expect(t.w.ctx.drivers.isHeld(t.id)).toBe(false);
  });
});

describe('Driver pool closing browsers', () => {
  it('waits for a browser another caller is already closing before opening the sign-in window or a new browser', async () => {
    const w = makeWorld();
    const log: string[] = [];
    let closed!: () => void;
    const slowClose = new Promise<void>((r) => (closed = r));
    let n = 0;
    w.ctx.drivers.factory = () => {
      const k = ++n;
      return {
        checkSession: async () => (log.push(`check ${k}`), { name: 'x', profileUrl: 'y' }),
        close: async () => {
          if (k === 1) await slowClose;
          log.push(`closed ${k}`);
        },
      } as unknown as LinkedInDriver;
    };
    await w.ctx.drivers.use(w.account(), (d) => d.checkSession());
    // The idle reaper (or a session that expired during an import) starts closing it.
    void w.ctx.drivers.drop(w.accountId);
    let held = false;
    const hold = w.ctx.drivers.hold(w.accountId).then((release) => ((held = true), release));
    await new Promise((r) => setTimeout(r, 20));
    expect(held).toBe(false);
    closed();
    const release = await hold;
    expect(log).toEqual(['check 1', 'closed 1']);
    release();

    // A new browser likewise starts only after the old one has closed.
    let closed2!: () => void;
    const slow2 = new Promise<void>((r) => (closed2 = r));
    w.ctx.drivers.factory = () =>
      ({
        checkSession: async () => (log.push('check new'), { name: 'x', profileUrl: 'y' }),
        close: async () => (await slow2, log.push('closed old')),
      }) as unknown as LinkedInDriver;
    await w.ctx.drivers.use(w.account(), (d) => d.checkSession());
    void w.ctx.drivers.drop(w.accountId);
    const next = w.ctx.drivers.use(w.account(), (d) => d.checkSession());
    await new Promise((r) => setTimeout(r, 20));
    expect(log.slice(2)).toEqual(['check new']);
    closed2();
    await next;
    expect(log.slice(2)).toEqual(['check new', 'closed old', 'check new']);
  });

  it('keeps storing rotations after a settings change restarts a browser-owned session', async () => {
    const w = makeWorld();
    w.ctx.db.update('accounts', w.accountId, { driver: 'playwright', session_enc: w.ctx.sealer.seal('L1'), session_origin: 'browser' });
    const jar = { liAt: 'L1' as string | null };
    w.ctx.drivers.launch = launcher(fakeContext(jar));
    const liAt = () => w.ctx.sealer.open(w.account().session_enc);
    const open = () => w.ctx.drivers.use(w.account(), (d) => (d as unknown as { open(): Promise<unknown> }).open());
    await open();
    // LinkedIn rotates the cookie in the open browser, then the user changes the time zone: the old browser
    // stores L2 as it closes, after the new driver was created from L1.
    jar.liAt = 'L2';
    w.ctx.db.update('accounts', w.accountId, { timezone: 'Europe/Berlin' });
    await open();
    expect(liAt()).toBe('L2');
    // Later rotations seen by the new browser are still stored.
    jar.liAt = 'L3';
    await w.ctx.drivers.drop(w.accountId);
    expect(liAt()).toBe('L3');
  });
});
