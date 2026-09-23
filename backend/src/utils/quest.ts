import { Check } from './inputs';
import { todayInApp, addDays, readableDay } from './appTime';

// "On a quest": the owner has taken their own mini out (say, to bring it to a
// game). No negotiation, no duration — just an optional date it's expected back.

// The same ceiling a loan gets (utils/loanRules.ts): a quest is "I'm taking my
// own mini out for a while", not indefinite storage.
export const MAX_QUEST_DAYS = 90;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// The last day a quest may run to, as YYYY-MM-DD, counted from the group's today.
export function latestBackBy(now: Date = new Date()): string {
  return addDays(todayInApp(now), MAX_QUEST_DAYS);
}

function isRealDay(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Accepts nothing (no date) or a YYYY-MM-DD calendar date from the group's
// today (APP_TIMEZONE — everyone is in one city) to the three-month limit.
export function parseBackBy(value: unknown, now: Date = new Date()): Check<string | null> {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) {
    return { ok: false, error: 'Back-by date must be a date like 2026-10-15' };
  }
  if (!isRealDay(value)) {
    return { ok: false, error: 'Back-by date is not a real date' };
  }
  if (value < todayInApp(now)) {
    return { ok: false, error: 'Back-by date can\'t be in the past' };
  }
  const latest = latestBackBy(now);
  if (value > latest) {
    return { ok: false, error: `A quest can last up to 3 months — pick a date on or before ${readableDay(latest)}` };
  }
  return { ok: true, value };
}
