import fs from 'fs';
import path from 'path';
import { rows, firstRow, firstValue, change } from '../db/query';
import { uploadsDir, MINI_ARCHIVE_GRACE_DAYS } from '../config';
import { dropHoldsInCollection, announceMiniRemoved, promoteNextHold } from './holds';
import { dropBookingsInCollection } from './bookings';
import { logAdminAction, displayNameOf } from '../db/auditLog';
import * as events from './loanEvents';

// Removing someone from a group without leaving anyone else stranded.
//
// A mini that's physically out (with them, or theirs with someone else) blocks
// removal: deleting the record would make it look available while it's really
// in someone's bag. Everything else is tidied up: open requests are cancelled
// with a notice to the other person, their holds and cart in the group go.
//
// Their minis: if they still belong to another collection, their minis here
// are archived, not deleted — hidden everywhere, restorable by an admin for
// MINI_ARCHIVE_GRACE_DAYS before maintenance/housekeeping.ts purges them for
// good. If this was their LAST collection, the account is deleted immediately
// (as it always has been) and takes its minis with it via a foreign key —
// deferring that too would leave an account with zero collections dangling
// for no real benefit here, so the grace period only applies when they
// survive the removal. Every call is recorded in audit_log either way.

export type RemovalResult =
  | { ok: true; accountDeleted: boolean; minisRemoved: number }
  | { ok: false; status: 404 | 409; error: string };

export async function removeMember(userId: number, collectionId: number, actorId: number): Promise<RemovalResult> {
  const member = await firstRow<{ display_name: string }>(
    `SELECT u.display_name FROM collection_memberships cm JOIN users u ON u.id = cm.user_id
     WHERE cm.user_id = ? AND cm.collection_id = ?`,
    [userId, collectionId]
  );
  if (!member) return { ok: false, status: 404, error: 'User not found in this collection' };
  const name = member.display_name;
  const actorName = await displayNameOf(actorId, 'An admin');

  const outCount = Number(await firstValue<number>(
    `SELECT COUNT(*) AS n FROM loans
     WHERE collection_id = ? AND status = 'adventuring' AND (borrower_id = ? OR owner_id = ?)`,
    [collectionId, userId, userId]
  ));
  if (outCount > 0) {
    return {
      ok: false,
      status: 409,
      error: outCount === 1
        ? `${name} has 1 mini out on loan in this group — it needs to be marked returned first`
        : `${name} has ${outCount} minis out on loan in this group — they need to be marked returned first`,
    };
  }

  // Their open requests, both as borrower and as owner.
  const open = await rows<{ id: number; mini_id: number; borrower_id: number }>(
    `SELECT id, mini_id, borrower_id FROM loans
     WHERE collection_id = ? AND status = 'negotiating' AND (borrower_id = ? OR owner_id = ?)`,
    [collectionId, userId, userId]
  );
  const freedMinis: number[] = [];
  for (const loan of open) {
    const cancelled = await change(
      `UPDATE loans SET status = 'cancelled', cancelled_by = ? WHERE id = ? AND status = 'negotiating'`,
      [userId, loan.id]
    );
    if (cancelled === 0) continue;
    await events.requestCancelledByRemoval(loan.id, userId);
    if (loan.borrower_id === userId) freedMinis.push(loan.mini_id);
  }

  await dropHoldsInCollection(userId, collectionId);
  // Their claims on other people's calendars go too — a booking by someone who
  // isn't in the group any more would come due and find nobody to hand it to.
  await dropBookingsInCollection(userId, collectionId);
  await change(
    'DELETE ci FROM cart_items ci JOIN minis m ON m.id = ci.mini_id WHERE ci.user_id = ? AND m.collection_id = ?',
    [userId, collectionId]
  );

  // Would this be their last collection anywhere? Decided now, before their
  // minis are touched, so the branch below knows whether to archive or
  // delete them outright.
  const willDeleteAccount = Number(await firstValue<number>(
    'SELECT COUNT(*) AS n FROM collection_memberships WHERE user_id = ? AND collection_id <> ?',
    [userId, collectionId]
  )) === 0;

  // Their minis leave the group — unless one was handed off in the meantime.
  const minis = await rows<{ id: number }>(
    `SELECT m.id FROM minis m
     WHERE m.owner_id = ? AND m.collection_id = ?
       AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.mini_id = m.id AND l.status = 'adventuring')`,
    [userId, collectionId]
  );
  for (const mini of minis) {
    await announceMiniRemoved(mini.id); // anyone waiting on it is told it's gone, either way
    if (willDeleteAccount) {
      const images = await rows<{ image_path: string }>('SELECT image_path FROM mini_images WHERE mini_id = ?', [mini.id]);
      await change('DELETE FROM minis WHERE id = ?', [mini.id]);
      for (const { image_path } of images) {
        fs.unlink(path.join(uploadsDir(), path.basename(image_path)), () => {}); // best effort; the hourly sweep catches the rest
      }
    } else {
      // Archived, not deleted — kept for MINI_ARCHIVE_GRACE_DAYS in case this
      // was a mistake. The row survives, but not the queues on it: nobody
      // waiting for it can actually get it while it's parked like this, and
      // ON DELETE CASCADE (which used to clear these for free) doesn't fire
      // when the mini isn't being deleted.
      await change('UPDATE minis SET archived_at = NOW() WHERE id = ?', [mini.id]);
      await change('DELETE FROM holds WHERE mini_id = ?', [mini.id]);
      await change('DELETE FROM hold_watchers WHERE mini_id = ?', [mini.id]);
      await change('DELETE FROM cart_items WHERE mini_id = ?', [mini.id]);
      await change('DELETE FROM bookings WHERE mini_id = ?', [mini.id]);
    }
  }

  // Their sets in this group go with their minis: archived alongside them (and
  // back if an admin restores the minis to them), rather than left on the Sets
  // page, empty, under the name of someone who isn't in the group. When the
  // account itself is going, sets.owner_id's ON DELETE CASCADE takes them.
  if (!willDeleteAccount) {
    await change(
      'UPDATE sets SET archived_at = NOW() WHERE owner_id = ? AND collection_id = ? AND archived_at IS NULL',
      [userId, collectionId]
    );
  }

  await change('DELETE FROM collection_memberships WHERE user_id = ? AND collection_id = ?', [userId, collectionId]);

  // Now that they're out of the group, the next person in line gets what they'd requested.
  for (const miniId of freedMinis) await promoteNextHold(miniId);

  const miniWord = minis.length === 1 ? 'mini' : 'minis';
  const details = willDeleteAccount
    ? minis.length === 0
      ? `Removed ${name} from the group — that was their last one, so the account was deleted too`
      : `Removed ${name} from the group — that was their last one, so the account and their ${minis.length} ${miniWord} here were deleted`
    : minis.length === 0
      ? `Removed ${name} from the group — they had no minis here`
      : `Removed ${name} from the group — archived their ${minis.length} ${miniWord} here, permanently deleted in ${MINI_ARCHIVE_GRACE_DAYS} days unless restored`;

  // Logged while userId still refers to a real row — audit_log's target_user_id
  // FK requires that at insert time; ON DELETE SET NULL then keeps the entry
  // (with its name already snapshotted) once the account below is gone.
  await logAdminAction({
    collectionId, actorId, actorName, action: 'member_removed', targetUserId: userId, targetName: name, details,
  });

  if (willDeleteAccount) await change('DELETE FROM users WHERE id = ?', [userId]);

  return { ok: true, accountDeleted: willDeleteAccount, minisRemoved: minis.length };
}

// Housekeeping: an archived mini nobody restored within MINI_ARCHIVE_GRACE_DAYS
// is gone for good. Called hourly from maintenance/housekeeping.ts.
export async function purgeArchivedMinis(): Promise<number> {
  const expired = await rows<{ id: number }>(
    'SELECT id FROM minis WHERE archived_at IS NOT NULL AND archived_at <= NOW() - INTERVAL ? DAY',
    [MINI_ARCHIVE_GRACE_DAYS]
  );
  for (const mini of expired) {
    const images = await rows<{ image_path: string }>('SELECT image_path FROM mini_images WHERE mini_id = ?', [mini.id]);
    await change('DELETE FROM minis WHERE id = ?', [mini.id]);
    for (const { image_path } of images) {
      fs.unlink(path.join(uploadsDir(), path.basename(image_path)), () => {}); // best effort; the hourly sweep catches the rest
    }
  }
  // Their archived sets go at the same time. Any mini still pointing at one
  // (restored to someone else keeps no set) is ungrouped by ON DELETE SET NULL.
  await change(
    'DELETE FROM sets WHERE archived_at IS NOT NULL AND archived_at <= NOW() - INTERVAL ? DAY',
    [MINI_ARCHIVE_GRACE_DAYS]
  );
  return expired.length;
}
