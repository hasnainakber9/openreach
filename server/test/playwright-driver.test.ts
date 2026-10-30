import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightLinkedInDriver } from '../src/drivers/playwright/linkedin.js';
import { mockLinkedIn, type MockState } from './fixtures/linkedin-mock.js';

// Runs the real browser driver against a local mock of LinkedIn. Needs a Chromium binary:
// set CHROMIUM_PATH, or run `npx playwright install chromium`.
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const haveBrowser = !!executablePath || process.env.PLAYWRIGHT_BROWSERS === 'installed';

describe.skipIf(!haveBrowser)('Playwright LinkedIn driver (against a local mock)', () => {
  const state: MockState = {
    people: {
      'jane-doe': { name: 'Jane Doe', degree: '1st', email: 'jane@northwind.example' },
      'max-mueller': { name: 'Max Mueller', degree: '2nd' },
      'lena-hidden': { name: 'Lena Hidden', degree: '2nd', connectInMoreMenu: true },
      'pat-pending': { name: 'Pat Pending', degree: '2nd', pending: true },
    },
    events: [],
    searchPages: 2,
  };
  const dir = mkdtempSync(join(tmpdir(), 'or-driver-'));
  const serve = mockLinkedIn(state);
  let redirectToCheckpoint = false;
  const driver = new PlaywrightLinkedInDriver({
    liAt: 'fake-cookie',
    userDataDir: dir,
    executablePath,
    pace: 0,
    onContext: async (ctx) => {
      await ctx.route('https://www.linkedin.com/**', async (route) => {
        const url = new URL(route.request().url());
        if (redirectToCheckpoint) {
          // LinkedIn bounces to /checkpoint/...; rewrite the URL the same way before the page settles.
          return route.fulfill({ contentType: 'text/html', body: "<script>history.replaceState(null, '', '/checkpoint/challenge/')</script><h1>Security check</h1>" });
        }
        const r = await serve(url, route.request().postData());
        if (r.json) return route.fulfill({ json: r.json });
        return route.fulfill({ status: r.status ?? 200, contentType: 'text/html', body: r.html });
      });
    },
  });
  const url = (slug: string) => `https://www.linkedin.com/in/${slug}/`;
  const events = (type: string) => state.events.filter((e) => e.type === type);
  const settle = () => new Promise((r) => setTimeout(r, 150));

  beforeAll(async () => {
    expect((await driver.checkSession()).name).toBe('Sam Sender');
  }, 30_000);
  afterAll(async () => {
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a profile, including contact info for 1st-degree connections', async () => {
    const p = await driver.viewProfile(url('jane-doe'));
    expect(p).toMatchObject({ publicId: 'jane-doe', firstName: 'Jane', lastName: 'Doe', degree: 1, company: 'Northwind', location: 'London, England, United Kingdom', email: 'jane@northwind.example' });
    expect(p.title).toBe('Head of Growth');
  }, 30_000);

  it('sends an invitation with a typed note', async () => {
    expect(await driver.connect(url('max-mueller'), 'Hi Max, great work!')).toBe('sent');
    await settle();
    expect(events('connect').at(-1)).toEqual({ type: 'connect', slug: 'max-mueller', text: 'Hi Max, great work!' });
  }, 30_000);

  it('finds Connect inside the More menu and can invite without a note', async () => {
    expect(await driver.connect(url('lena-hidden'), '')).toBe('sent');
    await settle();
    expect(events('connect').at(-1)).toEqual({ type: 'connect', slug: 'lena-hidden', text: '' });
  }, 30_000);

  it('recognises existing connections and pending invites, and withdraws', async () => {
    expect(await driver.connect(url('jane-doe'), 'hi')).toBe('already_connected');
    expect(await driver.connect(url('pat-pending'), 'hi')).toBe('already_pending');
    expect(await driver.withdrawInvite(url('pat-pending'))).toBe(true);
    await settle();
    expect(events('withdraw')).toHaveLength(1);
  }, 30_000);

  it('messages a connection, keeping line breaks in one message', async () => {
    await driver.sendMessage(url('jane-doe'), 'Hello Jane,\nthanks for connecting.');
    await settle();
    expect(events('message').at(-1)?.text).toBe('Hello Jane,\nthanks for connecting.');
  }, 30_000);

  it('follows, endorses and likes', async () => {
    await driver.follow(url('lena-hidden'));
    expect(await driver.endorse(url('jane-doe'), 2)).toBe(2);
    expect(await driver.likeRecentPost(url('jane-doe'))).toBe(true);
    await settle();
    expect(events('follow')).toHaveLength(1);
    expect(events('endorse')).toHaveLength(2);
    expect(events('like')).toHaveLength(1);
  }, 30_000);

  it('collects search results across pages and stops at the end', async () => {
    const people = await driver.search('https://www.linkedin.com/search/results/people/?keywords=founder', 50);
    expect(people).toHaveLength(20);
    expect(people[3]).toMatchObject({ publicId: 'person-3', firstName: 'Person', lastName: '3', headline: 'Founder at Co 3' });
  }, 60_000);

  it('reads recent connections and the inbox', async () => {
    const conns = await driver.recentConnections(10);
    expect(conns.map((c) => c.publicId)).toEqual(['jane-doe']);
    const threads = await driver.inbox(0);
    expect(threads[0]).toMatchObject({ threadId: '2-abc', unread: true, participant: { publicId: 'jane-doe', name: 'Jane Doe' } });
    expect(threads[0].messages.map((m) => [m.direction, m.body])).toEqual([
      ['out', 'Hi Jane!'],
      ['in', 'Hey Sam, sure.'],
    ]);
  }, 30_000);

  it('reports missing profiles and security checkpoints as distinct errors', async () => {
    await expect(driver.viewProfile(url('nobody-here'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    redirectToCheckpoint = true;
    await expect(driver.viewProfile(url('jane-doe'))).rejects.toMatchObject({ code: 'CHECKPOINT' });
    redirectToCheckpoint = false;
  }, 30_000);
});
