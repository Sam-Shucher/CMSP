import { describe, it, expect } from 'vitest';
import { parseBackBy } from './quest';

// "Today" for these tests: Oct 1 2026, mid-afternoon UTC.
const NOW = new Date('2026-10-01T15:00:00Z');

describe('parseBackBy — the optional "back by" date when taking a mini on a quest', () => {
  it('is optional', () => {
    expect(parseBackBy(undefined, NOW)).toEqual({ ok: true, value: null });
    expect(parseBackBy(null, NOW)).toEqual({ ok: true, value: null });
    expect(parseBackBy('', NOW)).toEqual({ ok: true, value: null });
  });

  it('accepts a calendar date from today up to a year out', () => {
    expect(parseBackBy('2026-10-01', NOW)).toEqual({ ok: true, value: '2026-10-01' });
    expect(parseBackBy('2026-10-15', NOW)).toEqual({ ok: true, value: '2026-10-15' });
    expect(parseBackBy('2027-10-01', NOW)).toEqual({ ok: true, value: '2027-10-01' });
  });

  // Someone west of UTC can still be on "yesterday" by the server's clock.
  it('allows yesterday, so a user a timezone behind isn\'t told today is in the past', () => {
    expect(parseBackBy('2026-09-30', NOW)).toMatchObject({ ok: true });
  });

  it('rejects dates clearly in the past or more than a year away', () => {
    expect(parseBackBy('2026-09-29', NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/past/i) });
    expect(parseBackBy('2027-10-03', NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/year/i) });
  });

  it.each([
    ['not a date', 'next tuesday'],
    ['the wrong format', '10/15/2026'],
    ['an impossible date', '2026-02-30'],
    ['a date with a time on it', '2026-10-15T12:00:00Z'],
    ['a number', 20261015],
    ['an object', { $gt: '' }],
  ])('rejects %s', (_why, value) => {
    expect(parseBackBy(value, NOW)).toMatchObject({ ok: false });
  });
});
