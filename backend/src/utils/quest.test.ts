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

  // A quest is "I'm borrowing my own mini for a bit", not indefinite storage —
  // three months, the same ceiling a loan gets.
  it('accepts a calendar date from today up to three months out', () => {
    expect(parseBackBy('2026-10-01', NOW)).toEqual({ ok: true, value: '2026-10-01' });
    expect(parseBackBy('2026-10-15', NOW)).toEqual({ ok: true, value: '2026-10-15' });
    expect(parseBackBy('2026-12-30', NOW)).toEqual({ ok: true, value: '2026-12-30' }); // 90 days out, the last day allowed
  });

  it('refuses a date past three months, and says what the limit is', () => {
    expect(parseBackBy('2026-12-31', NOW)).toEqual({
      ok: false,
      error: 'A quest can last up to 3 months — pick a date on or before Dec 30, 2026',
    });
    expect(parseBackBy('2027-10-01', NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/3 months/) });
  });

  // Everyone is in one city (APP_TIMEZONE, Chicago by default), so "today" is
  // that city's today: no allowance for a day that has already gone there...
  it('refuses yesterday', () => {
    expect(parseBackBy('2026-09-30', NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/past/i) });
  });

  it('rejects dates clearly in the past', () => {
    expect(parseBackBy('2026-09-29', NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/past/i) });
  });

  // ...and at 10pm in Chicago it is still that day, though UTC has moved on.
  it('counts days on the group\'s clock, not UTC\'s', () => {
    const lateEvening = new Date('2026-10-02T03:00:00Z'); // Oct 1, 10pm in Chicago
    expect(parseBackBy('2026-10-01', lateEvening)).toEqual({ ok: true, value: '2026-10-01' });
    expect(parseBackBy('2026-12-30', lateEvening)).toMatchObject({ ok: true }); // 90 days from Oct 1, not Oct 2
    expect(parseBackBy('2026-12-31', lateEvening)).toMatchObject({ ok: false });
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
