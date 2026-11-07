import { createHash } from 'node:crypto';
import type { BrowserContext, Locator, Page } from 'playwright';
import {
  DriverError,
  profileUrl,
  publicIdFromUrl,
  type ConnectResult,
  type EngagerFilter,
  type InboxThread,
  type InMail,
  type LinkedInDriver,
  type Person,
  type SessionInfo,
} from '../types.js';
import {
  companyFromCard,
  connectionRows,
  nameFromTitle,
  namesOtherPerson,
  parseDegree,
  parseTopCardLines,
  profileLinkRows,
  threadEvents,
  topCardSnapshot,
  type LinkRow,
  type TopCardSnapshot,
} from './parse.js';
import { BLOCKED_PATHS, LABELS, SEL, URLS } from './selectors.js';

// Drives a real Chromium session logged in with the member's `li_at` cookie. Each account gets
// its own persistent profile directory and (optionally) its own proxy, and every step is paced
// with small randomized pauses, scrolling and per-key typing so it reads as a person using the site.

export interface BrowserSpec {
  userDataDir: string;
  proxyUrl?: string | null;
  headless?: boolean;
  executablePath?: string;
  timezone?: string;
}

export type ContextOptions = ReturnType<typeof contextOptions>;
export type ContextLauncher = (userDataDir: string, options: ContextOptions) => Promise<BrowserContext>;

export interface PlaywrightOptions extends BrowserSpec {
  liAt: string;
  // 'browser': the session was signed in inside this profile (drivers/browser-login.ts). The profile's own
  // li_at is then the live one: LinkedIn ties a session to the browser that created it and rotates the
  // cookie, so putting the stored copy back would only break it. 'pasted' (the default) adds the stored one.
  sessionOrigin?: 'pasted' | 'browser' | null;
  // Called with the profile's li_at when a browser-owned session no longer matches the stored one, and the
  // value the driver last knew to be stored (what the new one replaces).
  onSessionCookie?: (liAt: string, previous: string) => void;
  // Opens the persistent context; tests pass a fake so no browser starts.
  launch?: ContextLauncher;
  // Tests use this to route linkedin.com to local fixtures.
  onContext?: (ctx: BrowserContext) => Promise<void>;
  // Multiplies every human-like pause (tests use 0).
  pace?: number;
  // How long to wait for a profile's card to render (default 15 s; tests shorten it).
  readyTimeoutMs?: number;
  // How long to wait for the message composer after clicking Message (default 20 s; tests shorten it).
  composerTimeoutMs?: number;
}

// What a session problem tells the user to do. A pasted cookie often stops working in OpenReach's browser
// while the browser it came from stays signed in, so signing in inside OpenReach's own window comes first.
export const RELOGIN_HINT = 'Use "Sign in in a browser window" on the Accounts page, or paste a fresh li_at cookie.';

// The automated session and the sign-in window open the same profile with the same options, so LinkedIn
// sees one device.
export function contextOptions(o: Omit<BrowserSpec, 'userDataDir'>) {
  return {
    headless: o.headless ?? true,
    executablePath: o.executablePath,
    proxy: o.proxyUrl ? parseProxy(o.proxyUrl) : undefined,
    viewport: { width: 1366, height: 860 },
    locale: 'en-US',
    timezoneId: o.timezone,
    args: ['--disable-blink-features=AutomationControlled'],
  };
}

export const launchContext: ContextLauncher = async (userDataDir, options) => {
  let pw: typeof import('playwright');
  try {
    pw = await import('playwright');
  } catch {
    throw new DriverError('TRANSIENT', 'Playwright is not installed. Run `npm install playwright` in server/.');
  }
  return pw.chromium.launchPersistentContext(userDataDir, options);
};

// The li_at the profile holds for linkedin.com, if any.
export async function profileLiAt(ctx: Pick<BrowserContext, 'cookies'>): Promise<string | null> {
  const cookies = await ctx.cookies('https://www.linkedin.com/');
  return cookies.find((c) => c.name === 'li_at' && /(^|\.)linkedin\.com$/.test(c.domain.replace(/^\./, '')) && c.value)?.value ?? null;
}

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

export class PlaywrightLinkedInDriver implements LinkedInDriver {
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private selfName = '';
  // The li_at last known to be stored for the account; a browser-owned session reports changes against it.
  private known: string;

  constructor(private o: PlaywrightOptions) {
    this.known = o.liAt;
  }

  private async open(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    // A context left from a closed page is replaced, not leaked.
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.ctx = await (this.o.launch ?? launchContext)(this.o.userDataDir, contextOptions(this.o));
    // A browser-owned session stays as the profile has it; the stored copy only fills in a profile without one.
    const own = this.o.sessionOrigin === 'browser' ? await profileLiAt(this.ctx).catch(() => null) : null;
    if (own) this.report(own);
    else {
      await this.ctx.addCookies([
        { name: 'li_at', value: this.o.liAt, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' },
      ]);
    }
    await this.o.onContext?.(this.ctx);
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.page.setDefaultTimeout(20_000);
    return this.page;
  }

  private report(liAt: string) {
    if (liAt === this.known) return;
    const previous = this.known;
    this.known = liAt;
    this.o.onSessionCookie?.(liAt, previous);
  }

  // LinkedIn rotates li_at now and then; a browser-owned session's new value is handed back to be stored.
  private async syncCookie() {
    if (this.o.sessionOrigin !== 'browser' || !this.ctx) return;
    const v = await profileLiAt(this.ctx).catch(() => null);
    if (v) this.report(v);
  }

  private async pause(lo = 0.8, hi = 2.4) {
    await new Promise((r) => setTimeout(r, rand(lo, hi) * 1000 * (this.o.pace ?? 1)));
  }

  private async go(url: string): Promise<Page> {
    const page = await this.open();
    // LinkedIn's pages are heavy; on a busy laptop the first load can take well over 20 s.
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((e: Error) => {
      // An invalid li_at typically sends LinkedIn into a login redirect loop.
      if (/ERR_TOO_MANY_REDIRECTS/.test(e.message)) throw new DriverError('SESSION_EXPIRED', `LinkedIn keeps redirecting, so it does not accept this session in OpenReach's browser. ${RELOGIN_HINT}`);
      throw new DriverError('TRANSIENT', `Navigation failed: ${e.message.split('\n')[0]}`);
    });
    this.guard(page);
    if (res && res.status() === 999) throw new DriverError('LIMIT_REACHED', 'LinkedIn is throttling this account (HTTP 999)');
    if (res && res.status() === 404) throw new DriverError('NOT_FOUND', `Page not found: ${url}`);
    await this.pause(1.5, 3.5);
    this.guard(page);
    return page;
  }

  private guard(page: Page) {
    const path = new URL(page.url()).pathname;
    if (BLOCKED_PATHS.checkpoint.test(path)) throw new DriverError('CHECKPOINT', `LinkedIn is asking for a security verification. ${RELOGIN_HINT}`);
    if (BLOCKED_PATHS.sessionExpired.test(path)) throw new DriverError('SESSION_EXPIRED', `The LinkedIn session is no longer valid. ${RELOGIN_HINT}`);
  }

  private async browse(page: Page) {
    for (let i = 0; i < Math.round(rand(1, 3)); i++) {
      await page.mouse.move(rand(200, 1100), rand(150, 700), { steps: Math.round(rand(5, 15)) });
      await page.mouse.wheel(0, rand(200, 600));
      await this.pause(0.4, 1.2);
    }
    await page.mouse.wheel(0, -2000);
  }

  private async firstText(page: Page, selectors: string | string[]): Promise<string> {
    for (const s of [selectors].flat()) {
      const t = await page.locator(s).first().innerText({ timeout: 1500 }).catch(() => '');
      if (t.trim()) return t.trim().split('\n')[0].trim();
    }
    return '';
  }

  // Waits for the profile's top card, which LinkedIn renders by script several seconds after the document
  // loads. False when it never shows.
  private async profileReady(page: Page): Promise<boolean> {
    const ok = await page.locator(SEL.profileReady).first().waitFor({ state: 'visible', timeout: this.o.readyTimeoutMs ?? 15_000 }).then(() => true, () => false);
    this.guard(page);
    return ok;
  }

  // Opens a profile and waits for its top card. A page that loaded but never rendered one is retried later.
  private async openProfile(url: string): Promise<Page> {
    const page = await this.go(url);
    if (!(await this.profileReady(page))) throw new DriverError('TRANSIENT', 'The profile page did not finish loading');
    return page;
  }

  // The section around the profile's name. Actions are looked up only in here: the rest of the page
  // shows other people's Connect and Follow buttons (People you may know).
  private async topCard(page: Page): Promise<Locator | null> {
    const h1 = page.locator('main h1');
    const heading = (await h1.count()) ? h1.first() : page.locator('main h2').first();
    const card = heading.locator('xpath=ancestor::section[1]');
    return (await card.count()) ? card.first() : null;
  }

  // The profile's name. The title ("Name | LinkedIn") is the most reliable source in the 2026 layout.
  private async nameOf(page: Page, snap?: TopCardSnapshot | null): Promise<string> {
    snap ??= await page.evaluate(topCardSnapshot).catch(() => null);
    return nameFromTitle(await page.title().catch(() => '')) || snap?.heading || (await this.firstText(page, SEL.profileName));
  }

  // Name, headline, location, degree and company from the top card, in either layout.
  private async readProfile(page: Page) {
    const snap = await page.evaluate(topCardSnapshot).catch(() => null);
    const name = await this.nameOf(page, snap);
    if (snap?.layout === 'h2') {
      const f = parseTopCardLines(snap.lines);
      return { name, headline: f.headline, location: f.location, degree: f.degree, company: companyFromCard(snap.chips, f.companyLine) };
    }
    const headline = await this.firstText(page, SEL.profileHeadline);
    const location = await this.firstText(page, SEL.profileLocation);
    const degree = parseDegree(await this.firstText(page, SEL.profileDegree));
    const companyLabel = (await page.locator(SEL.currentCompany).first().getAttribute('aria-label', { timeout: 1500 }).catch(() => null)) ?? '';
    const company = companyLabel.replace(/^Current company:\s*/i, '').replace(/\.\s*Click.*$/i, '').trim();
    return { name, headline, location, degree, company };
  }

  // The first visible control in `list` whose label doesn't name someone other than `person`. The 2026
  // top card is rendered twice (one copy hidden), so the first match is not always the one on screen.
  private async firstVisible(list: Locator, person = ''): Promise<Locator | null> {
    for (let i = 0; i < (await list.count()); i++) {
      const el = list.nth(i);
      if (!(await el.isVisible())) continue;
      if (person && namesOtherPerson(await controlLabel(el), person)) continue;
      return el;
    }
    return null;
  }

  // Finds a profile action (a button or a link) by accessible name in the top card, opening the "More"
  // menu if it is tucked away there. `person` is the profile's name: a control naming anyone else is
  // never returned.
  private async profileAction(page: Page, label: RegExp, person = ''): Promise<Locator | null> {
    const card = await this.topCard(page);
    if (!card) return null;
    const direct = await this.firstVisible(card.getByRole('button', { name: label }).or(card.getByRole('link', { name: label })), person);
    if (direct) return direct;
    const more = await this.firstVisible(card.getByRole('button', { name: LABELS.more }));
    if (!more) return null;
    await more.click();
    await this.pause(0.5, 1.2);
    const items = page.locator(SEL.menuItems);
    await items.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    for (let i = 0; i < (await items.count()); i++) {
      const item = items.nth(i);
      if (!(await item.isVisible())) continue;
      // A 2026 item's text is often one word ("Follow") while an inner element is labelled "Follow Jane Doe".
      const inner = (await item.locator('[aria-label]').count()) ? await item.locator('[aria-label]').first().getAttribute('aria-label') : null;
      const names = [await controlLabel(item), inner ?? ''].filter(Boolean);
      if (names.some((n) => label.test(n)) && !names.some((n) => namesOtherPerson(n, person))) return item;
    }
    await page.keyboard.press('Escape');
    return null;
  }

  private async type(locator: Locator, text: string) {
    await locator.click();
    for (const ch of text) {
      await locator.page().keyboard.type(ch, { delay: rand(25, 90) * (this.o.pace ?? 1) });
    }
  }

  // Marks the composers already open before clicking Message, and counts the dialogs, so what the click
  // opens can be told apart. New bubbles open to the left of old ones, so the last composer is not
  // necessarily the new one.
  private async composerBaseline(page: Page, boxSel: string): Promise<ComposerBaseline> {
    await page.locator(boxSel).evaluateAll((els) => els.forEach((el) => el.setAttribute('data-or-seen', '1')));
    return { dialogs: await page.locator(SEL.dialog).count() };
  }

  // Waits for the composer that clicking Message opened. LinkedIn keeps conversation bubbles open across
  // pages, so a bubble whose own profile card or header links to this person comes first (a link further
  // down, in a message or a shared profile, can be anyone), then a new dialog holding a composer (Sales
  // Navigator), then a composer that was not there before. A new dialog without one (an InMail upsell,
  // say) is LinkedIn's answer instead: 'declined'. Nothing at all before the deadline is null: on a busy
  // computer the bubble can be slow, and that is worth another try, not a verdict on the person. The
  // profile URL may have redirected (a URN to the vanity name), so both ids count.
  private async waitForComposer(page: Page, url: string, boxSel: string, before: ComposerBaseline): Promise<{ box: Locator; scope: Locator } | 'declined' | null> {
    const ids = [...new Set([publicIdFromUrl(url), publicIdFromUrl(page.url())].filter((id): id is string => !!id))];
    const own = ids.map((id) => SEL.bubbleOwnerLink(encodeURIComponent(id))).join(', ');
    const bubble = own ? page.locator(SEL.messageBubble).filter({ has: page.locator(own) }) : null;
    const fresh = page.locator(boxSel).and(page.locator(':not([data-or-seen])'));
    const dialogs = page.locator(SEL.dialog);
    const deadline = Date.now() + (this.o.composerTimeoutMs ?? 20_000);
    let answeredAt = 0;
    while (Date.now() < deadline) {
      if (bubble && (await bubble.locator(boxSel).count())) return this.pinComposer(page, bubble.last().locator(boxSel).last());
      if ((await dialogs.count()) > before.dialogs) {
        const d = dialogs.last();
        if (await d.locator(boxSel).count()) return this.pinComposer(page, d.locator(boxSel).last());
        answeredAt ||= Date.now();
        if (Date.now() - answeredAt > 1500) return 'declined';
      }
      if (await fresh.count()) return this.pinComposer(page, fresh.first());
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  // Tags the chosen composer and the bubble, dialog or form around it, so typing, Send and close all stay
  // on that one even when other bubbles (with their own enabled Send buttons) are open.
  private async pinComposer(page: Page, box: Locator): Promise<{ box: Locator; scope: Locator }> {
    const token = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    await box.evaluate(
      (el, a) => {
        el.setAttribute('data-or-box', a.token);
        let scope: Element | null = el.closest(a.container);
        // A composer outside any bubble or dialog: the nearest element that also holds a Send button.
        for (let n: Node | null = el; n && !scope; n = n instanceof ShadowRoot ? n.host : n.parentNode) {
          if (n instanceof Element && n.querySelector(a.send)) scope = n;
        }
        (scope ?? el).setAttribute('data-or-composer', a.token);
      },
      { token, container: `${SEL.messageBubble}, ${SEL.dialog}`, send: SEL.messageSend },
    );
    return { box: page.locator(`[data-or-box="${token}"]`), scope: page.locator(`[data-or-composer="${token}"]`) };
  }

  // Closes the composer's bubble after sending, so it doesn't pile up on later pages.
  private async closeComposer(scope: Locator) {
    const close = scope.locator(SEL.messageOverlayClose).last();
    if (await close.count()) await close.click({ timeout: 3000 }).catch(() => {});
  }

  async checkSession(): Promise<SessionInfo> {
    const page = await this.go(URLS.me);
    let name = (await this.profileReady(page)) ? (await this.readProfile(page)).name : '';
    const where = new URL(page.url()).pathname;
    if (!name && /^\/in\//.test(where)) {
      // Still on a profile, so the session works (guard() catches login and checkpoint pages): the card is
      // slow or laid out in a way the driver doesn't know. The title still has the name; without it, try later.
      name = nameFromTitle(await page.title().catch(() => ''));
      if (!name) throw new DriverError('TRANSIENT', `The logged-in profile did not finish loading (LinkedIn showed ${where})`);
    }
    if (!name) throw new DriverError('SESSION_EXPIRED', `Could not read the logged-in profile (LinkedIn showed ${where}). ${RELOGIN_HINT}`);
    this.selfName = name;
    await this.syncCookie();
    return { name, profileUrl: page.url().split('?')[0] };
  }

  async viewProfile(url: string): Promise<Person> {
    const page = await this.openProfile(url);
    await this.browse(page);
    const { name: full, headline, location, degree, company } = await this.readProfile(page);
    const [firstName, ...rest] = full.split(/\s+/);
    const title = headline.includes(' at ') ? headline.split(' at ')[0].trim() : headline;

    let email: string | null = null;
    let phone: string | null = null;
    const contact = (await this.topCard(page))?.locator(SEL.contactInfoLink).first();
    if (degree === 1 && contact && (await contact.count())) {
      await contact.click();
      const modal = page.locator(SEL.dialog).last();
      await modal.waitFor({ timeout: 10_000 }).catch(() => {});
      await this.pause(0.8, 1.8);
      email = (await modal.locator('a[href^="mailto:"]').first().innerText({ timeout: 1500 }).catch(() => '')).trim() || null;
      phone = (await modal.locator('section:has(h3:text-is("Phone")) span').first().innerText({ timeout: 1000 }).catch(() => '')).trim() || null;
      const close = modal.locator(SEL.modalClose).first();
      if (await close.count()) await close.click({ timeout: 3000 }).catch(() => page.keyboard.press('Escape'));
      else await page.keyboard.press('Escape');
    }

    const finalUrl = page.url().split('?')[0];
    const publicId = publicIdFromUrl(finalUrl) ?? publicIdFromUrl(url)!;
    return { publicId, profileUrl: profileUrl(publicId), firstName: firstName ?? '', lastName: rest.join(' '), headline, title, company, location, email, phone, degree };
  }

  async follow(url: string) {
    const page = await this.openProfile(url);
    const name = await this.nameOf(page);
    if (await this.profileAction(page, LABELS.following, name)) {
      // Already following; the item may sit in an open menu.
      await page.keyboard.press('Escape');
      return;
    }
    const btn = await this.profileAction(page, LABELS.follow, name);
    if (!btn) throw new DriverError('NOT_AVAILABLE', 'No Follow option on this profile');
    await btn.click();
    await this.pause();
  }

  async endorse(url: string, count: number) {
    const page = await this.go(url.replace(/\/?$/, '/') + 'details/skills/');
    await this.browse(page);
    const buttons = page.locator(SEL.endorseButtons);
    const n = Math.min(count, await buttons.count());
    if (!n) throw new DriverError('NOT_AVAILABLE', 'No skills available to endorse');
    for (let i = 0; i < n; i++) {
      // Each click turns the button into "Endorsed", so always take the first remaining one.
      await buttons.first().scrollIntoViewIfNeeded();
      await buttons.first().click();
      await this.pause(1, 2.5);
    }
    return n;
  }

  async likeRecentPost(url: string) {
    const page = await this.go(url.replace(/\/?$/, '/') + 'recent-activity/all/');
    await this.browse(page);
    const like = page.locator(SEL.likeButtons).first();
    if (!(await like.count())) return false;
    await like.scrollIntoViewIfNeeded();
    await like.click();
    await this.pause();
    return true;
  }

  async connect(url: string, note: string): Promise<ConnectResult> {
    const page = await this.openProfile(url);
    await this.browse(page);
    const { name, degree } = await this.readProfile(page);
    if (degree === 1) return 'already_connected';
    if (await this.profileAction(page, LABELS.pending, name)) {
      await page.keyboard.press('Escape');
      return 'already_pending';
    }
    const btn = await this.profileAction(page, LABELS.connect, name);
    if (!btn) throw new DriverError('NOT_AVAILABLE', 'No Connect option on this profile');
    // 2026: Connect is a link to /preload/custom-invite/?vanityName=..., which LinkedIn opens as a dialog.
    const href = await btn.getAttribute('href').catch(() => null);
    await btn.click();
    await this.pause();

    const dialog = page.locator(SEL.dialog).first();
    let opened = await dialog.waitFor({ timeout: 10_000 }).then(() => true, () => false);
    if (!opened && href && /custom-invite/.test(href) && !/custom-invite/.test(page.url())) {
      // The click did nothing visible: open the invitation page the link points to.
      await this.go(new URL(href, page.url()).toString());
      opened = await dialog.waitFor({ timeout: 10_000 }).then(() => true, () => false);
    }
    if (!opened) throw new DriverError('NOT_AVAILABLE', 'The invitation dialog did not open');
    if (await dialog.locator(SEL.inviteEmail).count()) {
      await page.keyboard.press('Escape');
      throw new DriverError('NOT_AVAILABLE', 'LinkedIn requires their email address to connect');
    }
    if (note.trim()) {
      const add = dialog.getByRole('button', { name: LABELS.addNote });
      if (await add.count()) {
        await add.click();
        await this.pause(0.6, 1.4);
        if (LABELS.premiumNoteUpsell.test(await dialog.innerText().catch(() => ''))) {
          // Free accounts get a few notes per month; fall back to a plain invite.
          await page.keyboard.press('Escape');
          await btn.click({ timeout: 5000 }).catch(() => {});
          await this.pause();
        } else {
          await this.type(dialog.locator(SEL.inviteNote).first(), note);
          await this.pause();
        }
      }
    }
    const send = dialog.getByRole('button', { name: note.trim() ? LABELS.sendInvite : LABELS.sendWithoutNote });
    const fallback = dialog.getByRole('button', { name: LABELS.sendInvite });
    await ((await send.count()) ? send : fallback).first().click();
    await this.pause(1.5, 3);
    const body = await page.locator('body').innerText().catch(() => '');
    if (LABELS.weeklyLimit.test(body)) throw new DriverError('LIMIT_REACHED', 'LinkedIn weekly invitation limit reached');
    return 'sent';
  }

  async withdrawInvite(url: string) {
    const page = await this.openProfile(url);
    const name = await this.nameOf(page);
    const pending = await this.profileAction(page, LABELS.pending, name);
    if (!pending) return false;
    await pending.click();
    await this.pause();
    await page.locator(SEL.dialog).getByRole('button', { name: LABELS.withdraw }).first().click();
    await this.pause();
    return true;
  }

  async sendMessage(url: string, text: string) {
    const page = await this.openProfile(url);
    const name = await this.nameOf(page);
    const btn = await this.profileAction(page, LABELS.message, name);
    if (!btn) throw new DriverError('NOT_AVAILABLE', 'No Message option on this profile');
    const before = await this.composerBaseline(page, SEL.messageBox);
    // 2026: Message is a link to /messaging/compose/...; LinkedIn opens it as a bubble on the same page.
    await btn.click();
    const composer = await this.waitForComposer(page, url, SEL.messageBox, before);
    if (!composer || composer === 'declined') {
      await page.keyboard.press('Escape');
      if (!composer) throw new DriverError('TRANSIENT', 'The message box did not open in time');
      throw new DriverError('NOT_AVAILABLE', 'Messaging is not open for this person (InMail required)');
    }
    await this.pause();
    // Shift+Enter keeps paragraphs inside one message instead of sending early.
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      await this.type(composer.box, lines[i]);
      if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
    }
    await this.pause();
    await composer.scope.locator(SEL.messageSend).last().click();
    await this.pause(1.5, 3);
    await this.closeComposer(composer.scope);
  }

  async recentConnections(limit: number): Promise<Person[]> {
    const page = await this.go(URLS.connections);
    await page.locator(SEL.connectionLinks).first().waitFor({ timeout: 15_000 }).catch(() => {});
    const people = await page.evaluate(connectionRows, limit);
    return people.flatMap((p) => {
      const id = publicIdFromUrl(p.url);
      if (!id) return [];
      const [firstName, ...rest] = p.name.split(/\s+/);
      return [{ publicId: id, profileUrl: profileUrl(id), firstName, lastName: rest.join(' '), headline: p.occupation, degree: 1 as const }];
    });
  }

  async inbox(_since: number, maxThreads = 15): Promise<InboxThread[]> {
    if (!this.selfName) await this.checkSession();
    const page = await this.go(URLS.messaging);
    const items = page.locator(SEL.threadItem);
    await items.first().waitFor().catch(() => {});
    const n = Math.min(maxThreads, await items.count());
    const threads: InboxThread[] = [];
    for (let i = 0; i < n; i++) {
      const item = items.nth(i);
      const unread = (await item.locator(SEL.threadUnread).count()) > 0;
      await item.click();
      await this.pause(1, 2);
      // The thread's own messages, not those of a bubble left open on the page.
      await page.locator('.msg-thread').locator(SEL.threadEvent).first().waitFor({ timeout: 3000 }).catch(() => {});
      const raw = await this.threadParticipantHref(page);
      const href = raw ? new URL(raw, page.url()).toString().split('?')[0] : '';
      const threadId = page.url().match(/thread\/([^/]+)/)?.[1] ?? `idx-${i}`;
      const events = await page.evaluate(threadEvents, { threadEvent: SEL.threadEvent, eventSender: SEL.eventSender, eventBody: SEL.eventBody, eventUrn: SEL.eventUrn, bubble: SEL.overlayBubble });
      const participantId = publicIdFromUrl(href);
      // The name comes from their messages, else from the thread's title (when only we have written).
      const other = events.find((e) => e.sender && e.sender !== this.selfName)?.sender || (await this.firstText(page, SEL.threadTitle));
      const now = Date.now();
      threads.push({
        threadId,
        participant: { name: other, publicId: participantId, profileUrl: participantId ? profileUrl(participantId) : href },
        lastMessageAt: now,
        unread,
        // LinkedIn shows only coarse times; messages are stamped when first seen and deduplicated by id.
        messages: events.map((e) => ({
          externalId: e.urn || createHash('sha1').update(threadId + e.sender + e.body).digest('hex'),
          direction: e.sender === this.selfName ? ('out' as const) : ('in' as const),
          body: e.body,
          sentAt: now,
        })),
      });
    }
    return threads;
  }

  // The open thread's participant's profile link, or null when it can't be told (the engine then matches
  // the thread by name). Older threads link the name in the header; a link inside a message is never used.
  // 2026 threads have no link: the header's name is a button whose hovercard holds it. Best effort: the
  // hovercard was not captured in the live check.
  private async threadParticipantHref(page: Page): Promise<string | null> {
    const direct = await page
      .locator(SEL.threadHeaderLink)
      .evaluateAll((els, skip) => els.find((el) => !el.closest(skip))?.getAttribute('href') ?? null, `${SEL.threadEvent}, ${SEL.overlayBubble}`)
      .catch(() => null);
    if (direct) return direct;
    const trigger = page.locator(SEL.threadParticipantTrigger).first();
    const cardId = (await trigger.count()) ? await trigger.getAttribute('aria-controls') : null;
    if (!cardId) return null;
    await trigger.hover({ timeout: 3000 }).catch(() => {});
    // The card is rendered into the trigger's wrapper, with the id the trigger names.
    const link = page.locator(`[id="${cardId}"] a[href*="/in/"]`).or(trigger.locator('xpath=..').locator('a[href*="/in/"]')).first();
    const href = await link.waitFor({ state: 'attached', timeout: 3000 }).then(
      () => link.getAttribute('href'),
      () => null,
    );
    await page.mouse.move(rand(5, 40), rand(5, 40)).catch(() => {});
    return href;
  }

  async search(url: string, limit: number, onPage?: (found: number) => void): Promise<Person[]> {
    const found = new Map<string, Person>();
    for (let pageNo = 1; found.size < limit && pageNo <= 100; pageNo++) {
      const u = new URL(url);
      u.searchParams.set('page', String(pageNo));
      const page = await this.go(u.toString());
      await this.browse(page);
      const before = found.size;
      for (const r of await readLinks(page, SEL.searchResultLinks)) {
        const p = linkToPerson(r, true);
        if (!p || found.has(p.publicId)) continue;
        found.set(p.publicId, p);
        if (found.size >= limit) break;
      }
      onPage?.(found.size);
      if (found.size === before) break; // no new results: last page
      await this.pause(3, 7);
    }
    return [...found.values()];
  }

  // Reads people from profile links matching `selector`, then asks `more` for the next batch (a
  // "Show more" button or infinite scroll) until `limit` people are found or nothing new appears.
  private async collectList(page: Page, selector: string, found: Map<string, Person>, limit: number, more: () => Promise<boolean>, onPage?: (found: number) => void) {
    for (let round = 0; found.size < limit && round < 200; round++) {
      const before = found.size;
      for (const r of await readLinks(page, selector)) {
        const p = linkToPerson(r);
        if (p && !found.has(p.publicId)) found.set(p.publicId, p);
        if (found.size >= limit) break;
      }
      onPage?.(found.size);
      if (found.size >= limit || (!(await more()) && found.size === before)) break;
      await this.pause(1.5, 3.5);
    }
  }

  // Clicks a "show more" button inside `scope` if there is one, else scrolls; true when the list may have grown.
  private async showMore(page: Page, scope: Locator, label: RegExp, selector: string): Promise<boolean> {
    const count = await page.locator(selector).count();
    const button = scope.getByRole('button', { name: label }).first();
    if ((await button.count()) && (await button.isVisible())) {
      await button.scrollIntoViewIfNeeded();
      await button.click();
    } else {
      await scope.hover().catch(() => {});
      await page.mouse.wheel(0, 2500);
    }
    await this.pause(1, 2);
    return (await page.locator(selector).count()) > count;
  }

  // Best effort: the reactions list opens from the post's reaction count; commenters are read from the
  // post's comment list, loading more comments as needed. Not tested against the live site.
  async postEngagers(postUrl: string, which: EngagerFilter, limit: number, onPage?: (found: number) => void): Promise<Person[]> {
    const page = await this.go(postUrl);
    await this.browse(page);
    const found = new Map<string, Person>();
    if (which.likers) {
      const count = page.locator('main').getByRole('button', { name: LABELS.reactionsCount }).first();
      if (await count.count()) {
        await count.click();
        await this.pause();
        const dialog = page.locator(SEL.reactionsDialog).last();
        await this.collectList(page, SEL.reactorLinks, found, limit, () => this.showMore(page, dialog, LABELS.showMoreResults, SEL.reactorLinks), onPage);
        await page.keyboard.press('Escape');
        await this.pause(0.5, 1.2);
      }
    }
    if (which.commenters && found.size < limit) {
      const main = page.locator('main').first();
      await this.collectList(page, SEL.commentAuthorLinks, found, limit, () => this.showMore(page, main, LABELS.moreComments, SEL.commentAuthorLinks), onPage);
    }
    return [...found.values()];
  }

  // Best effort: an event's attendee list is a people search behind the event page's "attendees" link,
  // which LinkedIn only shows to people who can see the attendees (usually fellow attendees).
  async eventAttendees(eventUrl: string, limit: number, onPage?: (found: number) => void): Promise<Person[]> {
    const page = await this.go(eventUrl);
    const link = page.getByRole('link', { name: LABELS.eventAttendees }).first();
    const href = (await link.count()) ? await link.getAttribute('href') : null;
    if (!href) throw new DriverError('NOT_AVAILABLE', "This event doesn't show its attendees to this account (attend it first)");
    await this.pause();
    return this.search(new URL(href, page.url()).toString(), limit, onPage);
  }

  // Best effort: the member list of a group the account belongs to, loaded with "Show more results".
  async groupMembers(groupUrl: string, limit: number, onPage?: (found: number) => void): Promise<Person[]> {
    const id = groupUrl.match(/\/groups\/([^/?#]+)/)?.[1];
    if (!id) throw new DriverError('NOT_FOUND', `Not a LinkedIn group URL: ${groupUrl}`);
    const page = await this.go(URLS.groupMembers(decodeURIComponent(id)));
    if (!(await page.locator(SEL.groupMemberLinks).first().waitFor({ timeout: 8000 }).then(() => true, () => false))) {
      throw new DriverError('NOT_AVAILABLE', 'Only members of this group can see its member list');
    }
    const found = new Map<string, Person>();
    const main = page.locator('main').first();
    await this.collectList(page, SEL.groupMemberLinks, found, limit, () => this.showMore(page, main, LABELS.showMoreResults, SEL.groupMemberLinks), onPage);
    return [...found.values()];
  }

  // Best effort: the profile's Message button opens the InMail composer (subject + body) for members you
  // aren't connected to, when the account has credits or the profile is open; otherwise LinkedIn shows a
  // Premium upsell. With Sales Navigator the message is written from the lead's Sales Navigator page.
  async sendInMail(url: string, msg: InMail) {
    const page = await this.openProfile(url);
    await this.browse(page);
    const name = await this.nameOf(page);
    let before: ComposerBaseline;
    if (msg.via === 'sales_navigator') {
      const open = await this.profileAction(page, LABELS.viewInSalesNav, name);
      if (!open) throw new DriverError('NOT_AVAILABLE', 'No "View in Sales Navigator" option on this profile (is Sales Navigator active on this account?)');
      await open.click();
      await page.waitForURL(/\/sales\//, { timeout: 20_000 }).catch(() => {
        throw new DriverError('NOT_AVAILABLE', 'Sales Navigator did not open');
      });
      this.guard(page);
      await this.pause(1.5, 3.5);
      const btn = page.locator('main').getByRole('button', { name: LABELS.message }).first();
      if (!(await btn.count())) throw new DriverError('NOT_AVAILABLE', 'No Message option for this lead in Sales Navigator');
      before = await this.composerBaseline(page, SEL.inmailBody);
      await btn.click();
    } else {
      const btn = await this.profileAction(page, LABELS.message, name);
      if (!btn) throw new DriverError('NOT_AVAILABLE', 'No Message option on this profile (InMail needs Premium credits or an open profile)');
      before = await this.composerBaseline(page, SEL.inmailBody);
      await btn.click();
    }
    await this.pause();

    // Either the composer opens or LinkedIn answers with a dialog (Premium upsell, no credits left).
    const composer = await this.waitForComposer(page, url, SEL.inmailBody, before);
    await this.pause(0.5, 1.2);
    if (!composer) {
      await page.keyboard.press('Escape');
      throw new DriverError('TRANSIENT', 'The InMail composer did not open in time');
    }
    if (composer === 'declined') {
      const dialog = await page.locator(SEL.dialog).last().innerText({ timeout: 1000 }).catch(() => '');
      await page.keyboard.press('Escape');
      if (LABELS.inmailNoCredits.test(dialog)) throw new DriverError('LIMIT_REACHED', 'No InMail credits left');
      throw new DriverError('NOT_AVAILABLE', 'No InMail credits and the profile is not open');
    }
    const scope = composer.scope;
    const subject = scope.locator(SEL.inmailSubject).last();
    if (msg.subject.trim() && (await subject.count())) {
      await this.type(subject, msg.subject);
      await this.pause(0.5, 1.2);
    }
    const lines = msg.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      await this.type(composer.box, lines[i]);
      if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
    }
    await this.pause();
    const send = scope.locator(SEL.messageSend).last();
    await ((await send.count()) ? send : scope.getByRole('button', { name: LABELS.send }).last()).click();
    await this.pause(1.5, 3);
    if (LABELS.inmailNoCredits.test(await page.locator(SEL.dialog).last().innerText({ timeout: 1000 }).catch(() => ''))) {
      throw new DriverError('LIMIT_REACHED', 'No InMail credits left');
    }
    await this.closeComposer(composer.scope);
  }

  async close() {
    await this.syncCookie();
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.page = null;
  }
}

interface ComposerBaseline {
  dialogs: number;
}

// The aria-label of a control, else the first line of its text.
async function controlLabel(el: Locator): Promise<string> {
  const aria = await el.getAttribute('aria-label').catch(() => null);
  if (aria?.trim()) return aria.trim();
  return ((await el.innerText({ timeout: 1000 }).catch(() => '')) || '').trim().split('\n')[0].trim();
}

// Profile links on a list page (search results, reactions, comments, members) with their card's text.
function readLinks(page: Page, selector: string): Promise<LinkRow[]> {
  return page.evaluate(profileLinkRows, selector);
}

// Name from the link, headline (and on search results, location) from the card's next lines. Hidden members ("LinkedIn Member") are skipped.
function linkToPerson(r: LinkRow, withLocation = false): Person | null {
  const id = publicIdFromUrl(r.href);
  if (!id || !r.name || /LinkedIn Member/i.test(r.name)) return null;
  const [firstName, ...rest] = r.name.replace(/\s*[•·].*$/, '').split(/\s+/);
  const after = r.lines.filter((l) => !l.includes(r.name) && !/^(•|·|Connect|Message|Follow|View|Like|Reply)/.test(l) && !/degree connection/i.test(l));
  return { publicId: id, profileUrl: profileUrl(id), firstName, lastName: rest.join(' '), headline: after[0] ?? '', location: withLocation ? (after[1] ?? '') : '' };
}

function parseProxy(raw: string) {
  const u = new URL(raw);
  return {
    server: `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}
