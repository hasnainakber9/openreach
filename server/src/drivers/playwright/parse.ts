// Reading LinkedIn pages: pure helpers that turn what a page shows into fields, and the functions the
// driver runs inside the page (passed to page.evaluate) to collect it.
//
// The functions that run inside the page are serialized with toString(), so they must not use anything
// from this module and must not bind named inner functions: tsx (the dev server) wraps those in a
// `__name(...)` helper that does not exist in the page. Object-literal methods and inline loops are fine.

// The contact-info link's place among the top card's lines (the location is the line before it).
export const CONTACT_MARK = '[contact-info]';

export interface TopCardSnapshot {
  // 'h1': the older profile layout (name in main h1, classed elements). 'h2': the 2026 layout (no h1,
  // obfuscated classes; the name is the first h2 in main and the details are plain <p> lines).
  layout: 'h1' | 'h2';
  heading: string;
  // Visible <p> lines of the 2026 top card in page order, leaving out links and company/school chips.
  lines: string[];
  // The company and school chips of the 2026 top card, told apart by their icon.
  chips: { kind: 'company' | 'school' | ''; text: string }[];
}

// Runs in the page. The top card is the section around the profile's name. In the 2026 layout every
// detail is a <p>, rendered twice where LinkedIn keeps a hidden copy (the degree, for one), so only lines
// a person can see count. The snapshots carry no CSS, so how the copy is hidden is not known: lines that
// are display:none, visibility:hidden, transparent or clipped to a pixel (screen-reader only) are all left out.
export function topCardSnapshot(): TopCardSnapshot | null {
  const h1 = document.querySelector('main h1');
  const heading = h1 ?? document.querySelector('main h2');
  if (!heading) return null;
  const out: TopCardSnapshot = {
    layout: h1 ? 'h1' : 'h2',
    heading: ((heading as HTMLElement).innerText || heading.textContent || '').replace(/\s+/g, ' ').trim(),
    lines: [],
    chips: [],
  };
  const section = heading.closest('section');
  if (h1 || !section) return out;
  for (const p of Array.from(section.querySelectorAll('p'))) {
    if (!p.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || p.getBoundingClientRect().width <= 1 || p.getBoundingClientRect().height <= 1) continue;
    if (p.querySelector('a[href*="overlay/contact-info"]')) {
      out.lines.push('[contact-info]');
      continue;
    }
    // Chips, the mutual-connections link and buttons carry their own text; they are not detail lines.
    if (p.closest('a, button, [role="button"]')) continue;
    const text = (p.innerText || p.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) out.lines.push(text);
  }
  for (const chip of Array.from(section.querySelectorAll('[role="button"]'))) {
    if (!chip.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || chip.getBoundingClientRect().width <= 1) continue;
    const icon = chip.querySelector('svg[id]')?.id ?? '';
    const text = ((chip as HTMLElement).innerText || chip.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) out.chips.push({ kind: /^company/.test(icon) ? 'company' : /^school/.test(icon) ? 'school' : '', text });
  }
  return out;
}

export interface TopCardFields {
  degree: 1 | 2 | 3 | null;
  pronouns: string;
  headline: string;
  // "Company · School" as one line, when LinkedIn shows it as text.
  companyLine: string;
  location: string;
  hasContactInfo: boolean;
}

const DEGREE = /^[·•]?\s*(1st|2nd|3rd\+?)$/i;
const PRONOUNS = /^(he|she|they|xe|ze|ey|fae|it)\s*\/\s*(him|his|her|hers|them|theirs|they|she|he|xem|xyr|zir|hir|em|eir|faer|its)(\s*\/\s*\w+)?$/i;
// Follower and connection counts, which follow the location when there is no contact-info link.
const STATS = /\b(connections?|followers?|mutual)\b/i;

export function parseDegree(text: string): 1 | 2 | 3 | null {
  return /1st/.test(text) ? 1 : /2nd/.test(text) ? 2 : /3rd/.test(text) ? 3 : null;
}

// Reads the 2026 top card's lines by their order: degree, pronouns (own profile), headline, a
// "Company · School" line, location, then the contact-info link. Class names are obfuscated and change,
// so nothing here depends on them.
export function parseTopCardLines(lines: string[]): TopCardFields {
  let degree: TopCardFields['degree'] = null;
  let pronouns = '';
  let hasContactInfo = false;
  const rest: string[] = [];
  for (const line of lines) {
    if (line === CONTACT_MARK) {
      hasContactInfo = true;
      break;
    }
    if (DEGREE.test(line)) {
      degree ??= parseDegree(line);
      continue;
    }
    // Separators ("·") between the location and the contact-info link.
    if (line.length < 2) continue;
    if (PRONOUNS.test(line)) {
      pronouns ||= line;
      continue;
    }
    rest.push(line);
  }
  const info = hasContactInfo ? rest : rest.filter((l) => !STATS.test(l)).slice(0, 3);
  return {
    degree,
    pronouns,
    headline: info[0] ?? '',
    companyLine: info.length > 2 ? info[1] : '',
    location: info.length > 1 ? info[info.length - 1] : '',
    hasContactInfo,
  };
}

// The current company: its chip when the top card shows chips (a school-only card has none), else the
// first part of the "Company · School" line.
export function companyFromCard(chips: TopCardSnapshot['chips'], companyLine: string): string {
  const chip = chips.find((c) => c.kind === 'company');
  if (chip) return chip.text;
  if (chips.some((c) => c.kind)) return '';
  return companyLine.split(/\s+[·•]\s+/)[0]?.trim() ?? '';
}

// A profile page's title is "Name | LinkedIn", with "(3) " in front when there are notifications.
export function nameFromTitle(title: string): string {
  const name = title.match(/^\s*(?:\(\d+\+?\)\s*)?(.+?)\s*\|\s*LinkedIn\s*$/i)?.[1]?.trim() ?? '';
  if (!name || /^linkedin$/i.test(name) || /\b(log ?in|sign ?in|sign ?up|feed|messaging|notifications)\b/i.test(name)) return '';
  return name;
}

// True when a control's label names someone else ("Invite Alex Example to connect" on Jane's profile).
// The page also shows other people's Invite and Follow buttons (People you may know), so an action is
// only taken when its label is about this person or names nobody.
export function namesOtherPerson(label: string, person: string): boolean {
  const m = label.trim().match(/^(?:Invite|Follow|Unfollow|Following|Message|Send a message to|Pending, click to withdraw invitation sent to)\s+(.+?)(?:\s+to connect)?$/i);
  if (!m || !person.trim()) return false;
  const words = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1);
  const own = new Set(words(person));
  return !words(m[1]).some((w) => own.has(w));
}

export interface ConnectionRow {
  url: string;
  name: string;
  occupation: string;
}

// Runs in the page. The 2026 connections page has no <li> cards: each person has a photo link and a
// name link, and the name link holds the name and occupation lines. The older layout kept the
// occupation in the card's <li>.
export function connectionRows(max: number): ConnectionRow[] {
  const out: ConnectionRow[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('main a[href*="/in/"]'))) {
    const url = a.href.split('?')[0];
    const lines = (a.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const name = lines[0] ?? '';
    if (!name || seen.has(url)) continue;
    seen.add(url);
    let occupation = lines[1] ?? '';
    if (!occupation) {
      const card = a.closest('li') as HTMLElement | null;
      const cardLines = (card?.innerText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
      occupation = cardLines.find((l) => l !== name && !/^(Message|Connected)/.test(l)) ?? '';
    }
    out.push({ url, name, occupation });
    if (out.length >= max) break;
  }
  return out;
}

export interface LinkRow {
  href: string;
  name: string;
  lines: string[];
}

// Runs in the page: profile links on a list page (search results, reactions, comments, members) with
// their card's text. A 2026 search result is one big profile link with more links inside (the name, and
// mutual connections), so links inside another profile link are left out, and in a card only the first
// person counts: later links there are mutual connections or @mentions, not results.
export function profileLinkRows(selector: string): LinkRow[] {
  const rows: LinkRow[] = [];
  const owners = new Map<Element, string>();
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>(selector))) {
    let nested = false;
    for (let el = a.parentElement; el && !nested; el = el.parentElement) nested = el.matches('a[href*="/in/"], a[href*="/sales/lead/"]');
    if (nested) continue;
    const href = a.href.split('?')[0];
    const id = href.match(/\/(?:in|sales\/lead)\/([^/?#]+)/)?.[1] ?? href;
    const name = (a.innerText || '').trim().split('\n')[0].trim();
    const listCard = a.closest('li, article');
    const card = (listCard ?? (a.querySelector('p, div') ? a : a.parentElement)) as HTMLElement | null;
    if (card && (listCard || card === a)) {
      const owner = owners.get(card);
      if (owner && owner !== id) continue;
      if (!owner && name) owners.set(card, id);
    }
    const lines = (card?.innerText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    rows.push({ href, name, lines });
  }
  return rows;
}

export interface ThreadEvent {
  sender: string;
  body: string;
  urn: string;
}

// Runs in the page: the messages of the open thread. Conversation bubbles (other people's conversations,
// kept open across pages) hold messages too, in the document in the older layout and in the open shadow
// root on div#interop-outlet in 2026; theirs are never this thread's. Other shadow roots are searched only
// when the document has no thread messages, in case LinkedIn moves the thread itself into one.
export function threadEvents(s: { threadEvent: string; eventSender: string; eventBody: string; eventUrn: string; bubble: string }): ThreadEvent[] {
  let items = Array.from(document.querySelectorAll(s.threadEvent)).filter((li) => !li.closest(s.bubble));
  if (!items.length) {
    for (const el of Array.from(document.querySelectorAll('*'))) {
      if (el.shadowRoot) items = items.concat(Array.from(el.shadowRoot.querySelectorAll(s.threadEvent)).filter((li) => !li.closest(s.bubble)));
    }
  }
  let sender = '';
  const out: ThreadEvent[] = [];
  for (const li of items) {
    sender = ((li.querySelector(s.eventSender) as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ').trim() || sender;
    const body = (li.querySelector(s.eventBody) as HTMLElement | null)?.innerText.trim() ?? '';
    const urn = li.querySelector(s.eventUrn)?.getAttribute('data-event-urn') ?? '';
    if (body) out.push({ sender, body, urn });
  }
  return out;
}
