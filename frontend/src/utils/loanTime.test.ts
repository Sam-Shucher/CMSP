import { describe, it, expect } from 'vitest';
import { formatTimeRemaining, toDateTimeLocalValue, fromDateTimeLocalValue } from './loanTime';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatTimeRemaining', () => {
  it('shows days and hours when more than a day is left', () => {
    expect(formatTimeRemaining(later(3 * DAY + 4 * HOUR + 10 * MIN), NOW)).toBe('3d 4h left');
  });

  it('shows hours and minutes when less than a day is left', () => {
    expect(formatTimeRemaining(later(2 * HOUR + 15 * MIN), NOW)).toBe('2h 15m left');
  });

  it('shows minutes when less than an hour is left', () => {
    expect(formatTimeRemaining(later(42 * MIN + 30 * 1000), NOW)).toBe('42m left');
  });

  it('says it is due now in the final minute', () => {
    expect(formatTimeRemaining(later(20 * 1000), NOW)).toBe('Due now');
  });

  it('counts how overdue it is once the time is up', () => {
    expect(formatTimeRemaining(later(-(1 * DAY + 2 * HOUR)), NOW)).toBe('Overdue by 1d 2h');
    expect(formatTimeRemaining(later(-(5 * MIN)), NOW)).toBe('Overdue by 5m');
  });
});

describe('datetime-local conversion', () => {
  it('round-trips a timestamp through the input value format', () => {
    const iso = '2026-10-01T18:30:00.000Z';
    const inputValue = toDateTimeLocalValue(iso);
    expect(inputValue).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(fromDateTimeLocalValue(inputValue)).toBe(iso);
  });

  it('treats an empty or invalid input as no value', () => {
    expect(fromDateTimeLocalValue('')).toBeNull();
    expect(fromDateTimeLocalValue('not a date')).toBeNull();
    expect(toDateTimeLocalValue(null)).toBe('');
  });
});
