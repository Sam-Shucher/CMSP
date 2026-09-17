import { describe, it, expect } from 'vitest';
import { todayInputValue, formatBackBy } from './questDates';

describe('questDates', () => {
  it('gives today as YYYY-MM-DD in local time', () => {
    expect(todayInputValue(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('formats a back-by day without shifting it across timezones', () => {
    expect(formatBackBy('2026-10-15')).toBe('Oct 15');
    expect(formatBackBy('2026-01-01')).toBe('Jan 1');
  });
});
