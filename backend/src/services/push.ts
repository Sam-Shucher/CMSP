import { sendNotification } from 'web-push';
import { pushConfig, SESSION_IDLE_DAYS } from '../config';
import { rows, firstValue, change } from '../db/query';
import { NotificationType } from '../utils/notificationMessages';
import { MAX_PUSH_DEVICES, PushNotice, PushSubscriptionInput, pushNotice } from '../utils/pushSubscription';

// Web Push: notices on a phone's lock screen, so a loan request reaches the
// owner without them opening the site. The bell (db/notifications.ts) stays
// the record; a push is only a nudge that something is in it. Only the push
// service in between (Google, Apple, Mozilla, Microsoft) handles the message,
// and it's encrypted end to end for the device — they see that a push
// happened, not what it says.

// How long a push service keeps trying a phone that's switched off. A day old
// "Alex wants to borrow Owlbear" is still worth seeing; a week old isn't.
const PUSH_TTL_SECONDS = 24 * 60 * 60;
const SEND_TIMEOUT_MS = 10_000;

// null when push isn't set up on this server (see config.ts).
export function pushPublicKey(): string | null {
  const config = pushConfig();
  return config.enabled ? config.publicKey : null;
}

// Upserts by endpoint: the same device signing in as someone else becomes
// theirs. Past MAX_PUSH_DEVICES the person's oldest devices are dropped.
// sessionId is the sign-in doing this: the device gets notices only while that
// session is live (sendToUsers), so one that expires or goes idle — a shared
// computer left signed in, a phone not opened for days — goes quiet with it,
// and the row itself goes when the session is purged. The app re-sends its
// subscription on every sign-in (frontend resyncPush), which moves the row to
// the new session.
export async function saveSubscription(userId: number, sessionId: string, sub: PushSubscriptionInput): Promise<void> {
  await change(
    `INSERT INTO push_subscriptions (user_id, session_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), session_id = VALUES(session_id),
                             p256dh = VALUES(p256dh), auth = VALUES(auth)`,
    [userId, sessionId, sub.endpoint, sub.p256dh, sub.auth]
  );
  const devices = await rows<{ id: number }>(
    'SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC',
    [userId]
  );
  const extra = devices.slice(MAX_PUSH_DEVICES).map(d => d.id);
  if (extra.length > 0) {
    await change(`DELETE FROM push_subscriptions WHERE id IN (${extra.map(() => '?').join(', ')})`, extra);
  }
}

// Only ever your own: an endpoint belonging to someone else is left alone.
export async function removeSubscription(userId: number, endpoint: string): Promise<void> {
  await change('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [userId, endpoint]);
}

interface SubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

// Sends to every device these people have. Returns how many took it. Never
// throws: a push that fails must never fail (or undo) what triggered it.
async function sendToUsers(userIds: number[], notice: PushNotice): Promise<number> {
  const config = pushConfig();
  if (!config.enabled || userIds.length === 0) return 0;

  // Only devices whose sign-in is still live — the same test requireAuth
  // applies (db/sessions.ts's touchSession). A device with no session at all
  // (signed up before sessions were recorded here) waits for its next sign-in.
  const devices = await rows<SubscriptionRow>(
    `SELECT p.id, p.endpoint, p.p256dh, p.auth
     FROM push_subscriptions p
     JOIN sessions s ON s.id = p.session_id AND s.user_id = p.user_id
     WHERE p.user_id IN (${userIds.map(() => '?').join(', ')})
       AND s.revoked_at IS NULL
       AND s.expires_at > NOW()
       AND s.last_seen_at > NOW() - INTERVAL ? DAY`,
    [...userIds, SESSION_IDLE_DAYS]
  );
  const { topic, ...payload } = notice;
  const results = await Promise.all(devices.map(async (device) => {
    try {
      await sendNotification(
        { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
          TTL: PUSH_TTL_SECONDS,
          timeout: SEND_TIMEOUT_MS,
          ...(topic ? { topic } : {}),
        }
      );
      return true;
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // The device unsubscribed, or the app was uninstalled — stop trying.
        await change('DELETE FROM push_subscriptions WHERE id = ?', [device.id]).catch(() => 0);
      } else {
        console.error(`Push to ${new URL(device.endpoint).hostname} failed (${status ?? 'no response'})`);
      }
      return false;
    }
  }));
  return results.filter(Boolean).length;
}

// Called by db/notifications.ts's notify() for every notice the bell gets.
export async function pushToUsers(
  userIds: number[],
  input: { collectionId: number; type: NotificationType; message: string; loanId?: number | null }
): Promise<number> {
  try {
    if (!pushConfig().enabled || userIds.length === 0) return 0;
    const groupName = await firstValue<string>('SELECT name FROM collections WHERE id = ?', [input.collectionId]);
    return await sendToUsers(userIds, pushNotice(input, groupName));
  } catch (err: unknown) {
    console.error('Push failed:', err);
    return 0;
  }
}

// "Send a test" on the Profile page — every device of yours that's signed up.
export async function pushTest(userId: number): Promise<number> {
  try {
    return await sendToUsers([userId], {
      title: 'Mini Library',
      body: 'Notifications are working on this device.',
      url: '/profile',
    });
  } catch (err: unknown) {
    console.error('Test push failed:', err);
    return 0;
  }
}
