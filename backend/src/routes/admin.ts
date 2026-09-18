import { Router } from 'express';
import { rows, firstRow, change } from '../db/query';
import { revokeAllSessions } from '../db/sessions';
import { hashPassword, temporaryPassword as newTemporaryPassword } from '../utils/passwords';
import { TEMP_PASSWORD_DAYS } from '../config';
import { requireAuth } from '../middleware/requireAuth';
import { requireAdmin } from '../middleware/requireAdmin';
import { requireCollectionMembership } from '../middleware/requireCollectionMembership';
import { route, idFrom } from '../utils/route';
import { emailAddress } from '../utils/inputs';
import { removeMember } from '../services/membership';

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
// makes them choose a new password before doing anything else.
router.post('/users/:id/reset-password', route(async (req, res) => {
  const userId = idFrom(req.params.id);
  if (userId === req.user!.userId) {
    res.status(400).json({ error: 'Change your own password from your profile instead' });
    return;
  }

  const member = userId === null ? null : await firstRow<{ display_name: string; phone: string | null }>(
    `SELECT u.display_name, u.phone FROM users u
     JOIN collection_memberships cm ON cm.user_id = u.id
     WHERE u.id = ? AND cm.collection_id = ?`,
    [userId, req.collectionId!]
  );
  if (!member || userId === null) {
    res.status(404).json({ error: 'User not found in this collection' });
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

  const result = await removeMember(userId, req.collectionId!);
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
      : `Removed from this group — their ${result.minisRemoved} ${result.minisRemoved === 1 ? 'mini' : 'minis'} here ${result.minisRemoved === 1 ? 'was' : 'were'} removed too`,
  });
}));

export default router;
