import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { authCookie } from '../test/helpers';

vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../db/connection';
import { createApp } from '../app';
import { placeHold, leaveHold, watchMini, holdSummary } from '../services/holds';
import { markNotificationRead } from '../db/notifications';

// The hold rules themselves are tested against the real database in
// holds.integration.test.ts. These check how the routes pass input in and
// turn the service's answers into responses.

const app = createApp();
const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;
const MEMBER = { userId: 7, username: 'alice', collectionId: 10 };

beforeEach(() => {
  execute.mockReset().mockResolvedValue([[{ role: 'user' }]]); // membership check
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('hold routes', () => {
  it('places a hold for the logged-in user in their active collection', async () => {
    vi.mocked(placeHold).mockResolvedValueOnce({ ok: true, position: 2 });

    const res = await request(app).post('/api/holds/minis/42').set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ position: 2 });
    expect(placeHold).toHaveBeenCalledWith(42, MEMBER.userId, MEMBER.collectionId);
  });

  it('passes along why a hold was refused, including the machine-readable code', async () => {
    vi.mocked(placeHold).mockResolvedValueOnce({ ok: false, status: 409, code: 'full', error: 'The hold line is full (3 people)' });

    const res = await request(app).post('/api/holds/minis/42').set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'full', error: 'The hold line is full (3 people)' });
  });

  it.each(['abc', '0', '-1', '1.5'])('treats a mini id of "%s" as not found, without calling the service', async (id) => {
    vi.mocked(placeHold).mockClear();

    const res = await request(app).post(`/api/holds/minis/${id}`).set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(404);
    expect(placeHold).not.toHaveBeenCalled();
  });

  it('returns 404 for the summary of a mini that isn\'t in your collection', async () => {
    vi.mocked(holdSummary).mockResolvedValueOnce(null);

    const res = await request(app).get('/api/holds/minis/42').set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(404);
  });

  it('maps leaving and watching failures to their status codes', async () => {
    vi.mocked(leaveHold).mockResolvedValueOnce({ ok: false, status: 404, error: 'You aren\'t in line for this mini' });
    vi.mocked(watchMini).mockResolvedValueOnce({ ok: false, status: 409, error: 'There\'s a spot open — place a hold instead' });

    expect((await request(app).delete('/api/holds/minis/42').set('Cookie', authCookie(MEMBER))).status).toBe(404);
    expect((await request(app).post('/api/holds/minis/42/watch').set('Cookie', authCookie(MEMBER))).status).toBe(409);
  });

  it('returns a generic 500 if the service fails unexpectedly', async () => {
    vi.mocked(placeHold).mockRejectedValueOnce(new Error('connection lost'));

    const res = await request(app).post('/api/holds/minis/42').set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Server error' });
  });
});

describe('notification routes', () => {
  it.each(['abc', '0'])('treats notification id "%s" as not found', async (id) => {
    vi.mocked(markNotificationRead).mockClear();

    const res = await request(app).post(`/api/notifications/${id}/read`).set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(404);
    expect(markNotificationRead).not.toHaveBeenCalled();
  });

  it('only marks the caller\'s own notification, in their active collection', async () => {
    vi.mocked(markNotificationRead).mockResolvedValueOnce(false);

    const res = await request(app).post('/api/notifications/5/read').set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(404);
    expect(markNotificationRead).toHaveBeenCalledWith(5, MEMBER.userId, MEMBER.collectionId);
  });
});
