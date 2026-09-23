import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { authCookie } from '../test/helpers';

// The cart's real SQL is exercised in cart.integration.test.ts. These mocked
// tests cover what a real database won't do on demand: fail mid-request.
vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../db/connection';
import { createApp } from '../app';

const app = createApp();
const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;

const BORROWER = { userId: 2, username: 'borrower', role: 'user', collectionId: 10 };
const MEMBERSHIP_CONFIRMED = [[{ id: 1 }]];

beforeEach(() => {
  execute.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('cart routes — access', () => {
  it.each([
    ['GET /api/cart', () => request(app).get('/api/cart')],
    ['POST /api/cart', () => request(app).post('/api/cart').send({ miniId: 1 })],
    ['DELETE /api/cart/:miniId', () => request(app).delete('/api/cart/1')],
    ['POST /api/cart/checkout', () => request(app).post('/api/cart/checkout')],
  ])('%s requires login', async (_route, send) => {
    const res = await send();

    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires membership in the active collection', async () => {
    execute.mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/cart').set('Cookie', authCookie(BORROWER));

    expect(res.status).toBe(403);
  });
});

describe('cart routes — input', () => {
  it.each([
    ['zero', 0],
    ['negative', -4],
    ['a fraction', 1.5],
    ['text', 'abc'],
  ])('rejects a miniId that is %s with 400', async (_why, miniId) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).post('/api/cart').set('Cookie', authCookie(BORROWER)).send({ miniId });

    expect(res.status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(1); // only the membership check
  });

  it.each(['lost', 'critically_wounded'])('refuses to add a %s mini to the cart', async (condition) => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1, active_loan_status: null, on_quest_since: null, condition_flag: condition }]]);

    const res = await request(app).post('/api/cart').set('Cookie', authCookie(BORROWER)).send({ miniId: 42 });

    expect(res.status).toBe(409);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('INSERT'), expect.anything());
  });

  it('only removes from the logged-in user\'s own cart', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([{}]);

    await request(app).delete('/api/cart/7').set('Cookie', authCookie(BORROWER));

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM cart_items'), [BORROWER.userId, 7]);
  });
});

describe('cart routes — database failures', () => {
  it.each([
    ['GET /api/cart', () => request(app).get('/api/cart').set('Cookie', authCookie(BORROWER))],
    ['POST /api/cart', () => request(app).post('/api/cart').set('Cookie', authCookie(BORROWER)).send({ miniId: 1 })],
    ['DELETE /api/cart/:miniId', () => request(app).delete('/api/cart/1').set('Cookie', authCookie(BORROWER))],
    ['POST /api/cart/checkout', () => request(app).post('/api/cart/checkout').set('Cookie', authCookie(BORROWER))],
  ])('%s returns a generic 500', async (_route, send) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockRejectedValue(new Error('connection lost'));

    const res = await send();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Server error' });
  });
});
