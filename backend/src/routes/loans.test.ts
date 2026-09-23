import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { authCookie } from '../test/helpers';

// The loan rules and SQL are exercised end-to-end in loans.integration.test.ts.
// These mocked tests cover the two things a real database won't do on demand:
//   1. fail mid-request, and
//   2. lose a race — the loan changes between being read and being updated
//      (e.g. the other person cancels at the same moment you approve). Every
//      UPDATE re-checks the loan's status in its WHERE clause, and a
//      0-row result must come back as a clean 409, never a false success.
vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../db/connection';
import { createApp } from '../app';

const app = createApp();
const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;

const OWNER = { userId: 1, username: 'owner', role: 'user', collectionId: 10 };
const BORROWER = { userId: 2, username: 'borrower', role: 'user', collectionId: 10 };
const MEMBERSHIP_CONFIRMED = [[{ id: 1 }]];

function loanRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    mini_id: 42,
    borrower_id: BORROWER.userId,
    owner_id: OWNER.userId,
    status: 'negotiating',
    handoff_when: new Date('2026-10-01T18:00:00.000Z'),
    handoff_where: 'Game store',
    handoff_how: 'In person',
    duration_days: 14,
    borrower_approved: 1,
    owner_approved: 1,
    handed_off_at: null,
    received_at: null,
    due_at: null,
    returned_at: null,
    created_at: new Date('2026-09-01T00:00:00.000Z'),
    mini_name: 'Dire Wolf',
    mini_image: null,
    borrower_username: 'borrower',
    borrower_name: 'Borrower',
    owner_username: 'owner',
    owner_name: 'Owner',
    holds_waiting: 0, // the query counts the hold line; nobody waiting by default
    ...overrides,
  };
}

const NO_ROWS_CHANGED = [{ affectedRows: 0 }];

beforeEach(() => {
  execute.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('loans — someone else changed the loan at the same moment', () => {
  it.each([
    ['proposing terms', () => request(app).patch('/api/loans/5/terms').set('Cookie', authCookie(OWNER)).send({ durationDays: 21 })],
    ['approving', () => request(app).post('/api/loans/5/approve').set('Cookie', authCookie(BORROWER))],
    ['confirming the handoff', () => request(app).post('/api/loans/5/handoff').set('Cookie', authCookie(OWNER))],
    ['cancelling', () => request(app).post('/api/loans/5/cancel').set('Cookie', authCookie(BORROWER))],
  ])('%s returns 409 when the update matches no rows', async (_action, send) => {
    const row = loanRow(_action === 'approving' ? { borrower_approved: 0 } : {});
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[row]])        // loan as read
      .mockResolvedValueOnce(NO_ROWS_CHANGED); // ...but it changed before the UPDATE landed

    const res = await send();

    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();
  });

  it('marking returned returns 409 when the loan stopped adventuring in between', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow({ status: 'adventuring', due_at: new Date('2026-10-15T18:00:00.000Z') })]])
      .mockResolvedValueOnce(NO_ROWS_CHANGED);

    const res = await request(app).post('/api/loans/5/return').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(409);
  });

  it('confirming you got it returns 409 when the loan changed in between, and never records it twice', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow({ status: 'adventuring', due_at: new Date('2026-10-15T18:00:00.000Z'), received_at: null })]])
      .mockResolvedValueOnce(NO_ROWS_CHANGED);

    const res = await request(app).post('/api/loans/5/received').set('Cookie', authCookie(BORROWER));

    expect(res.status).toBe(409);
    const update = execute.mock.calls.find(([sql]) => String(sql).includes('UPDATE loans'))!;
    expect(update[0]).toMatch(/status = 'adventuring' AND received_at IS NULL/);
  });

  it('every state-changing UPDATE re-checks the status it expects', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow()]])
      .mockResolvedValueOnce(NO_ROWS_CHANGED);

    await request(app).post('/api/loans/5/handoff').set('Cookie', authCookie(OWNER));

    const update = execute.mock.calls.find(([sql]) => String(sql).includes('UPDATE loans'))!;
    expect(update[0]).toMatch(/status = 'negotiating'/);
    expect(update[0]).toMatch(/borrower_approved = 1 AND owner_approved = 1/);
  });
});

// Keeping a mini longer. A library won't renew a reserved book, and the hold
// line is this app's version of a reservation — so the check that nobody is
// waiting has to happen on the server, not only in the button that's hidden.
describe('POST /api/loans/:id/extend', () => {
  const OUT = { status: 'adventuring', handed_off_at: new Date('2026-10-01T18:00:00.000Z'), due_at: new Date('2026-10-15T18:00:00.000Z') };
  const NOBODY_WAITING = [[{ waiting: 0 }]];
  const ONE_WAITING = [[{ waiting: 1 }]];
  const ONE_ROW_CHANGED = [{ affectedRows: 1 }];

  it('moves the due date on, counted from the handoff and not from today', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(OUT)]])
      .mockResolvedValueOnce(NOBODY_WAITING)
      .mockResolvedValueOnce(ONE_ROW_CHANGED)
      .mockResolvedValueOnce([[loanRow({ ...OUT, duration_days: 21, due_at: new Date('2026-10-22T18:00:00.000Z') })]]);

    const res = await request(app).post('/api/loans/5/extend').set('Cookie', authCookie(BORROWER)).send({ extraDays: 7 });

    expect(res.status).toBe(200);
    const update = execute.mock.calls.find(([sql]) => String(sql).includes('UPDATE loans SET duration_days'))!;
    expect(update[0]).toMatch(/status = 'adventuring'/); // can't extend one that just came back
    // 14 agreed + 7 = 21 days from the handoff, not 7 from now.
    expect(update[1]).toEqual(expect.arrayContaining([21, new Date('2026-10-22T18:00:00.000Z')]));
  });

  it('refuses while anyone is in the hold line, and changes nothing', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(OUT)]])
      .mockResolvedValueOnce(ONE_WAITING);

    const res = await request(app).post('/api/loans/5/extend').set('Cookie', authCookie(BORROWER)).send({ extraDays: 7 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/waiting in line/i);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes('UPDATE loans'))).toBe(false);
  });

  it('lets the owner give more time too', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(OUT)]])
      .mockResolvedValueOnce(NOBODY_WAITING)
      .mockResolvedValueOnce(ONE_ROW_CHANGED)
      .mockResolvedValueOnce([[loanRow({ ...OUT, duration_days: 21 })]]);

    const res = await request(app).post('/api/loans/5/extend').set('Cookie', authCookie(OWNER)).send({ extraDays: 7 });

    expect(res.status).toBe(200);
  });

  it('refuses a loan that isn\'t out adventuring', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow()]]); // still negotiating

    const res = await request(app).post('/api/loans/5/extend').set('Cookie', authCookie(BORROWER)).send({ extraDays: 7 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/isn't out/i);
  });

  it('refuses going past the three months, before asking about holds', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow({ ...OUT, duration_days: 85 })]])
      .mockResolvedValueOnce(NOBODY_WAITING);

    const res = await request(app).post('/api/loans/5/extend').set('Cookie', authCookie(BORROWER)).send({ extraDays: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/5 more days/);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes('UPDATE loans'))).toBe(false);
  });

  it('returns 409 when the loan came back between the read and the update', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(OUT)]])
      .mockResolvedValueOnce(NOBODY_WAITING)
      .mockResolvedValueOnce(NO_ROWS_CHANGED);

    const res = await request(app).post('/api/loans/5/extend').set('Cookie', authCookie(BORROWER)).send({ extraDays: 7 });

    expect(res.status).toBe(409);
  });
});

describe('POST /api/loans/:id/return — lost and critically wounded outcomes', () => {
  const OUT = { status: 'adventuring', handed_off_at: new Date('2026-10-01T18:00:00.000Z'), due_at: new Date('2026-10-15T18:00:00.000Z') };

  it.each(['lost', 'critically_wounded'])('marks the loan %s, flags the mini, and clears its hold line and cart entries', async (outcome) => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(OUT)]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE loans
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE minis condition
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // DELETE holds
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // DELETE hold_watchers
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // DELETE cart_items
      .mockResolvedValueOnce([[loanRow({ ...OUT, status: outcome })]]); // sendLoan's re-fetch

    const res = await request(app).post('/api/loans/5/return').set('Cookie', authCookie(OWNER)).send({ outcome });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(outcome);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE loans SET status = ?'), [outcome, expect.any(Date), 5]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE minis SET condition_flag = ?'), [outcome, expect.any(Date), 42]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM holds'), [42]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM hold_watchers'), [42]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM cart_items'), [42]);
  });

  it('defaults to a normal return when no outcome is given', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(OUT)]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[loanRow({ ...OUT, status: 'returned' })]]);

    const res = await request(app).post('/api/loans/5/return').set('Cookie', authCookie(OWNER)).send({});

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE loans SET status = ?'), ['returned', expect.any(Date), 5]);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE minis SET condition_flag'), expect.anything());
  });

  it('rejects an outcome that isn\'t returned, lost, or critically_wounded', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(OUT)]]);

    const res = await request(app).post('/api/loans/5/return').set('Cookie', authCookie(OWNER)).send({ outcome: 'exploded' });

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE loans'), expect.anything());
  });
});

describe('loans — scoping', () => {
  it('only ever looks up loans in the active collection that the caller is part of', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app).post('/api/loans/5/approve').set('Cookie', authCookie(BORROWER));

    expect(res.status).toBe(404);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('l.collection_id = ? AND (l.borrower_id = ? OR l.owner_id = ?)'),
      [10, BORROWER.userId, BORROWER.userId, 5]
    );
  });

  it.each([
    ['GET /api/loans', () => request(app).get('/api/loans')],
    ['PATCH terms', () => request(app).patch('/api/loans/5/terms').send({ where: 'x' })],
    ['POST approve', () => request(app).post('/api/loans/5/approve')],
    ['POST handoff', () => request(app).post('/api/loans/5/handoff')],
    ['POST received', () => request(app).post('/api/loans/5/received')],
    ['POST return', () => request(app).post('/api/loans/5/return')],
    ['POST cancel', () => request(app).post('/api/loans/5/cancel')],
    ['POST apply-terms-to-all', () => request(app).post('/api/loans/5/apply-terms-to-all')],
  ])('%s requires login', async (_route, send) => {
    const res = await send();

    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('loans — database failures', () => {
  it('GET /api/loans returns a generic 500', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockRejectedValue(new Error('connection lost'));

    const res = await request(app).get('/api/loans').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Server error' });
  });

  it.each(['approve', 'handoff', 'received', 'return', 'cancel', 'apply-terms-to-all'])('POST %s returns a generic 500', async (action) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockRejectedValue(new Error('connection lost'));

    const res = await request(app).post(`/api/loans/5/${action}`).set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Server error' });
  });
});
