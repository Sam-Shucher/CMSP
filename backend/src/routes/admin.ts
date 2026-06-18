import { Router, Response } from 'express';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from '../db/connection';
import { requireAuth, AuthRequest } from '../middleware/requireAuth';
import { requireAdmin } from '../middleware/requireAdmin';

const router = Router();

// Every route in this file requires the user to be logged in AND be an admin.
// requireAuth populates req.user, then requireAdmin checks req.user.role.
router.use(requireAuth, requireAdmin);

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
// Returns the full invite list so admins can see who has been approved.
router.get('/approved-emails', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.execute<ApprovedEmailRow[]>(
      `SELECT ae.id, ae.email, ae.added_at,
              u.username AS added_by_username
       FROM approved_emails ae
       LEFT JOIN users u ON ae.added_by = u.id
       ORDER BY ae.added_at DESC`
    );
    res.json(rows);
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/approved-emails
// Adds an email to the invite list. Until an email is here, no one can
// register with it — this is the invite-only gate.
router.post('/approved-emails', async (req: AuthRequest, res: Response): Promise<void> => {
  const { email } = req.body as { email: string };

  if (!email?.trim()) {
    res.status(400).json({ error: 'Email required' });
    return;
  }

  try {
    await pool.execute<ResultSetHeader>(
      'INSERT INTO approved_emails (email, added_by) VALUES (?, ?)',
      [email.toLowerCase().trim(), req.user!.userId]
    );
    res.status(201).json({ message: 'Email approved', email: email.toLowerCase().trim() });
  } catch (err: unknown) {
    // ER_DUP_ENTRY means the email is already in the list — return a friendly message
    if (isMySqlError(err) && err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: 'Email already on the invite list' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/approved-emails/:id
// Removes an email from the invite list. Does NOT delete the user if they've
// already registered — it just prevents new registrations with that email.
router.delete('/approved-emails/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await pool.execute<ResultSetHeader>('DELETE FROM approved_emails WHERE id = ?', [req.params.id]);
    res.json({ message: 'Email removed' });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/users
// Returns all registered users so admins can see who is in the system
// and manage their roles.
router.get('/users', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.execute<UserAdminRow[]>(
      'SELECT id, email, username, display_name, role, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/admin/users/:id/role
// Promotes a user to admin or demotes an admin back to a regular user.
// Only accepts the two valid role values to prevent arbitrary data being stored.
router.patch('/users/:id/role', async (req: AuthRequest, res: Response): Promise<void> => {
  const { role } = req.body as { role: string };

  if (!['user', 'admin'].includes(role)) {
    res.status(400).json({ error: 'Role must be "user" or "admin"' });
    return;
  }

  try {
    await pool.execute<ResultSetHeader>('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
    res.json({ message: 'Role updated' });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
