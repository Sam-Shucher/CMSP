import { describe, it, expect, afterEach } from 'vitest';
import { dayIn, todayInApp, minutesIntoDay, addDays, readableDay } from './appTime';
import { appTimezone, DEFAULT_APP_TIMEZONE } from '../config';

// Days and times on the group's own clock. The point of all of this is that
// the answer depends only on the moment and the group's city — never on the
// server's timezone, the database's, or UTC.

const CHICAGO = 'America/Chicago';

describe('dayIn — which calendar day a moment falls on, in the group\'s city', () => {
  it('is still "today" in Chicago in the evening, when UTC has moved on', () => {
    const tenPmChicago = new Date('2026-10-02T03:00:00Z');
    expect(dayIn(tenPmChicago, CHICAGO)).toBe('2026-10-01');
    expect(tenPmChicago.toISOString().slice(0, 10)).toBe('2026-10-02'); // what the old code used
  });

  it('turns over at local midnight, to the second', () => {
    expect(dayIn(new Date('2026-10-02T04:59:59Z'), CHICAGO)).toBe('2026-10-01'); // 11:59:59pm CDT
    expect(dayIn(new Date('2026-10-02T05:00:00Z'), CHICAGO)).toBe('2026-10-02'); // midnight CDT
    expect(dayIn(new Date('2026-12-02T05:59:59Z'), CHICAGO)).toBe('2026-12-01'); // 11:59:59pm CST
    expect(dayIn(new Date('2026-12-02T06:00:00Z'), CHICAGO)).toBe('2026-12-02'); // midnight CST
  });

  it('gives a different day for the same moment in a different city', () => {
    const moment = new Date('2026-10-01T20:00:00Z');
    expect(dayIn(moment, CHICAGO)).toBe('2026-10-01');
    expect(dayIn(moment, 'Asia/Tokyo')).toBe('2026-10-02');
  });
});

describe('minutesIntoDay — the local time of day', () => {
  it('reads the wall-clock time in the group\'s city', () => {
    expect(minutesIntoDay(new Date('2026-10-01T11:00:00Z'), CHICAGO)).toBe(6 * 60);       // 6:00am CDT
    expect(minutesIntoDay(new Date('2026-12-01T11:00:00Z'), CHICAGO)).toBe(5 * 60);       // 5:00am CST
    expect(minutesIntoDay(new Date('2026-10-02T04:59:00Z'), CHICAGO)).toBe(23 * 60 + 59); // 11:59pm
  });

  it('calls midnight 0, not 24', () => {
    expect(minutesIntoDay(new Date('2026-10-02T05:00:00Z'), CHICAGO)).toBe(0);
  });

  // Clocks go back at 2am on Nov 1 2026: 1:30am happens twice. Both are 1:30.
  it('reads both copies of the repeated hour when the clocks go back', () => {
    expect(minutesIntoDay(new Date('2026-11-01T06:30:00Z'), CHICAGO)).toBe(90); // 1:30am CDT
    expect(minutesIntoDay(new Date('2026-11-01T07:30:00Z'), CHICAGO)).toBe(90); // 1:30am CST
  });
});

describe('addDays — calendar arithmetic, free of any clock', () => {
  it.each([
    ['2026-10-01', 1, '2026-10-02'],
    ['2026-10-31', 1, '2026-11-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'], // leap year
    ['2027-02-28', 1, '2027-03-01'],
    ['2026-03-08', 1, '2026-03-09'], // the day the clocks go forward: still one day
    ['2026-11-01', 1, '2026-11-02'], // and back
    ['2026-10-01', -1, '2026-09-30'],
    ['2026-09-23', 180, '2027-03-22'],
  ])('%s + %i day(s) is %s', (day, days, expected) => {
    expect(addDays(day, days)).toBe(expected);
  });
});

describe('the server\'s own timezone makes no difference', () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it.each(['UTC', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/Los_Angeles'])('gives the same answers with the server set to %s', (zone) => {
    process.env.TZ = zone;
    const moment = new Date('2026-10-02T03:30:00Z'); // 10:30pm in Chicago
    expect(dayIn(moment, CHICAGO)).toBe('2026-10-01');
    expect(minutesIntoDay(moment, CHICAGO)).toBe(22 * 60 + 30);
    expect(todayInApp(moment, CHICAGO)).toBe('2026-10-01');
    expect(readableDay('2026-10-01')).toBe('Oct 1, 2026');
  });
});

describe('APP_TIMEZONE', () => {
  it('is Chicago unless set', () => {
    expect(DEFAULT_APP_TIMEZONE).toBe('America/Chicago');
    expect(appTimezone({})).toBe('America/Chicago');
    expect(appTimezone({ APP_TIMEZONE: '  ' })).toBe('America/Chicago');
  });

  it('takes another city by name', () => {
    expect(appTimezone({ APP_TIMEZONE: 'Europe/Berlin' })).toBe('Europe/Berlin');
  });

  it('refuses a name that isn\'t a timezone, rather than quietly using UTC', () => {
    expect(() => appTimezone({ APP_TIMEZONE: 'Chicago' })).toThrow(/isn't a timezone/);
  });
});
