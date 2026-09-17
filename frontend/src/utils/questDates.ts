// "Back by" dates are plain calendar days (YYYY-MM-DD) — no time or timezone.

const pad = (n: number) => String(n).padStart(2, '0');

// Today in the viewer's own timezone, in the format <input type="date"> uses.
export function todayInputValue(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// "2026-10-15" → "Oct 15". Parsed as a local date so it never shifts a day.
export function formatBackBy(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
