import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightLinkedInDriver } from '../src/drivers/playwright/linkedin.js';
import { companyFromCard, connectionRows, parseTopCardLines, profileLinkRows, threadEvents, topCardSnapshot } from '../src/drivers/playwright/parse.js';
import { LABELS, SEL } from '../src/drivers/playwright/selectors.js';
import { mockLinkedIn, type MockState } from './fixtures/linkedin-mock.js';

// Runs the real browser driver against a local mock of LinkedIn, and the driver's page readers against
// scrubbed snapshots of the live 2026 markup. Needs a Chromium binary: set CHROMIUM_PATH, or run
// `npx playwright install chromium` and set PLAYWRIGHT_BROWSERS=installed.
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const haveBrowser = !!executablePath || process.env.PLAYWRIGHT_BROWSERS === 'installed';

describe.skipIf(!haveBrowser)('Playwright LinkedIn driver (against a local mock)', () => {
  const state: MockState = {
    people: {
      // 2026 layout (the mock's default).
      'jane-doe': { name: 'Jane Doe', degree: '1st', email: 'jane@northwind.example', staleBubble: true },
      'lucy-late': { name: 'Lucy Late', degree: '1st', staleBubble: true, lateCard: true },
      'sam-slow': { name: 'Sam Slow', degree: '1st', noComposer: true },
      'max-mueller': { name: 'Max Mueller', degree: '2nd', staleBubble: true },
      'lena-hidden': { name: 'Lena Hidden', degree: '2nd', connectInMoreMenu: true },
      'nina-navigate': { name: 'Nina Navigate', degree: '2nd', invitePage: true },
      'pat-pending': { name: 'Pat Pending', degree: '2nd', pending: true },
      'olga-open': { name: 'Olga Open', degree: '2nd', inmail: 'compose' },
      // The older layout, which LinkedIn still serves to some members.
      'carl-classic': { name: 'Carl Classic', degree: '1st', layout: 'classic', email: 'carl@northwind.example' },
      'kim-classic': { name: 'Kim Classic', degree: '2nd', layout: 'classic' },
      'lars-classic': { name: 'Lars Classic', degree: '2nd', layout: 'classic', connectInMoreMenu: true },
      'una-upsell': { name: 'Una Upsell', degree: '2nd', layout: 'classic', inmail: 'upsell' },
      'nora-nocredit': { name: 'Nora Nocredit', degree: '2nd', layout: 'classic', inmail: 'no_credits' },
      'sven-sales': { name: 'Sven Sales', degree: '2nd', layout: 'classic', salesNav: true },
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
    readyTimeoutMs: 5000,
    composerTimeoutMs: 6000,
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
    // Own profile in the 2026 layout: the name comes from the title, "(2) Sam Sender | LinkedIn".
    expect((await driver.checkSession()).name).toBe('Sam Sender');
  }, 30_000);
  afterAll(async () => {
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a profile in either layout, including contact info for 1st-degree connections', async () => {
    const want = { degree: 1, company: 'Northwind', headline: 'Head of Growth at Northwind', title: 'Head of Growth', location: 'London, England, United Kingdom' };
    expect(await driver.viewProfile(url('jane-doe'))).toMatchObject({ ...want, publicId: 'jane-doe', firstName: 'Jane', lastName: 'Doe', email: 'jane@northwind.example' });
    expect(await driver.viewProfile(url('carl-classic'))).toMatchObject({ ...want, publicId: 'carl-classic', firstName: 'Carl', lastName: 'Classic', email: 'carl@northwind.example' });
    expect(await driver.viewProfile(url('max-mueller'))).toMatchObject({ degree: 2, firstName: 'Max', company: 'Northwind', email: null });
  }, 60_000);

  it('sends an invitation with a typed note from the Connect link, ignoring an open message bubble', async () => {
    expect(await driver.connect(url('max-mueller'), 'Hi Max, great work!')).toBe('sent');
    await settle();
    expect(events('connect').at(-1)).toEqual({ type: 'connect', slug: 'max-mueller', text: 'Hi Max, great work!' });
    expect(await driver.connect(url('kim-classic'), 'Hi Kim')).toBe('sent');
    await settle();
    expect(events('connect').at(-1)).toEqual({ type: 'connect', slug: 'kim-classic', text: 'Hi Kim' });
    expect(events('wrong')).toEqual([]);
  }, 60_000);

  it('finds Connect inside the More menu and can invite without a note', async () => {
    expect(await driver.connect(url('lena-hidden'), '')).toBe('sent');
    await settle();
    expect(events('connect').at(-1)).toEqual({ type: 'connect', slug: 'lena-hidden', text: '' });
    expect(await driver.connect(url('lars-classic'), '')).toBe('sent');
    await settle();
    expect(events('connect').at(-1)).toEqual({ type: 'connect', slug: 'lars-classic', text: '' });
    expect(events('wrong')).toEqual([]);
  }, 60_000);

  it('invites through the custom-invite page when the Connect link leads there', async () => {
    expect(await driver.connect(url('nina-navigate'), 'Hello Nina')).toBe('sent');
    await settle();
    expect(events('connect').at(-1)).toEqual({ type: 'connect', slug: 'nina-navigate', text: 'Hello Nina' });
  }, 30_000);

  it('recognises existing connections and pending invites, and withdraws', async () => {
    expect(await driver.connect(url('jane-doe'), 'hi')).toBe('already_connected');
    expect(await driver.connect(url('carl-classic'), 'hi')).toBe('already_connected');
    expect(await driver.connect(url('pat-pending'), 'hi')).toBe('already_pending');
    expect(await driver.withdrawInvite(url('pat-pending'))).toBe(true);
    await settle();
    expect(events('withdraw')).toHaveLength(1);
  }, 60_000);

  it('messages a connection through the shadow-root composer, keeping line breaks, then closes it', async () => {
    await driver.sendMessage(url('jane-doe'), 'Hello Jane,\nthanks for connecting.');
    await settle();
    expect(events('message').at(-1)).toEqual({ type: 'message', slug: 'jane-doe', text: 'Hello Jane,\nthanks for connecting.' });
    expect(events('close').at(-1)).toEqual({ type: 'close', slug: 'jane-doe' });
    // The bubble left open with someone else's draft (which links to Jane from a shared profile) was not touched.
    expect(events('wrong')).toEqual([]);
    // A new bubble that doesn't link to Lucy yet opens to the left of the stale one: the new one is still used.
    await driver.sendMessage(url('lucy-late'), 'Hello Lucy');
    await settle();
    expect(events('message').at(-1)).toEqual({ type: 'message', slug: 'lucy-late', text: 'Hello Lucy' });
    expect(events('close').at(-1)).toEqual({ type: 'close', slug: 'lucy-late' });
    expect(events('wrong')).toEqual([]);
    await driver.sendMessage(url('carl-classic'), 'Hello Carl,\nthanks.');
    await settle();
    expect(events('message').at(-1)).toEqual({ type: 'message', slug: 'carl-classic', text: 'Hello Carl,\nthanks.' });
  }, 60_000);

  it('reports a message box that never opens as worth retrying, not as "can\'t message this person"', async () => {
    await expect(driver.sendMessage(url('sam-slow'), 'Hello Sam')).rejects.toMatchObject({ code: 'TRANSIENT' });
    expect(events('message').filter((e) => e.slug === 'sam-slow')).toEqual([]);
  }, 60_000);

  it('follows, endorses and likes, leaving people already followed alone', async () => {
    await driver.follow(url('lena-hidden'));
    await driver.follow(url('jane-doe'));
    expect(await driver.endorse(url('jane-doe'), 2)).toBe(2);
    expect(await driver.likeRecentPost(url('jane-doe'))).toBe(true);
    expect(await driver.likeRecentPost(url('carl-classic'))).toBe(true);
    await settle();
    expect(events('follow')).toEqual([{ type: 'follow', slug: 'lena-hidden' }]);
    expect(events('endorse')).toHaveLength(2);
    expect(events('like').map((e) => e.slug)).toEqual(['jane-doe', 'carl-classic']);
    expect(events('wrong')).toEqual([]);
  }, 60_000);

  it('collects search results across pages, leaving out mutual connections, and stops at the end', async () => {
    const people = await driver.search('https://www.linkedin.com/search/results/people/?keywords=founder', 50);
    expect(people).toHaveLength(20);
    expect(people[3]).toMatchObject({ publicId: 'person-3', firstName: 'Person', lastName: '3', headline: 'Founder at Co 3', location: 'Berlin' });
    expect(people.filter((p) => p.publicId.startsWith('mutual-'))).toEqual([]);
  }, 60_000);

  it('reads recent connections and the inbox', async () => {
    const conns = await driver.recentConnections(10);
    expect(conns.map((c) => [c.publicId, c.firstName, c.headline])).toEqual([
      ['jane-doe', 'Jane', 'Head of Growth at Northwind'],
      ['lucy-late', 'Lucy', 'Head of Growth at Northwind'],
      ['sam-slow', 'Sam', 'Head of Growth at Northwind'],
      ['carl-classic', 'Carl', 'Head of Growth at Northwind'],
    ]);
    const threads = await driver.inbox(0);
    // Messages of the bubble open beside the threads (Ollie's) are in neither thread.
    expect(threads[0]).toMatchObject({ threadId: '2-abc', unread: true, participant: { publicId: 'jane-doe', name: 'Jane Doe' } });
    expect(threads[0].messages.map((m) => [m.direction, m.body])).toEqual([
      ['out', 'Hi Jane! Bea is great too: linkedin.com/in/bea-other'],
      ['in', 'Hey Sam, sure.'],
    ]);
    // 2026 thread: no profile link in the thread (the one in our message is Alex's), so it comes from the
    // name's hovercard; only our own message, so the name comes from the title bar.
    expect(threads[1]).toMatchObject({ threadId: '2-def', unread: false, participant: { publicId: 'olga-open', name: 'Olga Open', profileUrl: 'https://www.linkedin.com/in/olga-open/' } });
    expect(threads[1].messages.map((m) => [m.direction, m.body, m.externalId])).toEqual([['out', 'Hi Olga! You should meet Alex.', 'urn:li:msg:3']]);
  }, 60_000);

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
    await expect(driver.sendInMail(url('kim-classic'), { subject: 'x', body: 'x', via: 'sales_navigator' })).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
  }, 60_000);

  it('reports missing profiles and security checkpoints as distinct errors', async () => {
    await expect(driver.viewProfile(url('nobody-here'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    redirectToCheckpoint = true;
    await expect(driver.viewProfile(url('jane-doe'))).rejects.toMatchObject({ code: 'CHECKPOINT' });
    redirectToCheckpoint = false;
  }, 30_000);

  it('keeps a working session when the own profile card is slow, and says when nothing could be read', async () => {
    try {
      // The card never draws, but the page is still the profile: the title has the name.
      state.self = 'slow';
      expect((await driver.checkSession()).name).toBe('Sam Sender');
      // Neither card nor title: try again later, rather than asking to sign in again.
      state.self = 'blank';
      await expect(driver.checkSession()).rejects.toMatchObject({ code: 'TRANSIENT' });
    } finally {
      state.self = undefined;
    }
  }, 60_000);

  it('never used a control that belongs to someone else', () => {
    expect(events('wrong')).toEqual([]);
  });
});

// The page readers against the scrubbed snapshots of the live 2026 markup (fixtures/linkedin-2026:
// names are NAME or TTTT, slugs SLUG). No network: each snapshot is put into a blank page.
describe.skipIf(!haveBrowser)('LinkedIn 2026 snapshots (scrubbed live markup)', () => {
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/linkedin-2026/${name}`, import.meta.url), 'utf8');
  // The class LinkedIn hid the second degree line with on 2026-11-06; the snapshots carry no CSS.
  const liveCss = '.gvyaz2 { display: none; }';
  const eventSelectors = { threadEvent: SEL.threadEvent, eventSender: SEL.eventSender, eventBody: SEL.eventBody, eventUrn: SEL.eventUrn, bubble: SEL.overlayBubble };
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ executablePath });
    page = await browser.newPage();
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
  });

  // The snapshots were taken from the live DOM, which holds nestings HTML parsing can't produce (a
  // search result is a link with links inside, a message body is a <p> of <p>s), so they are parsed as
  // XHTML and moved into the page.
  async function mount(file: string, css = liveCss) {
    const xhtml = fixture(file).replace(/<(br|input|img|hr)\b([^>]*?)\/?>/g, '<$1$2/>');
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body></body></html>`);
    await page.evaluate((html) => {
      const doc = new DOMParser().parseFromString(`<main xmlns="http://www.w3.org/1999/xhtml">${html}</main>`, 'application/xhtml+xml');
      if (doc.querySelector('parsererror')) throw new Error(doc.querySelector('parsererror')!.textContent ?? 'XHTML parse error');
      document.body.replaceChildren(document.importNode(doc.documentElement, true));
    }, xhtml);
  }

  it('reads the top card of a stranger, a connection and a 1st-degree profile by structure', async () => {
    await mount('profile-stranger-topcard.html');
    const stranger = (await page.evaluate(topCardSnapshot))!;
    expect(stranger).toMatchObject({ layout: 'h2', heading: 'TTTTTTTTTTTT' });
    const s = parseTopCardLines(stranger.lines);
    expect(s).toMatchObject({ degree: 2, headline: 'TTTTTTTTTTTT', location: 'TTTTTTTT', hasContactInfo: true });
    expect(stranger.chips.map((c) => c.kind)).toEqual(['company', 'school']);
    expect(companyFromCard(stranger.chips, s.companyLine)).toBe('TTTTTTTTTTTT');

    await mount('profile-2nd-topcard.html');
    const connection = (await page.evaluate(topCardSnapshot))!;
    expect(parseTopCardLines(connection.lines)).toMatchObject({ degree: 1, headline: 'TTTTTTTTTTTT', location: 'TTTTTTTTTTTT', hasContactInfo: true });

    await mount('profile-1st-topcard.html');
    const first = (await page.evaluate(topCardSnapshot))!;
    const f = parseTopCardLines(first.lines);
    expect(f).toMatchObject({ degree: 1, location: 'TTTTTTTTTTTT', hasContactInfo: true });
    // Only a school chip: the company is not guessed from it.
    expect(first.chips.map((c) => c.kind)).toEqual(['school']);
    expect(companyFromCard(first.chips, f.companyLine)).toBe('');
  });

  it('reads only the degree line a person can see, however the hidden copy is hidden', async () => {
    // The hidden '· 1st' copy comes before the visible '· 2nd'; read as 1st, a stranger would never be invited.
    const hidings = ['.gvyaz2 { visibility: hidden; }', '.gvyaz2 > p { opacity: 0; }', '.gvyaz2 > p { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }'];
    for (const css of hidings) {
      await mount('profile-stranger-topcard.html', css);
      const snap = (await page.evaluate(topCardSnapshot))!;
      expect(snap.lines.filter((l) => /^· \d/.test(l)), css).toEqual(['· 2nd']);
      expect(parseTopCardLines(snap.lines).degree, css).toBe(2);
    }
  });

  it('finds the top card controls by the labels the driver uses', async () => {
    await mount('profile-stranger-topcard.html');
    const card = page.locator('main h2').first().locator('xpath=ancestor::section[1]');
    expect(await card.count()).toBe(1);
    // Each control is there twice: the visible row and LinkedIn's hidden copy.
    expect(await card.getByRole('link', { name: LABELS.connect }).count()).toBe(2);
    expect(await card.getByRole('link', { name: LABELS.connect }).first().getAttribute('href')).toBe('/preload/custom-invite/?vanityName=SLUG');
    expect(await card.getByRole('link', { name: LABELS.message }).count()).toBe(2);
    expect(await card.getByRole('button', { name: LABELS.more }).count()).toBe(2);
    expect(await card.locator(SEL.contactInfoLink).count()).toBe(1);
  });

  it('finds Follow in a stranger’s More menu and Following in a connection’s', async () => {
    await mount('profile-stranger-more-menu.html');
    const items = page.locator(SEL.menuItems);
    expect(await items.count()).toBe(6);
    const texts = await items.allInnerTexts();
    expect(texts.filter((t) => LABELS.follow.test(t.trim()))).toEqual(['Follow']);
    expect(await items.locator('[aria-label]').first().getAttribute('aria-label')).toBe('Follow NAME');

    await mount('profile-1st-more-menu.html');
    const own = (await page.locator(SEL.menuItems).allInnerTexts()).map((t) => t.trim());
    expect(own.filter((t) => LABELS.following.test(t))).toEqual(['Following']);
    expect(own.filter((t) => LABELS.follow.test(t) || LABELS.connect.test(t))).toEqual([]);
  });

  it('reads a connections card without <li>, and a search result without its mutual connections', async () => {
    await mount('connections-card.html');
    expect(await page.evaluate(connectionRows, 10)).toEqual([{ url: 'https://www.linkedin.com/in/SLUG/', name: 'TTTTTTTTTTTT', occupation: 'TTTTTTTTTTTT' }]);

    await mount('search-result.html');
    const rows = await page.evaluate(profileLinkRows, SEL.searchResultLinks);
    expect(rows).toHaveLength(1);
    expect(rows[0].href).toBe('https://www.linkedin.com/in/SLUG/');
    expect(rows[0].lines.slice(0, 4)).toEqual(['TTTTTTTTTTTTTTTTT', 'TTTTTTTTTTTT', 'TTTTTTTTTTTT', 'Connect']);
  });

  it('reads a message thread and the composer the 2026 bubble holds', async () => {
    await mount('messaging-thread.html');
    const events = await page.evaluate(threadEvents, eventSelectors);
    expect(events).toHaveLength(1);
    expect(events[0].sender).toBe('TTTTTTTTTTTT');
    expect(events[0].urn).toMatch(/^urn:li:X:ID,/);
    expect(events[0].body).toContain('TTTTTTTTTTTT');
    // The live thread has no profile link at all: the participant is behind the name's hovercard button.
    expect(await page.locator('.msg-thread a[href*="/in/"]').count()).toBe(0);
    expect(await page.locator(SEL.threadHeaderLink).count()).toBe(0);
    expect(await page.locator(SEL.threadParticipantTrigger).first().getAttribute('aria-controls')).toBe('artdeco-hoverable-artdeco-gen-43');

    await mount('message-composer.html');
    expect(await page.locator(SEL.messageBubble).count()).toBe(1);
    expect(await page.locator(SEL.dialog).count()).toBe(0);
    expect(await page.locator(SEL.messageBox).getAttribute('aria-label')).toBe('Write a message…');
    expect(await page.locator(SEL.messageSend).isDisabled()).toBe(true);
    // The bubble names its participant in its own profile card.
    expect(await page.locator(SEL.messageBubble).filter({ has: page.locator(SEL.bubbleOwnerLink('slug')) }).count()).toBe(1);
    expect(await page.locator(SEL.messageBubble).filter({ has: page.locator(SEL.bubbleOwnerLink('someone-else')) }).count()).toBe(0);
    // Expand comes first, close second; the close selector picks close.
    expect(await page.locator(SEL.messageOverlayClose).last().locator('svg').getAttribute('data-test-icon')).toBe('close-small');
  });

  it('never reads a conversation bubble’s messages as the open thread’s', async () => {
    const event = (who: string) =>
      `<li class="msg-s-message-list__event"><div data-event-urn="urn:${who}"><span class="msg-s-message-group__name">${who}</span><p class="msg-s-event-listitem__body">From ${who}</p></div></li>`;
    const bubble = (who: string) => `<div class="msg-overlay-conversation-bubble"><ul>${event(who)}</ul></div>`;
    // 2026: the bubble is in the shadow root on div#interop-outlet, and the thread has not rendered yet.
    await page.setContent(`<main><div class="msg-convo-wrapper msg-thread"></div></main><div id="interop-outlet"></div>`);
    await page.evaluate((html) => (document.getElementById('interop-outlet')!.attachShadow({ mode: 'open' }).innerHTML = html), bubble('Bea'));
    expect(await page.evaluate(threadEvents, eventSelectors)).toEqual([]);
    // Older layout: the bubble sits in the document next to the thread.
    await page.setContent(`${bubble('Bea')}<div class="msg-convo-wrapper msg-thread"><ul>${event('Ann')}</ul></div>`);
    expect((await page.evaluate(threadEvents, eventSelectors)).map((e) => e.sender)).toEqual(['Ann']);
  });

  it('finds the like toggle by its 2026 label', async () => {
    await mount('activity-social-bar.html');
    expect(await page.locator(SEL.likeButtons).count()).toBe(1);
    expect(await page.locator(SEL.likeButtons).getAttribute('aria-label')).toBe('Reaction button state: no reaction');
  });
});
