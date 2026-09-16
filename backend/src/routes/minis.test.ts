import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { authCookie } from '../test/helpers';

// Mock the DB layer entirely — these are route/permission tests, not DB integration tests.
vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../db/connection';
import { createApp } from '../app';

const app = createApp();
const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;

const OWNER = { userId: 1, username: 'owner', role: 'user' };
const OTHER = { userId: 2, username: 'other', role: 'user' };
const ADMIN = { userId: 3, username: 'boss', role: 'admin' };

// A single mini row, shaped like the join query in minis.ts returns it.
function miniRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 42,
    name: 'Dire Wolf',
    description: 'A wolf',
    image_path: null,
    price: '0.00',
    available: 1,
    owner_name: 'Owner Name',
    owner_username: 'owner',
    owner_id: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    tags: null,
    ...overrides,
  };
}

beforeEach(() => {
  execute.mockReset();
});

describe('GET /api/minis/:id', () => {
  it('returns the mini when it exists', async () => {
    execute.mockResolvedValueOnce([[miniRow()]]);

    const res = await request(app)
      .get('/api/minis/42')
      .set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 42, name: 'Dire Wolf', owner_id: 1 });
  });

  it('returns 404 when the mini does not exist', async () => {
    execute.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get('/api/minis/999')
      .set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(404);
  });

  it('returns 401 with no auth cookie', async () => {
    const res = await request(app).get('/api/minis/42');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/minis/:id', () => {
  it('lets the owner update their own mini', async () => {
    execute
      .mockResolvedValueOnce([[{ owner_id: 1, image_path: null }]]) // ownership lookup
      .mockResolvedValueOnce([{}])                                   // UPDATE minis
      .mockResolvedValueOnce([{}])                                   // DELETE mini_tags
      .mockResolvedValueOnce([[miniRow({ name: 'Renamed Wolf' })]]);  // re-fetch

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .send({ name: 'Renamed Wolf', price: '5' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed Wolf');
  });

  it('lets an admin update someone else\'s mini', async () => {
    execute
      .mockResolvedValueOnce([[{ owner_id: 1, image_path: null }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[miniRow()]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(ADMIN))
      .send({ name: 'Dire Wolf' });

    expect(res.status).toBe(200);
  });

  it('rejects a non-owner, non-admin with 403', async () => {
    execute.mockResolvedValueOnce([[{ owner_id: 1, image_path: null }]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OTHER))
      .send({ name: 'Stolen Wolf' });

    expect(res.status).toBe(403);
  });

  it('returns 404 when the mini does not exist', async () => {
    execute.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .patch('/api/minis/999')
      .set('Cookie', authCookie(OWNER))
      .send({ name: 'Ghost Wolf' });

    expect(res.status).toBe(404);
  });

  it('rejects a blank name with 400', async () => {
    execute.mockResolvedValueOnce([[{ owner_id: 1, image_path: null }]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .send({ name: '   ' });

    expect(res.status).toBe(400);
  });

  it('rejects a negative price with 400', async () => {
    execute.mockResolvedValueOnce([[{ owner_id: 1, image_path: null }]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .send({ name: 'Dire Wolf', price: '-3' });

    expect(res.status).toBe(400);
  });

  it('returns 401 with no auth cookie', async () => {
    const res = await request(app).patch('/api/minis/42').send({ name: 'Wolf' });
    expect(res.status).toBe(401);
  });
});
