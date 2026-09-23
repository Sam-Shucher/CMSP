import { appTimezone } from '../config';

// Calendar days and clock times on the group's own clock (config.ts's
// APP_TIMEZONE). The server, the database and UTC can each disagree with the
// group about what day it is for several hours every evening; anything a
// person picks as a day — a booking, a back-by date — or a time of day — a
// handoff — is judged here instead, and handed to SQL as a plain value rather
// than left to CURDATE().

const DAY_MS = 24 * 60 * 60 * 1000;

function parts(date: Date, zone: string): Record<string, string> {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(formatted.map(part => [part.type, part.value]));
}

// The calendar day (YYYY-MM-DD) that this moment falls on, in the group's city.
export function dayIn(date: Date, zone: string = appTimezone()): string {
  const { year, month, day } = parts(date, zone);
  return `${year}-${month}-${day}`;
}

// Today, in the group's city.
export function todayInApp(now: Date = new Date(), zone: string = appTimezone()): string {
  return dayIn(now, zone);
}

// Minutes since local midnight: 6:30am is 390.
export function minutesIntoDay(date: Date, zone: string = appTimezone()): number {
  const { hour, minute } = parts(date, zone);
  return Number(hour) * 60 + Number(minute);
}

// Calendar arithmetic on YYYY-MM-DD, free of any clock or daylight saving.
export function addDays(day: string, days: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

// "2026-12-30" → "Dec 30, 2026", for a message someone has to read.
export function readableDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}
