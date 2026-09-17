import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { authCookie } from '../test/helpers';

vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../db/connection';
import { createApp } from '../app';

const app = createApp();
const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;

const USER = { userId: 1, username: 'owner', role: 'user' };

function profileRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    email: 'owner@example.com',
    username: 'owner',
    display_name: 'Owner Name',
    phone: null,
    neighborhood: null,
    role: 'user',
    ...overrides,
  };
}

beforeEach(() => {
  execute.mockReset();
});

describe('GET /api/users/me', () => {
  it('returns the logged-in user\'s profile', async () => {
    execute.mockResolvedValueOnce([[profileRow()]]);

    const res = await request(app)
      .get('/api/users/me')
      .set('Cookie', authCookie(USER));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: 'owner', display_name: 'Owner Name' });
  });

  it('returns 401 with no auth cookie', async () => {
    const res = await request(app).get('/api/users/me');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/users/me', () => {
  it('updates display name, phone, and neighborhood', async () => {
    execute
      .mockResolvedValueOnce([{}]) // UPDATE users
      .mockResolvedValueOnce([[profileRow({ display_name: 'New Name', phone: '555-1234', neighborhood: 'Riverside' })]]); // re-fetch

    const res = await request(app)
      .patch('/api/users/me')
      .set('Cookie', authCookie(USER))
      .send({ displayName: 'New Name', phone: '555-1234', neighborhood: 'Riverside' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      display_name: 'New Name',
      phone: '555-1234',
      neighborhood: 'Riverside',
    });
  });

  it('trims values and clears blank optional fields to NULL', async () => {
    execute
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[profileRow({ display_name: 'New Name' })]]);

    await request(app)
      .patch('/api/users/me')
      .set('Cookie', authCookie(USER))
      .send({ displayName: '  New Name  ', phone: '   ', neighborhood: '' });

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE users'), ['New Name', null, null, USER.userId]);
  });

  it('only ever updates the logged-in user, never an id from the request', async () => {
    execute.mockResolvedValueOnce([{}]).mockResolvedValueOnce([[profileRow()]]);

    await request(app)
      .patch('/api/users/me')
      .set('Cookie', authCookie(USER))
      .send({ displayName: 'New Name', id: 99, userId: 99, role: 'admin' });

    const update = execute.mock.calls.find(([sql]) => String(sql).includes('UPDATE users'))!;
    expect(update[0]).not.toMatch(/role/);
    expect(update[1]).toEqual(['New Name', null, null, USER.userId]);
  });

  it.each([
    ['a display name over 100 characters', { displayName: 'x'.repeat(101) }],
    ['a phone number over 20 characters', { displayName: 'Ok', phone: '5'.repeat(21) }],
    ['a neighborhood over 100 characters', { displayName: 'Ok', neighborhood: 'x'.repeat(101) }],
    ['a display name that is an object', { displayName: { first: 'Bob' } }],
    ['a phone number that is not text', { displayName: 'Ok', phone: 5551234 }],
  ])('rejects %s with 400, saving nothing', async (_why, body) => {
    const res = await request(app).patch('/api/users/me').set('Cookie', authCookie(USER)).send(body);

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a blank display name with 400', async () => {
    const res = await request(app)
      .patch('/api/users/me')
      .set('Cookie', authCookie(USER))
      .send({ displayName: '   ' });

    expect(res.status).toBe(400);
  });

  it('returns 401 with no auth cookie', async () => {
    const res = await request(app).patch('/api/users/me').send({ displayName: 'New Name' });
    expect(res.status).toBe(401);
  });
});

describe('database failures', () => {
  it.each([
    ['GET /api/users/me', () => request(app).get('/api/users/me').set('Cookie', authCookie(USER))],
    ['PATCH /api/users/me', () => request(app).patch('/api/users/me').set('Cookie', authCookie(USER)).send({ displayName: 'New Name' })],
  ])('%s returns a generic 500', async (_route, send) => {
    execute.mockRejectedValue(new Error('connection lost'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await send();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Server error' });
  });
});
