import { createHash } from 'node:crypto';
import type { Clock } from '../clock.js';
import { HOUR } from '../clock.js';
import type { DB } from '../db/db.js';
import {
  DriverError,
  profileUrl,
  publicIdFromUrl,
  type ConnectResult,
  type InboxThread,
  type LinkedInDriver,
  type Person,
  type SessionInfo,
} from './types.js';

// A fake LinkedIn network for demos and tests. People are generated deterministically from
// their profile slug; invitations are accepted and messages answered with configurable odds
// after realistic delays, so campaigns behave the way they would against the real site.

export interface SimulatorOptions {
  acceptRate: number;
  replyRate: number;
  acceptHours: [number, number];
  replyHours: [number, number];
  latencyMs: number;
  random: () => number;
}

export const DEFAULT_SIM: SimulatorOptions = {
  acceptRate: 0.45,
  replyRate: 0.3,
  acceptHours: [1, 72],
  replyHours: [1, 36],
  latencyMs: 0,
  random: Math.random,
};

const FIRST = ['Ava', 'Liam', 'Sofia', 'Noah', 'Amara', 'Mateo', 'Hana', 'Omar', 'Chloe', 'Ravi', 'Lena', 'Kwame', 'Mei', 'Diego', 'Zara', 'Ethan', 'Aisha', 'Lucas', 'Ingrid', 'Tariq', 'Maya', 'Jonas', 'Priya', 'Felix'];
const LAST = ['Thompson', 'Okafor', 'Rossi', 'Nakamura', 'Haddad', 'Fernandez', 'Kowalski', 'Mensah', 'Chen', 'Iyer', 'Schmidt', 'Dubois', 'Khan', 'Silva', 'Novak', 'Andersen', 'Park', 'Mbeki', 'Costa', 'Weber'];
const TITLES = ['Head of Growth', 'VP Sales', 'Founder & CEO', 'Marketing Director', 'Talent Partner', 'CTO', 'Revenue Operations Lead', 'Product Manager', 'Account Executive', 'COO'];
const COMPANIES = ['Northwind Labs', 'Brightpath', 'Kestrel Analytics', 'Lumen Health', 'Harborline', 'Quantia', 'Fieldnote', 'Orbital Freight', 'Greenleaf Energy', 'Copperhill', 'Tessellate', 'Bluefin Pay'];
const CITIES = ['London, UK', 'Berlin, Germany', 'Austin, TX', 'Toronto, Canada', 'Lagos, Nigeria', 'Singapore', 'Karachi, Pakistan', 'Dubai, UAE', 'Sydney, Australia', 'Lisbon, Portugal'];
const REPLIES = [
  'Thanks for reaching out! Happy to chat, what does your calendar look like next week?',
  'Hi, appreciate the note. Not a priority for us right now, maybe next quarter.',
  'Interesting, can you send over a few more details?',
  "Thanks! We're actually looking at this now. Let's talk.",
  'Not interested, thanks.',
];

function seeded(key: string) {
  const h = createHash('sha256').update(key).digest();
  let i = 0;
  return (n: number) => h.readUInt32BE((i++ % 7) * 4) % n;
}

export function simPerson(publicId: string): Person {
  const pick = seeded(publicId);
  // Slugs from simulated searches look like "ava-thompson-3f2a1c"; keep those names.
  const slug = publicId.match(/^([a-z]+)-([a-z]+)-[0-9a-f]{6}$/);
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  const firstName = slug ? cap(slug[1]) : FIRST[pick(FIRST.length)];
  const lastName = slug ? cap(slug[2]) : LAST[pick(LAST.length)];
  const title = TITLES[pick(TITLES.length)];
  const company = COMPANIES[pick(COMPANIES.length)];
  const hasEmail = pick(10) < 4;
  return {
    publicId,
    profileUrl: profileUrl(publicId),
    firstName,
    lastName,
    title,
    company,
    headline: `${title} at ${company}`,
    location: CITIES[pick(CITIES.length)],
    email: hasEmail ? `${firstName}.${lastName}@${company.toLowerCase().replace(/[^a-z]/g, '')}.example`.toLowerCase() : null,
    degree: 2,
  };
}

interface SimRow {
  public_id: string;
  invite_sent_at: number | null;
  accept_at: number | null;
  connected: number;
  reply_at: number | null;
  replied: number;
}

export class SimulatorDriver implements LinkedInDriver {
  private o: SimulatorOptions;

  constructor(
    private db: DB,
    private accountId: number,
    private accountName: string,
    private clock: Clock,
    opts: Partial<SimulatorOptions> = {},
  ) {
    this.o = { ...DEFAULT_SIM, ...opts };
  }

  private async pause() {
    if (this.o.latencyMs) await new Promise((r) => setTimeout(r, this.o.latencyMs * (0.5 + this.o.random())));
  }

  private id(url: string) {
    const id = publicIdFromUrl(url);
    if (!id) throw new DriverError('NOT_FOUND', `Not a LinkedIn profile URL: ${url}`);
    return id;
  }

  private row(publicId: string): SimRow {
    this.settle();
    let r = this.db.get<SimRow>('SELECT * FROM sim_people WHERE account_id = ? AND public_id = ?', [this.accountId, publicId]);
    if (!r) {
      this.db.run('INSERT INTO sim_people (account_id, public_id) VALUES (?, ?)', [this.accountId, publicId]);
      r = { public_id: publicId, invite_sent_at: null, accept_at: null, connected: 0, reply_at: null, replied: 0 };
    }
    return r;
  }

  // Apply everything that "happened on LinkedIn" up to now.
  private settle() {
    const now = this.clock.now();
    this.db.run('UPDATE sim_people SET connected = 1 WHERE account_id = ? AND connected = 0 AND accept_at IS NOT NULL AND accept_at <= ?', [this.accountId, now]);
    this.db.run('UPDATE sim_people SET replied = 1 WHERE account_id = ? AND replied = 0 AND reply_at IS NOT NULL AND reply_at <= ?', [this.accountId, now]);
  }

  private between([lo, hi]: [number, number]) {
    return Math.round((lo + this.o.random() * (hi - lo)) * HOUR);
  }

  async checkSession(): Promise<SessionInfo> {
    await this.pause();
    return { name: this.accountName, profileUrl: profileUrl(`sim-${this.accountId}`) };
  }

  async viewProfile(url: string): Promise<Person> {
    await this.pause();
    const id = this.id(url);
    const r = this.row(id);
    const p = simPerson(id);
    // Like LinkedIn, contact info is only visible to 1st-degree connections.
    return { ...p, degree: r.connected ? 1 : 2, email: r.connected ? p.email : null };
  }

  async follow(url: string) {
    await this.pause();
    this.row(this.id(url));
  }

  async endorse(url: string, count: number) {
    await this.pause();
    const r = this.row(this.id(url));
    if (!r.connected) throw new DriverError('NOT_AVAILABLE', 'Only 1st-degree connections can be endorsed');
    return count;
  }

  async likeRecentPost(url: string) {
    await this.pause();
    this.row(this.id(url));
    return this.o.random() < 0.7;
  }

  async connect(url: string, _note: string): Promise<ConnectResult> {
    await this.pause();
    const id = this.id(url);
    const r = this.row(id);
    if (r.connected) return 'already_connected';
    if (r.invite_sent_at) return 'already_pending';
    const now = this.clock.now();
    const acceptAt = this.o.random() < this.o.acceptRate ? now + this.between(this.o.acceptHours) : null;
    this.db.run('UPDATE sim_people SET invite_sent_at = ?, accept_at = ? WHERE account_id = ? AND public_id = ?', [now, acceptAt, this.accountId, id]);
    return 'sent';
  }

  async withdrawInvite(url: string) {
    await this.pause();
    const id = this.id(url);
    const r = this.row(id);
    if (r.connected || !r.invite_sent_at) return false;
    this.db.run('UPDATE sim_people SET invite_sent_at = NULL, accept_at = NULL WHERE account_id = ? AND public_id = ?', [this.accountId, id]);
    return true;
  }

  async sendMessage(url: string, _text: string) {
    await this.pause();
    const id = this.id(url);
    const r = this.row(id);
    if (!r.connected) throw new DriverError('NOT_AVAILABLE', 'Can only message 1st-degree connections');
    if (r.reply_at == null && this.o.random() < this.o.replyRate) {
      this.db.run('UPDATE sim_people SET reply_at = ? WHERE account_id = ? AND public_id = ?', [this.clock.now() + this.between(this.o.replyHours), this.accountId, id]);
    }
  }

  async recentConnections(limit: number): Promise<Person[]> {
    await this.pause();
    this.settle();
    const rows = this.db.all<SimRow>('SELECT * FROM sim_people WHERE account_id = ? AND connected = 1 ORDER BY accept_at DESC LIMIT ?', [this.accountId, limit]);
    return rows.map((r) => ({ ...simPerson(r.public_id), degree: 1 as const }));
  }

  async inbox(since: number): Promise<InboxThread[]> {
    await this.pause();
    this.settle();
    const rows = this.db.all<SimRow>('SELECT * FROM sim_people WHERE account_id = ? AND replied = 1 AND reply_at >= ?', [this.accountId, since]);
    return rows.map((r) => {
      const p = simPerson(r.public_id);
      const body = REPLIES[seeded(r.public_id + ':reply')(REPLIES.length)];
      return {
        threadId: `sim-${r.public_id}`,
        participant: { name: `${p.firstName} ${p.lastName}`, publicId: r.public_id, profileUrl: p.profileUrl },
        lastMessageAt: r.reply_at!,
        unread: true,
        messages: [{ externalId: `sim-reply-${r.public_id}`, direction: 'in' as const, body, sentAt: r.reply_at! }],
      };
    });
  }

  async search(url: string, limit: number, onPage?: (found: number) => void): Promise<Person[]> {
    const pick = seeded(url);
    const out: Person[] = [];
    for (let i = 0; i < limit; i++) {
      if (i % 10 === 0) {
        await this.pause();
        onPage?.(i);
      }
      const first = FIRST[pick(FIRST.length)].toLowerCase();
      const last = LAST[(pick(LAST.length) + i) % LAST.length].toLowerCase();
      const id = `${first}-${last}-${createHash('md5').update(url + i).digest('hex').slice(0, 6)}`;
      out.push(simPerson(id));
    }
    onPage?.(out.length);
    return out;
  }

  async close() {}
}
