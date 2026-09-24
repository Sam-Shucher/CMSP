import { Router } from 'express';
import { rows, firstRow, change } from '../db/query';
import { revokeAllSessions } from '../db/sessions';
import { hashPassword, temporaryPassword as newTemporaryPassword } from '../utils/passwords';
import { TEMP_PASSWORD_DAYS, MINI_ARCHIVE_GRACE_DAYS } from '../config';
import { requireAuth } from '../middleware/requireAuth';
import { requireAdmin } from '../middleware/requireAdmin';
import { requireCollectionMembership } from '../middleware/requireCollectionMembership';
import { route, idFrom } from '../utils/route';
import { emailAddress, positiveId, requiredBoolean } from '../utils/inputs';
import { removeMember } from '../services/membership';
import { logAdminAction, listAuditLog, displayNameOf } from '../db/auditLog';

const router = Router();

// Every route in this file requires the user to be logged in AND be an admin
// of their active collection (a per-collection role). There is no
// cross-collection admin view: everything below is scoped to req.collectionId.
// Order matters: requireCollectionMembership loads the user's CURRENT role
// from the database, which requireAdmin then checks (never the cookie's copy).
router.use(requireAuth, requireCollectionMembership, requireAdmin);

// ---------------------------------------------------------------------------
// Row types — shape of each SELECT result we work with in this file
// ---------------------------------------------------------------------------

interface ApprovedEmailRow {
  id: number;
  email: string;
  added_at: string;
  added_by_username: string | null; // null if the row was inserted manually in MySQL
}

interface UserAdminRow {
  id: number;
  email: string;
  username: string;
  display_name: string;
  phone: string | null;
  neighborhood: string | null;
  role: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// MySQL errors include a `code` string field (e.g. 'ER_DUP_ENTRY').
// This type guard lets us check for specific error codes safely in catch blocks.
// ---------------------------------------------------------------------------
interface MySqlError extends Error {
  code: string;
}

function isMySqlError(err: unknown): err is MySqlError {
  return err instanceof Error && 'code' in err;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/admin/approved-emails
// Returns the invite list for the admin's active collection only.
router.get('/approved-emails', route(async (req, res) => {
  res.json(await rows<ApprovedEmailRow>(
    `SELECT ae.id, ae.email, ae.added_at,
            u.username AS added_by_username
     FROM approved_emails ae
     LEFT JOIN users u ON ae.added_by = u.id
     WHERE ae.collection_id = ?
     ORDER BY ae.added_at DESC`,
    [req.collectionId!]
  ));
}));

// POST /api/admin/approved-emails
// Adds an email to the invite list for the admin's active collection. The
// same email can be invited into a different collection separately — the
// uniqueness constraint is on (email, collection), not email alone.
router.post('/approved-emails', route(async (req, res) => {
  const check = emailAddress((req.body as { email?: unknown } | undefined)?.email);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }
  const email = check.value;

  try {
    await change(
      'INSERT INTO approved_emails (email, collection_id, added_by) VALUES (?, ?, ?)',
      [email, req.collectionId!, req.user!.userId]
    );
  } catch (err: unknown) {
    // ER_DUP_ENTRY means the email is already invited to this collection — friendly message
    if (isMySqlError(err) && err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: 'Email already on this collection\'s invite list' });
      return;
    }
    throw err;
  }
  res.status(201).json({ message: 'Email approved', email });
}));

// DELETE /api/admin/approved-emails/:id
// Removes an email from the invite list — only if that invite row belongs
// to the admin's active collection (an admin can't reach into another
// collection's invite list by guessing an id). Does NOT delete the user if
// they've already registered — it just prevents new registrations with it.
router.delete('/approved-emails/:id', route(async (req, res) => {
  const inviteId = idFrom(req.params.id);
  const removed = inviteId === null ? 0 : await change(
    'DELETE FROM approved_emails WHERE id = ? AND collection_id = ?',
    [inviteId, req.collectionId!]
  );

  if (removed === 0) {
    res.status(404).json({ error: 'Invite not found' });
    return;
  }

  res.json({ message: 'Email removed' });
}));

// GET /api/admin/users
// Returns members of the admin's active collection only — never every
// registered user, since that would leak who's in other collections.
router.get('/users', route(async (req, res) => {
  res.json(await rows<UserAdminRow>(
    `SELECT u.id, u.email, u.username, u.display_name, u.phone, u.neighborhood, cm.role, u.created_at
     FROM users u
     JOIN collection_memberships cm ON cm.user_id = u.id
     WHERE cm.collection_id = ?
     ORDER BY u.created_at DESC`,
    [req.collectionId!]
  ));
}));

// PATCH /api/admin/users/:id/role
// Makes a member an admin of the active collection, or back to a regular
// member — in THIS collection only. Their role in any other collection is
// untouched. You can't change your own role: that prevents locking yourself
// out, and guarantees the collection always keeps at least one admin (you).
router.patch('/users/:id/role', route(async (req, res) => {
  const role = (req.body as { role?: unknown } | undefined)?.role;
  const userId = idFrom(req.params.id);

  if (role !== 'user' && role !== 'admin') {
    res.status(400).json({ error: 'Role must be "user" or "admin"' });
    return;
  }
  if (userId === req.user!.userId) {
    res.status(400).json({ error: 'You cannot change your own role' });
    return;
  }

  const updated = userId === null ? 0 : await change(
    'UPDATE collection_memberships SET role = ? WHERE user_id = ? AND collection_id = ?',
    [role, userId, req.collectionId!]
  );
  if (updated === 0) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ message: 'Role updated' });
}));

// POST /api/admin/users/:id/reset-password
// For someone locked out of their account. There's no email here, so this
// hands the admin a temporary password to pass on in person or by text — the
// member's phone number is right there in the table. It's shown once and
// never stored in the clear; their sessions end immediately, and the app
// (and the API — middleware/requireAuth.ts) makes them choose a new password
// before doing anything else.
//
// A password is the whole account's, not one group's: whoever holds the
// temporary one can sign in as them everywhere. So it's only allowed when this
// admin also runs every other group the person is in — otherwise an admin of
// one group could become someone who's an admin of another.
router.post('/users/:id/reset-password', route(async (req, res) => {
  const userId = idFrom(req.params.id);
  if (userId === req.user!.userId) {
    res.status(400).json({ error: 'Change your own password from your profile instead' });
    return;
  }

  const member = userId === null ? null : await firstRow<{ display_name: string; phone: string | null; groups_not_run: number }>(
    `SELECT u.display_name, u.phone,
            (SELECT COUNT(*) FROM collection_memberships theirs
             LEFT JOIN collection_memberships mine
               ON mine.collection_id = theirs.collection_id AND mine.user_id = ? AND mine.role = 'admin'
             WHERE theirs.user_id = u.id AND mine.user_id IS NULL) AS groups_not_run
     FROM users u
     JOIN collection_memberships cm ON cm.user_id = u.id
     WHERE u.id = ? AND cm.collection_id = ?`,
    [req.user!.userId, userId, req.collectionId!]
  );
  if (!member || userId === null) {
    res.status(404).json({ error: 'User not found in this collection' });
    return;
  }
  if (Number(member.groups_not_run) > 0) {
    res.status(403).json({
      error: `${member.display_name} is also in a group you're not an admin of, so their password can only be reset by someone who's an admin of all their groups.`,
    });
    return;
  }

  const temporaryPassword = newTemporaryPassword();
  await change(
    `UPDATE users
     SET password_hash = ?, must_change_password = TRUE,
         temp_password_expires_at = NOW() + INTERVAL ? DAY
     WHERE id = ?`,
    [await hashPassword(temporaryPassword), TEMP_PASSWORD_DAYS, userId]
  );
  // Whoever is signed in as them — including anyone who shouldn't be — is out.
  await revokeAllSessions(userId);

  res.json({
    temporaryPassword,
    displayName: member.display_name,
    phone: member.phone,
    expiresInDays: TEMP_PASSWORD_DAYS,
  });
}));

// DELETE /api/admin/users/:id
// Removes this user's membership in the admin's active collection — not a
// global account delete. Refused while a mini is out on loan with or from
// them; otherwise their open requests, holds, cart, and minis in this group
// are tidied away (services/membership.ts). If that was their last
// collection anywhere, the account itself is also removed. Blocked for your
// own membership so an admin can't lock themselves out.
router.delete('/users/:id', route(async (req, res) => {
  const userId = idFrom(req.params.id);
  if (userId === req.user!.userId) {
    res.status(400).json({ error: 'You cannot remove yourself from this collection' });
    return;
  }
  if (userId === null) {
    res.status(404).json({ error: 'User not found in this collection' });
    return;
  }

  const result = await removeMember(userId, req.collectionId!, req.user!.userId);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  if (result.accountDeleted) {
    res.json({ message: 'Removed from this group — that was their last one, so the account was deleted too' });
    return;
  }
  res.json({
    message: result.minisRemoved === 0
      ? 'Removed from this group'
      : `Removed from this group — their ${result.minisRemoved} ${result.minisRemoved === 1 ? 'mini' : 'minis'} here ${result.minisRemoved === 1 ? 'was' : 'were'} archived, and will be permanently deleted in ${MINI_ARCHIVE_GRACE_DAYS} days unless an admin restores ${result.minisRemoved === 1 ? 'it' : 'them'}`,
  });
}));

// PATCH /api/admin/settings  { showPrices }
// Group-wide settings for the admin's active collection. showPrices: some
// groups don't want a dollar figure on every mini — off hides price
// everywhere in this group (requireCollectionMembership hands the setting to
// every route) while leaving the stored prices alone, so it can be undone.
router.patch('/settings', route(async (req, res) => {
  const showPrices = requiredBoolean((req.body as { showPrices?: unknown } | undefined)?.showPrices, 'showPrices');
  if (!showPrices.ok) {
    res.status(400).json({ error: showPrices.error });
    return;
  }

  await change('UPDATE collections SET show_prices = ? WHERE id = ?', [showPrices.value, req.collectionId!]);
  res.json({ showPrices: showPrices.value });
}));

// GET /api/admin/audit-log
// A trace of admin actions with real consequences in this collection —
// member removals and mini restores — newest first. See db/auditLog.ts for
// why this never needs to join back to users: names are snapshotted at the
// time of the action.
router.get('/audit-log', route(async (req, res) => {
  res.json(await listAuditLog(req.collectionId!));
}));

interface ArchivedMiniRow {
  id: number;
  name: string;
  price: string;
  owner_id: number;
  owner_name: string;
  archived_at: Date;
}

// GET /api/admin/archived-minis
// Minis whose owner was removed from this collection but kept another one —
// hidden everywhere else (see minis.ts/sets.ts's archived_at IS NULL guards),
// restorable here until maintenance/housekeeping.ts purges them for good.
router.get('/archived-minis', route(async (req, res) => {
  const archived = await rows<ArchivedMiniRow>(
    `SELECT m.id, m.name, m.price, u.id AS owner_id, u.display_name AS owner_name, m.archived_at
     FROM minis m JOIN users u ON u.id = m.owner_id
     WHERE m.collection_id = ? AND m.archived_at IS NOT NULL
     ORDER BY m.archived_at`,
    [req.collectionId!]
  );
  const now = Date.now();
  res.json(archived.map(mini => {
    const daysElapsed = Math.floor((now - new Date(mini.archived_at).getTime()) / (24 * 60 * 60 * 1000));
    return {
      id: mini.id,
      name: mini.name,
      price: req.showPrices ? Number(mini.price) : null,
      formerOwnerId: mini.owner_id,
      formerOwnerName: mini.owner_name,
      archivedAt: new Date(mini.archived_at).toISOString(),
      daysLeft: Math.max(0, MINI_ARCHIVE_GRACE_DAYS - daysElapsed),
    };
  }));
}));

// POST /api/admin/archived-minis/:id/restore  { newOwnerId }
// Gives an archived mini back before its grace period runs out. If the new
// owner is the mini's ORIGINAL owner (re-invited during the window), it stays
// in whatever set it was part of; anyone else gets it without one — same
// reasoning as POST /api/minis/:id/transfer (a set is one owner's own minis).
// Any quest it was on when its owner was removed ends here: nobody restoring
// it took it anywhere, and a quest left running would keep it unborrowable.
router.post('/archived-minis/:id/restore', route(async (req, res) => {
  const miniId = idFrom(req.params.id);
  const mini = miniId === null ? null : await firstRow<{ owner_id: number; set_id: number | null; name: string }>(
    'SELECT owner_id, set_id, name FROM minis WHERE id = ? AND collection_id = ? AND archived_at IS NOT NULL',
    [miniId, req.collectionId!]
  );
  if (!mini || miniId === null) {
    res.status(404).json({ error: 'Archived mini not found' });
    return;
  }

  const newOwnerCheck = positiveId((req.body as { newOwnerId?: unknown } | undefined)?.newOwnerId);
  if (!newOwnerCheck.ok) {
    res.status(400).json({ error: newOwnerCheck.error });
    return;
  }
  const newOwnerId = newOwnerCheck.value;

  const newOwner = await firstRow<{ display_name: string }>(
    `SELECT u.display_name FROM users u JOIN collection_memberships cm ON cm.user_id = u.id
     WHERE u.id = ? AND cm.collection_id = ?`,
    [newOwnerId, req.collectionId!]
  );
  if (!newOwner) {
    res.status(404).json({ error: 'That person isn\'t a member of this collection' });
    return;
  }

  const keepSet = newOwnerId === mini.owner_id;
  const restored = await change(
    `UPDATE minis SET owner_id = ?, archived_at = NULL, set_id = ?, on_quest_since = NULL, on_quest_until = NULL
     WHERE id = ? AND collection_id = ? AND archived_at IS NOT NULL`,
    [newOwnerId, keepSet ? mini.set_id : null, miniId, req.collectionId!]
  );
  if (restored === 0) {
    res.status(404).json({ error: 'Archived mini not found' });
    return;
  }
  // Back to its original owner: the set it was in comes back with it.
  if (keepSet && mini.set_id !== null) {
    await change('UPDATE sets SET archived_at = NULL WHERE id = ?', [mini.set_id]);
  }

  await logAdminAction({
    collectionId: req.collectionId!, actorId: req.user!.userId, actorName: await displayNameOf(req.user!.userId, 'An admin'),
    action: 'mini_restored', targetUserId: newOwnerId, targetName: newOwner.display_name,
    details: `Restored ${mini.name} to ${newOwner.display_name}`,
  });

  res.json({ message: `Restored to ${newOwner.display_name}` });
}));

interface LoanIncidentRow {
  borrower_id: number | null; // null once their account has been deleted
  borrower_name: string;
  lost_count: number;
  wounded_count: number;
}

// GET /api/admin/loan-incidents
// A private, per-borrower tally of lost/critically-wounded loans in this
// collection — never shown to anyone but admins, and never a ranking (see
// BACKLOG.md's reasoning against public reliability scores). The point is
// only to make a repeated pattern visible to the people running the group.
// Someone whose account has since been deleted still counts, under the name
// saved when it was (services/membership.ts) — being removed doesn't wipe it.
router.get('/loan-incidents', route(async (req, res) => {
  const incidents = await rows<LoanIncidentRow>(
    `SELECT l.borrower_id, COALESCE(b.display_name, l.removed_borrower_name) AS borrower_name,
            SUM(l.status = 'lost') AS lost_count,
            SUM(l.status = 'critically_wounded') AS wounded_count
     FROM loans l LEFT JOIN users b ON b.id = l.borrower_id
     WHERE l.collection_id = ? AND l.status IN ('lost', 'critically_wounded')
     GROUP BY l.borrower_id, COALESCE(b.display_name, l.removed_borrower_name)
     ORDER BY (SUM(l.status = 'lost') + SUM(l.status = 'critically_wounded')) DESC`,
    [req.collectionId!]
  );
  res.json(incidents.map(row => ({
    borrowerId: row.borrower_id,
    borrowerName: row.borrower_name,
    lostCount: Number(row.lost_count),
    woundedCount: Number(row.wounded_count),
  })));
}));

export default router;
