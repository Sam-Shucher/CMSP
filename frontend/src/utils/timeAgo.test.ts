import { describe, it, expect } from 'vitest';
import { timeAgo, timeUntil } from './timeAgo';

const NOW = new Date('2026-10-10T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe('timeAgo', () => {
  it('reads naturally at each scale', () => {
    expect(timeAgo(ago(20_000), NOW)).toBe('just now');
    expect(timeAgo(ago(5 * 60_000), NOW)).toBe('5m ago');
    expect(timeAgo(ago(3 * 3_600_000), NOW)).toBe('3h ago');
    expect(timeAgo(ago(2 * 86_400_000), NOW)).toBe('2d ago');
  });

  it('treats a slightly-future timestamp (clock skew) as just now', () => {
    expect(timeAgo(new Date(NOW.getTime() + 30_000).toISOString(), NOW)).toBe('just now');
  });
});

describe('timeUntil — the countdown on a read notification', () => {
  it('counts down through days, hours, and minutes', () => {
    expect(timeUntil(ahead(2 * 86_400_000), NOW)).toBe('2d');
    expect(timeUntil(ahead(47 * 3_600_000), NOW)).toBe('1d 23h');
    expect(timeUntil(ahead(24 * 3_600_000), NOW)).toBe('1d');
    expect(timeUntil(ahead(5 * 3_600_000 + 12 * 60_000), NOW)).toBe('5h 12m');
    expect(timeUntil(ahead(3_600_000), NOW)).toBe('1h');
    expect(timeUntil(ahead(12 * 60_000), NOW)).toBe('12m');
    expect(timeUntil(ahead(1 * 60_000), NOW)).toBe('1m');
  });

  it('says so when there is less than a minute, or the moment has passed', () => {
    expect(timeUntil(ahead(20_000), NOW)).toBe('less than a minute');
    expect(timeUntil(ago(60_000), NOW)).toBe('any moment now');
  });
});
