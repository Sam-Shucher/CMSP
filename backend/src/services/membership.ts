import fs from 'fs';
import path from 'path';
import { rows, firstRow, firstValue, change } from '../db/query';
import { uploadsDir } from '../config';
import { dropHoldsInCollection, announceMiniRemoved, promoteNextHold } from './holds';
import * as events from './loanEvents';

// Removing someone from a group without leaving anyone else stranded.
//
// A mini that's physically out (with them, or theirs with someone else) blocks
// removal: deleting the record would make it look available while it's really
// in someone's bag. Everything else is tidied up: open requests are cancelled
// with a notice to the other person, their holds and cart in the group go,
// and their minis leave the group (anyone waiting is told). If it was their
// last group, the account goes too.

export type RemovalResult =
  | { ok: true; accountDeleted: boolean; minisRemoved: number }
  | { ok: false; status: 404 | 409; error: string };

export async function removeMember(userId: number, collectionId: number): Promise<RemovalResult> {
  const member = await firstRow<{ display_name: string }>(
    `SELECT u.display_name FROM collection_memberships cm JOIN users u ON u.id = cm.user_id
     WHERE cm.user_id = ? AND cm.collection_id = ?`,
    [userId, collectionId]
  );
  if (!member) return { ok: false, status: 404, error: 'User not found in this collection' };
  const name = member.display_name;

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
  await change(
    'DELETE ci FROM cart_items ci JOIN minis m ON m.id = ci.mini_id WHERE ci.user_id = ? AND m.collection_id = ?',
    [userId, collectionId]
  );

  // Their minis leave the group — unless one was handed off in the meantime.
  const minis = await rows<{ id: number }>(
    `SELECT m.id FROM minis m
     WHERE m.owner_id = ? AND m.collection_id = ?
       AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.mini_id = m.id AND l.status = 'adventuring')`,
    [userId, collectionId]
  );
  for (const mini of minis) {
    const images = await rows<{ image_path: string }>('SELECT image_path FROM mini_images WHERE mini_id = ?', [mini.id]);
    await announceMiniRemoved(mini.id);
    await change('DELETE FROM minis WHERE id = ?', [mini.id]);
    for (const { image_path } of images) {
      fs.unlink(path.join(uploadsDir(), path.basename(image_path)), () => {}); // best effort; the hourly sweep catches the rest
    }
  }

  await change('DELETE FROM collection_memberships WHERE user_id = ? AND collection_id = ?', [userId, collectionId]);

  // Now that they're out of the group, the next person in line gets what they'd requested.
  for (const miniId of freedMinis) await promoteNextHold(miniId);

  const remaining = Number(await firstValue<number>(
    'SELECT COUNT(*) AS count FROM collection_memberships WHERE user_id = ?',
    [userId]
  ));
  const accountDeleted = remaining === 0;
  if (accountDeleted) await change('DELETE FROM users WHERE id = ?', [userId]);

  return { ok: true, accountDeleted, minisRemoved: minis.length };
}
