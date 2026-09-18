import crypto from 'crypto';
import { firstRow, change } from './query';
import { SESSION_IDLE_DAYS, SESSION_LIFETIME_DAYS } from '../config';

// Server-side login sessions. The cookie is signed, but a signature alone
// can't be taken back — so every request also checks that its session row is
// still live. All times use the database clock (NOW()) so the app server's
// clock can't disagree with it.

// Activity is recorded at most this often, not on every request.
const TOUCH_EVERY_MINUTES = 5;

export async function createSession(userId: number): Promise<string> {
  const id = crypto.randomBytes(32).toString('hex');
  await change(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL ? DAY)',
    [id, userId, SESSION_LIFETIME_DAYS]
  );
  return id;
}

// True if the session is live for this user — and extends its idle window.
export async function touchSession(sessionId: string, userId: number): Promise<boolean> {
  const session = await firstRow<{ needs_touch: number }>(
    `SELECT last_seen_at < NOW() - INTERVAL ${TOUCH_EVERY_MINUTES} MINUTE AS needs_touch
     FROM sessions
     WHERE id = ? AND user_id = ?
       AND revoked_at IS NULL
       AND expires_at > NOW()
       AND last_seen_at > NOW() - INTERVAL ? DAY`,
    [sessionId, userId, SESSION_IDLE_DAYS]
  );
  if (!session) return false;

  if (Number(session.needs_touch) === 1) {
    await change('UPDATE sessions SET last_seen_at = NOW() WHERE id = ?', [sessionId]);
  }
  return true;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await change('UPDATE sessions SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL', [sessionId]);
}

export async function revokeAllSessions(userId: number): Promise<void> {
  await change('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [userId]);
}

// Everywhere but here: used when someone changes their own password, so any
// other device — including whoever might have prompted the change — is signed
// out, while the person doing it stays where they are.
export async function revokeOtherSessions(userId: number, keepSessionId: string): Promise<void> {
  await change(
    'UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND id <> ? AND revoked_at IS NULL',
    [userId, keepSessionId]
  );
}

// Housekeeping: delete sessions that ended (logged out, expired, or went idle)
// more than a day ago. Returns how many were removed.
export function purgeEndedSessions(): Promise<number> {
  return change(
    `DELETE FROM sessions
     WHERE revoked_at < NOW() - INTERVAL 1 DAY
        OR expires_at < NOW() - INTERVAL 1 DAY
        OR last_seen_at < NOW() - INTERVAL (? + 1) DAY`,
    [SESSION_IDLE_DAYS]
  );
}
