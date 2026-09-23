import { rows, firstRow, insert } from './query';

// A trace of admin actions with real consequences — who did it, to/about
// whom, and when. See schema.sql's audit_log table for why actor/target are
// snapshotted by name alongside a nullable id: the account behind either one
// can be gone by the time anyone reads this.

export type AuditAction = 'member_removed' | 'mini_restored';

export interface LogAdminActionInput {
  collectionId: number;
  actorId: number;
  actorName: string;
  action: AuditAction;
  targetUserId?: number | null;
  targetName?: string | null;
  details: string;
}

// The actor/target names an audit entry snapshots — a user id alone isn't
// enough, since that account can be gone by the time anyone reads the log.
export async function displayNameOf(userId: number, fallback = 'Someone'): Promise<string> {
  return (await firstRow<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', [userId]))?.display_name ?? fallback;
}

export async function logAdminAction(input: LogAdminActionInput): Promise<void> {
  await insert(
    `INSERT INTO audit_log (collection_id, actor_id, actor_name, action, target_user_id, target_name, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.collectionId, input.actorId, input.actorName, input.action,
      input.targetUserId ?? null, input.targetName ?? null, input.details,
    ]
  );
}

export interface AuditLogEntry {
  id: number;
  action: AuditAction;
  actorName: string;
  targetName: string | null;
  details: string;
  createdAt: string;
}

interface AuditLogRow {
  id: number;
  action: AuditAction;
  actor_name: string;
  target_name: string | null;
  details: string;
  created_at: string;
}

const LIST_LIMIT = 100;

export async function listAuditLog(collectionId: number): Promise<AuditLogEntry[]> {
  const entries = await rows<AuditLogRow>(
    `SELECT id, action, actor_name, target_name, details, created_at
     FROM audit_log
     WHERE collection_id = ?
     ORDER BY id DESC
     LIMIT ${LIST_LIMIT}`,
    [collectionId]
  );
  return entries.map(entry => ({
    id: entry.id,
    action: entry.action,
    actorName: entry.actor_name,
    targetName: entry.target_name,
    details: entry.details,
    createdAt: entry.created_at,
  }));
}
