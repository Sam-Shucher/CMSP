const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function formatSpan(ms: number): string {
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MIN);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// "3d 4h left", "42m left", "Due now", "Overdue by 1d 2h"
export function formatTimeRemaining(dueAt: string, now: Date): string {
  const diff = new Date(dueAt).getTime() - now.getTime();
  if (diff >= 0) {
    return diff < MIN ? 'Due now' : `${formatSpan(diff)} left`;
  }
  return `Overdue by ${formatSpan(-diff)}`;
}

// <input type="datetime-local"> works in the viewer's local time with no
// timezone ("2026-10-01T13:30"), while the API stores real instants (ISO/UTC).
// Converting at the edges means both people see the handoff time in their
// own timezone.
export function toDateTimeLocalValue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDateTimeLocalValue(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
