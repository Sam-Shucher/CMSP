import { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { pool } from '../db/connection';
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
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT m.id, m.name, m.owner_id, m.collection_id, m.on_quest_since,
            (SELECT l.status FROM loans l WHERE l.mini_id = m.id AND l.status IN ('negotiating', 'adventuring') LIMIT 1) AS active_loan_status,
            (SELECT l.borrower_id FROM loans l WHERE l.mini_id = m.id AND l.status IN ('negotiating', 'adventuring') LIMIT 1) AS active_borrower_id
     FROM minis m
     WHERE m.id = ? ${collectionId === null ? '' : 'AND m.collection_id = ?'}
     FOR UPDATE`,
    collectionId === null ? [miniId] : [miniId, collectionId]
  );
  return (rows[0] as LockedMini | undefined) ?? null;
}

async function lockLine(conn: PoolConnection, miniId: number): Promise<LineEntry[]> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    'SELECT id AS hold_id, user_id FROM holds WHERE mini_id = ? ORDER BY id FOR UPDATE',
    [miniId]
  );
  return rows as LineEntry[];
}

async function currentLine(miniId: number): Promise<number[]> {
  const [rows] = await pool.execute<RowDataPacket[]>('SELECT user_id FROM holds WHERE mini_id = ? ORDER BY id', [miniId]);
  return rows.map(r => r.user_id as number);
}

async function displayName(userId: number): Promise<string> {
  const [rows] = await pool.execute<RowDataPacket[]>('SELECT display_name FROM users WHERE id = ?', [userId]);
  return (rows[0]?.display_name as string | undefined) ?? 'Someone';
}

async function watcherIds(miniId: number): Promise<number[]> {
  const [rows] = await pool.execute<RowDataPacket[]>('SELECT user_id FROM hold_watchers WHERE mini_id = ?', [miniId]);
  return rows.map(r => r.user_id as number);
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

export async function placeHold(miniId: number, userId: number, collectionId: number): Promise<{ ok: true; position: number } | HoldFailure> {
  const outcome = await inTransaction(async conn => {
    const mini = await lockMini(conn, miniId, collectionId);
    if (!mini) return { failure: NOT_FOUND };
    if (mini.owner_id === userId) return { failure: { ok: false, status: 400, error: 'That\'s your own mini' } as HoldFailure };

    const status = miniStatusFrom(mini.active_loan_status, mini.on_quest_since);
    if (status === 'available') {
      return { failure: { ok: false, status: 409, code: 'available', error: 'This mini is available — add it to your cart instead' } as HoldFailure };
    }
    if (mini.active_borrower_id === userId) {
      return { failure: { ok: false, status: 409, error: 'You already have this mini requested or borrowed' } as HoldFailure };
    }

    const line = await lockLine(conn, miniId);
    if (line.some(entry => entry.user_id === userId)) {
      return { failure: { ok: false, status: 409, error: 'You\'re already in line for this mini' } as HoldFailure };
    }
    if (line.length >= MAX_HOLDS) {
      return { failure: { ok: false, status: 409, code: 'full', error: `The hold line is full (${MAX_HOLDS} people)` } as HoldFailure };
    }

    await conn.execute('INSERT INTO holds (mini_id, user_id) VALUES (?, ?)', [miniId, userId]);
    await conn.execute('DELETE FROM hold_watchers WHERE mini_id = ? AND user_id = ?', [miniId, userId]);
    return { mini, position: line.length + 1 };
  });

  if ('failure' in outcome) return outcome.failure as HoldFailure;

  const { mini, position } = outcome as { mini: LockedMini; position: number };
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
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT m.owner_id,
            (SELECT COUNT(*) FROM holds h WHERE h.mini_id = m.id) AS hold_count,
            EXISTS (SELECT 1 FROM holds h WHERE h.mini_id = m.id AND h.user_id = ?) AS in_line
     FROM minis m WHERE m.id = ? AND m.collection_id = ?`,
    [userId, miniId, collectionId]
  );
  if (rows.length === 0) return NOT_FOUND;
  if (rows[0].owner_id === userId) return { ok: false, status: 400, error: 'That\'s your own mini' };
  if (Number(rows[0].in_line)) return { ok: false, status: 409, error: 'You\'re already in line for this mini' };
  if (Number(rows[0].hold_count) < MAX_HOLDS) {
    return { ok: false, status: 409, error: 'There\'s a spot open — place a hold instead' };
  }
  await pool.execute('INSERT IGNORE INTO hold_watchers (mini_id, user_id) VALUES (?, ?)', [miniId, userId]);
  return { ok: true };
}

export async function unwatchMini(miniId: number, userId: number, collectionId: number): Promise<{ ok: true } | HoldFailure> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE hw FROM hold_watchers hw JOIN minis m ON m.id = hw.mini_id
     WHERE hw.mini_id = ? AND hw.user_id = ? AND m.collection_id = ?`,
    [miniId, userId, collectionId]
  );
  if (result.affectedRows === 0) return { ok: false, status: 404, error: 'You aren\'t on the notify list for this mini' };
  return { ok: true };
}

export interface HoldSummary {
  max: number;
  count: number;
  position: number | null;
  watching: boolean;
  queue?: Array<{ position: number; displayName: string }>;
}

// Everyone sees the count; you see your own position; only the owner sees names.
export async function holdSummary(miniId: number, userId: number, collectionId: number): Promise<HoldSummary | null> {
  const [minis] = await pool.execute<RowDataPacket[]>(
    `SELECT m.owner_id, EXISTS (SELECT 1 FROM hold_watchers hw WHERE hw.mini_id = m.id AND hw.user_id = ?) AS watching
     FROM minis m WHERE m.id = ? AND m.collection_id = ?`,
    [userId, miniId, collectionId]
  );
  if (minis.length === 0) return null;

  const [line] = await pool.execute<RowDataPacket[]>(
    'SELECT h.user_id, u.display_name FROM holds h JOIN users u ON u.id = h.user_id WHERE h.mini_id = ? ORDER BY h.id',
    [miniId]
  );
  const index = line.findIndex(r => r.user_id === userId);
  const summary: HoldSummary = {
    max: MAX_HOLDS,
    count: line.length,
    position: index === -1 ? null : index + 1,
    watching: Boolean(Number(minis[0].watching)),
  };
  if (minis[0].owner_id === userId) {
    summary.queue = line.map((r, i) => ({ position: i + 1, displayName: r.display_name as string }));
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

export async function listMyHolds(userId: number, collectionId: number): Promise<{ holds: MyHold[]; watching: MyWatch[] }> {
  const [holds] = await pool.execute<RowDataPacket[]>(
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
  const [watching] = await pool.execute<RowDataPacket[]>(
    `SELECT m.id AS mini_id, m.name AS mini_name, (SELECT COUNT(*) FROM holds h WHERE h.mini_id = m.id) AS hold_count
     FROM hold_watchers hw JOIN minis m ON m.id = hw.mini_id
     WHERE hw.user_id = ? AND m.collection_id = ?
     ORDER BY hw.id`,
    [userId, collectionId]
  );
  return {
    holds: holds.map(r => ({
      miniId: r.mini_id,
      miniName: r.mini_name,
      miniImage: r.mini_image,
      ownerName: r.owner_name,
      position: Number(r.position),
      status: miniStatusFrom(r.active_loan_status, r.on_quest_since),
    })),
    watching: watching.map(r => ({ miniId: r.mini_id, miniName: r.mini_name, holdCount: Number(r.hold_count) })),
  };
}

// Call whenever a mini may have just become available (returned, request
// cancelled, back from a quest). If it's really free, the first person in
// line who is still in the group gets it as a request. Returns the new loan
// id, or null if nothing changed. Never throws: a failure is logged, and the
// hourly housekeeping retries (promoteStrandedHolds).
export async function promoteNextHold(miniId: number): Promise<number | null> {
  try {
    const outcome = await inTransaction(async conn => {
      const mini = await lockMini(conn, miniId, null);
      if (!mini || mini.active_loan_status || mini.on_quest_since) return null;

      const line = await lockLine(conn, miniId);
      if (line.length === 0) return null;

      for (const entry of line) {
        // One statement that only succeeds if the mini is still free and the
        // person is still a member of its group.
        const [result] = await conn.execute<ResultSetHeader>(
          `INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status)
           SELECT m.id, m.collection_id, ?, m.owner_id, 'negotiating'
           FROM minis m
           JOIN collection_memberships cm ON cm.user_id = ? AND cm.collection_id = m.collection_id
           WHERE m.id = ? AND m.on_quest_since IS NULL
             AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.mini_id = m.id AND l.status IN ('negotiating', 'adventuring'))`,
          [entry.user_id, entry.user_id, miniId]
        );
        await conn.execute('DELETE FROM holds WHERE id = ?', [entry.hold_id]);
        if (result.affectedRows === 1) {
          await conn.execute('DELETE FROM cart_items WHERE user_id = ? AND mini_id = ?', [entry.user_id, miniId]);
          return { mini, before: line.map(e => e.user_id), holderId: entry.user_id, loanId: result.insertId };
        }
        // No longer in the group: their hold is dropped and the next person is tried.
      }
      return { mini, before: line.map(e => e.user_id), holderId: null, loanId: null };
    });

    if (!outcome) return null;
    const { mini, before, holderId, loanId } = outcome;

    if (holderId !== null && loanId !== null) {
      await notify([holderId], {
        collectionId: mini.collection_id, type: 'your_turn', message: messages.yourTurn(mini.name), miniId: mini.id, loanId,
      });
      await notify([mini.owner_id], {
        collectionId: mini.collection_id, type: 'hold_became_request',
        message: messages.holdBecameRequest(await displayName(holderId), mini.name), miniId: mini.id, loanId,
      });
    }
    await announceLineChanges(mini, before);
    return loanId;
  } catch (err: unknown) {
    console.error('Promoting the next hold failed:', err);
    return null;
  }
}

// When someone is removed from a group, their holds on that group's minis go,
// and the people behind them move up.
export async function dropHoldsInCollection(userId: number, collectionId: number): Promise<void> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT h.mini_id FROM holds h JOIN minis m ON m.id = h.mini_id WHERE h.user_id = ? AND m.collection_id = ?',
    [userId, collectionId]
  );
  for (const row of rows) {
    await leaveHold(row.mini_id as number, userId, collectionId);
  }
  await pool.execute(
    'DELETE hw FROM hold_watchers hw JOIN minis m ON m.id = hw.mini_id WHERE hw.user_id = ? AND m.collection_id = ?',
    [userId, collectionId]
  );
}

// Before a mini is deleted: let everyone waiting for it know.
export async function announceMiniRemoved(miniId: number): Promise<void> {
  const [minis] = await pool.execute<RowDataPacket[]>('SELECT name, collection_id FROM minis WHERE id = ?', [miniId]);
  if (minis.length === 0) return;
  const waiting = [...await currentLine(miniId), ...await watcherIds(miniId)];
  await notify(waiting, {
    collectionId: minis[0].collection_id, type: 'mini_removed', message: messages.miniRemoved(minis[0].name), miniId,
  });
}

// Housekeeping safety net: any mini that's free but still has people in line
// (e.g. a promotion that failed mid-way) gets promoted now.
export async function promoteStrandedHolds(): Promise<number> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT DISTINCT h.mini_id FROM holds h JOIN minis m ON m.id = h.mini_id
     WHERE m.on_quest_since IS NULL
       AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.mini_id = m.id AND l.status IN ('negotiating', 'adventuring'))`
  );
  let promoted = 0;
  for (const row of rows) {
    if (await promoteNextHold(row.mini_id as number)) promoted += 1;
  }
  return promoted;
}
