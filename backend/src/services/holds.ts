import { PoolConnection } from 'mysql2/promise';
import { pool } from '../db/connection';
import { rows, firstRow, firstValue, change, insert } from '../db/query';
import { notify } from '../db/notifications';
import { messages } from '../utils/notificationMessages';
import { miniStatusFrom, MiniStatus } from '../utils/miniStatus';

// The hold line: up to MAX_HOLDS people waiting, in order, for a mini that
// isn't available. Nobody in line negotiates while the mini is out; once it's
// confirmed back, promoteNextHold() turns the first hold into a request.
//
// Every change to a mini's line runs in a transaction that locks that mini's
// row first, so simultaneous holds, leaves and promotions for the same mini
// happen one at a time (the 3-hold limit can't be overshot, and the mini can't
// be given to two people).

export const MAX_HOLDS = 3;

export type HoldFailure = { ok: false; status: 400 | 404 | 409; error: string; code?: 'available' | 'full' };

interface LockedMini {
  id: number;
  name: string;
  owner_id: number;
  collection_id: number;
  on_quest_since: Date | null;
  active_loan_status: string | null;
  active_borrower_id: number | null;
  condition_flag: string | null;
}

interface LineEntry {
  hold_id: number;
  user_id: number;
}

const NOT_FOUND: HoldFailure = { ok: false, status: 404, error: 'Mini not found' };

async function inTransaction<T>(work: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function lockMini(conn: PoolConnection, miniId: number, collectionId: number | null): Promise<LockedMini | null> {
  return firstRow<LockedMini>(
    `SELECT m.id, m.name, m.owner_id, m.collection_id, m.on_quest_since, m.condition_flag,
            (SELECT l.status FROM loans l WHERE l.mini_id = m.id AND l.status IN ('negotiating', 'adventuring') LIMIT 1) AS active_loan_status,
            (SELECT l.borrower_id FROM loans l WHERE l.mini_id = m.id AND l.status IN ('negotiating', 'adventuring') LIMIT 1) AS active_borrower_id
     FROM minis m
     WHERE m.id = ? ${collectionId === null ? '' : 'AND m.collection_id = ?'}
     FOR UPDATE`,
    collectionId === null ? [miniId] : [miniId, collectionId],
    conn
  );
}

async function lockLine(conn: PoolConnection, miniId: number): Promise<LineEntry[]> {
  return rows<LineEntry>(
    'SELECT id AS hold_id, user_id FROM holds WHERE mini_id = ? ORDER BY id FOR UPDATE',
    [miniId],
    conn
  );
}

async function currentLine(miniId: number): Promise<number[]> {
  const line = await rows<{ user_id: number }>('SELECT user_id FROM holds WHERE mini_id = ? ORDER BY id', [miniId]);
  return line.map(entry => entry.user_id);
}

async function displayName(userId: number): Promise<string> {
  return (await firstValue<string>('SELECT display_name FROM users WHERE id = ?', [userId])) ?? 'Someone';
}

async function watcherIds(miniId: number): Promise<number[]> {
  const watchers = await rows<{ user_id: number }>('SELECT user_id FROM hold_watchers WHERE mini_id = ?', [miniId]);
  return watchers.map(watcher => watcher.user_id);
}

// After people leave the line: tell everyone who moved closer their new
// position, and — if a full line just got a free spot — the notify list.
async function announceLineChanges(mini: LockedMini, before: number[]): Promise<void> {
  const after = await currentLine(mini.id);
  for (const [index, userId] of after.entries()) {
    const oldPosition = before.indexOf(userId) + 1;
    const newPosition = index + 1;
    if (newPosition < oldPosition) {
      await notify([userId], {
        collectionId: mini.collection_id, type: 'moved_up', message: messages.movedUp(mini.name, newPosition), miniId: mini.id,
      });
    }
  }
  if (before.length >= MAX_HOLDS && after.length < MAX_HOLDS) {
    await notify(await watcherIds(mini.id), {
      collectionId: mini.collection_id, type: 'spot_opened', message: messages.spotOpened(mini.name), miniId: mini.id,
    });
  }
}

// ---------------------------------------------------------------------------

// Either the hold was placed (and the owner needs telling), or it was refused.
type PlaceOutcome = { failure: HoldFailure } | { mini: LockedMini; position: number };

export async function placeHold(miniId: number, userId: number, collectionId: number): Promise<{ ok: true; position: number } | HoldFailure> {
  const outcome = await inTransaction<PlaceOutcome>(async conn => {
    const mini = await lockMini(conn, miniId, collectionId);
    if (!mini) return { failure: NOT_FOUND };
    if (mini.owner_id === userId) return { failure: { ok: false, status: 400, error: 'That\'s your own mini' } };

    const status = miniStatusFrom(mini.active_loan_status, mini.on_quest_since, mini.condition_flag);
    if (status === 'lost' || status === 'critically_wounded') {
      return { failure: { ok: false, status: 409, error: 'This mini isn\'t available right now' } };
    }
    if (status === 'available') {
      return { failure: { ok: false, status: 409, code: 'available', error: 'This mini is available — add it to your cart instead' } };
    }
    if (mini.active_borrower_id === userId) {
      return { failure: { ok: false, status: 409, error: 'You already have this mini requested or borrowed' } };
    }

    const line = await lockLine(conn, miniId);
    if (line.some(entry => entry.user_id === userId)) {
      return { failure: { ok: false, status: 409, error: 'You\'re already in line for this mini' } };
    }
    if (line.length >= MAX_HOLDS) {
      return { failure: { ok: false, status: 409, code: 'full', error: `The hold line is full (${MAX_HOLDS} people)` } };
    }

    await change('INSERT INTO holds (mini_id, user_id) VALUES (?, ?)', [miniId, userId], conn);
    await change('DELETE FROM hold_watchers WHERE mini_id = ? AND user_id = ?', [miniId, userId], conn);
    return { mini, position: line.length + 1 };
  });

  if ('failure' in outcome) return outcome.failure;

  const { mini, position } = outcome;
  await notify([mini.owner_id], {
    collectionId: mini.collection_id, type: 'hold_placed',
    message: messages.holdPlaced(await displayName(userId), mini.name, position), miniId: mini.id,
  });
  return { ok: true, position };
}

export async function leaveHold(miniId: number, userId: number, collectionId: number): Promise<{ ok: true } | HoldFailure> {
  const outcome = await inTransaction(async conn => {
    const mini = await lockMini(conn, miniId, collectionId);
    if (!mini) return null;
    const line = await lockLine(conn, miniId);
    const mine = line.find(entry => entry.user_id === userId);
    if (!mine) return null;
    await conn.execute('DELETE FROM holds WHERE id = ?', [mine.hold_id]);
    return { mini, before: line.map(entry => entry.user_id) };
  });

  if (!outcome) return { ok: false, status: 404, error: 'You aren\'t in line for this mini' };
  await announceLineChanges(outcome.mini, outcome.before);
  return { ok: true };
}

export async function watchMini(miniId: number, userId: number, collectionId: number): Promise<{ ok: true } | HoldFailure> {
  const mini = await firstRow<{ owner_id: number; hold_count: number; in_line: number }>(
    `SELECT m.owner_id,
            (SELECT COUNT(*) FROM holds h WHERE h.mini_id = m.id) AS hold_count,
            EXISTS (SELECT 1 FROM holds h WHERE h.mini_id = m.id AND h.user_id = ?) AS in_line
     FROM minis m WHERE m.id = ? AND m.collection_id = ?`,
    [userId, miniId, collectionId]
  );
  if (!mini) return NOT_FOUND;
  if (mini.owner_id === userId) return { ok: false, status: 400, error: 'That\'s your own mini' };
  if (Number(mini.in_line)) return { ok: false, status: 409, error: 'You\'re already in line for this mini' };
  if (Number(mini.hold_count) < MAX_HOLDS) {
    return { ok: false, status: 409, error: 'There\'s a spot open — place a hold instead' };
  }
  await change('INSERT IGNORE INTO hold_watchers (mini_id, user_id) VALUES (?, ?)', [miniId, userId]);
  return { ok: true };
}

export async function unwatchMini(miniId: number, userId: number, collectionId: number): Promise<{ ok: true } | HoldFailure> {
  const removed = await change(
    `DELETE hw FROM hold_watchers hw JOIN minis m ON m.id = hw.mini_id
     WHERE hw.mini_id = ? AND hw.user_id = ? AND m.collection_id = ?`,
    [miniId, userId, collectionId]
  );
  if (removed === 0) return { ok: false, status: 404, error: 'You aren\'t on the notify list for this mini' };
  return { ok: true };
}

export interface HoldSummary {
  max: number;
  count: number;
  position: number | null;
  watching: boolean;
  queue?: { position: number; displayName: string }[];
}

// Everyone sees the count; you see your own position; only the owner sees names.
export async function holdSummary(miniId: number, userId: number, collectionId: number): Promise<HoldSummary | null> {
  const mini = await firstRow<{ owner_id: number; watching: number }>(
    `SELECT m.owner_id, EXISTS (SELECT 1 FROM hold_watchers hw WHERE hw.mini_id = m.id AND hw.user_id = ?) AS watching
     FROM minis m WHERE m.id = ? AND m.collection_id = ?`,
    [userId, miniId, collectionId]
  );
  if (!mini) return null;

  const line = await rows<{ user_id: number; display_name: string }>(
    'SELECT h.user_id, u.display_name FROM holds h JOIN users u ON u.id = h.user_id WHERE h.mini_id = ? ORDER BY h.id',
    [miniId]
  );
  const index = line.findIndex(entry => entry.user_id === userId);
  const summary: HoldSummary = {
    max: MAX_HOLDS,
    count: line.length,
    position: index === -1 ? null : index + 1,
    watching: Boolean(Number(mini.watching)),
  };
  if (mini.owner_id === userId) {
    summary.queue = line.map((entry, i) => ({ position: i + 1, displayName: entry.display_name }));
  }
  return summary;
}

export interface MyHold {
  miniId: number;
  miniName: string;
  miniImage: string | null;
  ownerName: string;
  position: number;
  status: MiniStatus;
}

export interface MyWatch {
  miniId: number;
  miniName: string;
  holdCount: number;
}

interface MyHoldRow {
  mini_id: number;
  mini_name: string;
  mini_image: string | null;
  owner_name: string;
  position: number;
  active_loan_status: string | null;
  on_quest_since: Date | null;
}

export async function listMyHolds(userId: number, collectionId: number): Promise<{ holds: MyHold[]; watching: MyWatch[] }> {
  const holds = await rows<MyHoldRow>(
    `SELECT m.id AS mini_id, m.name AS mini_name, o.display_name AS owner_name, m.on_quest_since,
            (SELECT mi.image_path FROM mini_images mi WHERE mi.mini_id = m.id ORDER BY mi.position LIMIT 1) AS mini_image,
            (SELECT COUNT(*) FROM holds h2 WHERE h2.mini_id = h.mini_id AND h2.id <= h.id) AS position,
            (SELECT l.status FROM loans l WHERE l.mini_id = m.id AND l.status IN ('negotiating', 'adventuring') LIMIT 1) AS active_loan_status
     FROM holds h
     JOIN minis m ON m.id = h.mini_id
     JOIN users o ON o.id = m.owner_id
     WHERE h.user_id = ? AND m.collection_id = ?
     ORDER BY h.id`,
    [userId, collectionId]
  );
  const watching = await rows<{ mini_id: number; mini_name: string; hold_count: number }>(
    `SELECT m.id AS mini_id, m.name AS mini_name, (SELECT COUNT(*) FROM holds h WHERE h.mini_id = m.id) AS hold_count
     FROM hold_watchers hw JOIN minis m ON m.id = hw.mini_id
     WHERE hw.user_id = ? AND m.collection_id = ?
     ORDER BY hw.id`,
    [userId, collectionId]
  );
  return {
    holds: holds.map(hold => ({
      miniId: hold.mini_id,
      miniName: hold.mini_name,
      miniImage: hold.mini_image,
      ownerName: hold.owner_name,
      position: Number(hold.position),
      status: miniStatusFrom(hold.active_loan_status, hold.on_quest_since),
    })),
    watching: watching.map(watch => ({ miniId: watch.mini_id, miniName: watch.mini_name, holdCount: Number(watch.hold_count) })),
  };
}

// Call whenever a mini may have just become available (returned, request
// cancelled, back from a quest). If it's really free, the first person in
// line who is still in the group gets it as a request. Returns the new loan
// id, or null if nothing changed. Never throws: a failure is logged, and the
// hourly housekeeping retries (promoteStrandedHolds).
// Either nothing to do, or the line as it was plus whoever got the mini.
type PromotionOutcome = {
  mini: LockedMini;
  before: number[];
  promoted: { userId: number; loanId: number } | null;
} | null;

export async function promoteNextHold(miniId: number): Promise<number | null> {
  try {
    const outcome = await inTransaction<PromotionOutcome>(async conn => {
      const mini = await lockMini(conn, miniId, null);
      if (!mini || mini.active_loan_status || mini.on_quest_since || mini.condition_flag) return null;

      const line = await lockLine(conn, miniId);
      if (line.length === 0) return null;

      for (const entry of line) {
        // One statement that only succeeds if the mini is still free and the
        // person is still a member of its group.
        const request = await insert(
          `INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status)
           SELECT m.id, m.collection_id, ?, m.owner_id, 'negotiating'
           FROM minis m
           JOIN collection_memberships cm ON cm.user_id = ? AND cm.collection_id = m.collection_id
           WHERE m.id = ? AND m.on_quest_since IS NULL
             AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.mini_id = m.id AND l.status IN ('negotiating', 'adventuring'))`,
          [entry.user_id, entry.user_id, miniId],
          conn
        );
        await change('DELETE FROM holds WHERE id = ?', [entry.hold_id], conn);
        if (request.inserted) {
          await change('DELETE FROM cart_items WHERE user_id = ? AND mini_id = ?', [entry.user_id, miniId], conn);
          return { mini, before: line.map(e => e.user_id), promoted: { userId: entry.user_id, loanId: request.id } };
        }
        // No longer in the group: their hold is dropped and the next person is tried.
      }
      return { mini, before: line.map(e => e.user_id), promoted: null };
    });

    if (!outcome) return null;
    const { mini, before, promoted } = outcome;

    if (promoted) {
      await notify([promoted.userId], {
        collectionId: mini.collection_id, type: 'your_turn', message: messages.yourTurn(mini.name), miniId: mini.id, loanId: promoted.loanId,
      });
      await notify([mini.owner_id], {
        collectionId: mini.collection_id, type: 'hold_became_request',
        message: messages.holdBecameRequest(await displayName(promoted.userId), mini.name), miniId: mini.id, loanId: promoted.loanId,
      });
    }
    await announceLineChanges(mini, before);
    return promoted?.loanId ?? null;
  } catch (err: unknown) {
    console.error('Promoting the next hold failed:', err);
    return null;
  }
}

// When someone is removed from a group, their holds on that group's minis go,
// and the people behind them move up.
export async function dropHoldsInCollection(userId: number, collectionId: number): Promise<void> {
  const theirs = await rows<{ mini_id: number }>(
    'SELECT h.mini_id FROM holds h JOIN minis m ON m.id = h.mini_id WHERE h.user_id = ? AND m.collection_id = ?',
    [userId, collectionId]
  );
  for (const hold of theirs) {
    await leaveHold(hold.mini_id, userId, collectionId);
  }
  await change(
    'DELETE hw FROM hold_watchers hw JOIN minis m ON m.id = hw.mini_id WHERE hw.user_id = ? AND m.collection_id = ?',
    [userId, collectionId]
  );
}

// Before a mini is deleted: let everyone waiting for it know.
export async function announceMiniRemoved(miniId: number): Promise<void> {
  const mini = await firstRow<{ name: string; collection_id: number }>(
    'SELECT name, collection_id FROM minis WHERE id = ?',
    [miniId]
  );
  if (!mini) return;
  const waiting = [...await currentLine(miniId), ...await watcherIds(miniId)];
  await notify(waiting, {
    collectionId: mini.collection_id, type: 'mini_removed', message: messages.miniRemoved(mini.name), miniId,
  });
}

// Housekeeping safety net: any mini that's free but still has people in line
// (e.g. a promotion that failed mid-way) gets promoted now.
export async function promoteStrandedHolds(): Promise<number> {
  const stranded = await rows<{ mini_id: number }>(
    `SELECT DISTINCT h.mini_id FROM holds h JOIN minis m ON m.id = h.mini_id
     WHERE m.on_quest_since IS NULL
       AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.mini_id = m.id AND l.status IN ('negotiating', 'adventuring'))`
  );
  let promoted = 0;
  for (const mini of stranded) {
    if (await promoteNextHold(mini.mini_id)) promoted += 1;
  }
  return promoted;
}
