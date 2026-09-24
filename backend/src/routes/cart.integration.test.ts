import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { RowDataPacket } from 'mysql2/promise';
import { pool } from '../db/connection';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, joinCollection, createMini, TestUser,
} from '../test/dbHelpers';

const app = createApp();

let owner: TestUser;
let borrower: TestUser;
let otherBorrower: TestUser;

beforeAll(assertDatabaseReachable);
afterAll(() => pool.end());

beforeEach(async () => {
  await resetDatabase();
  const chicago = await createCollection('Chicago');
  owner = await createUser('owner', chicago);
  borrower = await createUser('borrower', chicago);
  otherBorrower = await createUser('other', chicago);
});

async function addToCart(user: TestUser, miniId: number) {
  return request(app).post('/api/cart').set('Cookie', user.cookie).send({ miniId });
}

async function checkout(user: TestUser) {
  return request(app).post('/api/cart/checkout').set('Cookie', user.cookie);
}

async function miniStatus(user: TestUser, miniId: number): Promise<string> {
  const res = await request(app).get(`/api/minis/${miniId}`).set('Cookie', user.cookie);
  return res.body.status;
}

describe('adding to the cart', () => {
  it('adds an available mini that belongs to someone else', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');

    expect((await addToCart(borrower, miniId)).status).toBe(201);

    const cart = await request(app).get('/api/cart').set('Cookie', borrower.cookie);
    expect(cart.status).toBe(200);
    expect(cart.body).toHaveLength(1);
    expect(cart.body[0]).toMatchObject({ miniId, name: 'Dire Wolf', ownerId: owner.userId, status: 'available' });
  });

  it('is harmless to add the same mini twice', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await addToCart(borrower, miniId);
    expect((await addToCart(borrower, miniId)).status).toBe(201);

    const cart = await request(app).get('/api/cart').set('Cookie', borrower.cookie);
    expect(cart.body).toHaveLength(1);
  });

  it('does not reserve anything — the mini stays available to everyone else', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await addToCart(borrower, miniId);

    expect(await miniStatus(otherBorrower, miniId)).toBe('available');
    expect((await addToCart(otherBorrower, miniId)).status).toBe(201);
  });

  it('rejects your own mini', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    expect((await addToCart(owner, miniId)).status).toBe(400);
  });

  it('rejects a mini that someone has already checked out (requested)', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await addToCart(otherBorrower, miniId);
    await checkout(otherBorrower);

    const res = await addToCart(borrower, miniId);
    expect(res.status).toBe(409);
  });

  it('rejects a mini that is currently adventuring', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await pool.execute(
      "INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status) VALUES (?, ?, ?, ?, 'adventuring')",
      [miniId, owner.collectionId, otherBorrower.userId, owner.userId]
    );

    expect((await addToCart(borrower, miniId)).status).toBe(409);
  });

  // An archived mini's owner has left the group; a browse tab opened before
  // that still shows it, but it must not be possible to ask for it.
  it('returns 404 for a mini archived when its owner left the group', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await pool.execute('UPDATE minis SET archived_at = NOW() WHERE id = ?', [miniId]);

    expect((await addToCart(borrower, miniId)).status).toBe(404);
  });

  it('returns 404 for a mini in a collection you are not currently in', async () => {
    const dojo = await createCollection('dojo');
    const dojoOwner = await createUser('dojo-owner', dojo);
    const dojoMini = await createMini(dojoOwner, 'Dojo Wolf');

    expect((await addToCart(borrower, dojoMini)).status).toBe(404);
  });

  it('rejects a missing or non-numeric miniId', async () => {
    const res = await request(app).post('/api/cart').set('Cookie', borrower.cookie).send({ miniId: 'abc' });
    expect(res.status).toBe(400);
  });
});

describe('viewing and removing', () => {
  it('shows only items from your active collection', async () => {
    const chicagoMini = await createMini(owner, 'Chicago Wolf');
    await addToCart(borrower, chicagoMini);

    const dojo = await createCollection('dojo');
    const dojoOwner = await createUser('dojo-owner', dojo);
    const dojoMini = await createMini(dojoOwner, 'Dojo Wolf');
    const borrowerInDojo = await joinCollection(borrower, dojo);
    await addToCart(borrowerInDojo, dojoMini);

    const chicagoCart = await request(app).get('/api/cart').set('Cookie', borrower.cookie);
    expect(chicagoCart.body.map((i: { name: string }) => i.name)).toEqual(['Chicago Wolf']);

    const dojoCart = await request(app).get('/api/cart').set('Cookie', borrowerInDojo.cookie);
    expect(dojoCart.body.map((i: { name: string }) => i.name)).toEqual(['Dojo Wolf']);
  });

  it('removes an item', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await addToCart(borrower, miniId);

    const res = await request(app).delete(`/api/cart/${miniId}`).set('Cookie', borrower.cookie);
    expect(res.status).toBe(200);

    const cart = await request(app).get('/api/cart').set('Cookie', borrower.cookie);
    expect(cart.body).toHaveLength(0);
  });

  it('removing a mini from your cart never touches anyone else\'s cart', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await addToCart(borrower, miniId);
    await addToCart(otherBorrower, miniId);

    await request(app).delete(`/api/cart/${miniId}`).set('Cookie', borrower.cookie);

    const otherCart = await request(app).get('/api/cart').set('Cookie', otherBorrower.cookie);
    expect(otherCart.body.map((i: { miniId: number }) => i.miniId)).toEqual([miniId]);
  });

  it('shows an item that became unavailable after it was added, flagged with its new status', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await addToCart(borrower, miniId);
    await addToCart(otherBorrower, miniId);
    await checkout(otherBorrower);

    const cart = await request(app).get('/api/cart').set('Cookie', borrower.cookie);
    expect(cart.body).toEqual([expect.objectContaining({ miniId, status: 'requested', ownerId: owner.userId })]);
  });
});

describe('checkout', () => {
  it('creates one negotiating loan per mini, empties those from the cart, and marks them requested', async () => {
    const wolf = await createMini(owner, 'Dire Wolf');
    const beholder = await createMini(owner, 'Beholder');
    await addToCart(borrower, wolf);
    await addToCart(borrower, beholder);

    const res = await checkout(borrower);
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(2);
    expect(res.body.unavailable).toEqual([]);

    const cart = await request(app).get('/api/cart').set('Cookie', borrower.cookie);
    expect(cart.body).toHaveLength(0);

    expect(await miniStatus(otherBorrower, wolf)).toBe('requested');
    expect(await miniStatus(otherBorrower, beholder)).toBe('requested');

    const loans = await request(app).get('/api/loans').set('Cookie', borrower.cookie);
    expect(loans.body).toHaveLength(2);
    expect(loans.body.every((l: { status: string }) => l.status === 'negotiating')).toBe(true);
  });

  it('skips minis someone else checked out first, keeps them in the cart, and still checks out the rest', async () => {
    const wolf = await createMini(owner, 'Dire Wolf');
    const beholder = await createMini(owner, 'Beholder');
    await addToCart(borrower, wolf);
    await addToCart(borrower, beholder);

    await addToCart(otherBorrower, wolf);
    await checkout(otherBorrower); // gets there first

    const res = await checkout(borrower);
    expect(res.status).toBe(201);
    expect(res.body.created.map((c: { miniId: number }) => c.miniId)).toEqual([beholder]);
    expect(res.body.unavailable).toEqual([{ miniId: wolf, name: 'Dire Wolf' }]);

    const cart = await request(app).get('/api/cart').set('Cookie', borrower.cookie);
    expect(cart.body).toMatchObject([{ miniId: wolf, status: 'requested' }]);
  });

  it('returns 409 when nothing in the cart is still available', async () => {
    const wolf = await createMini(owner, 'Dire Wolf');
    await addToCart(borrower, wolf);
    await addToCart(otherBorrower, wolf);
    await checkout(otherBorrower);

    const res = await checkout(borrower);
    expect(res.status).toBe(409);
  });

  // Archiving or flagging a mini clears it from carts, but a checkout already
  // under way can still be holding it — the insert itself must refuse.
  it.each([
    ['archived', 'UPDATE minis SET archived_at = NOW() WHERE id = ?'],
    ['marked lost', "UPDATE minis SET condition_flag = 'lost', condition_since = NOW() WHERE id = ?"],
  ])('never turns a mini %s after it was carted into a request', async (_label, sql) => {
    const wolf = await createMini(owner, 'Dire Wolf');
    await addToCart(borrower, wolf);
    await pool.execute(sql, [wolf]);

    expect((await checkout(borrower)).status).toBe(409);
    const [loans] = await pool.execute<RowDataPacket[]>('SELECT id FROM loans WHERE mini_id = ?', [wolf]);
    expect(loans).toHaveLength(0);
  });

  it('returns 400 for an empty cart', async () => {
    expect((await checkout(borrower)).status).toBe(400);
  });
});
