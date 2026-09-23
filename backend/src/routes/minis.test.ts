import { describe, it, expect, vi, beforeEach } from 'vitest';
import request, { Response as SuperTestResponse } from 'supertest';
import fs from 'fs';
import path from 'path';
import { authCookie } from '../test/helpers';
import { uploadsDir } from '../config';

// Mock the DB layer entirely — these are route/permission tests, not DB integration tests.
vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../db/connection';
import { createApp } from '../app';
import { BROWSE_MAX_PER_MINUTE } from './minis';
import { notify } from '../db/notifications'; // stubbed by unitSetup.ts — asserted directly, not via execute

const app = createApp();
const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;

const COLLECTION_A = 10;
const COLLECTION_B = 20;

const OWNER = { userId: 1, username: 'owner', role: 'user', collectionId: COLLECTION_A };
const OTHER = { userId: 2, username: 'other', role: 'user', collectionId: COLLECTION_A };
const ADMIN = { userId: 3, username: 'boss', role: 'admin', collectionId: COLLECTION_A };
// Same site-wide admin role, but currently acting in a DIFFERENT collection —
// this is the case that must never be allowed to touch collection A's minis.
const ADMIN_OTHER_COLLECTION = { userId: 3, username: 'boss', role: 'admin', collectionId: COLLECTION_B };
const NOT_A_MEMBER = { userId: 4, username: 'outsider', role: 'user', collectionId: COLLECTION_B };

// The requireCollectionMembership middleware's DB check, confirming the
// caller really belongs to the collection their JWT claims — this is always
// the first execute() call on every route in this file.
const MEMBERSHIP_CONFIRMED = [[{ role: 'user' }]];
// An admin's membership row — the middleware takes the role from here, not the cookie.
const ADMIN_MEMBERSHIP = [[{ role: 'admin' }]];
const NOT_A_MEMBER_ROW = [[]];

function tinyPng(): Buffer {
  // Smallest possible valid PNG — enough to satisfy multer's image/* fileFilter.
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
    'hex'
  );
}

// A single mini row, shaped like the join query in minis.ts returns it.
function miniRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 42,
    name: 'Dire Wolf',
    description: 'A wolf',
    price: '0.00',
    active_loan_status: null,
    owner_name: 'Owner Name',
    owner_username: 'owner',
    owner_id: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    tags: null,
    images: null,
    set_id: null,
    set_name: null,
    ...overrides,
  };
}

beforeEach(() => {
  execute.mockReset();
  vi.mocked(notify).mockClear();
});

describe('Collection access control', () => {
  it('rejects every route with 403 when the caller is not a member of their claimed collection', async () => {
    execute.mockResolvedValueOnce(NOT_A_MEMBER_ROW);

    const res = await request(app).get('/api/minis').set('Cookie', authCookie(NOT_A_MEMBER));

    expect(res.status).toBe(403);
  });

  it('rejects with 400 when no collection has been selected at all', async () => {
    const res = await request(app)
      .get('/api/minis')
      .set('Cookie', authCookie({ userId: 1, username: 'owner', role: 'user' })); // no collectionId

    expect(res.status).toBe(400);
  });
});

describe('GET /api/minis — fuzzy search', () => {
  it('finds a mini whose name is misspelled in the search term', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[
        miniRow({ id: 1, name: 'Tabaxi Bard' }),
        miniRow({ id: 2, name: 'Goblin Grunt' }),
      ]]);

    const res = await request(app)
      .get('/api/minis?q=tabaxe')
      .set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Tabaxi Bard');
  });

  it('excludes minis that do not match at all', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[
        miniRow({ id: 1, name: 'Tabaxi Bard' }),
        miniRow({ id: 2, name: 'Goblin Grunt' }),
      ]]);

    const res = await request(app)
      .get('/api/minis?q=beholder')
      .set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('scopes the list query to the caller\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/minis').set('Cookie', authCookie(OWNER));

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('m.collection_id = ?'),
      expect.arrayContaining([COLLECTION_A])
    );
  });
});

describe('GET /api/minis/:id', () => {
  it('returns the mini with images split into an array', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[miniRow({ images: '/uploads/a.png,/uploads/b.png' })]]);

    const res = await request(app)
      .get('/api/minis/42')
      .set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.images).toEqual(['/uploads/a.png', '/uploads/b.png']);
  });

  it('returns an empty images array when the mini has no photos', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[miniRow({ images: null })]]);

    const res = await request(app)
      .get('/api/minis/42')
      .set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.images).toEqual([]);
  });

  it('returns 404 when the mini does not exist', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get('/api/minis/999')
      .set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(404);
  });

  it('returns 404 (not 403) for a mini that exists but belongs to a different collection', async () => {
    // The query itself (id + collection_id) returns nothing — same as "doesn't exist" —
    // so a probing request can't even confirm another collection's mini exists.
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get('/api/minis/42')
      .set('Cookie', authCookie(ADMIN_OTHER_COLLECTION));

    expect(res.status).toBe(404);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('m.collection_id = ?'),
      [42, COLLECTION_B]
    );
  });
});

// "Who's had this, how often" — the owner's (or an admin's) view of every
// completed or ongoing loan for one mini. Not a public feature: this app
// otherwise keeps a mini's CURRENT borrower anonymous to everyone but the
// two people in the loan (MiniDetailModal says "with a borrower", not a
// name), so a full name-and-date history is scoped the same way editing is.
describe('GET /api/minis/:id/history', () => {
  function historyRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 501,
      borrower_id: 2,
      borrower_username: 'bruno',
      borrower_name: 'Bruno Borrower',
      handed_off_at: new Date('2026-09-01T18:00:00.000Z'),
      returned_at: new Date('2026-09-15T18:00:00.000Z'),
      status: 'returned',
      ...overrides,
    };
  }

  it('lets the owner see it, newest first, with days out computed', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: OWNER.userId }]])
      .mockResolvedValueOnce([[historyRow()]]);

    const res = await request(app).get('/api/minis/42/history').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{
      loanId: 501,
      borrowerId: 2,
      borrowerUsername: 'bruno',
      borrowerName: 'Bruno Borrower',
      handedOffAt: '2026-09-01T18:00:00.000Z',
      returnedAt: '2026-09-15T18:00:00.000Z',
      ongoing: false,
      outcome: 'returned',
      daysOut: 14,
    }]);
    const historyQuery = execute.mock.calls[2];
    expect(historyQuery[0]).toMatch(/ORDER BY .*handed_off_at.* DESC/is);
  });

  it('marks a loan that is still out as ongoing, with no return date', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: OWNER.userId }]])
      .mockResolvedValueOnce([[historyRow({ returned_at: null, status: 'adventuring' })]]);

    const res = await request(app).get('/api/minis/42/history').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ ongoing: true, returnedAt: null });
    expect(res.body[0].daysOut).toBeGreaterThanOrEqual(0);
  });

  it('lets an admin see someone else\'s mini history', async () => {
    execute
      .mockResolvedValueOnce(ADMIN_MEMBERSHIP)
      .mockResolvedValueOnce([[{ owner_id: OWNER.userId }]]) // owned by OWNER, not the admin
      .mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/minis/42/history').set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('refuses anyone else — even a fellow member browsing the same collection', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: OWNER.userId }]]);

    const res = await request(app).get('/api/minis/42/history').set('Cookie', authCookie(OTHER));

    expect(res.status).toBe(403);
    // Refused before ever running the history query.
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('returns 404 when the mini does not exist', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/minis/999/history').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(404);
  });

  it('returns 404 (not 403) for a mini in a different collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/minis/42/history').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(404);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('collection_id = ?'),
      [42, COLLECTION_A]
    );
  });

  it('never asks for a loan that was cancelled or is still being negotiated', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: OWNER.userId }]])
      .mockResolvedValueOnce([[]]);

    await request(app).get('/api/minis/42/history').set('Cookie', authCookie(OWNER));

    // Every row here has a handoff — a request that was cancelled, or never
    // got past negotiating, never happened, so it isn't lending history.
    expect(execute.mock.calls[2][0]).toMatch(/handed_off_at IS NOT NULL/);
  });
});

describe('mini status in responses', () => {
  it.each([
    [null, 'available', true],
    ['negotiating', 'requested', false],
    ['adventuring', 'adventuring', false],
  ])('turns an active loan status of %s into status "%s"', async (loanStatus, status, available) => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[miniRow({ active_loan_status: loanStatus, price: '12.50', tags: 'boss,painted' })]]);

    const res = await request(app).get('/api/minis/42').set('Cookie', authCookie(OWNER));

    expect(res.body).toMatchObject({ status, available, price: 12.5, tags: ['boss', 'painted'] });
    expect(res.body).not.toHaveProperty('active_loan_status');
  });

  it.each(['lost', 'critically_wounded'] as const)('a %s condition overrides an otherwise-available loan status', async (condition) => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[miniRow({
        active_loan_status: null, condition_flag: condition, condition_since: new Date('2026-09-01T00:00:00.000Z'),
      })]]);

    const res = await request(app).get('/api/minis/42').set('Cookie', authCookie(OWNER));

    expect(res.body).toMatchObject({
      status: condition, available: false, condition, conditionSince: '2026-09-01T00:00:00.000Z',
    });
    expect(res.body).not.toHaveProperty('condition_flag');
  });

  it('has no condition when the mini has never been flagged', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[miniRow()]]);

    const res = await request(app).get('/api/minis/42').set('Cookie', authCookie(OWNER));

    expect(res.body).toMatchObject({ condition: null, conditionSince: null });
  });
});

// A mini optionally belongs to one owner's named set (a boxed army) — carried
// on every mini response so a card or the detail view can say "part of X".
describe('a mini\'s set membership in responses', () => {
  it('shows which set a mini belongs to', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[miniRow({ set_id: 7, set_name: 'Blades of Khaine' })]]);

    const res = await request(app).get('/api/minis/42').set('Cookie', authCookie(OWNER));

    expect(res.body).toMatchObject({ set_id: 7, set_name: 'Blades of Khaine' });
  });

  it('is null for a mini that isn\'t part of any set', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[miniRow({ set_id: null, set_name: null })]]);

    const res = await request(app).get('/api/minis/42').set('Cookie', authCookie(OWNER));

    expect(res.body).toMatchObject({ set_id: null, set_name: null });
  });
});

describe('taking your own mini on a quest', () => {
  // Lookup row the take-out/bring-back routes read before changing anything.
  const lookup = (overrides: Record<string, unknown> = {}) =>
    [[{ owner_id: OWNER.userId, active_loan_status: null, on_quest_since: null, ...overrides }]];

  it('shows a mini the owner took out as "on_quest", with its back-by date, and not available', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[miniRow({ on_quest_since: new Date('2026-10-01T18:00:00Z'), on_quest_until: '2026-10-15' })]]);

    const res = await request(app).get('/api/minis/42').set('Cookie', authCookie(OTHER));

    expect(res.body).toMatchObject({
      status: 'on_quest',
      available: false,
      on_quest_since: '2026-10-01T18:00:00.000Z',
      on_quest_until: '2026-10-15',
    });
  });

  it('lets the owner take it out in one step, with no back-by date required', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce(lookup())
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[miniRow({ on_quest_since: new Date(), on_quest_until: null })]]);

    const res = await request(app).post('/api/minis/42/take-out').set('Cookie', authCookie(OWNER)).send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('on_quest');
    const update = execute.mock.calls.find(([sql]) => String(sql).includes('SET on_quest_since = NOW()'))!;
    expect(update[1]).toEqual([null, 42, COLLECTION_A, OWNER.userId]);
  });

  it('saves an optional back-by date', async () => {
    const backBy = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce(lookup())
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[miniRow({ on_quest_since: new Date(), on_quest_until: backBy })]]);

    const res = await request(app).post('/api/minis/42/take-out').set('Cookie', authCookie(OWNER)).send({ backBy });

    expect(res.status).toBe(200);
    expect(res.body.on_quest_until).toBe(backBy);
    const update = execute.mock.calls.find(([sql]) => String(sql).includes('SET on_quest_since = NOW()'))!;
    expect((update[1] as unknown[])[0]).toBe(backBy);
  });

  it('refuses an invalid back-by date', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).post('/api/minis/42/take-out').set('Cookie', authCookie(OWNER)).send({ backBy: '2001-01-01' });

    expect(res.status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('is only for the owner — not other members', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce(lookup());

    const res = await request(app).post('/api/minis/42/take-out').set('Cookie', authCookie(OTHER)).send({});

    expect(res.status).toBe(403);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE minis'), expect.anything());
  });

  it('is only for the owner — not even an admin', async () => {
    execute.mockResolvedValueOnce(ADMIN_MEMBERSHIP).mockResolvedValueOnce(lookup());

    const res = await request(app).post('/api/minis/42/take-out').set('Cookie', authCookie(ADMIN)).send({});

    expect(res.status).toBe(403);
  });

  it('returns 404 for a mini in another collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app).post('/api/minis/42/take-out').set('Cookie', authCookie(OWNER)).send({});

    expect(res.status).toBe(404);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('collection_id = ?'), [42, COLLECTION_A]);
  });

  it.each([
    ['someone has requested it', 'negotiating', /request/i],
    ['it is out adventuring with a borrower', 'adventuring', /adventuring/i],
  ])('is blocked while %s', async (_why, loanStatus, message) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce(lookup({ active_loan_status: loanStatus }));

    const res = await request(app).post('/api/minis/42/take-out').set('Cookie', authCookie(OWNER)).send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(message);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE minis'), expect.anything());
  });

  it('is blocked when it is already on a quest', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce(lookup({ on_quest_since: new Date() }));

    const res = await request(app).post('/api/minis/42/take-out').set('Cookie', authCookie(OWNER)).send({});

    expect(res.status).toBe(409);
  });

  // Someone could check it out in the instant between the lookup and the update.
  it('re-checks availability in the update itself, and reports a conflict if it lost the race', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce(lookup())
      .mockResolvedValueOnce([{ affectedRows: 0 }]);

    const res = await request(app).post('/api/minis/42/take-out').set('Cookie', authCookie(OWNER)).send({});

    expect(res.status).toBe(409);
    const update = String(execute.mock.calls.find(([sql]) => String(sql).includes('UPDATE minis'))![0]);
    expect(update).toMatch(/on_quest_since IS NULL/);
    expect(update).toMatch(/NOT EXISTS/);
    expect(update).toMatch(/owner_id = \?/);
  });

  it('lets the owner bring it back, making it available again', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce(lookup({ on_quest_since: new Date() }))
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[miniRow()]]);

    const res = await request(app).post('/api/minis/42/bring-back').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('available');
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('SET on_quest_since = NULL, on_quest_until = NULL'),
      [42, COLLECTION_A, OWNER.userId]
    );
  });

  it('does not let anyone else bring it back', async () => {
    execute.mockResolvedValueOnce(ADMIN_MEMBERSHIP).mockResolvedValueOnce(lookup({ on_quest_since: new Date() }));

    const res = await request(app).post('/api/minis/42/bring-back').set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(403);
  });

  it('reports a conflict when bringing back a mini that isn\'t on a quest', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce(lookup());

    const res = await request(app).post('/api/minis/42/bring-back').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(409);
  });
});

// Browsing is the most expensive thing a signed-in member can ask for: it
// reads the whole collection and fuzzy-matches it in this process, on the one
// core the Pi has. A runaway client (a retry loop, a stuck search box) would
// otherwise be able to keep everyone else waiting.
describe('GET /api/minis — rate limit', () => {
  it('lets a person browse and search freely', async () => {
    execute.mockResolvedValue(MEMBERSHIP_CONFIRMED);

    for (let i = 0; i < 30; i++) {
      const res = await request(app).get(`/api/minis?q=owlbear${i}`).set('Cookie', authCookie(OWNER));
      expect(res.status).toBe(200);
    }
  });

  it('stops a caller hammering it, and says to try again', async () => {
    execute.mockResolvedValue(MEMBERSHIP_CONFIRMED);

    let blocked: SuperTestResponse | undefined;
    for (let i = 0; i <= BROWSE_MAX_PER_MINUTE; i++) {
      const res = await request(app).get('/api/minis').set('Cookie', authCookie(OWNER));
      if (res.status === 429) { blocked = res; break; }
    }

    expect(blocked, `no 429 within ${BROWSE_MAX_PER_MINUTE + 1} requests`).toBeDefined();
    // Worded for browsing, not for a failed sign-in.
    expect(blocked!.body.error).toMatch(/too quickly|give it a moment/i);
    expect(blocked!.body.error).not.toMatch(/attempts/i);
    expect(blocked!.headers['retry-after']).toBeDefined();
  });

  // One member being throttled must not throttle the group.
  it('counts each member separately', async () => {
    execute.mockResolvedValue(MEMBERSHIP_CONFIRMED);
    for (let i = 0; i <= BROWSE_MAX_PER_MINUTE; i++) {
      await request(app).get('/api/minis').set('Cookie', authCookie(OWNER));
    }

    const other = await request(app).get('/api/minis').set('Cookie', authCookie(OTHER));

    expect(other.status).toBe(200);
  });
});

describe('GET /api/minis — tag filter', () => {
  it('passes the tag to the query as a parameter alongside the collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/minis?tag=dragon').set('Cookie', authCookie(OWNER));

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('t2.name = ?'), [COLLECTION_A, 'dragon']);
  });
});

describe('GET /api/minis — owner filter', () => {
  it('passes the owner id to the query as a parameter alongside the collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/minis?owner=5').set('Cookie', authCookie(OWNER));

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('m.owner_id = ?'), [COLLECTION_A, 5]);
  });
});

describe('GET /api/minis — hides lost/critically-wounded minis', () => {
  it('always excludes condition-flagged minis from the default query', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/minis').set('Cookie', authCookie(OWNER));

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('m.condition_flag IS NULL'), [COLLECTION_A]);
  });
});

describe('GET /api/minis — available only filter', () => {
  it('adds a HAVING clause on availability when requested', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/minis?available=1').set('Cookie', authCookie(OWNER));

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('HAVING active_loan_status IS NULL AND m.on_quest_since IS NULL'),
      [COLLECTION_A]
    );
  });

  it('adds no HAVING clause by default', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/minis').set('Cookie', authCookie(OWNER));

    expect(execute).toHaveBeenCalledWith(expect.not.stringContaining('HAVING'), [COLLECTION_A]);
  });
});

describe('GET /api/minis — sort', () => {
  it('defaults to newest first', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/minis').set('Cookie', authCookie(OWNER));

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('ORDER BY m.created_at DESC'), [COLLECTION_A]);
  });

  it.each([
    ['name', 'ORDER BY m.name ASC'],
    ['price', 'ORDER BY m.price ASC'],
  ])('sorts by %s', async (sort, expectedSql) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get(`/api/minis?sort=${sort}`).set('Cookie', authCookie(OWNER));

    expect(execute).toHaveBeenCalledWith(expect.stringContaining(expectedSql), [COLLECTION_A]);
  });

  it('rejects an unrecognized sort value with 400', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).get('/api/minis?sort=bogus').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(1); // membership only
  });
});

describe('GET /api/minis — combining tag, owner, available, and sort', () => {
  it('applies all four together, in the same query', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app)
      .get('/api/minis?tag=dragon&owner=5&available=1&sort=price')
      .set('Cookie', authCookie(OWNER));

    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/t2\.name = \?[\s\S]*m\.owner_id = \?[\s\S]*HAVING active_loan_status IS NULL AND m\.on_quest_since IS NULL[\s\S]*ORDER BY m\.price ASC/),
      [COLLECTION_A, 'dragon', 5]
    );
  });
});

describe('hostile or oversized input', () => {
  it.each([
    ['a search over 100 characters (typo-matching huge text would tie up the Pi)', '/api/minis?q=' + 'a'.repeat(101)],
    ['a search sent twice (arrives as an array)', '/api/minis?q=wolf&q=bear'],
    ['a tag filter over 100 characters', '/api/minis?tag=' + 'a'.repeat(101)],
    ['a tag filter sent as an object', '/api/minis?tag[$ne]=x'],
    ['an owner id sent twice (arrives as an array)', '/api/minis?owner=1&owner=2'],
    ['an owner id sent as an object', '/api/minis?owner[$ne]=1'],
    ['an owner id that is not a positive integer', '/api/minis?owner=abc'],
    ['an owner id of zero', '/api/minis?owner=0'],
    ['a negative owner id', '/api/minis?owner=-1'],
    ['an available flag sent as something other than 1', '/api/minis?available=true'],
    ['an available flag of 0', '/api/minis?available=0'],
    ['a sort value not in the allowed list', '/api/minis?sort=cheapest'],
    ['a sort value sent as an object', '/api/minis?sort[$ne]=x'],
  ])('rejects %s with 400', async (_why, url) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).get(url).set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(1); // membership only
  });

  it('passes a search full of SQL straight through as plain text', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[miniRow({ name: "Robert'); DROP TABLE minis;--" })]]);

    const res = await request(app).get("/api/minis?tag=x' OR '1'='1").set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    // (lowercased, like every saved tag)
    expect(execute).toHaveBeenCalledWith(expect.not.stringContaining("OR '1'='1"), [COLLECTION_A, "x' or '1'='1"]);
  });

  const createWith = (fields: Record<string, string>) => {
    let req = request(app).post('/api/minis').set('Cookie', authCookie(OWNER));
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req;
  };

  it.each([
    ['a name over 255 characters', { name: 'x'.repeat(256) }],
    ['a description over 5000 characters', { name: 'Wolf', description: 'x'.repeat(5001) }],
    ['more than 20 tags', { name: 'Wolf', tags: Array.from({ length: 21 }, (_, i) => `tag${i}`).join(',') }],
    ['a tag over 50 characters', { name: 'Wolf', tags: 'x'.repeat(51) }],
    ['a price above what the database can store', { name: 'Wolf', price: '10000' }],
  ])('rejects creating a mini with %s', async (_why, fields) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await createWith(fields);

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO minis'), expect.anything());
  });

  it('rejects editing a mini with an over-long name', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[]]);

    const res = await request(app).patch('/api/minis/42').set('Cookie', authCookie(OWNER)).field('name', 'x'.repeat(256));

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE minis'), expect.anything());
  });
});

describe('GET /api/minis/tags', () => {
  it('returns tag names used in the caller\'s active collection only', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ name: 'boss' }, { name: 'painted' }]]);

    const res = await request(app).get('/api/minis/tags').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(['boss', 'painted']);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('m.collection_id = ?'), [COLLECTION_A]);
  });

  it('excludes tags only used by a lost/critically-wounded mini', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/minis/tags').set('Cookie', authCookie(OWNER));

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('m.condition_flag IS NULL'), [COLLECTION_A]);
  });

  it('is not swallowed by the /:id route', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/minis/tags').set('Cookie', authCookie(OWNER));

    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('WHERE m.id = ?'), expect.anything());
  });
});

describe('GET /api/minis/owners', () => {
  it('returns owners of minis in the caller\'s active collection only', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ id: 1, name: 'Owner Name' }, { id: 2, name: 'Someone Else' }]]);

    const res = await request(app).get('/api/minis/owners').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, name: 'Owner Name' }, { id: 2, name: 'Someone Else' }]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('m.collection_id = ?'), [COLLECTION_A]);
  });

  it('excludes an owner whose only mini is lost/critically-wounded', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/minis/owners').set('Cookie', authCookie(OWNER));

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('m.condition_flag IS NULL'), [COLLECTION_A]);
  });

  it('is not swallowed by the /:id route', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/minis/owners').set('Cookie', authCookie(OWNER));

    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('WHERE m.id = ?'), expect.anything());
  });
});

describe('POST /api/minis — validation', () => {
  it('rejects a non-image upload (e.g. a script) with 400 and creates nothing', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app)
      .post('/api/minis')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .attach('images', Buffer.from('<script>alert(1)</script>'), { filename: 'evil.html', contentType: 'text/html' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only image files/i);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO minis'), expect.anything());
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
  ])('rejects a %s name with 400', async (_why, name) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    let req = request(app).post('/api/minis').set('Cookie', authCookie(OWNER)).field('price', '5');
    if (name !== undefined) req = req.field('name', name);
    const res = await req;

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
  });

  it.each(['-1', 'twelve', '0x10', '1e3', '12.999', '12,50', 'Infinity', '1.'])('rejects a price of "%s" with 400', async (price) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app)
      .post('/api/minis')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .field('price', price);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/price/i);
  });

  it.each([['12', 12], ['12.5', 12.5], ['12.50', 12.5], ['.75', 0.75], [' 9999.99 ', 9999.99]])('accepts a price of "%s"', async (price, saved) => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([{ insertId: 42 }])
      .mockResolvedValue([{}]);

    const res = await request(app)
      .post('/api/minis')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .field('price', price);

    expect(res.status).toBe(201);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO minis'), expect.arrayContaining([saved]));
  });

  it('rejects a name made only of invisible characters', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).post('/api/minis').set('Cookie', authCookie(OWNER)).field('name', '​');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
  });

  // Tags are saved in three statements however many there are, not three per tag.
  it('saves a trimmed name, a missing price as 0, and normalized tags', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([{ insertId: 42, affectedRows: 1 }]) // INSERT INTO minis
      .mockResolvedValueOnce([{}])                                // DELETE mini_tags
      .mockResolvedValueOnce([{}])                                // INSERT IGNORE tags (both)
      .mockResolvedValueOnce([[{ id: 7 }, { id: 8 }]])            // SELECT their ids
      .mockResolvedValueOnce([{}])                                // INSERT IGNORE mini_tags (both)
      .mockResolvedValueOnce([{}]);                               // DELETE mini_images

    const res = await request(app)
      .post('/api/minis')
      .set('Cookie', authCookie(OWNER))
      .field('name', '  Dire Wolf  ')
      .field('tags', ' Boss, painted ,, ');

    expect(res.status).toBe(201);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO minis'), ['Dire Wolf', null, OWNER.userId, COLLECTION_A, 0]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT IGNORE INTO tags'), ['boss', 'painted']);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT IGNORE INTO mini_tags'), [42, 7, 42, 8]);
    // Four statements (clear, add names, read ids, link) however many tags
    // there are — not three round trips per tag.
    expect(execute.mock.calls.filter(([sql]) => String(sql).includes('tags')).length).toBe(4);
  });

  it('creates the mini as the logged-in user, ignoring any owner sent in the form', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([{ insertId: 42 }])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);

    await request(app)
      .post('/api/minis')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .field('owner_id', '999')
      .field('collection_id', String(COLLECTION_B));

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO minis'), ['Dire Wolf', null, OWNER.userId, COLLECTION_A, 0]);
  });
});

describe('upload hardening', () => {
  // Every photo path from the single multi-row INSERT (mini_id, path, position).
  function savedImagePaths(): string[] {
    const call = execute.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO mini_images'));
    const params = (call?.[1] ?? []) as unknown[];
    return params.filter((_, i) => i % 3 === 1) as string[];
  }

  // A file named evil.html that merely CLAIMS to be image/png would otherwise
  // be saved as .html and served back as a live web page on this site. The
  // extension comes from what the file really is.
  it('names saved files by what the image really is, never by the uploader\'s filename or claimed type', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([{ insertId: 42 }])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])
      .mockResolvedValue([{}]);

    const res = await request(app)
      .post('/api/minis')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .attach('images', tinyPng(), { filename: 'evil.html', contentType: 'image/png' })
      .attach('images', tinyPng(), { filename: 'photo.jpg', contentType: 'image/jpeg' }) // a PNG renamed .jpg
      .attach('images', Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]), { filename: 'x.php.webp', contentType: 'image/webp' });

    expect(res.status).toBe(201);
    const [png, renamed, webp] = savedImagePaths();
    expect(png).toMatch(/^\/uploads\/[a-z0-9-]+\.png$/);
    expect(renamed).toMatch(/^\/uploads\/[a-z0-9-]+\.png$/);
    expect(webp).toMatch(/^\/uploads\/[a-z0-9-]+\.webp$/);
  });

  it.each([
    ['a text file renamed .png', Buffer.from('this is my shopping list'), 'notes.png', 'image/png'],
    ['HTML renamed .jpg', Buffer.from('<html><script>alert(1)</script></html>'), 'x.jpg', 'image/jpeg'],
    ['an empty file', Buffer.alloc(0), 'empty.jpg', 'image/jpeg'],
  ])('refuses %s that claims to be an image, naming the file, and keeps nothing', async (_why, content, filename, contentType) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);
    const before = new Set(fs.readdirSync(uploadsDir()));

    const res = await request(app)
      .post('/api/minis')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .attach('images', tinyPng(), 'good.png')
      .attach('images', content, { filename, contentType });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`"${filename}" isn't a photo we can open — use a JPG, PNG, GIF, or WebP`);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO minis'), expect.anything());
    await vi.waitFor(() => expect(fs.readdirSync(uploadsDir()).filter(f => !before.has(f))).toEqual([]));
  });

  it.each([
    ['an SVG (can contain scripts)', 'image/svg+xml', 'x.svg'],
    ['HTML pretending to be an image', 'text/html', 'x.png'],
    ['a JavaScript file', 'application/javascript', 'x.jpg'],
  ])('rejects %s', async (_why, contentType, filename) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app)
      .post('/api/minis')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .attach('images', Buffer.from('<svg onload="alert(1)"/>'), { filename, contentType });

    expect(res.status).toBe(400);
  });

  // existingImages is supplied by the browser. Trusting it would let someone
  // "keep" another member's photo on their own mini — and then deleting their
  // mini would delete that other member's photo file from disk.
  it('only keeps photos that already belong to this mini, ignoring any others named in the request', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[{ image_path: '/uploads/mine.png' }]])  // this mini's current photos
      .mockResolvedValueOnce([{}])                                     // UPDATE minis
      .mockResolvedValueOnce([{}])                                     // DELETE mini_tags
      .mockResolvedValueOnce([{}])                                     // DELETE mini_images
      .mockResolvedValueOnce([{}])                                     // INSERT kept photo
      .mockResolvedValueOnce([[miniRow()]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .field('existingImages', JSON.stringify([
        '/uploads/mine.png',
        '/uploads/someone-elses.png',
        'https://tracker.example/pixel.gif',
        '/uploads/../.env',
      ]));

    expect(res.status).toBe(200);
    expect(savedImagePaths()).toEqual(['/uploads/mine.png']);
  });

  it('does not let foreign "kept" photos count toward (or dodge) the 3-photo cap', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[]]) // no current photos
      .mockResolvedValue([{}]); // remaining calls resolve generically

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .field('existingImages', JSON.stringify(['/uploads/a.png', '/uploads/b.png', '/uploads/c.png']))
      .attach('images', tinyPng(), 'new.png');

    expect(res.status).not.toBe(400);
    expect(savedImagePaths()).toHaveLength(1);
    expect(savedImagePaths()[0]).toMatch(/\.png$/);
  });

  it('ignores a non-array existingImages value', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[{ image_path: '/uploads/mine.png' }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[miniRow()]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .field('existingImages', JSON.stringify({ length: 5, 0: '/uploads/x.png' }));

    expect(res.status).toBe(200);
    expect(savedImagePaths()).toEqual([]);
  });
});

describe('photos from rejected requests are deleted, not left on disk', () => {
  const filesOnDisk = () => new Set(fs.existsSync(uploadsDir()) ? fs.readdirSync(uploadsDir()) : []);
  const newFilesSince = (before: Set<string>) => [...filesOnDisk()].filter(f => !before.has(f));

  it('uses a scratch folder in tests, never the real backend/uploads', () => {
    expect(uploadsDir()).not.toBe(path.resolve(__dirname, '../../uploads'));
  });

  it('removes the photo when creating a mini is rejected (e.g. blank name)', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);
    const before = filesOnDisk();

    const res = await request(app).post('/api/minis').set('Cookie', authCookie(OWNER))
      .field('name', '   ')
      .attach('images', tinyPng(), 'wolf.png');

    expect(res.status).toBe(400);
    expect(newFilesSince(before)).toEqual([]);
  });

  it('removes photos someone uploads to a mini they don\'t own', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[{ owner_id: 1 }]]);
    const before = filesOnDisk();

    const res = await request(app).patch('/api/minis/42').set('Cookie', authCookie(OTHER))
      .field('name', 'Stolen Wolf')
      .attach('images', tinyPng(), 'a.png')
      .attach('images', tinyPng(), 'b.png');

    expect(res.status).toBe(403);
    expect(newFilesSince(before)).toEqual([]);
  });

  it('removes photos from an edit that would go over the 3-photo limit', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[{ image_path: '/uploads/a.png' }, { image_path: '/uploads/b.png' }, { image_path: '/uploads/c.png' }]]);
    const before = filesOnDisk();

    const res = await request(app).patch('/api/minis/42').set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .field('existingImages', JSON.stringify(['/uploads/a.png', '/uploads/b.png', '/uploads/c.png']))
      .attach('images', tinyPng(), 'd.png');

    expect(res.status).toBe(400);
    expect(newFilesSince(before)).toEqual([]);
  });

  it('removes photos when saving fails partway with a server error', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockRejectedValue(new Error('connection lost'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = filesOnDisk();

    const res = await request(app).post('/api/minis').set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .attach('images', tinyPng(), 'wolf.png');

    expect(res.status).toBe(500);
    expect(newFilesSince(before)).toEqual([]);
  });

  it('removes already-received photos when a later file in the same request is rejected', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);
    const before = filesOnDisk();

    const res = await request(app).post('/api/minis').set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .attach('images', tinyPng(), 'good.png')
      .attach('images', Buffer.from('not an image'), { filename: 'bad.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(newFilesSince(before)).toEqual([]);
  });

  it('keeps the photos of a mini that saved successfully', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([{ insertId: 42 }])
      .mockResolvedValue([{}]);
    const before = filesOnDisk();

    const res = await request(app).post('/api/minis').set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .attach('images', tinyPng(), 'wolf.png');

    expect(res.status).toBe(201);
    expect(newFilesSince(before)).toHaveLength(1);
  });
});

describe('POST /api/minis — photos', () => {
  it('accepts up to 3 images and stores one mini_images row per photo', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([{ insertId: 42 }]) // INSERT INTO minis
      .mockResolvedValueOnce([{}])                // DELETE mini_tags (setTags, unconditional)
      .mockResolvedValueOnce([{}])                // DELETE mini_images (setImages, unconditional)
      .mockResolvedValueOnce([{}])                // INSERT INTO mini_images (photo 1)
      .mockResolvedValueOnce([{}]);                // INSERT INTO mini_images (photo 2)

    const res = await request(app)
      .post('/api/minis')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .attach('images', tinyPng(), 'front.png')
      .attach('images', tinyPng(), 'back.png');

    expect(res.status).toBe(201);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO minis'),
      expect.arrayContaining([COLLECTION_A])
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO mini_images'),
      expect.arrayContaining([42, 0])
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO mini_images'),
      expect.arrayContaining([42, 1])
    );
  });

  it('rejects a 4th photo with a clean 400 instead of a server error', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app)
      .post('/api/minis')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .attach('images', tinyPng(), 'a.png')
      .attach('images', tinyPng(), 'b.png')
      .attach('images', tinyPng(), 'c.png')
      .attach('images', tinyPng(), 'd.png');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/most 3/i);
  });
});

describe('PATCH /api/minis/:id — photos', () => {
  it('lets the owner keep some existing photos and add a new one, within the cap of 3', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])                                   // ownership lookup
      .mockResolvedValueOnce([[{ image_path: '/uploads/old1.png' }, { image_path: '/uploads/old2.png' }]]) // current images
      .mockResolvedValueOnce([{}])                                                   // UPDATE minis
      .mockResolvedValueOnce([{}])                                                   // DELETE mini_tags (setTags)
      .mockResolvedValueOnce([{}])                                                   // DELETE mini_images
      .mockResolvedValueOnce([{}])                                                   // INSERT both images at once
      .mockResolvedValueOnce([[miniRow({ images: '/uploads/old1.png,/uploads/new.png' })]]); // re-fetch

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .field('existingImages', JSON.stringify(['/uploads/old1.png']))
      .attach('images', tinyPng(), 'new.png');

    expect(res.status).toBe(200);
    expect(res.body.images).toEqual(['/uploads/old1.png', '/uploads/new.png']);
  });

  it('rejects keeping 3 existing photos plus a new one (4 total) with 400', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[
        { image_path: '/uploads/a.png' },
        { image_path: '/uploads/b.png' },
        { image_path: '/uploads/c.png' },
      ]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .field('existingImages', JSON.stringify(['/uploads/a.png', '/uploads/b.png', '/uploads/c.png']))
      .attach('images', tinyPng(), 'new.png');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/most 3/i);
  });

  it('rejects a non-owner, non-admin with 403', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[{ owner_id: 1 }]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OTHER))
      .field('name', 'Stolen Wolf');

    expect(res.status).toBe(403);
  });

  it('does not let a demoted admin (old "admin" cookie) edit someone else\'s mini', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[{ owner_id: 1 }]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(ADMIN))
      .field('name', 'Dire Wolf');

    expect(res.status).toBe(403);
  });

  it('lets an admin edit someone else\'s mini in the SAME collection', async () => {
    execute
      .mockResolvedValueOnce(ADMIN_MEMBERSHIP)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[miniRow()]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(ADMIN))
      .field('name', 'Dire Wolf');

    expect(res.status).toBe(200);
  });

  it('returns 404 for an admin acting in a DIFFERENT collection than the mini — role alone is never enough', async () => {
    // Ownership lookup includes collection_id, so it finds nothing for this admin's active collection.
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(ADMIN_OTHER_COLLECTION))
      .field('name', 'Hijacked Wolf');

    expect(res.status).toBe(404);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('collection_id'),
      [42, COLLECTION_B]
    );
  });

  it('returns 404 when the mini does not exist', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .patch('/api/minis/999')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Ghost Wolf');

    expect(res.status).toBe(404);
  });

  it('rejects a blank name with 400', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .field('name', '   ');

    expect(res.status).toBe(400);
  });

  it('rejects a negative price with 400', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .field('price', '-3');

    expect(res.status).toBe(400);
  });

  it('treats malformed existingImages as keeping no photos, rather than erroring', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[{ image_path: '/uploads/old1.png' }]]) // current images
      .mockResolvedValueOnce([{}])                                   // UPDATE minis
      .mockResolvedValueOnce([{}])                                   // DELETE mini_tags
      .mockResolvedValueOnce([{}])                                   // DELETE mini_images
      .mockResolvedValueOnce([[miniRow()]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .field('existingImages', '{not json');

    expect(res.status).toBe(200);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO mini_images'), expect.anything());
  });

  it('rejects a non-numeric price with 400', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[]]); // current photos

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .field('price', 'free');

    expect(res.status).toBe(400);
  });

  it('rejects a non-image upload with 400', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .attach('images', Buffer.from('%PDF-1.4'), { filename: 'doc.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE minis'), expect.anything());
  });

  it('returns 401 with no auth cookie', async () => {
    const res = await request(app).patch('/api/minis/42').field('name', 'Wolf');
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/minis/:id', () => {
  it('lets the owner delete their own mini', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])            // ownership lookup
      .mockResolvedValueOnce([[{ image_path: '/uploads/a.png' }]]) // images to clean up
      .mockResolvedValueOnce([{}]);                           // DELETE FROM minis

    const res = await request(app)
      .delete('/api/minis/42')
      .set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM minis'), [42]);
  });

  it('does not let a demoted admin (old "admin" cookie) delete someone else\'s mini', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[{ owner_id: 1 }]]);

    const res = await request(app).delete('/api/minis/42').set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(403);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM minis'), expect.anything());
  });

  it('lets an admin delete someone else\'s mini in the SAME collection', async () => {
    execute
      .mockResolvedValueOnce(ADMIN_MEMBERSHIP)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{}]);

    const res = await request(app)
      .delete('/api/minis/42')
      .set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(200);
  });

  it('returns 404 for an admin acting in a DIFFERENT collection than the mini', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .delete('/api/minis/42')
      .set('Cookie', authCookie(ADMIN_OTHER_COLLECTION));

    expect(res.status).toBe(404);
  });

  it('rejects a non-owner, non-admin with 403', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[{ owner_id: 1 }]]);

    const res = await request(app)
      .delete('/api/minis/42')
      .set('Cookie', authCookie(OTHER));

    expect(res.status).toBe(403);
  });

  it('returns 404 when the mini does not exist', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .delete('/api/minis/999')
      .set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(404);
  });

  it.each(['negotiating', 'adventuring'])('refuses with 409 while the mini has a %s loan, and deletes nothing', async (loanStatus) => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1, active_loan_status: loanStatus }]]);

    const res = await request(app).delete('/api/minis/42').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(409);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM minis'), expect.anything());
  });

  it('checks ownership before revealing whether someone else\'s mini is on loan', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1, active_loan_status: 'adventuring' }]]);

    const res = await request(app).delete('/api/minis/42').set('Cookie', authCookie(OTHER));

    expect(res.status).toBe(403);
  });

  it('returns 401 with no auth cookie', async () => {
    const res = await request(app).delete('/api/minis/42');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/minis/:id/clear-condition', () => {
  it('lets the owner clear a lost/critically-wounded mini back into service', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1, condition_flag: 'critically_wounded' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[miniRow({ condition_flag: null, condition_since: null })]]);

    const res = await request(app).post('/api/minis/42/clear-condition').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE minis SET condition_flag = NULL, condition_since = NULL'),
      [42]
    );
  });

  it('lets an admin clear someone else\'s mini in the same collection', async () => {
    execute
      .mockResolvedValueOnce(ADMIN_MEMBERSHIP)
      .mockResolvedValueOnce([[{ owner_id: 1, condition_flag: 'lost' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[miniRow({ condition_flag: null, condition_since: null })]]);

    const res = await request(app).post('/api/minis/42/clear-condition').set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(200);
  });

  it('rejects a non-owner, non-admin with 403', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[{ owner_id: 1, condition_flag: 'lost' }]]);

    const res = await request(app).post('/api/minis/42/clear-condition').set('Cookie', authCookie(OTHER));

    expect(res.status).toBe(403);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE minis'), expect.anything());
  });

  it('returns 404 when the mini does not exist', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app).post('/api/minis/999/clear-condition').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(404);
  });

  it('returns 409 when the mini has no condition to clear', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[{ owner_id: 1, condition_flag: null }]]);

    const res = await request(app).post('/api/minis/42/clear-condition').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(409);
  });

  it('returns 401 with no auth cookie', async () => {
    const res = await request(app).post('/api/minis/42/clear-condition');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/minis/collection-members', () => {
  it('returns every member of the collection, not just those who own a mini', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ id: 1, name: 'Owner Name' }, { id: 2, name: 'Other Person' }]]);

    const res = await request(app).get('/api/minis/collection-members').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, name: 'Owner Name' }, { id: 2, name: 'Other Person' }]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('collection_memberships'), [COLLECTION_A]);
  });

  it('is not swallowed by the /:id route', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/minis/collection-members').set('Cookie', authCookie(OWNER));

    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('WHERE m.id = ?'), expect.anything());
  });
});

describe('POST /api/minis/:id/transfer', () => {
  // The lookup row shape: minis joined to its current owner's display name.
  function transferLookupRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      owner_id: 1,
      owner_name: 'Owner Name',
      name: 'Dire Wolf',
      active_loan_status: null,
      on_quest_since: null,
      ...overrides,
    };
  }

  it('lets the owner transfer their own mini to another member, and notifies them', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[transferLookupRow()]])       // ownership + status lookup
      .mockResolvedValueOnce([[{ exists: 1 }]])              // newOwnerId is a member
      .mockResolvedValueOnce([{ affectedRows: 1 }])          // UPDATE minis
      .mockResolvedValueOnce([{ affectedRows: 0 }])          // DELETE FROM cart_items
      .mockResolvedValueOnce([{ affectedRows: 0 }])          // DELETE FROM hold_watchers
      .mockResolvedValueOnce([[miniRow({ owner_id: 2 })]]);  // sendMini's re-fetch

    const res = await request(app)
      .post('/api/minis/42/transfer')
      .set('Cookie', authCookie(OWNER))
      .send({ newOwnerId: 2 });

    expect(res.status).toBe(200);
    expect(res.body.owner_id).toBe(2);
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE minis m SET m\.owner_id = \?, m\.set_id = NULL/),
      [2, 42, COLLECTION_A, 1]
    );
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM cart_items'), [2, 42]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM hold_watchers'), [42, 2]);
    // notify() itself is stubbed by unitSetup.ts (see notifications.integration.test.ts
    // for its real DB behavior) — asserted directly rather than via execute.
    expect(notify).toHaveBeenCalledWith(
      [2],
      expect.objectContaining({ type: 'ownership_transferred', message: 'Owner Name transferred Dire Wolf to you', miniId: 42 })
    );
  });

  it('lets an admin transfer someone else\'s mini in the SAME collection', async () => {
    execute
      .mockResolvedValueOnce(ADMIN_MEMBERSHIP)
      .mockResolvedValueOnce([[transferLookupRow()]])
      .mockResolvedValueOnce([[{ exists: 1 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[miniRow({ owner_id: 2 })]]);

    const res = await request(app)
      .post('/api/minis/42/transfer')
      .set('Cookie', authCookie(ADMIN))
      .send({ newOwnerId: 2 });

    expect(res.status).toBe(200);
  });

  it('returns 404 for an admin acting in a DIFFERENT collection than the mini', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post('/api/minis/42/transfer')
      .set('Cookie', authCookie(ADMIN_OTHER_COLLECTION))
      .send({ newOwnerId: 2 });

    expect(res.status).toBe(404);
  });

  it('rejects a non-owner, non-admin with 403, without checking the new owner or updating anything', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[transferLookupRow()]]);

    const res = await request(app)
      .post('/api/minis/42/transfer')
      .set('Cookie', authCookie(OTHER))
      .send({ newOwnerId: 2 });

    expect(res.status).toBe(403);
    expect(execute).toHaveBeenCalledTimes(2); // membership, then the lookup — nothing more
  });

  it('returns 404 when the mini does not exist', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post('/api/minis/999/transfer')
      .set('Cookie', authCookie(OWNER))
      .send({ newOwnerId: 2 });

    expect(res.status).toBe(404);
  });

  it.each([undefined, 0, -1, 1.5, 'abc', [2]])('rejects an invalid newOwnerId (%s) with 400', async (newOwnerId) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[transferLookupRow()]]);

    const res = await request(app)
      .post('/api/minis/42/transfer')
      .set('Cookie', authCookie(OWNER))
      .send({ newOwnerId });

    expect(res.status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(2); // membership, then the lookup — nothing more
  });

  it('rejects transferring a mini to its current owner', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[transferLookupRow({ owner_id: 1 })]]);

    const res = await request(app)
      .post('/api/minis/42/transfer')
      .set('Cookie', authCookie(OWNER))
      .send({ newOwnerId: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already theirs/i);
  });

  it('rejects a newOwnerId who isn\'t a member of this collection', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[transferLookupRow()]])
      .mockResolvedValueOnce([[]]); // not a member

    const res = await request(app)
      .post('/api/minis/42/transfer')
      .set('Cookie', authCookie(OWNER))
      .send({ newOwnerId: 99 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/isn't a member/i);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE minis'), expect.anything());
  });

  it.each(['negotiating', 'adventuring'])('refuses with 409 while the mini has a %s loan, and updates nothing', async (loanStatus) => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[transferLookupRow({ active_loan_status: loanStatus })]])
      .mockResolvedValueOnce([[{ exists: 1 }]]);

    const res = await request(app)
      .post('/api/minis/42/transfer')
      .set('Cookie', authCookie(OWNER))
      .send({ newOwnerId: 2 });

    expect(res.status).toBe(409);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE minis'), expect.anything());
  });

  it('refuses with 409 while the mini is out on a quest', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[transferLookupRow({ on_quest_since: new Date('2026-09-01T00:00:00.000Z') })]])
      .mockResolvedValueOnce([[{ exists: 1 }]]);

    const res = await request(app)
      .post('/api/minis/42/transfer')
      .set('Cookie', authCookie(OWNER))
      .send({ newOwnerId: 2 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/quest/i);
  });

  it('returns 409 if the mini became unavailable between the check and the write (race)', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[transferLookupRow()]])
      .mockResolvedValueOnce([[{ exists: 1 }]])
      .mockResolvedValueOnce([{ affectedRows: 0 }]); // UPDATE matched nothing

    const res = await request(app)
      .post('/api/minis/42/transfer')
      .set('Cookie', authCookie(OWNER))
      .send({ newOwnerId: 2 });

    expect(res.status).toBe(409);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM cart_items'), expect.anything());
  });

  it('returns 401 with no auth cookie', async () => {
    const res = await request(app).post('/api/minis/42/transfer').send({ newOwnerId: 2 });
    expect(res.status).toBe(401);
  });
});

describe('database failures', () => {
  it.each([
    ['GET /api/minis', () => request(app).get('/api/minis').set('Cookie', authCookie(OWNER))],
    ['GET /api/minis/tags', () => request(app).get('/api/minis/tags').set('Cookie', authCookie(OWNER))],
    ['GET /api/minis/:id', () => request(app).get('/api/minis/42').set('Cookie', authCookie(OWNER))],
    ['POST /api/minis', () => request(app).post('/api/minis').set('Cookie', authCookie(OWNER)).field('name', 'Dire Wolf')],
    ['PATCH /api/minis/:id', () => request(app).patch('/api/minis/42').set('Cookie', authCookie(OWNER)).field('name', 'Dire Wolf')],
    ['DELETE /api/minis/:id', () => request(app).delete('/api/minis/42').set('Cookie', authCookie(OWNER))],
  ])('%s returns a generic 500', async (_route, send) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockRejectedValue(new Error('connection lost'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await send();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Server error' });
  });
});
