import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTACT_MARK, companyFromCard, nameFromTitle, namesOtherPerson, parseDegree, parseTopCardLines } from '../src/drivers/playwright/parse.js';
import { LABELS } from '../src/drivers/playwright/selectors.js';

// The pure parts of reading LinkedIn's 2026 profile page. The same helpers run against the scrubbed live
// snapshots in playwright-driver.test.ts (which needs a browser).
describe('LinkedIn 2026 top card', () => {
  it('reads degree, headline, company line and location by their order', () => {
    expect(parseTopCardLines(['· 2nd', 'Head of Growth at Northwind', 'Northwind · LSE', 'London, England, United Kingdom', '·', CONTACT_MARK, '1,204 followers'])).toEqual({
      degree: 2,
      pronouns: '',
      headline: 'Head of Growth at Northwind',
      companyLine: 'Northwind · LSE',
      location: 'London, England, United Kingdom',
      hasContactInfo: true,
    });
  });

  it('skips pronouns on the own profile and a missing degree', () => {
    expect(parseTopCardLines(['He/Him', 'Founder', 'Berlin', CONTACT_MARK])).toMatchObject({ degree: null, pronouns: 'He/Him', headline: 'Founder', companyLine: '', location: 'Berlin' });
    expect(parseTopCardLines(['they / them', 'CEO/Founder at Acme', 'Paris', CONTACT_MARK])).toMatchObject({ pronouns: 'they / them', headline: 'CEO/Founder at Acme' });
  });

  it('takes the first degree line only and ignores separators', () => {
    expect(parseTopCardLines(['· 1st', '· 2nd', 'Engineer', 'Oslo', 'T', CONTACT_MARK])).toMatchObject({ degree: 1, headline: 'Engineer', location: 'Oslo' });
    expect(parseTopCardLines(['• 3rd+', 'Engineer', 'Oslo', CONTACT_MARK]).degree).toBe(3);
  });

  it('copes without the contact-info link, leaving counts out', () => {
    expect(parseTopCardLines(['· 3rd', 'Engineer', 'Oslo', '500+ connections', '12 followers'])).toMatchObject({ headline: 'Engineer', location: 'Oslo', hasContactInfo: false });
    expect(parseTopCardLines(['Engineer'])).toMatchObject({ headline: 'Engineer', location: '' });
    expect(parseTopCardLines([])).toMatchObject({ headline: '', location: '', degree: null });
  });

  it('takes the company from its chip, never from a school chip, else from the company line', () => {
    expect(companyFromCard([{ kind: 'company', text: 'Northwind' }, { kind: 'school', text: 'LSE' }], 'Northwind · LSE')).toBe('Northwind');
    expect(companyFromCard([{ kind: 'school', text: 'LSE' }], 'LSE')).toBe('');
    expect(companyFromCard([], 'Northwind · LSE')).toBe('Northwind');
    expect(companyFromCard([], '')).toBe('');
  });

  it('reads the name from the page title', () => {
    expect(nameFromTitle('Jane Doe | LinkedIn')).toBe('Jane Doe');
    expect(nameFromTitle('(3) Jane Doe | LinkedIn')).toBe('Jane Doe');
    expect(nameFromTitle('(99+) José Álvarez-Ruiz | LinkedIn')).toBe('José Álvarez-Ruiz');
    expect(nameFromTitle('LinkedIn')).toBe('');
    expect(nameFromTitle('LinkedIn Login, Sign in | LinkedIn')).toBe('');
    expect(nameFromTitle('Feed | LinkedIn')).toBe('');
    expect(nameFromTitle('')).toBe('');
  });

  it('reads the degree from either layout', () => {
    expect(parseDegree('· 1st')).toBe(1);
    expect(parseDegree('2nd degree connection')).toBe(2);
    expect(parseDegree('3rd+')).toBe(3);
    expect(parseDegree('')).toBeNull();
  });
});

// The snapshots come from a real account's network: every profile id in them, plain or URL-encoded (a
// "Send profile in a message" link carries one), must be scrubbed to SLUG, and tracking ids to ID.
describe('LinkedIn 2026 snapshots stay scrubbed', () => {
  it('holds no real profile ids or tracking ids', () => {
    const dir = new URL('./fixtures/linkedin-2026/', import.meta.url);
    for (const file of readdirSync(dir)) {
      const text = readFileSync(new URL(file, dir), 'utf8');
      expect(text.match(/(?:\/|%2F)in(?:\/|%2F)(?!SLUG\b|me\/)[^"'&\s/?]+/gi) ?? [], file).toEqual([]);
      expect(text.match(/\b(?:r_id|session_id|vanityName|recipient)=(?!ID\b|RID\b|SLUG\b)[^"'&\s]+/gi) ?? [], file).toEqual([]);
    }
  });
});

describe('LinkedIn control labels', () => {
  it('spots controls about someone else', () => {
    expect(namesOtherPerson('Invite Alex Other to connect', 'Jane Doe')).toBe(true);
    expect(namesOtherPerson('Follow Alex Other', 'Jane Doe')).toBe(true);
    expect(namesOtherPerson('Invite Jane Doe to connect', 'Jane Doe')).toBe(false);
    expect(namesOtherPerson('Invite Jane to connect', 'Dr. Jane Doe, PhD')).toBe(false);
    expect(namesOtherPerson('Invite José Ruiz to connect', 'Jose Ruiz')).toBe(false);
    // Labels without a name, and an unknown person, never block.
    expect(namesOtherPerson('Follow', 'Jane Doe')).toBe(false);
    expect(namesOtherPerson('Message', 'Jane Doe')).toBe(false);
    expect(namesOtherPerson('Invite Alex Other to connect', '')).toBe(false);
  });

  it('matches the 2026 names and the older ones', () => {
    expect(LABELS.connect.test('Invite NAME to connect')).toBe(true);
    expect(LABELS.connect.test('Connect')).toBe(true);
    expect(LABELS.message.test('Message')).toBe(true);
    expect(LABELS.message.test('Message Jane Doe')).toBe(true);
    expect(LABELS.message.test('Send profile in a message')).toBe(false);
    expect(LABELS.more.test('More')).toBe(true);
    expect(LABELS.more.test('More actions')).toBe(true);
    expect(LABELS.more.test('More actions for Jane Doe')).toBe(false);
    expect(LABELS.follow.test('Follow')).toBe(true);
    expect(LABELS.follow.test('Follow Jane Doe')).toBe(true);
    expect(LABELS.follow.test('Following')).toBe(false);
    expect(LABELS.following.test('Following')).toBe(true);
    expect(LABELS.following.test('Unfollow Jane Doe')).toBe(true);
    expect(LABELS.pending.test('Pending')).toBe(true);
    expect(LABELS.pending.test('Pending, click to withdraw invitation sent to Jane Doe')).toBe(true);
  });
});
