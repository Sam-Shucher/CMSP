import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { RowDataPacket } from 'mysql2';
import { createApp } from '../app';
import { pool } from '../db/connection';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, createMini, joinCollection, TestUser,
} from '../test/dbHelpers';

// Removing a member from a group, against the real database — what happens to
// the loans, requests, holds, and minis they're part of.
// Requires: docker compose -f docker-compose.test.yml up -d

const app = createApp();
const WHEN = '2026-10-01T18:00:00.000Z';

let chicago: number;
let admin: TestUser;
let olivia: TestUser;
let bruno: TestUser;
let theo: TestUser;
let wendy: TestUser;

beforeAll(assertDatabaseReachable);
afterAll(() => pool.end());

beforeEach(async () => {
  await resetDatabase();
  chicago = await createCollection('Chicago');
  admin = await createUser('boss', chicago, 'admin');
  olivia = await createUser('olivia', chicago);
  bruno = await createUser('bruno', chicago);
  theo = await createUser('theo', chicago);
  wendy = await createUser('wendy', chicago);
});

const remove = (who: TestUser) => request(app).delete(`/api/admin/users/${who.userId}`).set('Cookie', admin.cookie);

async function checkOut(who: TestUser, miniId: number): Promise<number> {
  await request(app).post('/api/cart').set('Cookie', who.cookie).send({ miniId });
  const res = await request(app).post('/api/cart/checkout').set('Cookie', who.cookie);
  return res.body.created.find((c: { miniId: number }) => c.miniId === miniId).loanId;
}

async function handOff(owner: TestUser, borrower: TestUser, loanId: number): Promise<void> {
  await request(app).patch(`/api/loans/${loanId}/terms`).set('Cookie', borrower.cookie).send({ when: WHEN, where: 'Shop', how: 'In person' });
  await request(app).patch(`/api/loans/${loanId}/terms`).set('Cookie', owner.cookie).send({ durationDays: 7 });
  await request(app).post(`/api/loans/${loanId}/approve`).set('Cookie', borrower.cookie);
  await request(app).post(`/api/loans/${loanId}/handoff`).set('Cookie', owner.cookie);
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params);
  return result;
}

async function inbox(who: TestUser) {
  return (await request(app).get('/api/notifications').set('Cookie', who.cookie)).body.items as Array<{ type: string; message: string }>;
}

describe('removing a member who is part of loans', () => {
  it('refuses while a mini is out on loan with them, and changes nothing', async () => {
    const dragon = await createMini(olivia, 'Dragon');
    await handOff(olivia, bruno, await checkOut(bruno, dragon));
    const beholder = await createMini(bruno, 'Beholder');
    const request_ = await checkOut(theo, beholder);

    const res = await remove(bruno);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('bruno display has 1 mini out on loan in this group — it needs to be marked returned first');
    expect(await rows('SELECT id FROM collection_memberships WHERE user_id = ?', [bruno.userId])).toHaveLength(1);
    expect(await rows("SELECT id FROM loans WHERE id = ? AND status = 'negotiating'", [request_])).toHaveLength(1);
    expect(await rows('SELECT id FROM minis WHERE id = ?', [beholder])).toHaveLength(1);
  });

  it('refuses while one of their own minis is out with someone else', async () => {
    const beholder = await createMini(bruno, 'Beholder');
    const owlbear = await createMini(bruno, 'Owlbear');
    await handOff(bruno, theo, await checkOut(theo, beholder));
    await handOff(bruno, wendy, await checkOut(wendy, owlbear));

    const res = await remove(bruno);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('bruno display has 2 minis out on loan in this group — they need to be marked returned first');
  });

  it('once nothing is out: cancels their open requests both ways, telling the other person', async () => {
    const dragon = await createMini(olivia, 'Dragon');
    await checkOut(bruno, dragon);
    const beholder = await createMini(bruno, 'Beholder');
    await checkOut(theo, beholder);

    const res = await remove(bruno);

    expect(res.status).toBe(200);
    expect((await request(app).get(`/api/minis/${dragon}`).set('Cookie', olivia.cookie)).body.status).toBe('available');
    expect((await inbox(olivia))[0]).toMatchObject({ type: 'request_cancelled', message: 'bruno display is no longer in the group, so the request for Dragon was cancelled' });
    expect((await inbox(theo))[0]).toMatchObject({ type: 'request_cancelled', message: 'bruno display is no longer in the group, so the request for Beholder was cancelled' });
  });

  it('frees the minis they had requested, so the next person in line gets them', async () => {
    const dragon = await createMini(olivia, 'Dragon');
    await checkOut(bruno, dragon);
    await request(app).post(`/api/holds/minis/${dragon}`).set('Cookie', wendy.cookie);

    await remove(bruno);

    expect(await rows("SELECT borrower_id FROM loans WHERE mini_id = ? AND status = 'negotiating'", [dragon]))
      .toEqual([expect.objectContaining({ borrower_id: wendy.userId })]);
    const mini = await request(app).get(`/api/minis/${dragon}`).set('Cookie', olivia.cookie);
    expect(mini.body.status).toBe('requested');
  });

  it('takes their minis out of the group, telling anyone waiting for them', async () => {
    const beholder = await createMini(bruno, 'Beholder');
    const onQuest = await createMini(bruno, 'Owlbear');
    await request(app).post(`/api/minis/${onQuest}/take-out`).set('Cookie', bruno.cookie).send({});
    await request(app).post(`/api/holds/minis/${onQuest}`).set('Cookie', wendy.cookie);
    await checkOut(theo, beholder);

    const res = await remove(bruno);

    expect(res.status).toBe(200);
    const list = await request(app).get('/api/minis').set('Cookie', olivia.cookie);
    expect(list.body).toEqual([]);
    expect((await inbox(wendy))[0]).toMatchObject({ type: 'mini_removed', message: expect.stringContaining('Owlbear') });
  });

  it('clears their cart in this group', async () => {
    const dragon = await createMini(olivia, 'Dragon');
    const brunoInDojo = await joinCollection(bruno, await createCollection('dojo'));
    await request(app).post('/api/cart').set('Cookie', bruno.cookie).send({ miniId: dragon });

    await remove(bruno);

    expect(await rows('SELECT id FROM cart_items WHERE user_id = ?', [brunoInDojo.userId])).toEqual([]);
  });

  it('someone in two groups keeps the other group and everything in it', async () => {
    const dojo = await createCollection('dojo');
    const brunoInDojo = await joinCollection(bruno, dojo);
    const sensei = await createUser('sensei', dojo);
    const dojoMini = await createMini(brunoInDojo, 'Dojo Wolf');
    const dojoRequest = await checkOut(sensei, dojoMini);
    const chicagoMini = await createMini(bruno, 'Chicago Wolf');

    const res = await remove(bruno);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Removed from this group — their 1 mini here was removed too');
    expect(await rows('SELECT id FROM minis WHERE id = ?', [chicagoMini])).toEqual([]);
    expect(await rows('SELECT id FROM minis WHERE id = ?', [dojoMini])).toHaveLength(1);
    expect(await rows("SELECT id FROM loans WHERE id = ? AND status = 'negotiating'", [dojoRequest])).toHaveLength(1);
  });

  it('deletes the account when it was their last group, once nothing is out', async () => {
    const res = await remove(bruno);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Removed from this group — that was their last one, so the account was deleted too');
    expect(await rows('SELECT id FROM users WHERE id = ?', [bruno.userId])).toEqual([]);
  });

  it('a loan that already came back doesn\'t block removal', async () => {
    const dragon = await createMini(olivia, 'Dragon');
    const loanId = await checkOut(bruno, dragon);
    await handOff(olivia, bruno, loanId);
    await request(app).post(`/api/loans/${loanId}/return`).set('Cookie', olivia.cookie);

    expect((await remove(bruno)).status).toBe(200);
  });
});
