import { Check } from './inputs';

// "On a quest": the owner has taken their own mini out (say, to bring it to a
// game). No negotiation, no duration — just an optional date it's expected back.

const DAY_MS = 24 * 60 * 60 * 1000;
// The same ceiling a loan gets (utils/loanRules.ts): a quest is "I'm taking my
// own mini out for a while", not indefinite storage.
export const MAX_QUEST_DAYS = 90;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// The last day a quest may run to, as YYYY-MM-DD.
export function latestBackBy(now: Date = new Date()): string {
  return isoDay(new Date(now.getTime() + MAX_QUEST_DAYS * DAY_MS));
}

// "2026-12-30" → "Dec 30, 2026", for a message someone has to read.
function readableDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

// Accepts nothing (no date) or a YYYY-MM-DD calendar date between yesterday
// (so a user a timezone behind the server can still pick "today") and the
// three-month limit.
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
  const latest = latestBackBy(now);
  if (value > latest) {
    return { ok: false, error: `A quest can last up to 3 months — pick a date on or before ${readableDay(latest)}` };
  }
  return { ok: true, value };
}
