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
      'olga-open': { name: 'Olga Open', degree: '2nd', inmail: 'compose' },
      'una-upsell': { name: 'Una Upsell', degree: '2nd', inmail: 'upsell' },
      'nora-nocredit': { name: 'Nora Nocredit', degree: '2nd', inmail: 'no_credits' },
      'sven-sales': { name: 'Sven Sales', degree: '2nd', salesNav: true },
    },
    events: [],
    searchPages: 2,
    post: { reactors: 23, commenters: 12 },
    groupMembers: 25,
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

  it('collects a post’s reactions and comments, separately or together', async () => {
    const post = 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/';
    const likers = await driver.postEngagers(post, { likers: true, commenters: false }, 100);
    expect(likers).toHaveLength(23);
    expect(likers[4]).toMatchObject({ publicId: 'reactor-4', firstName: 'Reactor', lastName: '4', headline: 'Founder at Co 4' });
    const commenters = await driver.postEngagers(post, { likers: false, commenters: true }, 100);
    expect(commenters.map((p) => p.publicId)).toEqual(Array.from({ length: 12 }, (_, i) => `commenter-${i}`));
    expect(commenters[0].headline).toBe('CTO at Co 0');
    const both = await driver.postEngagers(post, { likers: true, commenters: true }, 30);
    expect(both).toHaveLength(30);
    expect(both.filter((p) => p.publicId.startsWith('commenter-'))).toHaveLength(7);
  }, 90_000);

  it('collects event attendees through the attendee search, and says when they are hidden', async () => {
    const people = await driver.eventAttendees('https://www.linkedin.com/events/7123456/', 15);
    expect(people).toHaveLength(15);
    expect(people[0].publicId).toBe('person-0');
    await expect(driver.eventAttendees('https://www.linkedin.com/events/hidden-1/', 10)).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
  }, 60_000);

  it('collects group members with "Show more results"', async () => {
    const people = await driver.groupMembers('https://www.linkedin.com/groups/12345/', 100);
    expect(people).toHaveLength(25);
    expect(people[24]).toMatchObject({ publicId: 'member-24', headline: 'Designer at Studio 24' });
  }, 60_000);

  it('sends an InMail with a subject, and reports no credits or no Premium distinctly', async () => {
    await driver.sendInMail(url('olga-open'), { subject: 'Quick idea', body: 'Hello Olga,\nworth a chat?', via: 'profile' });
    await settle();
    expect(events('inmail').at(-1)).toEqual({ type: 'inmail', slug: 'olga-open', subject: 'Quick idea', text: 'Hello Olga,\nworth a chat?' });
    await expect(driver.sendInMail(url('una-upsell'), { subject: 'Hi', body: 'Hi', via: 'profile' })).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    await expect(driver.sendInMail(url('nora-nocredit'), { subject: 'Hi', body: 'Hi', via: 'profile' })).rejects.toMatchObject({ code: 'LIMIT_REACHED' });
  }, 60_000);

  it('writes from Sales Navigator when asked', async () => {
    await driver.sendInMail(url('sven-sales'), { subject: 'From Sales Navigator', body: 'Hi Sven', via: 'sales_navigator' });
    await settle();
    expect(events('salesnav').at(-1)).toEqual({ type: 'salesnav', slug: 'sven-sales', subject: 'From Sales Navigator', text: 'Hi Sven' });
    await expect(driver.sendInMail(url('max-mueller'), { subject: 'x', body: 'x', via: 'sales_navigator' })).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
  }, 60_000);

  it('reports missing profiles and security checkpoints as distinct errors', async () => {
    await expect(driver.viewProfile(url('nobody-here'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    redirectToCheckpoint = true;
    await expect(driver.viewProfile(url('jane-doe'))).rejects.toMatchObject({ code: 'CHECKPOINT' });
    redirectToCheckpoint = false;
  }, 30_000);
});
