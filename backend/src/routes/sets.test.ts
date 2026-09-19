import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { authCookie } from '../test/helpers';

// Mock the DB layer entirely — these are route/permission tests, not DB
// integration tests. The real SQL (the LEFT JOIN sets in MINI_SELECT, the
// ON DELETE SET NULL cascade, GROUP BY under sql_mode) is proven for real in
// sets.integration.test.ts.
vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../db/connection';
import { createApp } from '../app';

const app = createApp();
const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;

const COLLECTION_A = 10;

const OWNER = { userId: 1, username: 'owner', role: 'user', collectionId: COLLECTION_A };
const OTHER = { userId: 2, username: 'other', role: 'user', collectionId: COLLECTION_A };
const ADMIN = { userId: 3, username: 'boss', role: 'admin', collectionId: COLLECTION_A };

const MEMBERSHIP_CONFIRMED = [[{ role: 'user' }]];
const ADMIN_MEMBERSHIP = [[{ role: 'admin' }]];

// One row from the sets-listing query (sets joined to their owner).
function setRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    name: 'Blades of Khaine',
    owner_id: OWNER.userId,
    owner_name: 'Owner Name',
    owner_username: 'owner',
    ...overrides,
  };
}

// One row from MINI_SELECT (minis.ts), the shape a set's members come back as.
function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Banshee',
    description: null,
    price: '0.00',
    active_loan_status: null,
    on_quest_since: null,
    on_quest_until: null,
    owner_name: 'Owner Name',
    owner_username: 'owner',
    owner_id: OWNER.userId,
    created_at: '2026-01-01T00:00:00.000Z',
    set_id: 501,
    set_name: 'Blades of Khaine',
    tags: null,
    images: null,
    ...overrides,
  };
}

beforeEach(() => {
  execute.mockReset();
});

describe('GET /api/sets', () => {
  it('lists every set in the collection with its members', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[setRow()]])
      .mockResolvedValueOnce([[memberRow(), memberRow({ id: 2, name: 'Farseer' })]]);

    const res = await request(app).get('/api/sets').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{
      id: 501,
      name: 'Blades of Khaine',
      ownerId: OWNER.userId,
      ownerName: 'Owner Name',
      ownerUsername: 'owner',
      members: [
        expect.objectContaining({ id: 1, name: 'Banshee' }),
        expect.objectContaining({ id: 2, name: 'Farseer' }),
      ],
    }]);
  });

  it('is scoped to the caller\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/sets').set('Cookie', authCookie(OWNER));

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('collection_id = ?'),
      expect.arrayContaining([COLLECTION_A])
    );
  });

  it('returns an empty array when there are no sets yet', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/sets').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /api/sets/:id', () => {
  it('returns one set with its members', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[setRow()]])
      .mockResolvedValueOnce([[memberRow()]]);

    const res = await request(app).get('/api/sets/501').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 501, name: 'Blades of Khaine' });
    expect(res.body.members).toHaveLength(1);
  });

  it('returns 404 when the set does not exist', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/sets/999').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(404);
  });

  it('returns 404 (not the other collection\'s data) for a set in a different collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/sets/501').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(404);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('collection_id = ?'),
      expect.arrayContaining([COLLECTION_A])
    );
  });
});

describe('POST /api/sets', () => {
  it('creates a set with no minis in it yet', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([{ insertId: 501, affectedRows: 1 }]) // INSERT INTO sets
      .mockResolvedValueOnce([[setRow()]])
      .mockResolvedValueOnce([[]]); // no members

    const res = await request(app).post('/api/sets').set('Cookie', authCookie(OWNER)).send({ name: 'Blades of Khaine' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 501, name: 'Blades of Khaine', members: [] });
  });

  it('creates a set and moves the given minis into it', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ id: 1 }, { id: 2 }]]) // ownership check: both qualify
      .mockResolvedValueOnce([{ insertId: 501, affectedRows: 1 }]) // INSERT INTO sets
      .mockResolvedValueOnce([{ affectedRows: 2 }]) // UPDATE minis SET set_id
      .mockResolvedValueOnce([[setRow()]])
      .mockResolvedValueOnce([[memberRow(), memberRow({ id: 2, name: 'Farseer' })]]);

    const res = await request(app).post('/api/sets').set('Cookie', authCookie(OWNER)).send({ name: 'Blades of Khaine', miniIds: [1, 2] });

    expect(res.status).toBe(201);
    expect(res.body.members).toHaveLength(2);
    const updateCall = execute.mock.calls.find(([sql]) => String(sql).includes('UPDATE minis SET set_id'));
    expect(updateCall![0]).toMatch(/set_id IS NULL/);
  });

  it('rejects a blank name, before touching the database', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).post('/api/sets').set('Cookie', authCookie(OWNER)).send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(1); // only the membership check
  });

  it('rejects a name over the limit', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).post('/api/sets').set('Cookie', authCookie(OWNER)).send({ name: 'x'.repeat(101) });

    expect(res.status).toBe(400);
  });

  it('rejects miniIds that are not a list of ids', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).post('/api/sets').set('Cookie', authCookie(OWNER)).send({ name: 'Set', miniIds: 'not-a-list' });

    expect(res.status).toBe(400);
  });

  it('rejects if any mini isn\'t owned by the caller, isn\'t in this collection, or is already in a set — and creates nothing', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ id: 1 }]]); // only 1 of the 2 requested qualifies

    const res = await request(app).post('/api/sets').set('Cookie', authCookie(OWNER)).send({ name: 'Set', miniIds: [1, 2] });

    expect(res.status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(2); // membership + the failed ownership check — no INSERT
    expect(execute.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO sets'))).toBe(false);
  });
});

describe('PATCH /api/sets/:id', () => {
  it('lets the owner rename their set', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[setRow()]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE sets SET name
      .mockResolvedValueOnce([[setRow({ name: 'Renamed Host' })]])
      .mockResolvedValueOnce([[]]);

    const res = await request(app).patch('/api/sets/501').set('Cookie', authCookie(OWNER)).send({ name: 'Renamed Host' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed Host');
  });

  it('lets an admin rename someone else\'s set', async () => {
    execute
      .mockResolvedValueOnce(ADMIN_MEMBERSHIP)
      .mockResolvedValueOnce([[setRow({ owner_id: OWNER.userId })]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[setRow({ owner_id: OWNER.userId, name: 'Renamed' })]])
      .mockResolvedValueOnce([[]]);

    const res = await request(app).patch('/api/sets/501').set('Cookie', authCookie(ADMIN)).send({ name: 'Renamed' });

    expect(res.status).toBe(200);
  });

  it('refuses anyone else, even a fellow collection member', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[setRow()]]);

    const res = await request(app).patch('/api/sets/501').set('Cookie', authCookie(OTHER)).send({ name: 'Hijacked' });

    expect(res.status).toBe(403);
  });

  it('returns 404 for a set that does not exist in this collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app).patch('/api/sets/999').set('Cookie', authCookie(OWNER)).send({ name: 'x' });

    expect(res.status).toBe(404);
  });

  it('adds minis owned by the SET\'S owner, not the caller, when an admin does it', async () => {
    execute
      .mockResolvedValueOnce(ADMIN_MEMBERSHIP)
      .mockResolvedValueOnce([[setRow({ owner_id: OWNER.userId })]])
      .mockResolvedValueOnce([[{ id: 5 }]]) // ownership check against the SET's owner
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[setRow({ owner_id: OWNER.userId })]])
      .mockResolvedValueOnce([[memberRow({ id: 5 })]]);

    const res = await request(app).patch('/api/sets/501').set('Cookie', authCookie(ADMIN)).send({ addMiniIds: [5] });

    expect(res.status).toBe(200);
    const ownershipCheck = execute.mock.calls[2];
    expect(ownershipCheck[0]).toMatch(/owner_id = \?/);
    expect(ownershipCheck[1]).toEqual(expect.arrayContaining([OWNER.userId]));
    expect(ownershipCheck[1]).not.toEqual(expect.arrayContaining([ADMIN.userId]));
  });

  it('rejects adding a mini that is not the owner\'s, or is already in another set', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[setRow()]])
      .mockResolvedValueOnce([[]]); // ownership check finds nothing

    const res = await request(app).patch('/api/sets/501').set('Cookie', authCookie(OWNER)).send({ addMiniIds: [99] });

    expect(res.status).toBe(400);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes('UPDATE minis'))).toBe(false);
  });

  it('removes a mini from the set, freeing it up', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[setRow()]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE minis SET set_id = NULL
      .mockResolvedValueOnce([[setRow()]])
      .mockResolvedValueOnce([[]]);

    const res = await request(app).patch('/api/sets/501').set('Cookie', authCookie(OWNER)).send({ removeMiniIds: [1] });

    expect(res.status).toBe(200);
    const updateCall = execute.mock.calls.find(([sql]) => String(sql).includes('UPDATE minis'));
    expect(updateCall![0]).toMatch(/set_id = NULL/);
    expect(updateCall![0]).toMatch(/set_id = \?/); // scoped to THIS set
  });

  it('rejects removing a mini that isn\'t currently in this set', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[setRow()]])
      .mockResolvedValueOnce([{ affectedRows: 0 }]); // nothing matched set_id = this set

    const res = await request(app).patch('/api/sets/501').set('Cookie', authCookie(OWNER)).send({ removeMiniIds: [77] });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/sets/:id', () => {
  it('lets the owner delete their set', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[setRow()]]).mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app).delete('/api/sets/501').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/deleted/i);
  });

  it('refuses anyone but the owner or an admin', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[setRow()]]);

    const res = await request(app).delete('/api/sets/501').set('Cookie', authCookie(OTHER));

    expect(res.status).toBe(403);
    expect(execute).toHaveBeenCalledTimes(2); // never reached a DELETE
  });

  it('returns 404 for a set that does not exist here', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app).delete('/api/sets/999').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(404);
  });
});

describe('POST /api/sets/:id/cart — borrowing a whole set at once', () => {
  function membersRow(overrides: Record<string, unknown> = {}) {
    return { id: 1, name: 'Banshee', owner_id: OWNER.userId, active_loan_status: null, on_quest_since: null, ...overrides };
  }

  it('adds every available member to the caller\'s cart in one go', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[setRow()]])
      .mockResolvedValueOnce([[membersRow({ id: 1 }), membersRow({ id: 2, name: 'Farseer' })]])
      .mockResolvedValueOnce([[]]) // caller's current cart: empty
      .mockResolvedValueOnce([{ affectedRows: 2 }]); // the batched INSERT IGNORE

    const res = await request(app).post('/api/sets/501/cart').set('Cookie', authCookie(OTHER));

    expect(res.status).toBe(201);
    expect(res.body.added).toEqual(expect.arrayContaining([
      expect.objectContaining({ miniId: 1 }), expect.objectContaining({ miniId: 2 }),
    ]));
    expect(res.body.skipped).toEqual([]);
    // One batched insert, not one per mini.
    expect(execute.mock.calls.filter(([sql]) => String(sql).includes('INSERT IGNORE INTO cart_items'))).toHaveLength(1);
  });

  it('skips a member that is already out, already in the cart, or the caller\'s own — and says which', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[setRow({ owner_id: OTHER.userId })]])
      .mockResolvedValueOnce([[
        membersRow({ id: 1, name: 'Out already', owner_id: OTHER.userId, active_loan_status: 'adventuring' }),
        membersRow({ id: 2, name: 'In cart already', owner_id: OTHER.userId }),
        membersRow({ id: 3, name: 'Free one', owner_id: OTHER.userId }),
      ]])
      .mockResolvedValueOnce([[{ mini_id: 2 }]]) // already in cart
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app).post('/api/sets/501/cart').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(201);
    expect(res.body.added).toEqual([expect.objectContaining({ miniId: 3 })]);
    expect(res.body.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ miniId: 1, reason: 'unavailable' }),
      expect.objectContaining({ miniId: 2, reason: 'already_in_cart' }),
    ]));
  });

  it('refuses when every member is the caller\'s own, and says so plainly', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[setRow()]])
      .mockResolvedValueOnce([[membersRow({ owner_id: OWNER.userId })]])
      .mockResolvedValueOnce([[]]); // caller's cart: empty

    const res = await request(app).post('/api/sets/501/cart').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/your own set/i);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes('INSERT IGNORE INTO cart_items'))).toBe(false);
  });

  it('refuses an empty set, and says so plainly', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[setRow()]])
      .mockResolvedValueOnce([[]]);

    const res = await request(app).post('/api/sets/501/cart').set('Cookie', authCookie(OTHER));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/doesn't have any minis in it/i);
  });

  it('returns 404 for a set that does not exist in this collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app).post('/api/sets/999/cart').set('Cookie', authCookie(OTHER));

    expect(res.status).toBe(404);
  });
});
