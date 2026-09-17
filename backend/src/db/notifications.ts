import { NotificationType, fitMessage } from '../utils/notificationMessages';
import { NOTIFICATION_KEEP_READ_DAYS } from '../config';
import { rows, firstValue, change } from './query';

// The in-app bell. Notifications belong to a user within one collection, so
// switching groups shows that group's notifications only.

export interface NotifyInput {
  collectionId: number;
  type: NotificationType;
  message: string;
  miniId?: number | null;
  loanId?: number | null;
}

export async function notify(userIds: number[], input: NotifyInput): Promise<void> {
  const recipients = [...new Set(userIds)];
  if (recipients.length === 0) return;

  const placeholders = recipients.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
  const params = recipients.flatMap(userId => [
    userId, input.collectionId, input.type, fitMessage(input.message), input.miniId ?? null, input.loanId ?? null,
  ]);
  await change(
    `INSERT INTO notifications (user_id, collection_id, type, message, mini_id, loan_id) VALUES ${placeholders}`,
    params
  );
}

export interface NotificationItem {
  id: number;
  type: string;
  message: string;
  miniId: number | null;
  loanId: number | null;
  read: boolean;
  expiresAt: string | null; // when a read one disappears; null while unread
  createdAt: string;
}

// One row of the inbox query below.
interface NotificationRow {
  id: number;
  type: NotificationType;
  message: string;
  mini_id: number | null;
  loan_id: number | null;
  read_at: Date | null;
  age_seconds: number;
  expires_in_seconds: number | null;
}

const LIST_LIMIT = 50;

// Read ones past their two days are left out here as well as swept hourly, so
// the list always matches the countdown people were shown.
const NOT_EXPIRED = `(read_at IS NULL OR read_at > NOW() - INTERVAL ${NOTIFICATION_KEEP_READ_DAYS} DAY)`;

export async function listNotifications(userId: number, collectionId: number): Promise<{ unread: number; items: NotificationItem[] }> {
  // Ages and countdowns are measured by the database against its own clock and
  // sent as plain seconds, so a database in another timezone can't shift them.
  const inbox = await rows<NotificationRow>(
    `SELECT id, type, message, mini_id, loan_id, read_at,
            TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_seconds,
            TIMESTAMPDIFF(SECOND, NOW(), read_at + INTERVAL ${NOTIFICATION_KEEP_READ_DAYS} DAY) AS expires_in_seconds
     FROM notifications
     WHERE user_id = ? AND collection_id = ? AND ${NOT_EXPIRED}
     ORDER BY id DESC
     LIMIT ${LIST_LIMIT}`,
    [userId, collectionId]
  );
  const unread = await firstValue<number>(
    'SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND collection_id = ? AND read_at IS NULL',
    [userId, collectionId]
  );

  const now = Date.now();
  return {
    unread: Number(unread ?? 0),
    items: inbox.map(row => ({
      id: row.id,
      type: row.type,
      message: row.message,
      miniId: row.mini_id,
      loanId: row.loan_id,
      read: row.read_at !== null,
      expiresAt: row.expires_in_seconds === null ? null : new Date(now + Number(row.expires_in_seconds) * 1000).toISOString(),
      createdAt: new Date(now - Number(row.age_seconds) * 1000).toISOString(),
    })),
  };
}

// False when there's no such notification for this user in this collection.
export async function markNotificationRead(id: number, userId: number, collectionId: number): Promise<boolean> {
  const updated = await change(
    `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
     WHERE id = ? AND user_id = ? AND collection_id = ?`,
    [id, userId, collectionId]
  );
  return updated > 0;
}

// Back to unread — the countdown stops and it stays until read again.
export async function markNotificationUnread(id: number, userId: number, collectionId: number): Promise<boolean> {
  const updated = await change(
    `UPDATE notifications SET read_at = NULL WHERE id = ? AND user_id = ? AND collection_id = ? AND ${NOT_EXPIRED}`,
    [id, userId, collectionId]
  );
  return updated > 0;
}

// Gone for good, read or not.
export async function dismissNotification(id: number, userId: number, collectionId: number): Promise<boolean> {
  const removed = await change(
    `DELETE FROM notifications WHERE id = ? AND user_id = ? AND collection_id = ? AND ${NOT_EXPIRED}`,
    [id, userId, collectionId]
  );
  return removed > 0;
}

// Housekeeping: read notifications whose two days are up.
export async function purgeExpiredNotifications(): Promise<number> {
  return change(
    `DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at <= NOW() - INTERVAL ${NOTIFICATION_KEEP_READ_DAYS} DAY`
  );
}

export async function markAllNotificationsRead(userId: number, collectionId: number): Promise<void> {
  await change(
    'UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND collection_id = ? AND read_at IS NULL',
    [userId, collectionId]
  );
}
