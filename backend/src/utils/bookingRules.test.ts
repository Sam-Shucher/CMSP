import { describe, it, expect } from 'vitest';
import {
  parseBookingWindow, overlaps, bookingBlocksLoan, bookingDays,
  MAX_BOOKING_DAYS, MAX_BOOKING_AHEAD_DAYS,
} from './bookingRules';
import { MAX_DURATION_DAYS } from './loanRules';

// A booking claims a range of days on one mini. Holds answer "tell me when
// it's free"; this answers "I need it for game night on the 14th". The rules
// below are the ones that stop a calendar becoming nonsense: real dates, not
// the past, not further out than anyone can plan for, and never two people
// claiming the same day.

const NOW = new Date('2026-09-23T12:00:00.000Z');

function window(startsOn: string, endsOn: string) {
  return { startsOn, endsOn };
}

describe('parseBookingWindow — the shape of a date', () => {
  it('accepts a single day booked as itself', () => {
    const parsed = parseBookingWindow({ startsOn: '2026-10-14', endsOn: '2026-10-14' }, NOW);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toEqual(window('2026-10-14', '2026-10-14'));
  });

  it('accepts a weekend', () => {
    const parsed = parseBookingWindow({ startsOn: '2026-10-14', endsOn: '2026-10-16' }, NOW);

    expect(parsed.ok).toBe(true);
  });

  it.each([
    ['a missing start', { endsOn: '2026-10-14' }],
    ['a missing end', { startsOn: '2026-10-14' }],
    ['a timestamp instead of a date', { startsOn: '2026-10-14T18:00:00Z', endsOn: '2026-10-14' }],
    ['an array', { startsOn: ['2026-10-14'], endsOn: '2026-10-14' }],
    ['an object', { startsOn: { day: 1 }, endsOn: '2026-10-14' }],
    ['a number', { startsOn: 20261014, endsOn: '2026-10-14' }],
  ])('refuses %s', (_label: string, input: Record<string, unknown>) => {
    const parsed = parseBookingWindow(input, NOW);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/date like/i);
  });

  it('refuses a date that looks right but never happened', () => {
    const parsed = parseBookingWindow({ startsOn: '2026-02-30', endsOn: '2026-02-30' }, NOW);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/not a real date/i);
  });
});

describe('parseBookingWindow — when the days have to be', () => {
  it('refuses a range that ends before it starts', () => {
    const parsed = parseBookingWindow({ startsOn: '2026-10-16', endsOn: '2026-10-14' }, NOW);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/before it starts/i);
  });

  it('refuses booking a day that has already gone', () => {
    const parsed = parseBookingWindow({ startsOn: '2026-09-01', endsOn: '2026-09-02' }, NOW);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/in the past/i);
  });

  // Same one-day tolerance parseBackBy gives a quest: someone a timezone behind
  // the server picking "today" must not be told today is in the past.
  it('still allows yesterday, for someone a timezone behind the server', () => {
    const parsed = parseBookingWindow({ startsOn: '2026-09-22', endsOn: '2026-09-24' }, NOW);

    expect(parsed.ok).toBe(true);
  });

  it(`refuses a window longer than the ${MAX_BOOKING_DAYS} days a loan can run`, () => {
    const parsed = parseBookingWindow({ startsOn: '2026-10-01', endsOn: '2027-06-01' }, NOW);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/3 months/i);
  });

  it('refuses a booking further out than anyone is really planning', () => {
    const parsed = parseBookingWindow({ startsOn: '2028-01-01', endsOn: '2028-01-02' }, NOW);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/months ahead/i);
  });

  // A booking reserves a window a loan then has to fit inside, so letting one
  // run longer than a loan may run would promise something unkeepable.
  it('caps a booking at the same three months a loan gets', () => {
    expect(MAX_BOOKING_DAYS).toBe(MAX_DURATION_DAYS);
  });

  it('lets you plan further ahead than a single booking may run', () => {
    expect(MAX_BOOKING_AHEAD_DAYS).toBeGreaterThan(MAX_BOOKING_DAYS);
  });
});

describe('bookingDays — how long a window is', () => {
  it('counts a single day as one, not nought', () => {
    expect(bookingDays(window('2026-10-14', '2026-10-14'))).toBe(1);
  });

  it('counts both ends of a weekend', () => {
    expect(bookingDays(window('2026-10-14', '2026-10-16'))).toBe(3);
  });
});

describe('overlaps — two people cannot claim the same day', () => {
  it.each([
    ['the same single day', window('2026-10-14', '2026-10-14'), window('2026-10-14', '2026-10-14')],
    ['one starting inside the other', window('2026-10-14', '2026-10-20'), window('2026-10-16', '2026-10-22')],
    ['one wholly inside the other', window('2026-10-14', '2026-10-20'), window('2026-10-16', '2026-10-17')],
    ['touching on a single shared day', window('2026-10-14', '2026-10-16'), window('2026-10-16', '2026-10-18')],
  ])('%s overlaps', (_label: string, a, b) => {
    expect(overlaps(a, b)).toBe(true);
    expect(overlaps(b, a)).toBe(true); // and it can't matter which way round they are asked
  });

  it.each([
    ['back to back, a day apart', window('2026-10-14', '2026-10-15'), window('2026-10-16', '2026-10-17')],
    ['months apart', window('2026-10-14', '2026-10-15'), window('2026-12-01', '2026-12-02')],
  ])('%s does not overlap', (_label: string, a, b) => {
    expect(overlaps(a, b)).toBe(false);
    expect(overlaps(b, a)).toBe(false);
  });
});

describe('bookingBlocksLoan — a loan has to be back before the booked window', () => {
  // The rule in one line: the mini must be home before the first booked day.
  // A loan still out on the morning of game night is a loan that ruined it.
  it('blocks a loan due on the booking\'s first day', () => {
    expect(bookingBlocksLoan(new Date('2026-10-14T09:00:00.000Z'), '2026-10-14')).toBe(true);
  });

  it('blocks a loan due after the booking starts', () => {
    expect(bookingBlocksLoan(new Date('2026-10-20T09:00:00.000Z'), '2026-10-14')).toBe(true);
  });

  it('allows a loan due the day before', () => {
    expect(bookingBlocksLoan(new Date('2026-10-13T23:00:00.000Z'), '2026-10-14')).toBe(false);
  });
});
