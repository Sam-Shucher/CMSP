import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from './connection';
import { NotificationType, fitMessage } from '../utils/notificationMessages';

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
  await pool.execute<ResultSetHeader>(
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
  createdAt: string;
}

const LIST_LIMIT = 50;

export async function listNotifications(userId: number, collectionId: number): Promise<{ unread: number; items: NotificationItem[] }> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id, type, message, mini_id, loan_id, read_at, created_at
     FROM notifications
     WHERE user_id = ? AND collection_id = ?
     ORDER BY id DESC
     LIMIT ${LIST_LIMIT}`,
    [userId, collectionId]
  );
  const [[count]] = await pool.execute<RowDataPacket[]>(
    'SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND collection_id = ? AND read_at IS NULL',
    [userId, collectionId]
  );
  return {
    unread: Number(count.unread),
    items: rows.map(r => ({
      id: r.id,
      type: r.type,
      message: r.message,
      miniId: r.mini_id,
      loanId: r.loan_id,
      read: r.read_at !== null,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  };
}

// False when there's no such notification for this user in this collection.
export async function markNotificationRead(id: number, userId: number, collectionId: number): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
     WHERE id = ? AND user_id = ? AND collection_id = ?`,
    [id, userId, collectionId]
  );
  return result.affectedRows > 0;
}

export async function markAllNotificationsRead(userId: number, collectionId: number): Promise<void> {
  await pool.execute<ResultSetHeader>(
    'UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND collection_id = ? AND read_at IS NULL',
    [userId, collectionId]
  );
}
