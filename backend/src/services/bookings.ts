import { PoolConnection } from 'mysql2/promise';
import { pool } from '../db/connection';
import { rows, firstRow, change, insert, inTransaction, Db } from '../db/query';
import { notify } from '../db/notifications';
import { messages } from '../utils/notificationMessages';
import {
  BookingWindow, OutState, bookingBlocksLoan, overlaps, earliestBookingStart, outUntilMessage,
} from '../utils/bookingRules';
import { todayInApp, dayIn } from '../utils/appTime';

// "I need this for game night on the 14th". A hold is a place in a queue for
// whenever a mini next comes free; a booking claims a range of days up front.
//
// The invariant: no two bookings on the same mini may overlap. Every change to
// a mini's calendar runs in a transaction that locks that mini's row first, so
// two people clicking the same day at the same instant are serialised and only
// one of them gets it — the same approach services/holds.ts takes to the line.
//
// While a mini is out — lent, or on a quest with its owner, which counts the
// same — it can be booked only from the day AFTER it's due back (see
// utils/bookingRules.ts's earliestBookingStart). The hold line always gets it
// first when it comes home; a booking constrains the CALENDAR instead:
// routes/loans.ts refuses a handoff or extension (and routes/minis.ts a quest)
// whose due date would still have the mini out when someone's booked window
// begins.
//
// "Today" is always the group's today (APP_TIMEZONE), passed into the SQL as a
// value — never CURDATE(), which is the database's today and can be a day off.

// One person's calendar shouldn't be fillable by one other person, and a mini
// with more than this many claims on it is a mini that needs a second copy.
export const MAX_BOOKINGS_PER_MINI = 10;

export type BookingFailure = { ok: false; status: 400 | 404 | 409; error: string };

const NOT_FOUND: BookingFailure = { ok: false, status: 404, error: 'Mini not found' };

interface LockedMini {
  id: number;
  name: string;
  owner_id: number;
  collection_id: number;
  condition_flag: string | null;
  archived_at: Date | null;
}

// A booking as the calendar stores it. Dates are read back as YYYY-MM-DD
// strings so they compare as calendar days, never as timestamps in whatever
// timezone the connection happens to be using.
interface LockedBooking {
  id: number;
  user_id: number;
  starts_on: string;
  ends_on: string;
}

interface ExistingBooking extends LockedBooking {
  holder_name: string;
}

async function lockMini(conn: PoolConnection, miniId: number, collectionId: number): Promise<LockedMini | null> {
  return firstRow<LockedMini>(
    `SELECT m.id, m.name, m.owner_id, m.collection_id, m.condition_flag, m.archived_at
     FROM minis m WHERE m.id = ? AND m.collection_id = ? FOR UPDATE`,
    [miniId, collectionId],
    conn
  );
}

// Whether the mini is out right now, and until when (a calendar day in the
// group's city). An adventuring loan is out until its due date; a quest until
// its back-by date, or with no end at all when it has none.
export async function outState(miniId: number, db: Db = pool): Promise<OutState> {
  const state = await firstRow<{ on_quest_since: Date | null; on_quest_until: string | null; due_at: Date | null }>(
    `SELECT m.on_quest_since, DATE_FORMAT(m.on_quest_until, '%Y-%m-%d') AS on_quest_until,
            (SELECT l.due_at FROM loans l WHERE l.mini_id = m.id AND l.status = 'adventuring' LIMIT 1) AS due_at
     FROM minis m WHERE m.id = ?`,
    [miniId],
    db
  );
  if (state?.due_at) return { out: true, until: dayIn(new Date(state.due_at)), reason: 'loan' };
  if (state?.on_quest_since) return { out: true, until: state.on_quest_until, reason: 'quest' };
  return { out: false };
}

// Every booking on this mini that still has days to come, soonest first.
const BOOKING_COLUMNS = `
  b.id, b.user_id, b.note, b.started_at, b.loan_id,
  DATE_FORMAT(b.starts_on, '%Y-%m-%d') AS starts_on,
  DATE_FORMAT(b.ends_on, '%Y-%m-%d') AS ends_on,
  u.display_name AS holder_name
`;

// Deliberately no join to users: FOR UPDATE locks every row a statement
// reads, and locking user rows inside this transaction would make two people
// booking different minis contend with each other. The clashing booker's name
// is looked up afterwards, for the message only — same reasoning as
// services/holds.ts's lockLine.
async function lockCalendar(conn: PoolConnection, miniId: number, today: string): Promise<LockedBooking[]> {
  return rows<LockedBooking>(
    `SELECT b.id, b.user_id,
            DATE_FORMAT(b.starts_on, '%Y-%m-%d') AS starts_on,
            DATE_FORMAT(b.ends_on, '%Y-%m-%d') AS ends_on
     FROM bookings b
     WHERE b.mini_id = ? AND b.ends_on >= ? ORDER BY b.starts_on FOR UPDATE`,
    [miniId, today],
    conn
  );
}

// A clash carries the booker's id rather than their name: the name needs a
// users lookup, which is done after the transaction has released its locks.
type PlaceOutcome =
  | { failure: BookingFailure }
  | { clashWith: number }
  | { mini: LockedMini; bookingId: number };

export async function placeBooking(
  miniId: number,
  userId: number,
  collectionId: number,
  window: BookingWindow,
  note: string | null,
  now: Date = new Date()
): Promise<{ ok: true; bookingId: number } | BookingFailure> {
  const today = todayInApp(now);
  const outcome = await inTransaction<PlaceOutcome>(async conn => {
    const mini = await lockMini(conn, miniId, collectionId);
    if (!mini || mini.archived_at) return { failure: NOT_FOUND };
    if (mini.owner_id === userId) return { failure: { ok: false, status: 400, error: 'That\'s your own mini' } };
    if (mini.condition_flag) {
      return { failure: { ok: false, status: 409, error: 'This mini isn\'t available to book right now' } };
    }

    // Out on a loan or a quest: only from the day after it's due back, and not
    // at all if nobody knows when that is.
    const state = await outState(miniId, conn);
    const start = earliestBookingStart(state, today);
    if (state.out && !start.bookable) {
      return { failure: { ok: false, status: 409, error: outUntilMessage(state, null) } };
    }
    if (state.out && start.bookable && window.startsOn < start.earliest) {
      return { failure: { ok: false, status: 409, error: outUntilMessage(state, start.earliest) } };
    }

    const calendar = await lockCalendar(conn, miniId, today);
    if (calendar.some(booking => booking.user_id === userId)) {
      return { failure: { ok: false, status: 409, error: 'You already have this mini booked — cancel that booking first' } };
    }
    if (calendar.length >= MAX_BOOKINGS_PER_MINI) {
      return { failure: { ok: false, status: 409, error: `This mini's calendar is full (${MAX_BOOKINGS_PER_MINI} bookings)` } };
    }

    const clash = calendar.find(booking => overlaps(window, { startsOn: booking.starts_on, endsOn: booking.ends_on }));
    if (clash) return { clashWith: clash.user_id };

    const booking = await insert(
      'INSERT INTO bookings (mini_id, collection_id, user_id, starts_on, ends_on, note) VALUES (?, ?, ?, ?, ?, ?)',
      [miniId, collectionId, userId, window.startsOn, window.endsOn, note],
      conn
    );
    return { mini, bookingId: booking.id };
  });

  if ('failure' in outcome) return outcome.failure;
  if ('clashWith' in outcome) {
    return {
      ok: false,
      status: 409,
      error: `${await displayName(outcome.clashWith)} already has this booked for those days — pick another date`,
    };
  }

  const { mini, bookingId } = outcome;
  const holder = await displayName(userId);
  await notify([mini.owner_id], {
    collectionId: mini.collection_id, type: 'booking_placed',
    message: messages.bookingPlaced(holder, mini.name, window.startsOn), miniId: mini.id,
  });
  return { ok: true, bookingId };
}

async function displayName(userId: number): Promise<string> {
  const found = await firstRow<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', [userId]);
  return found?.display_name ?? 'Someone';
}

interface BookingLookup {
  id: number;
  user_id: number;
  owner_id: number;
  mini_id: number;
  mini_name: string;
  collection_id: number;
  starts_on: string;
}

// The booker drops their own; the mini's owner can drop any on their mini
// (they are the one who has to physically hand it over). Anyone else gets a
// 404, same as a booking that doesn't exist.
export async function cancelBooking(
  bookingId: number,
  userId: number,
  collectionId: number
): Promise<{ ok: true } | BookingFailure> {
  const booking = await firstRow<BookingLookup>(
    `SELECT b.id, b.user_id, b.mini_id, b.collection_id, m.owner_id, m.name AS mini_name,
            DATE_FORMAT(b.starts_on, '%Y-%m-%d') AS starts_on
     FROM bookings b JOIN minis m ON m.id = b.mini_id
     WHERE b.id = ? AND b.collection_id = ?`,
    [bookingId, collectionId]
  );

  if (!booking || (booking.user_id !== userId && booking.owner_id !== userId)) {
    return { ok: false, status: 404, error: 'Booking not found' };
  }

  const removed = await change('DELETE FROM bookings WHERE id = ?', [bookingId]);
  if (removed === 0) return { ok: false, status: 404, error: 'Booking not found' };

  // Only the other person needs telling — whoever clicked already knows.
  if (booking.user_id !== userId) {
    await notify([booking.user_id], {
      collectionId: booking.collection_id, type: 'booking_cancelled',
      message: messages.bookingCancelled(await displayName(userId), booking.mini_name, booking.starts_on),
      miniId: booking.mini_id,
    });
  }
  return { ok: true };
}

export interface CalendarEntry {
  id: number;
  startsOn: string;
  endsOn: string;
  holderName: string | null; // only the owner and the booker see who
  note: string | null;
  mine: boolean;
  started: boolean;
}

export interface MiniCalendar {
  max: number;
  bookings: CalendarEntry[];
  // Whether it's out now and until when, so the page can warn before anyone
  // picks a day: the earliest day that can be booked (today, or the day after
  // it's due back), or bookable: false for a quest with no back-by date.
  out: { until: string | null; reason: 'loan' | 'quest' } | null;
  bookable: boolean;
  earliestStart: string | null;
}

interface CalendarRow extends ExistingBooking {
  note: string | null;
  started_at: Date | null;
}

// The booked days are public to the collection — that's what makes a calendar
// usable — but who booked them, and why, is between that person and the owner.
// Same reasoning as the hold line, where everyone sees the count and only the
// owner sees the names.
export async function miniCalendar(
  miniId: number, userId: number, collectionId: number, now: Date = new Date()
): Promise<MiniCalendar | null> {
  const mini = await firstRow<{ owner_id: number }>(
    'SELECT owner_id FROM minis WHERE id = ? AND collection_id = ? AND archived_at IS NULL',
    [miniId, collectionId]
  );
  if (!mini) return null;

  const today = todayInApp(now);
  const booked = await rows<CalendarRow>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings b JOIN users u ON u.id = b.user_id
     WHERE b.mini_id = ? AND b.ends_on >= ? ORDER BY b.starts_on, b.id`,
    [miniId, today]
  );
  const state = await outState(miniId);
  const start = earliestBookingStart(state, today);

  const isOwner = mini.owner_id === userId;
  return {
    max: MAX_BOOKINGS_PER_MINI,
    bookings: booked.map(row => {
      const mine = row.user_id === userId;
      const named = isOwner || mine;
      return {
        id: row.id,
        startsOn: row.starts_on,
        endsOn: row.ends_on,
        holderName: named ? row.holder_name : null,
        note: named ? row.note : null,
        mine,
        started: row.started_at !== null,
      };
    }),
    out: state.out ? { until: state.until, reason: state.reason } : null,
    bookable: start.bookable,
    earliestStart: start.bookable ? start.earliest : null,
  };
}

export interface MyBooking {
  id: number;
  miniId: number;
  miniName: string;
  miniImage: string | null;
  ownerName: string;
  holderName: string;
  startsOn: string;
  endsOn: string;
  note: string | null;
  started: boolean;
  loanId: number | null;
}

interface MyBookingRow extends CalendarRow {
  mini_id: number;
  mini_name: string;
  mini_image: string | null;
  owner_name: string;
  loan_id: number | null;
}

const MY_BOOKING_SELECT = `
  SELECT ${BOOKING_COLUMNS}, b.mini_id, m.name AS mini_name, o.display_name AS owner_name,
         (SELECT mi.image_path FROM mini_images mi WHERE mi.mini_id = m.id ORDER BY mi.position LIMIT 1) AS mini_image
  FROM bookings b
  JOIN minis m ON m.id = b.mini_id
  JOIN users u ON u.id = b.user_id
  JOIN users o ON o.id = m.owner_id
  WHERE b.collection_id = ? AND b.ends_on >= ?
`;

function serializeMyBooking(row: MyBookingRow): MyBooking {
  return {
    id: row.id,
    miniId: row.mini_id,
    miniName: row.mini_name,
    miniImage: row.mini_image,
    ownerName: row.owner_name,
    holderName: row.holder_name,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    note: row.note,
    started: row.started_at !== null,
    loanId: row.loan_id,
  };
}

export async function listMyBookings(
  userId: number,
  collectionId: number,
  now: Date = new Date()
): Promise<{ mine: MyBooking[]; onMyMinis: MyBooking[] }> {
  const today = todayInApp(now);
  const mine = await rows<MyBookingRow>(
    `${MY_BOOKING_SELECT} AND b.user_id = ? ORDER BY b.starts_on, b.id`,
    [collectionId, today, userId]
  );
  // The owner needs to see what has been claimed on their shelf, and by whom —
  // they're the one who has to hand it over on the day.
  const onMyMinis = await rows<MyBookingRow>(
    `${MY_BOOKING_SELECT} AND m.owner_id = ? AND b.user_id <> ? ORDER BY b.starts_on, b.id`,
    [collectionId, today, userId, userId]
  );
  return { mine: mine.map(serializeMyBooking), onMyMinis: onMyMinis.map(serializeMyBooking) };
}

// The rule a loan has to obey: the mini must be home before anyone else's
// booked window begins. Returns the booking that stands in the way, if any, so
// the refusal can name the date someone has to plan around.
// Pass the connection of a transaction that has locked the mini row (as
// routes/loans.ts's handoff and extend do): placeBooking takes the same lock,
// so no booking can land between this answer and the loan being saved.
export async function bookingBlocking(
  miniId: number,
  dueAt: Date,
  borrowerId: number,
  now: Date = new Date(),
  db?: Db
): Promise<{ startsOn: string; holderName: string } | null> {
  const upcoming = await rows<ExistingBooking>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings b JOIN users u ON u.id = b.user_id
     WHERE b.mini_id = ? AND b.user_id <> ? AND b.started_at IS NULL AND b.ends_on >= ?
     ORDER BY b.starts_on`,
    [miniId, borrowerId, todayInApp(now)],
    db
  );

  const clash = upcoming.find(booking => bookingBlocksLoan(dueAt, booking.starts_on));
  return clash ? { startsOn: clash.starts_on, holderName: clash.holder_name } : null;
}

// The same rule for the owner's own quest: it counts like a loan, so it has to
// be back before the next booked day — and with no back-by date at all, it
// would run into any booking there is. Returns the first booking in the way.
export async function bookingBlockingQuest(
  miniId: number,
  backBy: string | null,
  now: Date = new Date()
): Promise<{ startsOn: string; holderName: string } | null> {
  const upcoming = await rows<ExistingBooking>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings b JOIN users u ON u.id = b.user_id
     WHERE b.mini_id = ? AND b.started_at IS NULL AND b.ends_on >= ?
     ORDER BY b.starts_on`,
    [miniId, todayInApp(now)]
  );
  const clash = upcoming.find(booking => backBy === null || backBy >= booking.starts_on);
  return clash ? { startsOn: clash.starts_on, holderName: clash.holder_name } : null;
}

// Housekeeping: a booking whose first day has arrived becomes a request, so
// the person who planned around it doesn't have to be watching at midnight.
// If the mini isn't free yet it is simply left for the next sweep — never
// forced, because someone else is holding it right now. If the person who
// booked it already has it (borrowed or requested), the booking is simply
// fulfilled by that loan: no second request, and no "never came free" later.
export async function startDueBookings(now: Date = new Date()): Promise<number> {
  const today = todayInApp(now);
  const due = await rows<{ id: number; mini_id: number; user_id: number; collection_id: number; mini_name: string; owner_id: number }>(
    `SELECT b.id, b.mini_id, b.user_id, b.collection_id, m.name AS mini_name, m.owner_id
     FROM bookings b JOIN minis m ON m.id = b.mini_id
     WHERE b.started_at IS NULL AND b.starts_on <= ? AND b.ends_on >= ?
       AND m.archived_at IS NULL AND m.condition_flag IS NULL
     ORDER BY b.starts_on, b.id`,
    [today, today]
  );

  let started = 0;
  for (const booking of due) {
    const theirs = await firstRow<{ id: number }>(
      `SELECT id FROM loans WHERE mini_id = ? AND borrower_id = ? AND status IN ('negotiating', 'adventuring') LIMIT 1`,
      [booking.mini_id, booking.user_id]
    );
    if (theirs) {
      await change('UPDATE bookings SET started_at = NOW(), loan_id = ? WHERE id = ? AND started_at IS NULL', [theirs.id, booking.id]);
      continue;
    }

    // One statement that only succeeds if the mini is still free and the
    // person is still a member of its group — the same shape promoteNextHold
    // uses, and for the same reason.
    const request = await insert(
      `INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status)
       SELECT m.id, m.collection_id, ?, m.owner_id, 'negotiating'
       FROM minis m
       JOIN collection_memberships cm ON cm.user_id = ? AND cm.collection_id = m.collection_id
       WHERE m.id = ? AND m.on_quest_since IS NULL AND m.owner_id <> ?
         AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.mini_id = m.id AND l.status IN ('negotiating', 'adventuring'))`,
      [booking.user_id, booking.user_id, booking.mini_id, booking.user_id]
    );
    if (!request.inserted) continue;

    await change('UPDATE bookings SET started_at = NOW(), loan_id = ? WHERE id = ?', [request.id, booking.id]);
    await change('DELETE FROM cart_items WHERE user_id = ? AND mini_id = ?', [booking.user_id, booking.mini_id]);
    await notify([booking.user_id], {
      collectionId: booking.collection_id, type: 'booking_started',
      message: messages.bookingStarted(booking.mini_name), miniId: booking.mini_id, loanId: request.id,
    });
    await notify([booking.owner_id], {
      collectionId: booking.collection_id, type: 'booking_became_request',
      message: messages.bookingBecameRequest(await displayName(booking.user_id), booking.mini_name),
      miniId: booking.mini_id, loanId: request.id,
    });
    started += 1;
  }
  return started;
}

// Housekeeping: clear out bookings whose days have gone. One that never became
// a request is a no-show — the mini never came free — and the person who
// planned around it is told, because nothing else would tell them.
export async function sweepPastBookings(now: Date = new Date()): Promise<number> {
  const past = await rows<{ id: number; user_id: number; collection_id: number; mini_id: number; mini_name: string; starts_on: string; started_at: Date | null }>(
    `SELECT b.id, b.user_id, b.collection_id, b.mini_id, b.started_at, m.name AS mini_name,
            DATE_FORMAT(b.starts_on, '%Y-%m-%d') AS starts_on
     FROM bookings b JOIN minis m ON m.id = b.mini_id
     WHERE b.ends_on < ?`,
    [todayInApp(now)]
  );

  for (const booking of past) {
    await change('DELETE FROM bookings WHERE id = ?', [booking.id]);
    if (booking.started_at === null) {
      await notify([booking.user_id], {
        collectionId: booking.collection_id, type: 'booking_missed',
        message: messages.bookingMissed(booking.mini_name, booking.starts_on), miniId: booking.mini_id,
      });
    }
  }
  return past.length;
}

// When someone leaves a group, their claims on that group's calendar go with
// them — the same as their holds (services/holds.ts).
export async function dropBookingsInCollection(userId: number, collectionId: number): Promise<void> {
  await change('DELETE FROM bookings WHERE user_id = ? AND collection_id = ?', [userId, collectionId]);
}
