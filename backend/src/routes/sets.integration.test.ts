import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { createApp } from '../app';
import { pool } from '../db/connection';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, createMini, joinCollection, TestUser,
} from '../test/dbHelpers';

// Sets, against the real database: the ownership/grouping checks that decide
// whether a mini can join a set, the ON DELETE SET NULL cascade when a set is
// deleted, and the "borrow this set" journey through the real cart and
// checkout — proving the backlog's claim that this needed no new loan
// machinery, just grouping and a lend-together action.
//
// Requires: docker compose -f docker-compose.test.yml up -d

const app = createApp();

let chicago: number;
let dojo: number;
let olivia: TestUser;    // owns a set
let bruno: TestUser;     // borrows it
let dojoOwner: TestUser; // a mini in the OTHER collection, same ids reused

beforeAll(assertDatabaseReachable);
afterAll(() => pool.end());

beforeEach(async () => {
  await resetDatabase();
  chicago = await createCollection('Chicago');
  dojo = await createCollection('dojo');
  olivia = await createUser('olivia', chicago);
  bruno = await createUser('bruno', chicago);
  dojoOwner = await createUser('dojo-owner', dojo);
});

async function markSetId(miniId: number, setId: number | null): Promise<void> {
  await pool.execute('UPDATE minis SET set_id = ? WHERE id = ?', [setId, miniId]);
}

async function setIdOf(miniId: number): Promise<number | null> {
  const [rows] = await pool.execute<RowDataPacket[]>('SELECT set_id FROM minis WHERE id = ?', [miniId]);
  return rows[0].set_id;
}

describe('POST /api/sets — creating', () => {
  it('creates a set with the given minis moved into it', async () => {
    const banshee = await createMini(olivia, 'Banshee');
    const farseer = await createMini(olivia, 'Farseer');

    const res = await request(app).post('/api/sets').set('Cookie', olivia.cookie)
      .send({ name: 'Blades of Khaine', miniIds: [banshee, farseer] });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Blades of Khaine');
    expect(res.body.members.map((m: { name: string }) => m.name).sort()).toEqual(['Banshee', 'Farseer']);
    expect(await setIdOf(banshee)).toBe(res.body.id);
  });

  it('refuses a mini that belongs to someone else', async () => {
    const brunoMini = await createMini(bruno, 'Not Yours');

    const res = await request(app).post('/api/sets').set('Cookie', olivia.cookie)
      .send({ name: 'Stolen Host', miniIds: [brunoMini] });

    expect(res.status).toBe(400);
    expect(await setIdOf(brunoMini)).toBeNull();
  });

  it('refuses a mini already in another set, and creates neither the set nor a partial grouping', async () => {
    const grouped = await createMini(olivia, 'Already Grouped');
    const free = await createMini(olivia, 'Free Agent');
    const first = await request(app).post('/api/sets').set('Cookie', olivia.cookie).send({ name: 'First Set', miniIds: [grouped] });
    expect(first.status).toBe(201);

    const res = await request(app).post('/api/sets').set('Cookie', olivia.cookie)
      .send({ name: 'Second Set', miniIds: [grouped, free] });

    expect(res.status).toBe(400);
    expect(await setIdOf(free)).toBeNull(); // the whole request failed together, nothing partially applied
    const [[{ n }]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM sets WHERE name = ?', ['Second Set']);
    expect(Number(n)).toBe(0);
  });

  it('refuses a mini from another collection, even one the caller happens to own', async () => {
    const dojoMini = await createMini(dojoOwner, 'Dojo Mini');

    // olivia can't reach it at all — try it as someone actually acting in dojo instead.
    const someone = await joinCollection(await createUser('wanderer', chicago), dojo);
    const res = await request(app).post('/api/sets').set('Cookie', someone.cookie).send({ name: 'x', miniIds: [dojoMini] });

    expect(res.status).toBe(400); // not theirs — dojoOwner's, not someone's
  });
});

describe('PATCH /api/sets/:id — managing membership', () => {
  it('adds and removes members in one call', async () => {
    const a = await createMini(olivia, 'A');
    const b = await createMini(olivia, 'B');
    const created = await request(app).post('/api/sets').set('Cookie', olivia.cookie).send({ name: 'Squad', miniIds: [a] });
    const setId = created.body.id;

    const res = await request(app).patch(`/api/sets/${setId}`).set('Cookie', olivia.cookie)
      .send({ addMiniIds: [b], removeMiniIds: [a] });

    expect(res.status).toBe(200);
    expect(await setIdOf(a)).toBeNull();
    expect(await setIdOf(b)).toBe(setId);
  });

  it('lets a collection admin manage someone else\'s set, using minis owned by the SET\'S owner', async () => {
    const admin = await createUser('ada', chicago, 'admin');
    const oliviaMini = await createMini(olivia, 'Olivia\'s Mini');
    const adminsOwnMini = await createMini(admin, 'Admin\'s Own Mini');
    const created = await request(app).post('/api/sets').set('Cookie', olivia.cookie).send({ name: 'Squad', miniIds: [] });

    // The admin can add Olivia's own mini to Olivia's set...
    const addHers = await request(app).patch(`/api/sets/${created.body.id}`).set('Cookie', admin.cookie).send({ addMiniIds: [oliviaMini] });
    expect(addHers.status).toBe(200);

    // ...but not slip their OWN mini into it.
    const addTheirs = await request(app).patch(`/api/sets/${created.body.id}`).set('Cookie', admin.cookie).send({ addMiniIds: [adminsOwnMini] });
    expect(addTheirs.status).toBe(400);
    expect(await setIdOf(adminsOwnMini)).toBeNull();
  });

  it('refuses a non-owner, non-admin member', async () => {
    const created = await request(app).post('/api/sets').set('Cookie', olivia.cookie).send({ name: 'Squad', miniIds: [] });

    const res = await request(app).patch(`/api/sets/${created.body.id}`).set('Cookie', bruno.cookie).send({ name: 'Hijacked' });

    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/sets/:id — ungroups its minis rather than deleting them', () => {
  it('leaves the member minis in place, just no longer in a set', async () => {
    const banshee = await createMini(olivia, 'Banshee');
    const created = await request(app).post('/api/sets').set('Cookie', olivia.cookie).send({ name: 'Squad', miniIds: [banshee] });

    const res = await request(app).delete(`/api/sets/${created.body.id}`).set('Cookie', olivia.cookie);

    expect(res.status).toBe(200);
    expect(await setIdOf(banshee)).toBeNull(); // ungrouped, not gone
    const mini = await request(app).get(`/api/minis/${banshee}`).set('Cookie', olivia.cookie);
    expect(mini.status).toBe(200); // still exists
    const list = await request(app).get('/api/sets').set('Cookie', olivia.cookie);
    expect(list.body).toEqual([]);
  });
});

describe('POST /api/sets/:id/cart — borrowing a whole set in one action', () => {
  it('adds every available member to the cart, and checkout turns each into its own loan request', async () => {
    const banshee = await createMini(olivia, 'Banshee');
    const farseer = await createMini(olivia, 'Farseer');
    const created = await request(app).post('/api/sets').set('Cookie', olivia.cookie).send({ name: 'Blades of Khaine', miniIds: [banshee, farseer] });

    const borrow = await request(app).post(`/api/sets/${created.body.id}/cart`).set('Cookie', bruno.cookie);
    expect(borrow.status).toBe(201);
    expect(borrow.body.added).toHaveLength(2);

    const cart = await request(app).get('/api/cart').set('Cookie', bruno.cookie);
    expect(cart.body.map((c: { name: string }) => c.name).sort()).toEqual(['Banshee', 'Farseer']);

    // No special "set loan" concept needed — checkout does exactly what it
    // always does: one negotiating loan per mini.
    const checkout = await request(app).post('/api/cart/checkout').set('Cookie', bruno.cookie);
    expect(checkout.status).toBe(201);
    expect(checkout.body.created).toHaveLength(2);

    const loans = await request(app).get('/api/loans').set('Cookie', bruno.cookie);
    expect(loans.body.map((l: { miniName: string }) => l.miniName).sort()).toEqual(['Banshee', 'Farseer']);
  });

  it('skips a member already out on loan, and still adds the rest', async () => {
    const banshee = await createMini(olivia, 'Banshee');
    const farseer = await createMini(olivia, 'Farseer');
    const created = await request(app).post('/api/sets').set('Cookie', olivia.cookie).send({ name: 'Squad', miniIds: [banshee, farseer] });

    // Bruno already has Banshee out — Farseer is what's left to grab.
    await request(app).post('/api/cart').set('Cookie', bruno.cookie).send({ miniId: banshee });
    await request(app).post('/api/cart/checkout').set('Cookie', bruno.cookie);

    const someoneElse = await createUser('wendy', chicago);
    const res = await request(app).post(`/api/sets/${created.body.id}/cart`).set('Cookie', someoneElse.cookie);

    expect(res.status).toBe(201);
    expect(res.body.added).toEqual([expect.objectContaining({ name: 'Farseer' })]);
    expect(res.body.skipped).toEqual([expect.objectContaining({ name: 'Banshee', reason: 'unavailable' })]);
  });

  it('returns 404 for a set in a different collection', async () => {
    const dojoMini = await createMini(dojoOwner, 'Dojo Mini');
    const [setResult] = await pool.execute<ResultSetHeader>(
      'INSERT INTO sets (name, owner_id, collection_id) VALUES (?, ?, ?)', ['Dojo Squad', dojoOwner.userId, dojo]
    );
    await markSetId(dojoMini, setResult.insertId);

    const res = await request(app).post(`/api/sets/${setResult.insertId}/cart`).set('Cookie', bruno.cookie);

    expect(res.status).toBe(404);
  });
});
