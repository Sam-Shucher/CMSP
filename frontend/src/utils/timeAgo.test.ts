import { describe, it, expect } from 'vitest';
import { timeAgo } from './timeAgo';

const NOW = new Date('2026-10-10T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

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
