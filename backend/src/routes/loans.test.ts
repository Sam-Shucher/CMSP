import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { authCookie } from '../test/helpers';
import { bookingBlocking } from '../services/bookings';

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
    condition_reports: 0, // and the condition reports filed on this loan
    ...overrides,
  };
}

const NO_ROWS_CHANGED = [{ affectedRows: 0 }];

beforeEach(() => {
  execute.mockReset();
  // Nobody has days claimed on the mini unless a test says otherwise.
  vi.mocked(bookingBlocking).mockReset().mockResolvedValue(null);
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

// A hold decides WHO is next; a booking constrains the CALENDAR. The mini has
// to be home before someone else's booked window begins, so the two places
// that set a due date — the handoff and an extension — both have to ask.
describe('a booking blocks a loan that would still be out on its first day', () => {
  const AGREED = { status: 'negotiating', borrower_approved: 1, owner_approved: 1 };
  const OUT = { status: 'adventuring', handed_off_at: new Date('2026-10-01T18:00:00.000Z'), due_at: new Date('2026-10-15T18:00:00.000Z') };
  const CLAIMED = { startsOn: '2026-10-10', holderName: 'Wendy Waiting' };

  it('refuses the handoff, naming who booked it and from when', async () => {
    vi.mocked(bookingBlocking).mockResolvedValue(CLAIMED);
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(AGREED)]]);

    const res = await request(app).post('/api/loans/5/handoff').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Wendy Waiting has this booked from Oct 10, 2026/);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes('UPDATE loans'))).toBe(false);
  });

  // It asks about the date this loan would actually run to, not about today.
  it('asks using the due date the agreed duration produces', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(AGREED)]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[loanRow({ status: 'adventuring' })]]);

    await request(app).post('/api/loans/5/handoff').set('Cookie', authCookie(OWNER));

    // 14 agreed days from the handoff, and the mini this loan is for.
    expect(bookingBlocking).toHaveBeenCalledWith(42, expect.any(Date), BORROWER.userId);
    const [, askedDueAt] = vi.mocked(bookingBlocking).mock.calls[0];
    expect(askedDueAt.getTime()).toBeGreaterThan(Date.now() + 13 * 24 * 60 * 60 * 1000);
  });

  it('refuses an extension that would run into the booked days', async () => {
    vi.mocked(bookingBlocking).mockResolvedValue(CLAIMED);
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(OUT)]])
      .mockResolvedValueOnce([[{ waiting: 0 }]]);

    const res = await request(app).post('/api/loans/5/extend').set('Cookie', authCookie(BORROWER)).send({ extraDays: 7 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/booked from Oct 10, 2026/);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes('UPDATE loans SET duration_days'))).toBe(false);
  });

  it('lets a handoff through when nobody has claimed those days', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(AGREED)]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[loanRow({ status: 'adventuring' })]]);

    const res = await request(app).post('/api/loans/5/handoff').set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
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
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // DELETE bookings
      .mockResolvedValueOnce([[loanRow({ ...OUT, status: outcome })]]); // sendLoan's re-fetch

    const res = await request(app).post('/api/loans/5/return').set('Cookie', authCookie(OWNER)).send({ outcome });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(outcome);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE loans SET status = ?'), [outcome, expect.any(Date), 5]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE minis SET condition_flag = ?'), [outcome, expect.any(Date), 42]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM holds'), [42]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM hold_watchers'), [42]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM cart_items'), [42]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM bookings'), [42]);
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

// A condition report says what the mini looked like at one end of a loan.
// The real storage and reading back is exercised in loans.integration.test.ts;
// what matters here is that the lifecycle rules are enforced on the server and
// that a second report from the same person can't overwrite the first.
describe('POST /api/loans/:id/condition', () => {
  const OUT = { status: 'adventuring', handed_off_at: new Date('2026-10-01T18:00:00.000Z'), due_at: new Date('2026-10-15T18:00:00.000Z') };
  const RECORDED = [{ affectedRows: 1, insertId: 77 }];
  const ALREADY_RECORDED = [{ affectedRows: 0, insertId: 0 }];

  function reportRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 77, phase: 'handoff', author_id: BORROWER.userId, author_name: 'Borrower',
      note: 'The spear was already bent', created_at: new Date('2026-10-01T18:05:00.000Z'),
      photos: null, ...overrides,
    };
  }

  it('records a note from the borrower while the mini is out', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(OUT)]])
      .mockResolvedValueOnce(RECORDED)
      .mockResolvedValueOnce([[reportRow()]]);

    const res = await request(app).post('/api/loans/5/condition')
      .set('Cookie', authCookie(BORROWER))
      .field('phase', 'handoff')
      .field('note', 'The spear was already bent');

    expect(res.status).toBe(201);
    expect(res.body).toEqual([expect.objectContaining({
      phase: 'handoff', note: 'The spear was already bent', authorName: 'Borrower', photos: [],
    })]);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT IGNORE INTO loan_condition_reports'),
      [5, 'handoff', BORROWER.userId, 'The spear was already bent']
    );
  });

  it('lets the owner record their own side of the same end', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(OUT)]])
      .mockResolvedValueOnce(RECORDED)
      .mockResolvedValueOnce([[reportRow({ author_id: OWNER.userId, author_name: 'Owner' })]]);

    const res = await request(app).post('/api/loans/5/condition')
      .set('Cookie', authCookie(OWNER))
      .field('phase', 'handoff')
      .field('note', 'Spear was straight when it left me');

    expect(res.status).toBe(201);
  });

  // A record that can be rewritten later isn't a record — that is the whole
  // point of the feature, so the second attempt is refused, not merged.
  it('refuses a second report from the same person for the same end', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(OUT)]])
      .mockResolvedValueOnce(ALREADY_RECORDED);

    const res = await request(app).post('/api/loans/5/condition')
      .set('Cookie', authCookie(BORROWER))
      .field('phase', 'handoff')
      .field('note', 'Actually it was fine');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already recorded/i);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('loan_condition_photos'), expect.anything());
  });

  it('refuses a claim about the handoff once the loan is over', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow({ ...OUT, status: 'returned', returned_at: new Date('2026-10-14T10:00:00.000Z') })]]);

    const res = await request(app).post('/api/loans/5/condition')
      .set('Cookie', authCookie(BORROWER))
      .field('phase', 'handoff')
      .field('note', 'It was already bent, honest');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/while the mini is out/i);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('INSERT IGNORE INTO loan_condition_reports'), expect.anything());
  });

  // The owner only has it back in hand once the loan has ended.
  it('still accepts a report about the return after the loan is over', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow({ ...OUT, status: 'returned', returned_at: new Date('2026-10-14T10:00:00.000Z') })]])
      .mockResolvedValueOnce(RECORDED)
      .mockResolvedValueOnce([[reportRow({ phase: 'return' })]]);

    const res = await request(app).post('/api/loans/5/condition')
      .set('Cookie', authCookie(OWNER))
      .field('phase', 'return')
      .field('note', 'Came back with a chipped base');

    expect(res.status).toBe(201);
  });

  it('refuses any report on a request that never changed hands', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow()]]); // still negotiating

    const res = await request(app).post('/api/loans/5/condition')
      .set('Cookie', authCookie(BORROWER))
      .field('phase', 'return')
      .field('note', 'Looks great');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/changed hands/i);
  });

  it('refuses an empty report — a blank note and no photo records nothing', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(OUT)]]);

    const res = await request(app).post('/api/loans/5/condition')
      .set('Cookie', authCookie(BORROWER))
      .field('phase', 'handoff')
      .field('note', '   ');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/note or a photo/i);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('INSERT IGNORE INTO loan_condition_reports'), expect.anything());
  });

  it('refuses a phase that isn\'t one end of a loan', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(OUT)]]);

    const res = await request(app).post('/api/loans/5/condition')
      .set('Cookie', authCookie(BORROWER))
      .field('phase', 'midway')
      .field('note', 'Halfway through it was fine');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/handoff/);
  });

  it('refuses a note longer than the column holds', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow(OUT)]]);

    const res = await request(app).post('/api/loans/5/condition')
      .set('Cookie', authCookie(BORROWER))
      .field('phase', 'handoff')
      .field('note', 'x'.repeat(1001));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1000 characters/);
  });

  it('is not open to anyone but the two people on the loan', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app).post('/api/loans/5/condition')
      .set('Cookie', authCookie({ userId: 99, username: 'nosy', role: 'user', collectionId: 10 }))
      .field('phase', 'handoff')
      .field('note', 'Just curious');

    expect(res.status).toBe(404);
  });
});

describe('GET /api/loans/:id/condition', () => {
  it('returns both sides\' reports, with their photos split out', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[loanRow({ status: 'adventuring', handed_off_at: new Date('2026-10-01T18:00:00.000Z') })]])
      .mockResolvedValueOnce([[
        { id: 1, phase: 'handoff', author_id: 1, author_name: 'Owner', note: 'All good', created_at: new Date('2026-10-01T18:01:00.000Z'), photos: '/uploads/a.jpg,/uploads/b.jpg' },
        { id: 2, phase: 'handoff', author_id: 2, author_name: 'Borrower', note: null, created_at: new Date('2026-10-01T18:02:00.000Z'), photos: '/uploads/c.jpg' },
      ]]);

    const res = await request(app).get('/api/loans/5/condition').set('Cookie', authCookie(BORROWER));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].photos).toEqual(['/uploads/a.jpg', '/uploads/b.jpg']);
    expect(res.body[1]).toEqual(expect.objectContaining({ note: null, photos: ['/uploads/c.jpg'] }));
  });

  it('404s for someone who isn\'t on the loan', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/loans/5/condition')
      .set('Cookie', authCookie({ userId: 99, username: 'nosy', role: 'user', collectionId: 10 }));

    expect(res.status).toBe(404);
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
