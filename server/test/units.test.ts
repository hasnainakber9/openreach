import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '../src/clock.js';
import { effectiveLimits, isWorkingTime, nextWorkingTime, warmupFactor } from '../src/engine/limits.js';
import { defaultSequence, SequenceSchema, validateSequence } from '../src/engine/sequence.js';
import { clampNote, render, unknownVariables } from '../src/engine/template.js';
import { publicIdFromUrl } from '../src/drivers/types.js';
import { Sealer, hashPassword, verifyPassword } from '../src/services/crypto.js';
import { MONDAY_8AM, seededRandom } from './helpers.js';

describe('templates', () => {
  const vars = { firstName: 'Ava', company: '', title: 'CTO {at} | Acme' };

  it('fills variables and fallbacks', () => {
    expect(render('Hi {{firstName}} from {{company|your team}}', vars)).toBe('Hi Ava from your team');
    expect(render('Hi {{ missing }}!', vars)).toBe('Hi!');
  });

  it('resolves nested spintax and keeps braces inside values intact', () => {
    const r = seededRandom(1);
    for (let i = 0; i < 20; i++) {
      const out = render('{Hi|Hello|{Hey|Yo}} {{firstName}}, {{title}}', vars, r);
      expect(out).toMatch(/^(Hi|Hello|Hey|Yo) Ava, CTO \{at\} \| Acme$/);
    }
  });

  it('flags unknown variables', () => {
    expect(unknownVariables('{{firstName}} {{favouriteColour}}')).toEqual(['favouriteColour']);
  });

  it('trims invitation notes at a word boundary', () => {
    const note = 'word '.repeat(80);
    const out = clampNote(note, 300);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith('…')).toBe(true);
    expect(clampNote('short', 300)).toBe('short');
  });
});

describe('sequences', () => {
  it('accepts the default sequence', () => {
    expect(validateSequence(defaultSequence())).toEqual([]);
  });

  it('rejects loops, missing nodes and orphaned conditions', () => {
    const loop = SequenceSchema.parse({ start: 'a', nodes: { a: { id: 'a', type: 'follow', next: 'b' }, b: { id: 'b', type: 'wait', next: 'a' } } });
    expect(validateSequence(loop).join()).toMatch(/loops back/);
    const missing = SequenceSchema.parse({ start: 'a', nodes: { a: { id: 'a', type: 'follow', next: 'zz' } } });
    expect(validateSequence(missing).join()).toMatch(/missing node/);
    const cond = SequenceSchema.parse({ start: 'a', nodes: { a: { id: 'a', type: 'condition', kind: 'accepted_within' } } });
    expect(validateSequence(cond).join()).toMatch(/needs a Connect step/);
  });
});

describe('schedule and limits', () => {
  const s = { timezone: 'UTC', work_days: [1, 2, 3, 4, 5], work_start: '09:00', work_end: '18:00' };

  it('knows working hours', () => {
    expect(isWorkingTime(MONDAY_8AM, s)).toBe(false);
    expect(isWorkingTime(MONDAY_8AM + HOUR, s)).toBe(true);
    expect(isWorkingTime(MONDAY_8AM + 10 * HOUR, s)).toBe(false); // 18:00
  });

  it('skips to Monday from a Friday evening', () => {
    const friEvening = MONDAY_8AM + 4 * DAY + 11 * HOUR; // Fri 19:00
    expect(new Date(nextWorkingTime(friEvening, s)).toISOString()).toBe('2026-01-12T09:00:00.000Z');
  });

  it('respects time zones', () => {
    // 08:00 UTC is 13:00 in Karachi.
    expect(isWorkingTime(MONDAY_8AM, { ...s, timezone: 'Asia/Karachi' })).toBe(true);
  });

  it('ramps limits during warm-up', () => {
    expect(warmupFactor(0, 0, true)).toBeCloseTo(0.3);
    expect(warmupFactor(0, 10 * DAY, true)).toBe(1);
    expect(effectiveLimits({ connect: 20 }, 0, 0, true).connect).toBe(6);
    expect(effectiveLimits({ connect: 20 }, 0, 0, false).connect).toBe(20);
  });
});

describe('misc', () => {
  it('parses profile URLs', () => {
    expect(publicIdFromUrl('https://www.linkedin.com/in/Jane-Doe-123/?trk=x')).toBe('jane-doe-123');
    expect(publicIdFromUrl('https://www.linkedin.com/sales/lead/ACwAAAbcdefghijklmnopqrstuv,NAME_SEARCH,xyz')).toBe('ACwAAAbcdefghijklmnopqrstuv');
    expect(publicIdFromUrl('https://example.com/whatever')).toBeNull();
  });

  it('seals secrets and hashes passwords', () => {
    const s = new Sealer('k');
    expect(s.open(s.seal('li_at_value'))).toBe('li_at_value');
    expect(new Sealer('other').open(s.seal('x'))).toBeNull();
    const h = hashPassword('hunter22');
    expect(verifyPassword('hunter22', h)).toBe(true);
    expect(verifyPassword('nope', h)).toBe(false);
  });
});
