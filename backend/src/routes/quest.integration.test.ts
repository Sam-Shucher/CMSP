import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { pool } from '../db/connection';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, createMini, TestUser,
} from '../test/dbHelpers';
import { todayInApp, addDays } from '../utils/appTime';

// "On a Quest": owners taking their own minis out, against the real database.
// Requires: docker compose -f docker-compose.test.yml up -d

const app = createApp();

let owner: TestUser;
let borrower: TestUser;
let admin: TestUser;

beforeAll(assertDatabaseReachable);
afterAll(() => pool.end());

beforeEach(async () => {
  await resetDatabase();
  const chicago = await createCollection('Chicago');
  owner = await createUser('owner', chicago);
  borrower = await createUser('borrower', chicago);
  admin = await createUser('boss', chicago, 'admin');
});

const takeOut = (who: TestUser, miniId: number, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/minis/${miniId}/take-out`).set('Cookie', who.cookie).send(body);
const bringBack = (who: TestUser, miniId: number) =>
  request(app).post(`/api/minis/${miniId}/bring-back`).set('Cookie', who.cookie);
const view = (who: TestUser, miniId: number) =>
  request(app).get(`/api/minis/${miniId}`).set('Cookie', who.cookie);

function daysFromNow(days: number): string {
  return addDays(todayInApp(), days);
}

describe('taking your own mini on a quest', () => {
  it('shows everyone it\'s on a quest, with the back-by date, then available again once it\'s back', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const backBy = daysFromNow(3);

    const res = await takeOut(owner, miniId, { backBy });
    expect(res.status).toBe(200);

    const seenByOthers = await view(borrower, miniId);
    expect(seenByOthers.body).toMatchObject({ status: 'on_quest', available: false, on_quest_until: backBy });
    expect(new Date(seenByOthers.body.on_quest_since).getTime()).toBeGreaterThan(Date.now() - 60_000);

    expect((await bringBack(owner, miniId)).status).toBe(200);
    expect((await view(borrower, miniId)).body).toMatchObject({ status: 'available', on_quest_since: null, on_quest_until: null });
  });

  it('works without a back-by date', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');

    await takeOut(owner, miniId);

    expect((await view(borrower, miniId)).body).toMatchObject({ status: 'on_quest', on_quest_until: null });
  });

  it('can\'t be added to anyone\'s cart while on a quest', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await takeOut(owner, miniId);

    const res = await request(app).post('/api/cart').set('Cookie', borrower.cookie).send({ miniId });

    expect(res.status).toBe(409);
  });

  it('is skipped at checkout if the owner took it out while it sat in someone\'s cart', async () => {
    const wolf = await createMini(owner, 'Dire Wolf');
    const bear = await createMini(owner, 'Owlbear');
    await request(app).post('/api/cart').set('Cookie', borrower.cookie).send({ miniId: wolf });
    await request(app).post('/api/cart').set('Cookie', borrower.cookie).send({ miniId: bear });

    await takeOut(owner, wolf);

    const cart = await request(app).get('/api/cart').set('Cookie', borrower.cookie);
    expect(cart.body.find((i: { miniId: number }) => i.miniId === wolf).status).toBe('on_quest');

    const checkout = await request(app).post('/api/cart/checkout').set('Cookie', borrower.cookie);
    expect(checkout.status).toBe(201);
    expect(checkout.body.created.map((c: { miniId: number }) => c.miniId)).toEqual([bear]);
    expect(checkout.body.unavailable).toEqual([{ miniId: wolf, name: 'Dire Wolf' }]);
  });

  it('is blocked while someone has requested the mini', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await request(app).post('/api/cart').set('Cookie', borrower.cookie).send({ miniId });
    await request(app).post('/api/cart/checkout').set('Cookie', borrower.cookie);

    const res = await takeOut(owner, miniId);

    expect(res.status).toBe(409);
    expect((await view(owner, miniId)).body.status).toBe('requested');
  });

  it('becomes possible again once that request is cancelled', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await request(app).post('/api/cart').set('Cookie', borrower.cookie).send({ miniId });
    const checkout = await request(app).post('/api/cart/checkout').set('Cookie', borrower.cookie);
    await request(app).post(`/api/loans/${checkout.body.created[0].loanId}/cancel`).set('Cookie', owner.cookie);

    expect((await takeOut(owner, miniId)).status).toBe(200);
  });

  it('is only for the owner — other members and admins get 403 and nothing changes', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');

    expect((await takeOut(borrower, miniId)).status).toBe(403);
    expect((await takeOut(admin, miniId)).status).toBe(403);
    expect((await view(owner, miniId)).body.status).toBe('available');

    await takeOut(owner, miniId);
    expect((await bringBack(admin, miniId)).status).toBe(403);
    expect((await view(owner, miniId)).body.status).toBe('on_quest');
  });

  it('can\'t be done to another collection\'s mini, even by guessing its id', async () => {
    const dojo = await createCollection('dojo');
    const outsider = await createUser('ninja', dojo);
    const miniId = await createMini(owner, 'Dire Wolf');

    expect((await takeOut(outsider, miniId)).status).toBe(404);
  });

  it('refuses to take out twice or bring back something that isn\'t out', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');

    expect((await bringBack(owner, miniId)).status).toBe(409);
    await takeOut(owner, miniId);
    expect((await takeOut(owner, miniId)).status).toBe(409);
  });

  it('rejects a back-by date in the past', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');

    const res = await takeOut(owner, miniId, { backBy: daysFromNow(-5) });

    expect(res.status).toBe(400);
    expect((await view(owner, miniId)).body.status).toBe('available');
  });

  it('shows up in the browse list with its status', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await takeOut(owner, miniId, { backBy: daysFromNow(2) });

    const list = await request(app).get('/api/minis').set('Cookie', borrower.cookie);

    expect(list.body).toEqual([expect.objectContaining({ id: miniId, status: 'on_quest', on_quest_until: daysFromNow(2) })]);
  });
});
