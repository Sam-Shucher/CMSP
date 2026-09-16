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
