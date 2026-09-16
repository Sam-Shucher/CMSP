import { Router, Response } from 'express';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from '../db/connection';
import { requireAuth, AuthRequest } from '../middleware/requireAuth';

const router = Router();

interface ProfileRow extends RowDataPacket {
  id: number;
  email: string;
  username: string;
  display_name: string;
  phone: string | null;
  neighborhood: string | null;
  role: string;
}

// GET /api/users/me
// Returns the logged-in user's own profile fields (beyond what's in the JWT).
router.get('/me', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.execute<ProfileRow[]>(
      'SELECT id, email, username, display_name, phone, neighborhood, role FROM users WHERE id = ?',
      [req.user!.userId]
    );
    res.json(rows[0]);
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/users/me
// Lets a user update their own display name, phone, and neighborhood.
// Email, username, and role are not editable here.
router.patch('/me', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { displayName, phone, neighborhood } = req.body as Record<string, string | undefined>;

  if (!displayName?.trim()) {
    res.status(400).json({ error: 'Display name is required' });
    return;
  }

  try {
    await pool.execute<ResultSetHeader>(
      'UPDATE users SET display_name = ?, phone = ?, neighborhood = ? WHERE id = ?',
      [displayName.trim(), phone?.trim() || null, neighborhood?.trim() || null, req.user!.userId]
    );

    const [rows] = await pool.execute<ProfileRow[]>(
      'SELECT id, email, username, display_name, phone, neighborhood, role FROM users WHERE id = ?',
      [req.user!.userId]
    );
    res.json(rows[0]);
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
