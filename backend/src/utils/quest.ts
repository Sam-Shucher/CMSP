import { Check } from './inputs';

// "On a quest": the owner has taken their own mini out (say, to bring it to a
// game). No negotiation, no duration — just an optional date it's expected back.

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS_AHEAD = 365;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Accepts nothing (no date) or a YYYY-MM-DD calendar date between yesterday
// (so a user a timezone behind the server can still pick "today") and a year out.
export function parseBackBy(value: unknown, now: Date = new Date()): Check<string | null> {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) {
    return { ok: false, error: 'Back-by date must be a date like 2026-10-15' };
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || isoDay(parsed) !== value) {
    return { ok: false, error: 'Back-by date is not a real date' };
  }
  if (value < isoDay(new Date(now.getTime() - DAY_MS))) {
    return { ok: false, error: 'Back-by date can\'t be in the past' };
  }
  if (value > isoDay(new Date(now.getTime() + MAX_DAYS_AHEAD * DAY_MS))) {
    return { ok: false, error: 'Back-by date must be within a year' };
  }
  return { ok: true, value };
}
