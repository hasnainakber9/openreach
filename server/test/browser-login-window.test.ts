import { describe, expect, it, vi } from 'vitest';
import { playwrightLoginWindow } from '../src/drivers/browser-login.js';
import { contextOptions } from '../src/drivers/playwright/linkedin.js';

// The real sign-in window (playwrightLoginWindow) on a fake Playwright: no browser starts.

const pw = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('playwright', () => ({ chromium: { launchPersistentContext: async () => pw.ctx } }));

// A persistent context that behaves like Playwright's: close() resolves once Chromium has exited, and a
// second close() while the first is under way returns at once (BrowserContext.close's _closingStatus guard).
function fakeChromium() {
  const log: string[] = [];
  let status: 'none' | 'closing' | 'closed' = 'none';
  let exit!: () => void;
  const exited = new Promise<void>((r) => (exit = r));
  const page = {
    url: () => 'about:blank',
    isClosed: () => false,
    goto: async (url: string) => void log.push(`goto ${url}`),
    setContent: async (html: string) => void log.push(`content ${html}`),
    bringToFront: async () => {},
  };
  const ctx = {
    on() {},
    cookies: async () => [],
    clearCookies: async () => {},
    pages: () => [page],
    newPage: async () => page,
    close: async () => {
      if (status !== 'none') return;
      status = 'closing';
      await exited;
      status = 'closed';
      log.push('chromium exited');
    },
  };
  pw.ctx = ctx;
  return { log, exit, status: () => status };
}

const options = contextOptions({ timezone: 'UTC', headless: false });

describe('The sign-in window', () => {
  it('waits for Chromium to exit on every close, also one made while an earlier close is under way', async () => {
    const chromium = fakeChromium();
    const win = await playwrightLoginWindow('profile', options);
    // Cancel closes the window without waiting; the sign-in's cleanup then closes it again and waits.
    void win.close();
    let closed = false;
    const cleanup = win.close().then(() => void (closed = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false);
    expect(chromium.status()).toBe('closing');
    chromium.exit();
    await cleanup;
    expect(chromium.status()).toBe('closed');
  });
});
