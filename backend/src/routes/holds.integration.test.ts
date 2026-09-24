import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { RowDataPacket } from 'mysql2';
import { createApp } from '../app';
import { pool } from '../db/connection';
import { resetRateLimits } from '../middleware/rateLimit';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, createMini, joinCollection, TestUser,
} from '../test/dbHelpers';

// The hold line, end to end against the real database.
// Requires: docker compose -f docker-compose.test.yml up -d

const app = createApp();

let chicago: number;
let owner: TestUser;
let borrower: TestUser;
let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
let dave: TestUser;
let admin: TestUser;

beforeAll(assertDatabaseReachable);
afterAll(() => pool.end());

beforeEach(async () => {
  resetRateLimits();
  await resetDatabase();
  chicago = await createCollection('Chicago');
  owner = await createUser('owner', chicago);
  borrower = await createUser('borrower', chicago);
  alice = await createUser('alice', chicago);
  bob = await createUser('bob', chicago);
  carol = await createUser('carol', chicago);
  dave = await createUser('dave', chicago);
  admin = await createUser('boss', chicago, 'admin');
});

// ---- helpers --------------------------------------------------------------

const placeHold = (who: TestUser, miniId: number) =>
  request(app).post(`/api/holds/minis/${miniId}`).set('Cookie', who.cookie);
const leaveHold = (who: TestUser, miniId: number) =>
  request(app).delete(`/api/holds/minis/${miniId}`).set('Cookie', who.cookie);
const watch = (who: TestUser, miniId: number) =>
  request(app).post(`/api/holds/minis/${miniId}/watch`).set('Cookie', who.cookie);
const summary = (who: TestUser, miniId: number) =>
  request(app).get(`/api/holds/minis/${miniId}`).set('Cookie', who.cookie);

// The real flow: cart → checkout. Returns the loan id.
async function checkOut(who: TestUser, miniId: number): Promise<number> {
  await request(app).post('/api/cart').set('Cookie', who.cookie).send({ miniId });
  const res = await request(app).post('/api/cart/checkout').set('Cookie', who.cookie);
  return res.body.created.find((c: { miniId: number }) => c.miniId === miniId).loanId;
}

async function lendOut(miniId: number): Promise<number> {
  const loanId = await checkOut(borrower, miniId);
  await request(app).patch(`/api/loans/${loanId}/terms`).set('Cookie', borrower.cookie)
    .send({ when: '2026-10-01T18:00:00.000Z', where: 'Game store', how: 'In person' });
  await request(app).patch(`/api/loans/${loanId}/terms`).set('Cookie', owner.cookie).send({ durationDays: 7 });
  await request(app).post(`/api/loans/${loanId}/approve`).set('Cookie', borrower.cookie);
  await request(app).post(`/api/loans/${loanId}/handoff`).set('Cookie', owner.cookie);
  return loanId;
}

async function notificationsFor(who: TestUser): Promise<{ type: string; message: string; loanId: number | null; miniId: number | null }[]> {
  const res = await request(app).get('/api/notifications').set('Cookie', who.cookie);
  return res.body.items;
}

async function typesFor(who: TestUser): Promise<string[]> {
  return (await notificationsFor(who)).map(n => n.type);
}

async function holdOrder(miniId: number): Promise<number[]> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT user_id FROM holds WHERE mini_id = ? ORDER BY id', [miniId]);
  return rows.map(r => r.user_id as number);
}

// ---- placing holds ---------------------------------------------------------

describe('placing a hold', () => {
  it('is not needed for an available mini — you\'re told to add it to your cart', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');

    const res = await placeHold(alice, miniId);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'available', error: expect.stringMatching(/cart/i) });
  });

  it('works as soon as someone has requested the mini, putting you first in line', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await checkOut(borrower, miniId);

    const res = await placeHold(alice, miniId);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ position: 1 });
  });

  it('works while the mini is out adventuring, or on a quest with its owner', async () => {
    const lent = await createMini(owner, 'Dire Wolf');
    await lendOut(lent);
    const questing = await createMini(owner, 'Owlbear');
    await request(app).post(`/api/minis/${questing}/take-out`).set('Cookie', owner.cookie).send({});

    expect((await placeHold(alice, lent)).status).toBe(201);
    expect((await placeHold(alice, questing)).status).toBe(201);
  });

  it('lines people up in the order they placed holds', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await checkOut(borrower, miniId);

    expect((await placeHold(alice, miniId)).body.position).toBe(1);
    expect((await placeHold(bob, miniId)).body.position).toBe(2);
    expect((await placeHold(carol, miniId)).body.position).toBe(3);
    expect(await holdOrder(miniId)).toEqual([alice.userId, bob.userId, carol.userId]);
  });

  it('allows at most 3 holds per mini', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await checkOut(borrower, miniId);
    for (const who of [alice, bob, carol]) await placeHold(who, miniId);

    const res = await placeHold(dave, miniId);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('full');
    expect(await holdOrder(miniId)).toHaveLength(3);
  });

  it('never lets more than 3 in, even when several people grab the last spots at the same moment', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await checkOut(borrower, miniId);
    const extra = await createUser('erin', chicago);

    const results = await Promise.all([alice, bob, carol, dave, extra].map(who => placeHold(who, miniId)));

    expect(results.filter(r => r.status === 201)).toHaveLength(3);
    expect(results.filter(r => r.status === 409)).toHaveLength(2);
    expect(await holdOrder(miniId)).toHaveLength(3);
  });

  it('refuses your own mini, the mini you\'re already requesting or borrowing, and a second hold', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await checkOut(borrower, miniId);

    expect((await placeHold(owner, miniId)).status).toBe(400);
    expect((await placeHold(borrower, miniId)).status).toBe(409); // no renewing by getting back in line
    await placeHold(alice, miniId);
    expect((await placeHold(alice, miniId)).status).toBe(409);
  });

  // Removing a member archives their minis, even one they had out on a quest
  // (a quest doesn't block removal) — it's parked, not waiting to come back.
  it('can\'t be done to an archived mini, even one still marked on a quest', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await request(app).post(`/api/minis/${miniId}/take-out`).set('Cookie', owner.cookie).send({});
    await pool.execute('UPDATE minis SET archived_at = NOW() WHERE id = ?', [miniId]);

    expect((await placeHold(alice, miniId)).status).toBe(404);
  });

  it('can\'t be done to another collection\'s mini, even by guessing its id', async () => {
    const dojo = await createCollection('dojo');
    const outsider = await createUser('ninja', dojo);
    const miniId = await createMini(owner, 'Dire Wolf');
    await checkOut(borrower, miniId);

    expect((await placeHold(outsider, miniId)).status).toBe(404);
    expect((await summary(outsider, miniId)).status).toBe(404);
  });

  it('tells the owner someone is waiting', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await checkOut(borrower, miniId);

    await placeHold(alice, miniId);

    const [latest] = await notificationsFor(owner);
    expect(latest).toMatchObject({ type: 'hold_placed', miniId, message: expect.stringMatching(/alice display placed a hold on Dire Wolf \(#1 in line\)/) });
  });
});

// ---- seeing the line ---------------------------------------------------------

describe('seeing the line', () => {
  it('shows everyone the count, you your own position, and only the owner the names', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await checkOut(borrower, miniId);
    await placeHold(alice, miniId);
    await placeHold(bob, miniId);

    expect((await summary(carol, miniId)).body).toEqual({ max: 3, count: 2, position: null, watching: false });
    expect((await summary(bob, miniId)).body).toEqual({ max: 3, count: 2, position: 2, watching: false });
    expect((await summary(owner, miniId)).body).toEqual({
      max: 3, count: 2, position: null, watching: false,
      queue: [{ position: 1, displayName: 'alice display' }, { position: 2, displayName: 'bob display' }],
    });
  });

  it('lists your holds and notify-list entries in the active collection', async () => {
    const wolf = await createMini(owner, 'Dire Wolf');
    const bear = await createMini(owner, 'Owlbear');
    await checkOut(borrower, wolf);
    await checkOut(borrower, bear);
    await placeHold(alice, wolf);
    await placeHold(bob, wolf);
    for (const who of [alice, bob, carol]) await placeHold(who, bear);
    await watch(dave, bear);

    const bobs = await request(app).get('/api/holds').set('Cookie', bob.cookie);
    expect(bobs.body.holds).toEqual([
      expect.objectContaining({ miniId: wolf, miniName: 'Dire Wolf', position: 2, ownerName: 'owner display', status: 'requested' }),
      expect.objectContaining({ miniId: bear, miniName: 'Owlbear', position: 2 }),
    ]);
    expect(bobs.body.watching).toEqual([]);

    const daves = await request(app).get('/api/holds').set('Cookie', dave.cookie);
    expect(daves.body.watching).toEqual([expect.objectContaining({ miniId: bear, miniName: 'Owlbear', holdCount: 3 })]);
  });
});

// ---- leaving the line ----------------------------------------------------------

describe('leaving the line', () => {
  it('moves everyone behind you up, and tells them their new place', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await checkOut(borrower, miniId);
    for (const who of [alice, bob, carol]) await placeHold(who, miniId);

    expect((await leaveHold(alice, miniId)).status).toBe(200);

    expect((await summary(bob, miniId)).body.position).toBe(1);
    expect((await summary(carol, miniId)).body.position).toBe(2);
    expect((await notificationsFor(bob))[0]).toMatchObject({ type: 'moved_up', message: expect.stringMatching(/#1 in line for Dire Wolf/) });
    expect((await notificationsFor(carol))[0]).toMatchObject({ type: 'moved_up', message: expect.stringMatching(/#2 in line/) });
  });

  it('doesn\'t bother people ahead of you', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await checkOut(borrower, miniId);
    await placeHold(alice, miniId);
    await placeHold(bob, miniId);

    await leaveHold(bob, miniId);

    expect(await typesFor(alice)).not.toContain('moved_up');
  });

  it('reports 404 when you aren\'t in line', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await checkOut(borrower, miniId);

    expect((await leaveHold(alice, miniId)).status).toBe(404);
  });
});

// ---- the notify list -------------------------------------------------------------

describe('the notify list', () => {
  async function fullLine(): Promise<number> {
    const miniId = await createMini(owner, 'Dire Wolf');
    await checkOut(borrower, miniId);
    for (const who of [alice, bob, carol]) await placeHold(who, miniId);
    return miniId;
  }

  it('is only for when the line is full', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await checkOut(borrower, miniId);

    const res = await watch(dave, miniId);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/place a hold/i);
  });

  it('tells everyone on it when a spot opens, and the first to grab it gets it', async () => {
    const miniId = await fullLine();
    const erin = await createUser('erin', chicago);
    await watch(dave, miniId);
    await watch(erin, miniId);
    expect((await summary(dave, miniId)).body.watching).toBe(true);

    await leaveHold(alice, miniId);

    for (const who of [dave, erin]) {
      expect((await notificationsFor(who))[0]).toMatchObject({ type: 'spot_opened', miniId, message: 'A hold spot opened on Dire Wolf' });
    }

    expect((await placeHold(erin, miniId)).status).toBe(201);
    expect((await placeHold(dave, miniId)).body.code).toBe('full');
    expect((await summary(erin, miniId)).body.watching).toBe(false); // off the list once in line
    expect((await summary(dave, miniId)).body.watching).toBe(true);  // still waiting for the next spot
  });

  it('can be left', async () => {
    const miniId = await fullLine();
    await watch(dave, miniId);

    expect((await request(app).delete(`/api/holds/minis/${miniId}/watch`).set('Cookie', dave.cookie)).status).toBe(200);
    await leaveHold(alice, miniId);

    expect(await typesFor(dave)).not.toContain('spot_opened');
  });
});

// ---- the mini comes back ------------------------------------------------------------

describe('when the mini is confirmed back, the first person in line is checked out automatically', () => {
  async function yourTurnLoan(who: TestUser) {
    const loans = await request(app).get('/api/loans').set('Cookie', who.cookie);
    return loans.body.find((l: { status: string }) => l.status === 'negotiating');
  }

  it('nobody in line negotiates while the mini is still out', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await lendOut(miniId);
    await placeHold(alice, miniId);

    expect(await yourTurnLoan(alice)).toBeUndefined();
  });

  it('after it\'s returned: first in line gets a request, the rest move up, the notify list hears a spot opened', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await lendOut(miniId);
    for (const who of [alice, bob, carol]) await placeHold(who, miniId);
    await watch(dave, miniId);

    const res = await request(app).post(`/api/loans/${loanId}/return`).set('Cookie', owner.cookie);
    expect(res.status).toBe(200);

    const aliceLoan = await yourTurnLoan(alice);
    expect(aliceLoan).toMatchObject({ miniId, role: 'borrower', counterpart: { id: owner.userId }, stage: 'negotiating' });
    expect((await request(app).get(`/api/minis/${miniId}`).set('Cookie', dave.cookie)).body.status).toBe('requested');

    expect((await notificationsFor(alice))[0]).toMatchObject({
      type: 'your_turn', loanId: aliceLoan.id, message: 'It\'s your turn — you can now negotiate for Dire Wolf',
    });
    expect((await notificationsFor(bob))[0]).toMatchObject({ type: 'moved_up', message: expect.stringMatching(/#1 in line/) });
    expect((await notificationsFor(carol))[0]).toMatchObject({ type: 'moved_up', message: expect.stringMatching(/#2 in line/) });
    expect((await notificationsFor(dave))[0]).toMatchObject({ type: 'spot_opened' });
    expect(await typesFor(owner)).toContain('hold_became_request');

    expect(await holdOrder(miniId)).toEqual([bob.userId, carol.userId]);
  });

  it('after a request is cancelled, the next person gets it', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await checkOut(borrower, miniId);
    await placeHold(alice, miniId);

    await request(app).post(`/api/loans/${loanId}/cancel`).set('Cookie', borrower.cookie);

    expect(await yourTurnLoan(alice)).toMatchObject({ miniId });
    expect(await holdOrder(miniId)).toEqual([]);
  });

  it('after the owner brings it back from a quest, the next person gets it', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await request(app).post(`/api/minis/${miniId}/take-out`).set('Cookie', owner.cookie).send({});
    await placeHold(alice, miniId);

    await request(app).post(`/api/minis/${miniId}/bring-back`).set('Cookie', owner.cookie);

    expect(await yourTurnLoan(alice)).toMatchObject({ miniId });
  });

  it('passes down the line when each person in turn declines', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const first = await checkOut(borrower, miniId);
    await placeHold(alice, miniId);
    await placeHold(bob, miniId);

    await request(app).post(`/api/loans/${first}/cancel`).set('Cookie', owner.cookie);
    const alicesTurn = await yourTurnLoan(alice);
    await request(app).post(`/api/loans/${alicesTurn.id}/cancel`).set('Cookie', alice.cookie);

    expect(await yourTurnLoan(bob)).toMatchObject({ miniId });
  });

  it('becomes available again when nobody is left in line', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await checkOut(borrower, miniId);

    await request(app).post(`/api/loans/${loanId}/cancel`).set('Cookie', owner.cookie);

    expect((await request(app).get(`/api/minis/${miniId}`).set('Cookie', alice.cookie)).body.status).toBe('available');
  });

  it('takes the mini out of the next person\'s cart when it becomes their request', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await checkOut(borrower, miniId);
    await placeHold(alice, miniId);
    await pool.execute('INSERT INTO cart_items (user_id, mini_id) VALUES (?, ?)', [alice.userId, miniId]);

    await request(app).post(`/api/loans/${loanId}/cancel`).set('Cookie', owner.cookie);

    const cart = await request(app).get('/api/cart').set('Cookie', alice.cookie);
    expect(cart.body).toEqual([]);
  });

  it('skips someone no longer in this group, even if they\'re still in another one', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await checkOut(borrower, miniId);
    await placeHold(alice, miniId);
    await placeHold(bob, miniId);
    await joinCollection(alice, await createCollection('dojo'));
    await pool.execute('DELETE FROM collection_memberships WHERE user_id = ? AND collection_id = ?', [alice.userId, chicago]);

    await request(app).post(`/api/loans/${loanId}/cancel`).set('Cookie', owner.cookie);

    expect(await yourTurnLoan(bob)).toMatchObject({ miniId });
  });

  it('only checks out one person, even if the mini is returned and cancelled at the same moment', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await checkOut(borrower, miniId);
    await placeHold(alice, miniId);
    await placeHold(bob, miniId);

    await Promise.all([
      request(app).post(`/api/loans/${loanId}/cancel`).set('Cookie', owner.cookie),
      request(app).post(`/api/loans/${loanId}/cancel`).set('Cookie', borrower.cookie),
    ]);

    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM loans WHERE mini_id = ? AND status IN ('negotiating', 'adventuring')", [miniId]
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});

// ---- cleanup when things go away ----------------------------------------------------

describe('when people or minis go away', () => {
  it('removing someone from the group drops their holds and moves the line up', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await checkOut(borrower, miniId);
    await placeHold(alice, miniId);
    await placeHold(bob, miniId);

    await request(app).delete(`/api/admin/users/${alice.userId}`).set('Cookie', admin.cookie);

    expect(await holdOrder(miniId)).toEqual([bob.userId]);
    expect((await notificationsFor(bob))[0]).toMatchObject({ type: 'moved_up' });
  });

  it('removing someone from one group leaves their holds in another group alone', async () => {
    const dojo = await createCollection('dojo');
    const dojoOwner = await createUser('sensei', dojo);
    const dojoMini = await createMini(dojoOwner, 'Dojo Wolf');
    const dojoBorrower = await joinCollection(borrower, dojo);
    await checkOut(dojoBorrower, dojoMini);
    const aliceInDojo = await joinCollection(alice, dojo);
    await placeHold(aliceInDojo, dojoMini);

    await request(app).delete(`/api/admin/users/${alice.userId}`).set('Cookie', admin.cookie);

    expect(await holdOrder(dojoMini)).toEqual([alice.userId]);
  });

  it('deleting a mini on a quest tells everyone waiting for it', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await request(app).post(`/api/minis/${miniId}/take-out`).set('Cookie', owner.cookie).send({});
    for (const who of [alice, bob, carol]) await placeHold(who, miniId);
    await watch(dave, miniId);

    expect((await request(app).delete(`/api/minis/${miniId}`).set('Cookie', owner.cookie)).status).toBe(200);

    for (const who of [alice, dave]) {
      expect((await notificationsFor(who))[0]).toMatchObject({ type: 'mini_removed', message: expect.stringMatching(/Dire Wolf was removed/) });
    }
    expect(await holdOrder(miniId)).toEqual([]);
  });
});
