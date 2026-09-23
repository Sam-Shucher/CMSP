import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { RowDataPacket } from 'mysql2';
import { pool } from '../db/connection';
import {
  placeBooking, cancelBooking, miniCalendar, listMyBookings, bookingBlocking,
  startDueBookings, sweepPastBookings, MAX_BOOKINGS_PER_MINI,
} from './bookings';
import { todayInApp, addDays } from '../utils/appTime';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, createMini, TestUser,
} from '../test/dbHelpers';

// Bookings against a real database. A hold answers "tell me when it's free";
// a booking claims a range of days up front — so the rules that matter are the
// ones a mocked database can't check: two people can't claim the same day, and
// a booking that comes due really does turn into a request.

// Days are the group's days (APP_TIMEZONE, Chicago by default) — the same
// "today" the app uses — so these don't turn flaky in the evening, when UTC
// has already moved on to tomorrow.
function day(offsetDays: number): string {
  return addDays(todayInApp(), offsetDays);
}

// Midday on that day in Chicago (18:00 UTC is noon CST, 1pm CDT): a moment
// that can't slip into the day before or after, whatever the clocks do.
function middayOn(offsetDays: number): Date {
  return new Date(`${day(offsetDays)}T18:00:00Z`);
}

let collectionId: number;
let olivia: TestUser;  // owns the minis
let wendy: TestUser;
let theo: TestUser;
let miniId: number;

beforeAll(assertDatabaseReachable);

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await resetDatabase();
  collectionId = await createCollection('Chicago');
  olivia = await createUser('olivia', collectionId);
  wendy = await createUser('wendy', collectionId);
  theo = await createUser('theo', collectionId);
  miniId = await createMini(olivia, 'Dire Wolf');
});

afterAll(async () => {
  await pool.end();
});

function window(from: number, to: number = from) {
  return { startsOn: day(from), endsOn: day(to) };
}

describe('placing a booking', () => {
  it('claims the days and tells the owner', async () => {
    const result = await placeBooking(miniId, wendy.userId, collectionId, window(14), 'game night');

    expect(result.ok).toBe(true);
    const [saved] = await pool.query<RowDataPacket[]>(
      'SELECT user_id, note, DATE_FORMAT(starts_on, "%Y-%m-%d") AS starts_on FROM bookings WHERE mini_id = ?',
      [miniId]
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(expect.objectContaining({ user_id: wendy.userId, note: 'game night', starts_on: day(14) }));

    const [notices] = await pool.query<RowDataPacket[]>(
      'SELECT user_id, type FROM notifications WHERE type = ?', ['booking_placed']
    );
    expect(notices).toEqual([expect.objectContaining({ user_id: olivia.userId })]);
  });

  // Works whether or not the mini is free right now — that's the entire point
  // of booking a date rather than getting in line.
  it('works while the mini is out with someone else', async () => {
    await pool.execute(
      `INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status, handed_off_at, due_at)
       VALUES (?, ?, ?, ?, 'adventuring', NOW(), NOW() + INTERVAL 3 DAY)`,
      [miniId, collectionId, theo.userId, olivia.userId]
    );

    expect((await placeBooking(miniId, wendy.userId, collectionId, window(14), null)).ok).toBe(true);
  });

  it('refuses your own mini', async () => {
    const result = await placeBooking(miniId, olivia.userId, collectionId, window(14), null);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/your own mini/i);
  });

  it('refuses a mini in another collection, even by guessing its id', async () => {
    const otherCollection = await createCollection('dojo');
    const stranger = await createUser('stranger', otherCollection);

    const result = await placeBooking(miniId, stranger.userId, otherCollection, window(14), null);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(404);
  });

  it.each(['lost', 'critically_wounded'])('refuses a mini marked %s', async (flag: string) => {
    await pool.execute('UPDATE minis SET condition_flag = ?, condition_since = NOW() WHERE id = ?', [flag, miniId]);

    const result = await placeBooking(miniId, wendy.userId, collectionId, window(14), null);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(409);
  });
});

// A mini that's out — lent, or on a quest with its owner, which counts the
// same — can be booked only from the day after it's due back: the owner may
// not want to lend it again the very day it comes home.
describe('booking a mini that is out', () => {
  async function lentUntil(dueInDays: number): Promise<void> {
    await pool.execute(
      `INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status, handed_off_at, due_at)
       VALUES (?, ?, ?, ?, 'adventuring', NOW(), ?)`,
      [miniId, collectionId, theo.userId, olivia.userId, middayOn(dueInDays)]
    );
  }

  it('refuses any day up to and including the day it\'s due back, saying which day is free', async () => {
    await lentUntil(5);

    for (const start of [0, 3, 5]) {
      const result = await placeBooking(miniId, wendy.userId, collectionId, window(start), null);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.status).toBe(409);
      expect(!result.ok && result.error).toMatch(/out on loan until .*earliest you can book it is/);
    }
  });

  it('allows the day after it\'s due back', async () => {
    await lentUntil(5);

    expect((await placeBooking(miniId, wendy.userId, collectionId, window(6), null)).ok).toBe(true);
  });

  it('treats a quest with a back-by date exactly like a loan due that day', async () => {
    await pool.execute('UPDATE minis SET on_quest_since = NOW(), on_quest_until = ? WHERE id = ?', [day(5), miniId]);

    const onTheDay = await placeBooking(miniId, wendy.userId, collectionId, window(5), null);
    expect(!onTheDay.ok && onTheDay.error).toMatch(/on a quest with its owner until/);
    expect((await placeBooking(miniId, wendy.userId, collectionId, window(6), null)).ok).toBe(true);
  });

  it('can\'t be booked at all while on a quest with no back-by date — a hold is the way in', async () => {
    await pool.execute('UPDATE minis SET on_quest_since = NOW(), on_quest_until = NULL WHERE id = ?', [miniId]);

    const result = await placeBooking(miniId, wendy.userId, collectionId, window(30), null);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/no date it's due back — place a hold/);
  });

  it('counts an overdue mini as due back today, so tomorrow is the earliest', async () => {
    await lentUntil(-3);

    expect((await placeBooking(miniId, wendy.userId, collectionId, window(0), null)).ok).toBe(false);
    expect((await placeBooking(miniId, wendy.userId, collectionId, window(1), null)).ok).toBe(true);
  });

  it('tells the page all of this before anyone picks a day', async () => {
    await lentUntil(5);
    const lent = await miniCalendar(miniId, wendy.userId, collectionId);
    expect(lent).toMatchObject({ out: { until: day(5), reason: 'loan' }, bookable: true, earliestStart: day(6) });

    await pool.execute('DELETE FROM loans WHERE mini_id = ?', [miniId]);
    await pool.execute('UPDATE minis SET on_quest_since = NOW(), on_quest_until = NULL WHERE id = ?', [miniId]);
    const questing = await miniCalendar(miniId, wendy.userId, collectionId);
    expect(questing).toMatchObject({ out: { until: null, reason: 'quest' }, bookable: false, earliestStart: null });

    await pool.execute('UPDATE minis SET on_quest_since = NULL WHERE id = ?', [miniId]);
    const home = await miniCalendar(miniId, wendy.userId, collectionId);
    expect(home).toMatchObject({ out: null, bookable: true, earliestStart: day(0) });
  });

  // A request that hasn't been handed over yet has no due date; the handoff
  // rule (routes/loans.ts) makes its loan fit around the booking instead.
  it('still takes a booking while it\'s only requested, not yet handed over', async () => {
    await pool.execute(
      `INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status) VALUES (?, ?, ?, ?, 'negotiating')`,
      [miniId, collectionId, theo.userId, olivia.userId]
    );

    expect((await placeBooking(miniId, wendy.userId, collectionId, window(3), null)).ok).toBe(true);
  });
});

describe('two people can never claim the same day', () => {
  it('refuses a booking that overlaps one already made, naming who has it', async () => {
    await placeBooking(miniId, wendy.userId, collectionId, window(14, 16), null);

    const result = await placeBooking(miniId, theo.userId, collectionId, window(16, 18), null);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(409);
    expect(!result.ok && result.error).toMatch(/wendy display/i);
  });

  it('allows a booking that starts the day after another ends', async () => {
    await placeBooking(miniId, wendy.userId, collectionId, window(14, 16), null);

    expect((await placeBooking(miniId, theo.userId, collectionId, window(17, 18), null)).ok).toBe(true);
  });

  // The overlap check and the insert have to be one atomic step, or two people
  // clicking at the same instant both get the 14th.
  it('lets only one of two simultaneous bookings for the same day through', async () => {
    const [first, second] = await Promise.all([
      placeBooking(miniId, wendy.userId, collectionId, window(14), null),
      placeBooking(miniId, theo.userId, collectionId, window(14), null),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const [saved] = await pool.query<RowDataPacket[]>('SELECT id FROM bookings WHERE mini_id = ?', [miniId]);
    expect(saved).toHaveLength(1);
  });

  it('refuses a second booking on the same mini by the same person', async () => {
    await placeBooking(miniId, wendy.userId, collectionId, window(14), null);

    const result = await placeBooking(miniId, wendy.userId, collectionId, window(30), null);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/already have this mini booked/i);
  });

  it(`refuses more than ${MAX_BOOKINGS_PER_MINI} bookings on one mini`, async () => {
    for (let i = 0; i < MAX_BOOKINGS_PER_MINI; i += 1) {
      const booker = await createUser(`booker${i}`, collectionId);
      const placed = await placeBooking(miniId, booker.userId, collectionId, window(i * 2 + 2), null);
      expect(placed.ok).toBe(true);
    }

    const result = await placeBooking(miniId, wendy.userId, collectionId, window(60), null);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/calendar is full/i);
  });
});

describe('seeing the calendar', () => {
  it('shows everyone the booked days, but only names them to the owner and the booker', async () => {
    await placeBooking(miniId, wendy.userId, collectionId, window(14, 15), 'game night');

    const toOwner = await miniCalendar(miniId, olivia.userId, collectionId);
    const toBooker = await miniCalendar(miniId, wendy.userId, collectionId);
    const toBystander = await miniCalendar(miniId, theo.userId, collectionId);

    expect(toOwner!.bookings[0]).toEqual(expect.objectContaining({ startsOn: day(14), holderName: 'wendy display', mine: false }));
    expect(toBooker!.bookings[0]).toEqual(expect.objectContaining({ holderName: 'wendy display', mine: true }));
    expect(toBystander!.bookings[0]).toEqual(expect.objectContaining({ startsOn: day(14), holderName: null, mine: false }));
    // The dates are public — that's what makes the calendar usable — but the
    // note is between the booker and the owner.
    expect(toBystander!.bookings[0].note).toBeNull();
    expect(toOwner!.bookings[0].note).toBe('game night');
  });

  it('returns null for a mini in another collection', async () => {
    const otherCollection = await createCollection('dojo');
    const stranger = await createUser('stranger', otherCollection);

    expect(await miniCalendar(miniId, stranger.userId, otherCollection)).toBeNull();
  });
});

describe('listing your own bookings', () => {
  it('separates the ones you made from the ones on your minis', async () => {
    const second = await createMini(wendy, 'Owlbear');
    await placeBooking(miniId, wendy.userId, collectionId, window(14), null);
    await placeBooking(second, theo.userId, collectionId, window(20), null);

    const wendys = await listMyBookings(wendy.userId, collectionId);

    expect(wendys.mine.map(b => b.miniName)).toEqual(['Dire Wolf']);
    expect(wendys.onMyMinis.map(b => b.miniName)).toEqual(['Owlbear']);
    expect(wendys.onMyMinis[0].holderName).toBe('theo display');
  });

  it('never shows another collection\'s bookings', async () => {
    const otherCollection = await createCollection('dojo');
    const wendyElsewhere = await createUser('wendy2', otherCollection);
    const elsewhereMini = await createMini(await createUser('owner2', otherCollection), 'Beholder');
    await placeBooking(elsewhereMini, wendyElsewhere.userId, otherCollection, window(14), null);
    await placeBooking(miniId, wendy.userId, collectionId, window(14), null);

    const here = await listMyBookings(wendy.userId, collectionId);

    expect(here.mine.map(b => b.miniName)).toEqual(['Dire Wolf']);
  });
});

describe('cancelling a booking', () => {
  it('lets the booker drop their own, freeing the days again', async () => {
    const placed = await placeBooking(miniId, wendy.userId, collectionId, window(14), null);
    const bookingId = placed.ok ? placed.bookingId : 0;

    expect((await cancelBooking(bookingId, wendy.userId, collectionId)).ok).toBe(true);
    expect((await placeBooking(miniId, theo.userId, collectionId, window(14), null)).ok).toBe(true);
  });

  it('lets the owner cancel one on their mini, and tells the booker', async () => {
    const placed = await placeBooking(miniId, wendy.userId, collectionId, window(14), null);
    const bookingId = placed.ok ? placed.bookingId : 0;

    expect((await cancelBooking(bookingId, olivia.userId, collectionId)).ok).toBe(true);
    const [notices] = await pool.query<RowDataPacket[]>(
      'SELECT user_id FROM notifications WHERE type = ?', ['booking_cancelled']
    );
    expect(notices).toEqual([expect.objectContaining({ user_id: wendy.userId })]);
  });

  it('is nobody else\'s to cancel', async () => {
    const placed = await placeBooking(miniId, wendy.userId, collectionId, window(14), null);
    const bookingId = placed.ok ? placed.bookingId : 0;

    const result = await cancelBooking(bookingId, theo.userId, collectionId);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(404);
  });
});

describe('a booking constrains the loan calendar', () => {
  it('reports the booking a loan due that day would run into', async () => {
    await placeBooking(miniId, wendy.userId, collectionId, window(14, 15), null);

    const blocking = await bookingBlocking(miniId, middayOn(14), theo.userId);

    expect(blocking).toEqual({ startsOn: day(14), holderName: 'wendy display' });
  });

  it('says nothing about a loan due the day before it starts', async () => {
    await placeBooking(miniId, wendy.userId, collectionId, window(14, 15), null);

    expect(await bookingBlocking(miniId, middayOn(13), theo.userId)).toBeNull();
  });

  // Your own booking is not a reason to refuse you the mini.
  it('ignores the prospective borrower\'s own booking', async () => {
    await placeBooking(miniId, wendy.userId, collectionId, window(14, 15), null);

    expect(await bookingBlocking(miniId, middayOn(20), wendy.userId)).toBeNull();
  });

  it('ignores a booking that has already become a request', async () => {
    await placeBooking(miniId, wendy.userId, collectionId, window(14, 15), null);
    await pool.execute('UPDATE bookings SET started_at = NOW() WHERE mini_id = ?', [miniId]);

    expect(await bookingBlocking(miniId, middayOn(20), theo.userId)).toBeNull();
  });
});

describe('a booking coming due', () => {
  async function bookStartingToday(user: TestUser): Promise<void> {
    await placeBooking(miniId, user.userId, collectionId, window(0, 2), null);
  }

  it('becomes a request on its first day, and tells both people', async () => {
    await bookStartingToday(wendy);

    expect(await startDueBookings()).toBe(1);

    const [loans] = await pool.query<RowDataPacket[]>(
      'SELECT borrower_id, owner_id, status FROM loans WHERE mini_id = ?', [miniId]
    );
    expect(loans).toEqual([expect.objectContaining({
      borrower_id: wendy.userId, owner_id: olivia.userId, status: 'negotiating',
    })]);

    const [notices] = await pool.query<RowDataPacket[]>(
      'SELECT user_id, type FROM notifications WHERE type IN (?, ?)',
      ['booking_started', 'booking_became_request']
    );
    expect(notices).toHaveLength(2);
  });

  it('runs once and not again on the next sweep', async () => {
    await bookStartingToday(wendy);

    expect(await startDueBookings()).toBe(1);
    expect(await startDueBookings()).toBe(0);

    const [loans] = await pool.query<RowDataPacket[]>('SELECT id FROM loans WHERE mini_id = ?', [miniId]);
    expect(loans).toHaveLength(1);
  });

  // Booked while it was home; it went out anyway (overdue from an earlier loan,
  // say) and is still out on the day.
  it('waits, rather than double-booking, while the mini is still out', async () => {
    await bookStartingToday(wendy);
    await pool.execute(
      `INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status, handed_off_at, due_at)
       VALUES (?, ?, ?, ?, 'adventuring', NOW(), NOW() + INTERVAL 3 DAY)`,
      [miniId, collectionId, theo.userId, olivia.userId]
    );

    expect(await startDueBookings()).toBe(0);
    const [bookings] = await pool.query<RowDataPacket[]>(
      'SELECT started_at FROM bookings WHERE mini_id = ?', [miniId]
    );
    expect(bookings[0].started_at).toBeNull(); // still waiting, so tomorrow's sweep tries again
  });

  it('skips someone who has left the group since booking', async () => {
    await bookStartingToday(wendy);
    await pool.execute('DELETE FROM collection_memberships WHERE user_id = ? AND collection_id = ?', [wendy.userId, collectionId]);

    expect(await startDueBookings()).toBe(0);
    const [loans] = await pool.query<RowDataPacket[]>('SELECT id FROM loans WHERE mini_id = ?', [miniId]);
    expect(loans).toHaveLength(0);
  });

  // The person who booked it already has it — borrowed through the hold line,
  // or requested straight from the cart. Their booking is simply fulfilled.
  it.each(['adventuring', 'negotiating'])('is fulfilled by the booker\'s own %s loan: no second request, no notice', async (status) => {
    await bookStartingToday(wendy);
    const [loan] = await pool.execute<import('mysql2').ResultSetHeader>(
      `INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status, handed_off_at, due_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW() + INTERVAL 10 DAY)`,
      [miniId, collectionId, wendy.userId, olivia.userId, status]
    );

    expect(await startDueBookings()).toBe(0);

    const [loans] = await pool.query<RowDataPacket[]>('SELECT id FROM loans WHERE mini_id = ?', [miniId]);
    expect(loans).toHaveLength(1);
    const [bookings] = await pool.query<RowDataPacket[]>('SELECT started_at, loan_id FROM bookings WHERE mini_id = ?', [miniId]);
    expect(bookings[0].started_at).not.toBeNull();
    expect(bookings[0].loan_id).toBe(loan.insertId);
    const [notices] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM notifications WHERE type IN ('booking_started', 'booking_became_request')"
    );
    expect(notices).toHaveLength(0);
  });

  it('never tells someone who had it all along that it "never came free"', async () => {
    await bookStartingToday(wendy);
    await pool.execute(
      `INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status, handed_off_at, due_at)
       VALUES (?, ?, ?, ?, 'adventuring', NOW(), NOW() + INTERVAL 10 DAY)`,
      [miniId, collectionId, wendy.userId, olivia.userId]
    );
    await startDueBookings();

    // Days later, once the booked days are over.
    await sweepPastBookings(new Date(Date.now() + 5 * 24 * 60 * 60 * 1000));

    const [missed] = await pool.query<RowDataPacket[]>("SELECT id FROM notifications WHERE type = 'booking_missed'");
    expect(missed).toHaveLength(0);
  });

  it('leaves a booking whose day hasn\'t come alone', async () => {
    await placeBooking(miniId, wendy.userId, collectionId, window(14), null);

    expect(await startDueBookings()).toBe(0);
  });
});

describe('a booking that never happened', () => {
  async function bookInThePast(user: TestUser, from: number, to: number): Promise<void> {
    await pool.execute(
      'INSERT INTO bookings (mini_id, collection_id, user_id, starts_on, ends_on) VALUES (?, ?, ?, ?, ?)',
      [miniId, collectionId, user.userId, day(from), day(to)]
    );
  }

  it('is swept away once its days have passed, with a notice to the booker', async () => {
    await bookInThePast(wendy, -5, -3);

    expect(await sweepPastBookings()).toBe(1);

    const [left] = await pool.query<RowDataPacket[]>('SELECT id FROM bookings WHERE mini_id = ?', [miniId]);
    expect(left).toHaveLength(0);
    const [notices] = await pool.query<RowDataPacket[]>(
      'SELECT user_id, message FROM notifications WHERE type = ?', ['booking_missed']
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].user_id).toBe(wendy.userId);
  });

  // One that did become a loan is just history — cleared out, but silently:
  // the person already had their turn with it.
  it('clears a past booking that did become a request, without a notice', async () => {
    await bookInThePast(wendy, -5, -3);
    await pool.execute('UPDATE bookings SET started_at = NOW() WHERE mini_id = ?', [miniId]);

    expect(await sweepPastBookings()).toBe(1);

    const [notices] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM notifications WHERE type = ?', ['booking_missed']
    );
    expect(notices).toHaveLength(0);
  });

  it('leaves a booking that is still running today', async () => {
    await bookInThePast(wendy, -2, 2);

    expect(await sweepPastBookings()).toBe(0);
  });
});
