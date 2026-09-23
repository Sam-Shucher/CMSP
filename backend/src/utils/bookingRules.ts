import { Check } from './inputs';
import { MAX_DURATION_DAYS } from './loanRules';
import { todayInApp, dayIn, addDays, readableDay } from './appTime';

export { readableDay };

// "I need this for game night on the 14th". A hold is a place in a queue; a
// booking is a claim on a range of days. Kept free of Express and SQL so every
// rule below can be tested directly — services/bookings.ts does the locking
// and the overlap check against what is already in the database.

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// A booking reserves a window that a loan then has to fit inside, so it can't
// be allowed to run longer than a loan may run in the first place.
export const MAX_BOOKING_DAYS = MAX_DURATION_DAYS;

// How far out a booking may be made. Longer than one booking may run, because
// "the tournament in March" is a real plan; beyond this is not planning.
export const MAX_BOOKING_AHEAD_DAYS = 180;

export interface BookingWindow {
  startsOn: string; // YYYY-MM-DD
  endsOn: string;   // YYYY-MM-DD, inclusive
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Inclusive: a single day booked as itself is one day, not nought.
export function bookingDays(window: BookingWindow): number {
  const start = new Date(`${window.startsOn}T00:00:00Z`).getTime();
  const end = new Date(`${window.endsOn}T00:00:00Z`).getTime();
  return Math.round((end - start) / DAY_MS) + 1;
}

function parseDay(value: unknown): Check<string> {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) {
    return { ok: false, error: 'Booking dates must each be a date like 2026-10-14' };
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || isoDay(parsed) !== value) {
    return { ok: false, error: `${value} is not a real date` };
  }
  return { ok: true, value };
}

export function parseBookingWindow(
  input: { startsOn?: unknown; endsOn?: unknown },
  now: Date = new Date()
): Check<BookingWindow> {
  const startsOn = parseDay(input.startsOn);
  if (!startsOn.ok) return startsOn;
  const endsOn = parseDay(input.endsOn);
  if (!endsOn.ok) return endsOn;

  const window = { startsOn: startsOn.value, endsOn: endsOn.value };

  if (window.endsOn < window.startsOn) {
    return { ok: false, error: 'A booking can\'t end before it starts' };
  }
  // "Today" is the group's today (APP_TIMEZONE) — everyone is in one city, so
  // there's no one a timezone behind to make allowances for, and a day the
  // group has already lived through can't be booked.
  const today = todayInApp(now);
  if (window.startsOn < today) {
    return { ok: false, error: 'A booking can\'t start in the past' };
  }
  if (bookingDays(window) > MAX_BOOKING_DAYS) {
    return { ok: false, error: `A booking can run up to 3 months — that's ${MAX_BOOKING_DAYS} days at most` };
  }

  const latestStart = addDays(today, MAX_BOOKING_AHEAD_DAYS);
  if (window.startsOn > latestStart) {
    return {
      ok: false,
      error: `Bookings can be made up to 6 months ahead — pick a date on or before ${readableDay(latestStart)}`,
    };
  }

  return { ok: true, value: window };
}

// Inclusive ranges: two bookings collide unless one ends before the other begins.
export function overlaps(a: BookingWindow, b: BookingWindow): boolean {
  return a.startsOn <= b.endsOn && b.startsOn <= a.endsOn;
}

// The rule a loan has to obey: the mini must be home before the first booked
// day. A loan still out on the morning of game night is a loan that ruined it.
export function bookingBlocksLoan(dueAt: Date, startsOn: string): boolean {
  return dayIn(dueAt) >= startsOn;
}

// While a mini is out — lent, or on a quest with its owner, which counts the
// same — it can only be booked from the day AFTER it's due back: the owner may
// not want to lend it out again the very day it comes home. An overdue mini is
// treated as due back today. A quest with no back-by date has no day to book
// after, so there's nothing to offer but a place in the hold line.
export type OutState =
  | { out: false }
  | { out: true; until: string | null; reason: 'loan' | 'quest' };

export function earliestBookingStart(state: OutState, today: string): { bookable: true; earliest: string } | { bookable: false } {
  if (!state.out) return { bookable: true, earliest: today };
  if (state.until === null) return { bookable: false };
  const until = state.until < today ? today : state.until;
  return { bookable: true, earliest: addDays(until, 1) };
}

export function outUntilMessage(state: OutState & { out: true }, earliest: string | null): string {
  const what = state.reason === 'quest' ? 'on a quest with its owner' : 'out on loan';
  if (earliest === null) {
    return `It's ${what} with no date it's due back — place a hold to be next in line when it's home`;
  }
  // The day before the earliest start: the due date, or today for one overdue.
  return `It's ${what} until ${readableDay(addDays(earliest, -1))} — the earliest you can book it is ${readableDay(earliest)}`;
}

export function bookingBlocksMessage(holder: string, startsOn: string): string {
  return `${holder} has this booked from ${readableDay(startsOn)}, so it needs to be back before then`;
}
