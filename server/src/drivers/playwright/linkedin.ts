import { createHash } from 'node:crypto';
import type { BrowserContext, Locator, Page } from 'playwright';
import {
  DriverError,
  profileUrl,
  publicIdFromUrl,
  type ConnectResult,
  type InboxThread,
  type LinkedInDriver,
  type Person,
  type SessionInfo,
} from '../types.js';
import { BLOCKED_PATHS, LABELS, SEL, URLS } from './selectors.js';

// Drives a real Chromium session logged in with the member's `li_at` cookie. Each account gets
// its own persistent profile directory and (optionally) its own proxy, and every step is paced
// with small randomized pauses, scrolling and per-key typing so it reads as a person using the site.

export interface PlaywrightOptions {
  liAt: string;
  userDataDir: string;
  proxyUrl?: string | null;
  headless?: boolean;
  executablePath?: string;
  timezone?: string;
}

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

export class PlaywrightLinkedInDriver implements LinkedInDriver {
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private selfName = '';

  constructor(private o: PlaywrightOptions) {}

  private async open(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    let pw: typeof import('playwright');
    try {
      pw = await import('playwright');
    } catch {
      throw new DriverError('TRANSIENT', 'Playwright is not installed. Run `npm install playwright` in server/.');
    }
    const proxy = this.o.proxyUrl ? parseProxy(this.o.proxyUrl) : undefined;
    this.ctx = await pw.chromium.launchPersistentContext(this.o.userDataDir, {
      headless: this.o.headless ?? true,
      executablePath: this.o.executablePath,
      proxy,
      viewport: { width: 1366, height: 860 },
      locale: 'en-US',
      timezoneId: this.o.timezone,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    await this.ctx.addCookies([
      { name: 'li_at', value: this.o.liAt, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' },
    ]);
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.page.setDefaultTimeout(20_000);
    return this.page;
  }

  private async pause(lo = 0.8, hi = 2.4) {
    await new Promise((r) => setTimeout(r, rand(lo, hi) * 1000));
  }

  private async go(url: string): Promise<Page> {
    const page = await this.open();
    const res = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e: Error) => {
      throw new DriverError('TRANSIENT', `Navigation failed: ${e.message}`);
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
    if (BLOCKED_PATHS.checkpoint.test(path)) throw new DriverError('CHECKPOINT', 'LinkedIn is asking for a security verification; log in manually once');
    if (BLOCKED_PATHS.sessionExpired.test(path)) throw new DriverError('SESSION_EXPIRED', 'The li_at session cookie is no longer valid');
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

  // Finds a profile action by accessible name, opening the "More" menu if it is tucked away there.
  private async profileAction(page: Page, label: RegExp): Promise<Locator | null> {
    const card = page.locator(SEL.topCard).first();
    const direct = card.getByRole('button', { name: label });
    for (let i = 0; i < (await direct.count()); i++) {
      if (await direct.nth(i).isVisible()) return direct.nth(i);
    }
    const more = card.getByRole('button', { name: LABELS.more });
    if (await more.count()) {
      await more.first().click();
      await this.pause(0.5, 1.2);
      const items = page.locator(SEL.dropdownItems);
      for (let i = 0; i < (await items.count()); i++) {
        const item = items.nth(i);
        const name = (await item.getAttribute('aria-label')) ?? (await item.innerText().catch(() => ''));
        if (label.test(name.trim()) && (await item.isVisible())) return item;
      }
      await page.keyboard.press('Escape');
    }
    return null;
  }

  private async type(locator: Locator, text: string) {
    await locator.click();
    for (const ch of text) {
      await locator.page().keyboard.type(ch, { delay: rand(25, 90) });
    }
  }

  async checkSession(): Promise<SessionInfo> {
    const page = await this.go(URLS.me);
    const name = await this.firstText(page, SEL.profileName);
    if (!name) throw new DriverError('SESSION_EXPIRED', 'Could not read the logged-in profile');
    this.selfName = name;
    return { name, profileUrl: page.url().split('?')[0] };
  }

  async viewProfile(url: string): Promise<Person> {
    const page = await this.go(url);
    await page.locator(SEL.profileName).first().waitFor().catch(() => {
      throw new DriverError('NOT_FOUND', 'Profile did not load');
    });
    await this.browse(page);
    const full = await this.firstText(page, SEL.profileName);
    const [firstName, ...rest] = full.split(/\s+/);
    const headline = await this.firstText(page, SEL.profileHeadline);
    const location = await this.firstText(page, SEL.profileLocation);
    const degreeText = await this.firstText(page, SEL.profileDegree);
    const degree = /1st/.test(degreeText) ? 1 : /2nd/.test(degreeText) ? 2 : /3rd/.test(degreeText) ? 3 : null;
    const companyLabel = (await page.locator(SEL.currentCompany).first().getAttribute('aria-label').catch(() => null)) ?? '';
    const company = companyLabel.replace(/^Current company:\s*/i, '').replace(/\.\s*Click.*$/i, '').trim();
    const title = headline.includes(' at ') ? headline.split(' at ')[0].trim() : headline;

    let email: string | null = null;
    let phone: string | null = null;
    if (degree === 1 && (await page.locator(SEL.contactInfoLink).count())) {
      await page.locator(SEL.contactInfoLink).first().click();
      const modal = page.locator(SEL.contactModal).first();
      await modal.waitFor().catch(() => {});
      await this.pause(0.8, 1.8);
      email = (await modal.locator('a[href^="mailto:"]').first().innerText({ timeout: 1500 }).catch(() => '')).trim() || null;
      phone = (await modal.locator('section:has(h3:text-is("Phone")) span').first().innerText({ timeout: 1000 }).catch(() => '')).trim() || null;
      await page.locator(SEL.modalClose).first().click().catch(() => page.keyboard.press('Escape'));
    }

    const finalUrl = page.url().split('?')[0];
    const publicId = publicIdFromUrl(finalUrl) ?? publicIdFromUrl(url)!;
    return { publicId, profileUrl: profileUrl(publicId), firstName: firstName ?? '', lastName: rest.join(' '), headline, title, company, location, email, phone, degree };
  }

  async follow(url: string) {
    const page = await this.go(url);
    if (await this.profileAction(page, LABELS.following)) return;
    const btn = await this.profileAction(page, LABELS.follow);
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
    const page = await this.go(url);
    await this.browse(page);
    if (/1st/.test(await this.firstText(page, SEL.profileDegree))) return 'already_connected';
    if (await this.profileAction(page, LABELS.pending)) return 'already_pending';
    const btn = await this.profileAction(page, LABELS.connect);
    if (!btn) throw new DriverError('NOT_AVAILABLE', 'No Connect option on this profile');
    await btn.click();
    await this.pause();

    const dialog = page.getByRole('dialog').first();
    await dialog.waitFor().catch(() => {});
    if (await page.locator(SEL.inviteEmail).count()) {
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
          await btn.click().catch(() => {});
          await this.pause();
        } else {
          await this.type(page.locator(SEL.inviteNote).first(), note);
          await this.pause();
        }
      }
    }
    const send = page.getByRole('dialog').first().getByRole('button', { name: note.trim() ? LABELS.sendInvite : LABELS.sendWithoutNote });
    const fallback = page.getByRole('dialog').first().getByRole('button', { name: LABELS.sendInvite });
    await ((await send.count()) ? send : fallback).first().click();
    await this.pause(1.5, 3);
    const body = await page.locator('body').innerText().catch(() => '');
    if (LABELS.weeklyLimit.test(body)) throw new DriverError('LIMIT_REACHED', 'LinkedIn weekly invitation limit reached');
    return 'sent';
  }

  async withdrawInvite(url: string) {
    const page = await this.go(url);
    const pending = await this.profileAction(page, LABELS.pending);
    if (!pending) return false;
    await pending.click();
    await this.pause();
    await page.getByRole('dialog').getByRole('button', { name: LABELS.withdraw }).click();
    await this.pause();
    return true;
  }

  async sendMessage(url: string, text: string) {
    const page = await this.go(url);
    const btn = await this.profileAction(page, LABELS.message);
    if (!btn) throw new DriverError('NOT_AVAILABLE', 'No Message option on this profile');
    await btn.click();
    const box = page.locator(SEL.messageBox).last();
    await box.waitFor().catch(() => {
      throw new DriverError('NOT_AVAILABLE', 'Messaging is not open for this person (InMail required)');
    });
    await this.pause();
    // Shift+Enter keeps paragraphs inside one message instead of sending early.
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      await this.type(box, lines[i]);
      if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
    }
    await this.pause();
    await page.locator(SEL.messageSend).last().click();
    await this.pause(1.5, 3);
    await page.locator(SEL.messageOverlayClose).last().click().catch(() => {});
  }

  async recentConnections(limit: number): Promise<Person[]> {
    const page = await this.go(URLS.connections);
    await page.locator('main a[href*="/in/"]').first().waitFor().catch(() => {});
    const people = await page.evaluate((max) => {
      const out: { url: string; name: string; occupation: string }[] = [];
      const seen = new Set<string>();
      for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('main a[href*="/in/"]'))) {
        const url = a.href.split('?')[0];
        const name = a.innerText.trim().split('\n')[0];
        if (!name || seen.has(url)) continue;
        seen.add(url);
        const card = a.closest('li');
        const lines = (card?.innerText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
        out.push({ url, name, occupation: lines.find((l) => l !== name && !/^(Message|Connected)/.test(l)) ?? '' });
        if (out.length >= max) break;
      }
      return out;
    }, limit);
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
      const href = (await page.locator(SEL.threadHeaderLink).first().getAttribute('href').catch(() => null)) ?? '';
      const threadId = page.url().match(/thread\/([^/]+)/)?.[1] ?? `idx-${i}`;
      const events = await page.evaluate((s) => {
        let sender = '';
        return Array.from(document.querySelectorAll(s.threadEvent)).flatMap((li) => {
          sender = (li.querySelector(s.eventSender) as HTMLElement | null)?.innerText.trim() || sender;
          const body = (li.querySelector(s.eventBody) as HTMLElement | null)?.innerText.trim() ?? '';
          const urn = li.querySelector(s.eventUrn)?.getAttribute('data-event-urn') ?? '';
          return body ? [{ sender, body, urn }] : [];
        });
      }, SEL);
      const participantId = publicIdFromUrl(href);
      const other = events.find((e) => e.sender && e.sender !== this.selfName)?.sender ?? '';
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

  async search(url: string, limit: number, onPage?: (found: number) => void): Promise<Person[]> {
    const found = new Map<string, Person>();
    for (let pageNo = 1; found.size < limit && pageNo <= 100; pageNo++) {
      const u = new URL(url);
      u.searchParams.set('page', String(pageNo));
      const page = await this.go(u.toString());
      await this.browse(page);
      const rows = await page.evaluate((sel) => {
        return Array.from(document.querySelectorAll<HTMLAnchorElement>(sel)).map((a) => {
          const card = a.closest('li') ?? a.parentElement;
          const lines = (card?.textContent ? (card as HTMLElement).innerText : '').split('\n').map((l) => l.trim()).filter(Boolean);
          return { href: a.href.split('?')[0], name: a.innerText.trim().split('\n')[0], lines };
        });
      }, SEL.searchResultLinks);
      const before = found.size;
      for (const r of rows) {
        const id = publicIdFromUrl(r.href);
        if (!id || found.has(id) || !r.name || /LinkedIn Member/i.test(r.name)) continue;
        const [firstName, ...rest] = r.name.replace(/\s*[•·].*$/, '').split(/\s+/);
        const after = r.lines.filter((l) => !l.includes(r.name) && !/^(•|Connect|Message|Follow|View)/.test(l) && !/degree connection/i.test(l));
        found.set(id, { publicId: id, profileUrl: profileUrl(id), firstName, lastName: rest.join(' '), headline: after[0] ?? '', location: after[1] ?? '' });
        if (found.size >= limit) break;
      }
      onPage?.(found.size);
      if (found.size === before) break; // no new results: last page
      await this.pause(3, 7);
    }
    return [...found.values()];
  }

  async close() {
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.page = null;
  }
}

function parseProxy(raw: string) {
  const u = new URL(raw);
  return {
    server: `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}
