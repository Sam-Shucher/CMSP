import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { RowDataPacket } from 'mysql2';
import { createApp } from '../app';
import { pool } from '../db/connection';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, createMini, joinCollection, TestUser,
} from '../test/dbHelpers';

// Turning prices off for a group, against the real database: the admin's
// switch lands on collections.show_prices, requireCollectionMembership's JOIN
// picks it up on the very next request, and the stored prices survive being
// hidden — so switching back on brings back exactly what was there.
//
// Requires: docker compose -f docker-compose.test.yml up -d

const app = createApp();

let chicago: number;
let dojo: number;
let admin: TestUser;   // admin of Chicago
let olivia: TestUser;  // a member of Chicago, owns the minis

beforeAll(assertDatabaseReachable);
afterAll(() => pool.end());

beforeEach(async () => {
  await resetDatabase();
  chicago = await createCollection('Chicago');
  dojo = await createCollection('dojo');
  admin = await createUser('admin', chicago, 'admin');
  olivia = await createUser('olivia', chicago);
});

async function pricedMini(owner: TestUser, name: string, price: number): Promise<number> {
  const miniId = await createMini(owner, name);
  await pool.execute('UPDATE minis SET price = ? WHERE id = ?', [price, miniId]);
  return miniId;
}

async function storedPrice(miniId: number): Promise<number> {
  const [rows] = await pool.execute<RowDataPacket[]>('SELECT price FROM minis WHERE id = ?', [miniId]);
  return Number(rows[0].price);
}

function setShowPrices(showPrices: boolean) {
  return request(app).patch('/api/admin/settings').set('Cookie', admin.cookie).send({ showPrices });
}

describe('a new group', () => {
  it('shows prices until an admin says otherwise', async () => {
    await pricedMini(olivia, 'Dire Wolf', 12.5);

    const res = await request(app).get('/api/minis').set('Cookie', olivia.cookie);

    expect(res.body[0].price).toBe(12.5);
  });
});

describe('PATCH /api/admin/settings { showPrices: false }', () => {
  it('hides prices from every member at once, and says so on the group list', async () => {
    const miniId = await pricedMini(olivia, 'Dire Wolf', 12.5);

    expect((await setShowPrices(false)).status).toBe(200);

    const list = await request(app).get('/api/minis').set('Cookie', olivia.cookie);
    expect(list.body[0].price).toBeNull();
    const one = await request(app).get(`/api/minis/${miniId}`).set('Cookie', olivia.cookie);
    expect(one.body.price).toBeNull();

    const groups = await request(app).get('/api/auth/collections').set('Cookie', olivia.cookie);
    expect(groups.body).toEqual([expect.objectContaining({ id: chicago, showPrices: false })]);
  });

  it('only touches the admin\'s own group', async () => {
    await setShowPrices(false);
    const dojoMember = await createUser('dojo-member', dojo);
    await pricedMini(dojoMember, 'Owlbear', 30);

    const res = await request(app).get('/api/minis').set('Cookie', dojoMember.cookie);

    expect(res.body[0].price).toBe(30);
    // Someone in both groups sees each group's own setting.
    const both = await joinCollection(olivia, dojo);
    const groups = await request(app).get('/api/auth/collections').set('Cookie', both.cookie);
    expect(groups.body).toEqual([
      expect.objectContaining({ id: chicago, showPrices: false }),
      expect.objectContaining({ id: dojo, showPrices: true }),
    ]);
  });

  it('ignores a request to sort by price, giving the newest first instead', async () => {
    await setShowPrices(false);
    await pricedMini(olivia, 'Cheap', 1);
    await pricedMini(olivia, 'Dear', 99);
    // Same-second inserts would tie on created_at; make "Cheap" clearly the newer.
    await pool.execute('UPDATE minis SET created_at = NOW() - INTERVAL 1 DAY WHERE name = ?', ['Dear']);

    const res = await request(app).get('/api/minis?sort=price').set('Cookie', olivia.cookie);

    expect(res.status).toBe(200);
    expect(res.body.map((m: { name: string }) => m.name)).toEqual(['Cheap', 'Dear']);
  });

  it('leaves the stored price alone through an edit, so turning prices back on restores it', async () => {
    const miniId = await pricedMini(olivia, 'Dire Wolf', 12.5);
    await setShowPrices(false);

    const edited = await request(app)
      .patch(`/api/minis/${miniId}`)
      .set('Cookie', olivia.cookie)
      .field('name', 'Dire Wolf (painted)')
      .field('price', '1.00');
    expect(edited.status).toBe(200);
    expect(await storedPrice(miniId)).toBe(12.5);

    await setShowPrices(true);
    const res = await request(app).get(`/api/minis/${miniId}`).set('Cookie', olivia.cookie);
    expect(res.body).toMatchObject({ name: 'Dire Wolf (painted)', price: 12.5 });
  });

  it('adds a new mini at 0, whatever price was sent', async () => {
    await setShowPrices(false);

    const created = await request(app)
      .post('/api/minis')
      .set('Cookie', olivia.cookie)
      .field('name', 'Owlbear')
      .field('price', '30.00');

    expect(created.status).toBe(201);
    expect(await storedPrice(created.body.miniId)).toBe(0);
  });

  it('is refused for a member who is not an admin', async () => {
    const res = await request(app).patch('/api/admin/settings').set('Cookie', olivia.cookie).send({ showPrices: false });

    expect(res.status).toBe(403);
    const [rows] = await pool.execute<RowDataPacket[]>('SELECT show_prices FROM collections WHERE id = ?', [chicago]);
    expect(rows[0].show_prices).toBe(1);
  });
});
