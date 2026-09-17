import crypto from 'crypto';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from './connection';
import { SESSION_IDLE_DAYS, SESSION_LIFETIME_DAYS } from '../config';

// Server-side login sessions. The cookie is signed, but a signature alone
// can't be taken back — so every request also checks that its session row is
// still live. All times use the database clock (NOW()) so the app server's
// clock can't disagree with it.

// Activity is recorded at most this often, not on every request.
const TOUCH_EVERY_MINUTES = 5;

export async function createSession(userId: number): Promise<string> {
  const id = crypto.randomBytes(32).toString('hex');
  await pool.execute<ResultSetHeader>(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL ? DAY)',
    [id, userId, SESSION_LIFETIME_DAYS]
  );
  return id;
}

// True if the session is live for this user — and extends its idle window.
export async function touchSession(sessionId: string, userId: number): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT last_seen_at < NOW() - INTERVAL ${TOUCH_EVERY_MINUTES} MINUTE AS needs_touch
     FROM sessions
     WHERE id = ? AND user_id = ?
       AND revoked_at IS NULL
       AND expires_at > NOW()
       AND last_seen_at > NOW() - INTERVAL ? DAY`,
    [sessionId, userId, SESSION_IDLE_DAYS]
  );
  if (rows.length === 0) return false;

  if (Number(rows[0].needs_touch) === 1) {
    await pool.execute<ResultSetHeader>('UPDATE sessions SET last_seen_at = NOW() WHERE id = ?', [sessionId]);
  }
  return true;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await pool.execute<ResultSetHeader>('UPDATE sessions SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL', [sessionId]);
}

export async function revokeAllSessions(userId: number): Promise<void> {
  await pool.execute<ResultSetHeader>('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [userId]);
}

// Housekeeping: delete sessions that ended (logged out, expired, or went idle)
// more than a day ago. Returns how many were removed.
export async function purgeEndedSessions(): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM sessions
     WHERE revoked_at < NOW() - INTERVAL 1 DAY
        OR expires_at < NOW() - INTERVAL 1 DAY
        OR last_seen_at < NOW() - INTERVAL (? + 1) DAY`,
    [SESSION_IDLE_DAYS]
  );
  return result.affectedRows;
}
