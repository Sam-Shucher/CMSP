import { describe, it, expect } from 'vitest';
import { todayInputValue, formatBackBy, latestBackByInputValue, clampBackBy } from './questDates';

describe('questDates', () => {
  it('gives today as YYYY-MM-DD in local time', () => {
    expect(todayInputValue(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  // A quest lasts at most three months (90 days), the same as a loan —
  // backend/src/utils/quest.ts refuses anything later.
  it('puts the latest back-by day three months out', () => {
    expect(latestBackByInputValue(new Date(2026, 9, 1, 15, 0))).toBe('2026-12-30');
    expect(latestBackByInputValue(new Date(2026, 0, 5, 15, 0))).toBe('2026-04-05'); // across a spring
  });

  it('pulls a later day back to the limit, and says it moved it', () => {
    const now = new Date(2026, 9, 1, 15, 0);
    expect(clampBackBy('2026-12-31', now)).toEqual({ day: '2026-12-30', moved: 'later' });
    expect(clampBackBy('2099-01-01', now)).toEqual({ day: '2026-12-30', moved: 'later' });
  });

  // The calendar won't offer one, but a date can be typed or pasted in — and
  // finding out it was refused only after pressing the button is worse than
  // being moved to the first day that works.
  it('pulls a day already gone forward to today', () => {
    const now = new Date(2026, 9, 1, 15, 0);
    expect(clampBackBy('2020-01-01', now)).toEqual({ day: '2026-10-01', moved: 'earlier' });
    expect(clampBackBy('2026-09-30', now)).toEqual({ day: '2026-10-01', moved: 'earlier' });
  });

  it('leaves a day inside the limit — and an empty one — alone', () => {
    const now = new Date(2026, 9, 1, 15, 0);
    expect(clampBackBy('2026-10-01', now)).toEqual({ day: '2026-10-01', moved: false });
    expect(clampBackBy('2026-10-15', now)).toEqual({ day: '2026-10-15', moved: false });
    expect(clampBackBy('2026-12-30', now)).toEqual({ day: '2026-12-30', moved: false });
    expect(clampBackBy('', now)).toEqual({ day: '', moved: false });
  });

  it('formats a back-by day without shifting it across timezones', () => {
    expect(formatBackBy('2026-10-15')).toBe('Oct 15');
    expect(formatBackBy('2026-01-01')).toBe('Jan 1');
  });
});
