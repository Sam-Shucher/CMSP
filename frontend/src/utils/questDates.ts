import { LIMITS } from '../limits';

// "Back by" dates are plain calendar days (YYYY-MM-DD) — no time or timezone.

const pad = (n: number) => String(n).padStart(2, '0');

// Today in the viewer's own timezone, in the format <input type="date"> uses.
export function todayInputValue(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// The last day a quest may run to — the same three months the server allows
// (backend/src/utils/quest.ts). The server counts its three months in UTC, so
// a viewer far enough east of it could otherwise be offered a day the server
// then refuses; we take whichever of the two days comes first.
export function latestBackByInputValue(now: Date = new Date()): string {
  const local = new Date(now);
  local.setDate(local.getDate() + LIMITS.questDays);
  const byServer = new Date(now.getTime() + LIMITS.questDays * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const byViewer = todayInputValue(local);
  return byViewer < byServer ? byViewer : byServer;
}

// Keeps a typed or pasted date inside the range the server will accept: past
// the three-month limit becomes the limit, already-gone becomes today. Nobody
// is left holding a date that only fails once they press the button. Says which
// way it moved, so the page can explain itself.
export function clampBackBy(
  day: string,
  now: Date = new Date()
): { day: string; moved: 'later' | 'earlier' | false } {
  if (!day) return { day, moved: false };

  const latest = latestBackByInputValue(now);
  if (day > latest) return { day: latest, moved: 'later' };

  const today = todayInputValue(now);
  if (day < today) return { day: today, moved: 'earlier' };

  return { day, moved: false };
}

// "2026-10-15" → "Oct 15". Parsed as a local date so it never shifts a day.
export function formatBackBy(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
