import crypto from 'crypto';
import { firstRow, change } from './query';
import { SESSION_IDLE_DAYS, SESSION_LIFETIME_DAYS } from '../config';
import { GroupAccess, GroupAccessRow, groupAccessFrom } from '../utils/groupAccess';

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

// What a live session tells requireAuth beyond "yes, it's live".
export interface LiveSession {
  // Signed in with a temporary password an admin set, not yet replaced — the
  // API refuses almost everything until it is (middleware/requireAuth.ts).
  mustChangePassword: boolean;
  // Their place in the group the cookie names, when it names one: null if
  // they aren't a member there (any more). requireCollectionMembership uses
  // this rather than asking the database a second time.
  membership?: GroupAccess | null;
}

interface SessionRow extends GroupAccessRow {
  needs_touch: number;
  must_change_password: number;
  member_of: number | null; // the group's id when they're in it, else null
}

// The session, if it's live for this user — and extends its idle window.
// Null when it isn't (logged out, expired, idle, or not theirs).
//
// Also reads their membership of `collectionId` in the same query: every
// collection-scoped request needs both, and it was two round trips per API
// call. A LEFT JOIN, so a live session with no membership there still counts
// as signed in — the missing membership is requireCollectionMembership's
// call to refuse, not this one's.
export async function touchSession(sessionId: string, userId: number, collectionId?: number): Promise<LiveSession | null> {
  const session = await firstRow<SessionRow>(
    `SELECT s.last_seen_at < NOW() - INTERVAL ${TOUCH_EVERY_MINUTES} MINUTE AS needs_touch,
            u.must_change_password,
            cm.collection_id AS member_of, cm.role, c.show_prices
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN collection_memberships cm ON cm.user_id = s.user_id AND cm.collection_id = ?
     LEFT JOIN collections c ON c.id = cm.collection_id
     WHERE s.id = ? AND s.user_id = ?
       AND s.revoked_at IS NULL
       AND s.expires_at > NOW()
       AND s.last_seen_at > NOW() - INTERVAL ? DAY`,
    [collectionId ?? null, sessionId, userId, SESSION_IDLE_DAYS]
  );
  if (!session) return null;

  if (Number(session.needs_touch) === 1) {
    await change('UPDATE sessions SET last_seen_at = NOW() WHERE id = ?', [sessionId]);
  }
  const live: LiveSession = { mustChangePassword: Number(session.must_change_password) === 1 };
  if (collectionId !== undefined) {
    live.membership = session.member_of === null ? null : groupAccessFrom(session);
  }
  return live;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await change('UPDATE sessions SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL', [sessionId]);
}

// Also stops their phone notifications (services/push.ts): "sign out
// everywhere" after a lost phone or a shared computer has to mean that device
// stops showing their loan chatter too. Their own devices sign back up the
// next time they sign in there (frontend/src/push.ts's resyncPush).
export async function revokeAllSessions(userId: number): Promise<void> {
  await change('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [userId]);
  await forgetPushDevices(userId);
}

async function forgetPushDevices(userId: number): Promise<void> {
  await change('DELETE FROM push_subscriptions WHERE user_id = ?', [userId]);
}

// Everywhere but here: used when someone changes their own password, so any
// other device — including whoever might have prompted the change — is signed
// out, while the person doing it stays where they are.
export async function revokeOtherSessions(userId: number, keepSessionId: string): Promise<void> {
  await change(
    'UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND id <> ? AND revoked_at IS NULL',
    [userId, keepSessionId]
  );
  // Which device is "here" isn't known on this side, so all of them go; the
  // one doing this signs straight back up (frontend/src/push.ts's resyncPush).
  await forgetPushDevices(userId);
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
