import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { authCookie } from '../test/helpers';

// The booking rules themselves (overlaps, locking, the calendar) run against a
// real database in services/bookings.integration.test.ts. What this file pins
// is the route layer: that every date the server will refuse is refused here
// with a 400 before it reaches the service, and that a failure from the
// service is passed through with the status it chose.
vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../db/connection';
import { placeBooking, cancelBooking, miniCalendar, listMyBookings } from '../services/bookings';
import { createApp } from '../app';

const app = createApp();
const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;
const MEMBERSHIP_CONFIRMED = [[{ id: 1 }]];
const MEMBER = { userId: 2, username: 'wendy', role: 'user', collectionId: 10 };

const DAY_MS = 24 * 60 * 60 * 1000;
function day(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

beforeEach(() => {
  execute.mockReset();
  vi.mocked(placeBooking).mockReset().mockResolvedValue({ ok: true, bookingId: 7 });
  vi.mocked(cancelBooking).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(miniCalendar).mockReset().mockResolvedValue({ max: 10, bookings: [] });
  vi.mocked(listMyBookings).mockReset().mockResolvedValue({ mine: [], onMyMinis: [] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/bookings/minis/:miniId', () => {
  function book(body: Record<string, unknown>) {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);
    return request(app).post('/api/bookings/minis/42').set('Cookie', authCookie(MEMBER)).send(body);
  }

  it('books a single day and reports where it landed', async () => {
    const res = await book({ startsOn: day(14), endsOn: day(14), note: 'game night' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ bookingId: 7 });
    expect(placeBooking).toHaveBeenCalledWith(
      42, MEMBER.userId, 10, { startsOn: day(14), endsOn: day(14) }, 'game night'
    );
  });

  it('treats a missing note as no note at all', async () => {
    await book({ startsOn: day(14), endsOn: day(14) });

    expect(placeBooking).toHaveBeenCalledWith(42, MEMBER.userId, 10, expect.anything(), null);
  });

  it.each([
    ['no dates at all', {}],
    ['only a start', { startsOn: day(14) }],
    ['an end before the start', { startsOn: day(14), endsOn: day(12) }],
    ['a day already gone', { startsOn: day(-30), endsOn: day(-30) }],
    ['a date that is not a date', { startsOn: 'game night', endsOn: 'game night' }],
  ])('refuses %s without touching the calendar', async (_label: string, body: Record<string, unknown>) => {
    const res = await book(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(placeBooking).not.toHaveBeenCalled();
  });

  it('refuses a note longer than the column holds', async () => {
    const res = await book({ startsOn: day(14), endsOn: day(14), note: 'x'.repeat(256) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/255 characters/);
    expect(placeBooking).not.toHaveBeenCalled();
  });

  it('passes a clash back with the status the service chose', async () => {
    vi.mocked(placeBooking).mockResolvedValue({ ok: false, status: 409, error: 'Theo already has this booked for those days — pick another date' });

    const res = await book({ startsOn: day(14), endsOn: day(14) });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already has this booked/);
  });

  it('404s an id that could never be a mini', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).post('/api/bookings/minis/nonsense')
      .set('Cookie', authCookie(MEMBER)).send({ startsOn: day(14), endsOn: day(14) });

    expect(res.status).toBe(404);
    expect(placeBooking).not.toHaveBeenCalled();
  });
});

describe('GET /api/bookings/minis/:miniId', () => {
  it('returns the calendar the service built', async () => {
    vi.mocked(miniCalendar).mockResolvedValue({
      max: 10,
      bookings: [{ id: 1, startsOn: day(14), endsOn: day(15), holderName: null, note: null, mine: false, started: false }],
    });
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).get('/api/bookings/minis/42').set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    expect(miniCalendar).toHaveBeenCalledWith(42, MEMBER.userId, 10);
  });

  it('404s a mini the caller can\'t see', async () => {
    vi.mocked(miniCalendar).mockResolvedValue(null);
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).get('/api/bookings/minis/42').set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(404);
  });
});

describe('GET /api/bookings and DELETE /api/bookings/:id', () => {
  it('lists your bookings and the ones on your minis', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).get('/api/bookings').set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mine: [], onMyMinis: [] });
    expect(listMyBookings).toHaveBeenCalledWith(MEMBER.userId, 10);
  });

  it('cancels one by id, scoped to the active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).delete('/api/bookings/7').set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(200);
    expect(cancelBooking).toHaveBeenCalledWith(7, MEMBER.userId, 10);
  });

  it('passes a refusal through rather than reporting success', async () => {
    vi.mocked(cancelBooking).mockResolvedValue({ ok: false, status: 404, error: 'Booking not found' });
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).delete('/api/bookings/7').set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(404);
  });
});

describe('bookings — database failures', () => {
  it('returns a generic 500 when the service throws', async () => {
    vi.mocked(listMyBookings).mockRejectedValue(new Error('connection lost'));
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).get('/api/bookings').set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Server error' });
  });
});
