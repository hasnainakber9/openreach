import { rm } from 'node:fs/promises';
import type { Ctx } from '../context.js';
import { HttpError } from '../http.js';
import { sendsForOthers } from '../mail/mailboxes.js';
import { callLinkedIn } from '../services/linkedin-calls.js';
import type { AccountRow } from '../types.js';
import { contextOptions, launchContext, profileLiAt, type ContextOptions } from './playwright/linkedin.js';
import { BLOCKED_PATHS } from './playwright/selectors.js';

// "Sign in in a browser window": opens LinkedIn's sign-in page in a visible window on the account's own
// browser profile, and the user signs in there themselves (OpenReach never sees or types the password).
// A pasted li_at often fails in OpenReach's browser (LinkedIn answers with a redirect loop) because LinkedIn
// ties a session to the browser that created it; a session created in this profile is that browser's own.
// The window opens on the machine running the server, so this is only offered when that is the user's own
// computer (not on installs that serve other people).

export const LOGIN_URL = 'https://www.linkedin.com/login';

export interface SignInState {
  state: 'waiting' | 'done' | 'failed';
  message: string;
  startedAt: number;
  // False once there is nothing left to cancel: signed in, and now checking the session (or finished).
  cancellable: boolean;
  // Closes the window and gives up; false when not cancellable.
  cancel: () => boolean;
  // Settles once the window is closed and the account's profile is free again.
  windowClosed: Promise<void>;
}

// The sign-in window as the flow sees it; tests pass a fake.
export interface LoginWindow {
  // Addresses of the window's open tabs; empty once the user has closed it.
  urls(): string[];
  liAt(): Promise<string | null>;
  close(): Promise<void>;
  // The li_at the profile had before the window cleared it.
  previousLiAt?: string | null;
}

export type LoginLauncher = (userDataDir: string, options: ContextOptions) => Promise<LoginWindow>;

export const playwrightLoginWindow: LoginLauncher = async (userDataDir, options) => {
  const ctx = await launchContext(userDataDir, { ...options, headless: false });
  let closed = false;
  ctx.on('close', () => void (closed = true));
  let previousLiAt: string | null = null;
  try {
    // The li_at already in the profile (a pasted one, or an old session) is the one LinkedIn rejects or may
    // have ended, so the window starts signed out: a cookie seen from here on was issued by this sign-in.
    previousLiAt = await profileLiAt(ctx).catch(() => null);
    await ctx.clearCookies({ name: 'li_at' });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.bringToFront().catch(() => {});
  } catch (e) {
    await ctx.close().catch(() => {});
    throw e;
  }
  return {
    urls: () => (closed ? [] : ctx.pages().filter((p) => !p.isClosed()).map((p) => p.url())),
    liAt: () => profileLiAt(ctx),
    close: () => ctx.close().catch(() => {}),
    previousLiAt,
  };
};

// Signed in once a tab shows LinkedIn past the sign-in, verification and sign-up pages.
function pastSignIn(urls: string[]): boolean {
  return urls.some((u) => {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      return false;
    }
    return /(^|\.)linkedin\.com$/.test(url.hostname) && !BLOCKED_PATHS.sessionExpired.test(url.pathname) && !BLOCKED_PATHS.checkpoint.test(url.pathname);
  });
}

// Why this install can't offer the window at all, or null when it can. The window opens on the machine
// running the server: on one that serves other people that is not their screen, and a server or Docker
// container has no screen to show it on.
export function browserWindowUnavailable(ctx: Ctx): string | null {
  if (sendsForOthers(ctx)) {
    return 'Signing in in a browser window only works when OpenReach runs on your own computer: on this server the window would open on the server, not on your screen. Paste the li_at cookie instead.';
  }
  if (!ctx.config.hasDisplay) {
    return 'Signing in in a browser window needs OpenReach to run on a computer with a screen. This server has none (as in Docker), so paste the li_at cookie instead.';
  }
  return null;
}

// Why the button is not offered for this account, or null when it is.
export function browserLoginUnavailable(ctx: Ctx, a: Pick<AccountRow, 'driver'>): string | null {
  const why = browserWindowUnavailable(ctx);
  if (why) return why;
  if (a.driver !== 'playwright') return 'Simulated accounts do not sign in to LinkedIn.';
  // The window must open where the account's browser sessions are kept (see services/linkedin-calls.ts).
  if (!ctx.isLeader()) return 'This server does not run the LinkedIn sessions. Open OpenReach on the server that runs the campaign engine.';
  return null;
}

export const publicSignIn = (s: SignInState | undefined) => (s ? { state: s.state, message: s.message, startedAt: s.startedAt, cancellable: s.cancellable } : null);

// Starts the sign-in in the background and returns at once; the account's `browserLogin` shows how it goes.
export function startBrowserLogin(ctx: Ctx, a: AccountRow): SignInState {
  const why = browserLoginUnavailable(ctx, a);
  if (why) throw new HttpError(a.driver !== 'playwright' ? 400 : browserWindowUnavailable(ctx) ? 403 : 409, why);
  if (ctx.drivers.signIns.get(a.id)?.state === 'waiting') throw new HttpError(409, 'A sign-in window is already open for this account.');
  let closed!: () => void;
  const st: SignInState = {
    state: 'waiting',
    message: 'Opening a LinkedIn window on this computer.',
    startedAt: ctx.clock.now(),
    cancellable: true,
    cancel: () => false,
    windowClosed: new Promise<void>((r) => (closed = r)),
  };
  ctx.drivers.signIns.set(a.id, st);
  void signIn(ctx, a, st, closed)
    .catch((e) => finish(st, 'failed', `Signing in stopped: ${(e as Error).message}`))
    .finally(closed);
  return st;
}

export function cancelBrowserLogin(ctx: Ctx, accountId: number): boolean {
  const st = ctx.drivers.signIns.get(accountId);
  return st?.state === 'waiting' ? st.cancel() : false;
}

// Deleting an account: closes its sign-in window and its browser, forgets the sign-in, and removes the
// browser profile, which holds the account's LinkedIn cookies outside the sealed store (and SQLite may give
// the same id, so the same folder, to the next account). removeRow runs while no browser can start on it.
export async function discardAccountBrowser(ctx: Ctx, accountId: number, removeRow: () => void = () => {}) {
  const st = ctx.drivers.signIns.get(accountId);
  st?.cancel();
  await st?.windowClosed;
  ctx.drivers.signIns.delete(accountId);
  const release = await ctx.drivers.hold(accountId);
  try {
    removeRow();
    await rm(ctx.drivers.userDataDir(accountId), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  } finally {
    release();
  }
}

function finish(st: SignInState, state: 'done' | 'failed', message: string) {
  if (st.state !== 'waiting') return;
  st.state = state;
  st.message = message;
  st.cancellable = false;
  st.cancel = () => false;
}

const UNCHANGED = 'The account is unchanged.';

async function signIn(ctx: Ctx, a: AccountRow, st: SignInState, windowClosed: () => void) {
  const pool = ctx.drivers;
  const { pollMs, timeoutMs } = pool.loginTiming;
  const deadline = Date.now() + timeoutMs;
  const sleep = () => new Promise((r) => setTimeout(r, pollMs));
  let cancelled = false;
  let win: LoginWindow | null = null;
  st.cancel = () => {
    cancelled = true;
    finish(st, 'failed', `Cancelled. ${UNCHANGED}`);
    void win?.close();
    return true;
  };

  // The engine leases an account for each run (Engine.runAccount); holding that lease keeps it off this
  // account until the sign-in ends, and waiting for it lets an action that is under way finish first.
  const until = deadline + 60_000;
  let leased = false;
  let release: (() => void) | null = null;
  let liAt: string | null = null;
  try {
    for (;;) {
      if (cancelled) return;
      const now = Date.now();
      leased = ctx.db.run('UPDATE accounts SET busy_until = ? WHERE id = ? AND (busy_until IS NULL OR busy_until < ?)', [until, a.id, now]).changes > 0;
      if (leased) break;
      if (now >= deadline) return finish(st, 'failed', `The account stayed busy with LinkedIn actions, so no window was opened. ${UNCHANGED}`);
      st.message = 'Waiting for the LinkedIn action this account is doing to finish.';
      await sleep();
    }
    // Imports, checks and replies use the pool directly: it closes this account's browser and starts none
    // until the window is closed again.
    release = await pool.hold(a.id);
    if (cancelled) return;
    const fresh = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [a.id]) ?? a;
    const options = contextOptions({ proxyUrl: fresh.proxy_url, timezone: fresh.timezone, executablePath: ctx.config.executablePath, headless: false });
    win = await (pool.loginWindow ?? playwrightLoginWindow)(pool.userDataDir(a.id), options);
    // The window cleared the profile's li_at. For a browser-owned session that was the live copy, which can be
    // newer than the stored one (if the server stopped before storing a rotation), so it is stored now: giving
    // up then leaves the account as it was, since the driver puts the stored copy into an empty profile.
    const previous = win.previousLiAt;
    if (previous && fresh.session_origin === 'browser' && previous !== ctx.sealer.open(fresh.session_enc)) {
      ctx.db.run("UPDATE accounts SET session_enc = ? WHERE id = ? AND session_origin = 'browser' AND session_enc = ?", [ctx.sealer.seal(previous), a.id, fresh.session_enc]);
    }
    if (cancelled) return;
    st.message = 'A LinkedIn window is open on this computer. Sign in there; OpenReach notices when you are done.';
    for (;;) {
      if (cancelled) return;
      const urls = win.urls();
      if (!urls.length) return finish(st, 'failed', `The LinkedIn window was closed before signing in finished. ${UNCHANGED}`);
      const value = await win.liAt().catch(() => null);
      if (value && pastSignIn(urls)) {
        liAt = value;
        break;
      }
      if (Date.now() >= deadline) return finish(st, 'failed', `Nobody finished signing in within ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes, so the window was closed. ${UNCHANGED}`);
      await sleep();
    }
    if (cancelled) return;
    // Like a successful check: the account works again (a paused one stays paused). The cookie is the
    // profile's own now, so the driver leaves it there instead of putting a stored copy back (see open()).
    ctx.db.run(
      "UPDATE accounts SET session_enc = ?, session_origin = 'browser', status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'active' END, status_message = NULL WHERE id = ?",
      [ctx.sealer.seal(liAt), a.id],
    );
    st.cancellable = false;
    st.cancel = () => false;
  } catch (e) {
    return finish(st, 'failed', `Could not open the LinkedIn window: ${(e as Error).message.split('\n')[0]}. ${UNCHANGED}`);
  } finally {
    // Finally runs before the check below, which opens the same profile through the pool.
    await (win as LoginWindow | null)?.close();
    release?.();
    if (leased) ctx.db.run('UPDATE accounts SET busy_until = NULL WHERE id = ? AND busy_until = ?', [a.id, until]);
    windowClosed();
  }

  // The usual session check fills in whose account it is (or reports why LinkedIn still refuses it).
  st.message = 'Signed in. Checking the session.';
  try {
    const info = await callLinkedIn(ctx, a.workspace_id, { op: 'check', accountId: a.id });
    finish(st, 'done', info?.name ? `Signed in as ${info.name}.` : 'Signed in.');
  } catch (e) {
    finish(st, 'failed', `Signed in, but the session check failed: ${(e as Error).message}`);
  }
}
