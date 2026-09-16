import { Router, Response } from 'express';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from '../db/connection';
import { requireAuth } from '../middleware/requireAuth';
import { requireAdmin } from '../middleware/requireAdmin';
import { requireCollectionMembership, CollectionRequest } from '../middleware/requireCollectionMembership';

const router = Router();

// Every route in this file requires the user to be logged in, be a
// (site-wide) admin, AND be a verified member of their active collection —
// an admin can never administer a collection they don't belong to, and
// there is no cross-collection admin view: everything below is scoped to
// req.collectionId.
router.use(requireAuth, requireAdmin, requireCollectionMembership);

// ---------------------------------------------------------------------------
// Row types — shape of each SELECT result we work with in this file
// ---------------------------------------------------------------------------

interface ApprovedEmailRow extends RowDataPacket {
  id: number;
  email: string;
  added_at: string;
  added_by_username: string | null; // null if the row was inserted manually in MySQL
}

interface UserAdminRow extends RowDataPacket {
  id: number;
  email: string;
  username: string;
  display_name: string;
  phone: string | null;
  neighborhood: string | null;
  role: string;
  created_at: string;
}

interface MembershipCountRow extends RowDataPacket {
  count: number;
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
router.get('/approved-emails', async (req: CollectionRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.execute<ApprovedEmailRow[]>(
      `SELECT ae.id, ae.email, ae.added_at,
              u.username AS added_by_username
       FROM approved_emails ae
       LEFT JOIN users u ON ae.added_by = u.id
       WHERE ae.collection_id = ?
       ORDER BY ae.added_at DESC`,
      [req.collectionId!]
    );
    res.json(rows);
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/approved-emails
// Adds an email to the invite list for the admin's active collection. The
// same email can be invited into a different collection separately — the
// uniqueness constraint is on (email, collection), not email alone.
router.post('/approved-emails', async (req: CollectionRequest, res: Response): Promise<void> => {
  const { email } = req.body as { email: string };

  if (!email?.trim()) {
    res.status(400).json({ error: 'Email required' });
    return;
  }

  try {
    await pool.execute<ResultSetHeader>(
      'INSERT INTO approved_emails (email, collection_id, added_by) VALUES (?, ?, ?)',
      [email.toLowerCase().trim(), req.collectionId!, req.user!.userId]
    );
    res.status(201).json({ message: 'Email approved', email: email.toLowerCase().trim() });
  } catch (err: unknown) {
    // ER_DUP_ENTRY means the email is already invited to this collection — friendly message
    if (isMySqlError(err) && err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: 'Email already on this collection\'s invite list' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/approved-emails/:id
// Removes an email from the invite list — only if that invite row belongs
// to the admin's active collection (an admin can't reach into another
// collection's invite list by guessing an id). Does NOT delete the user if
// they've already registered — it just prevents new registrations with it.
router.delete('/approved-emails/:id', async (req: CollectionRequest, res: Response): Promise<void> => {
  try {
    const [result] = await pool.execute<ResultSetHeader>(
      'DELETE FROM approved_emails WHERE id = ? AND collection_id = ?',
      [req.params.id, req.collectionId!]
    );

    if (result.affectedRows === 0) {
      res.status(404).json({ error: 'Invite not found' });
      return;
    }

    res.json({ message: 'Email removed' });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/users
// Returns members of the admin's active collection only — never every
// registered user, since that would leak who's in other collections.
router.get('/users', async (req: CollectionRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.execute<UserAdminRow[]>(
      `SELECT u.id, u.email, u.username, u.display_name, u.phone, u.neighborhood, u.role, u.created_at
       FROM users u
       JOIN collection_memberships cm ON cm.user_id = u.id
       WHERE cm.collection_id = ?
       ORDER BY u.created_at DESC`,
      [req.collectionId!]
    );
    res.json(rows);
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/admin/users/:id/role
// Promotes a user to (site-wide) admin or demotes them back to a regular
// user. Only accepts the two valid role values, and only for someone who is
// actually a member of the admin's active collection — role is a global
// flag, but an admin's authority to change it is still collection-scoped.
router.patch('/users/:id/role', async (req: CollectionRequest, res: Response): Promise<void> => {
  const { role } = req.body as { role: string };

  if (!['user', 'admin'].includes(role)) {
    res.status(400).json({ error: 'Role must be "user" or "admin"' });
    return;
  }

  try {
    const [membershipRows] = await pool.execute<RowDataPacket[]>(
      'SELECT id FROM collection_memberships WHERE user_id = ? AND collection_id = ?',
      [req.params.id, req.collectionId!]
    );
    if (membershipRows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    await pool.execute<ResultSetHeader>('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
    res.json({ message: 'Role updated' });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/users/:id
// Removes this user's membership in the admin's active collection — not a
// global account delete. If that was their last collection anywhere, the
// account itself is also removed (an account with zero collection access
// is orphaned and pointless to keep). Blocked for your own membership so
// an admin can't lock themselves out of the collection they're acting in.
router.delete('/users/:id', async (req: CollectionRequest, res: Response): Promise<void> => {
  if (Number(req.params.id) === req.user!.userId) {
    res.status(400).json({ error: 'You cannot remove yourself from this collection' });
    return;
  }

  try {
    const [membershipRows] = await pool.execute<RowDataPacket[]>(
      'SELECT id FROM collection_memberships WHERE user_id = ? AND collection_id = ?',
      [req.params.id, req.collectionId!]
    );
    if (membershipRows.length === 0) {
      res.status(404).json({ error: 'User not found in this collection' });
      return;
    }

    await pool.execute<ResultSetHeader>(
      'DELETE FROM collection_memberships WHERE user_id = ? AND collection_id = ?',
      [req.params.id, req.collectionId!]
    );

    const [countRows] = await pool.execute<MembershipCountRow[]>(
      'SELECT COUNT(*) AS count FROM collection_memberships WHERE user_id = ?',
      [req.params.id]
    );

    if (countRows[0].count === 0) {
      await pool.execute<ResultSetHeader>('DELETE FROM users WHERE id = ?', [req.params.id]);
      res.json({ message: 'Removed from this collection — that was their last one, so the account was deleted too' });
      return;
    }

    res.json({ message: 'Removed from this collection' });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
