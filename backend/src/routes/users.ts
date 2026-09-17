import { Router, Response } from 'express';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from '../db/connection';
import { requireAuth, AuthRequest } from '../middleware/requireAuth';
import { requiredText, optionalText, LIMITS } from '../utils/inputs';

const router = Router();

interface ProfileRow extends RowDataPacket {
  id: number;
  email: string;
  username: string;
  display_name: string;
  phone: string | null;
  neighborhood: string | null;
}

// GET /api/users/me
// Returns the logged-in user's own profile fields (beyond what's in the JWT).
router.get('/me', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.execute<ProfileRow[]>(
      'SELECT id, email, username, display_name, phone, neighborhood FROM users WHERE id = ?',
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
  const body = (req.body ?? {}) as Record<string, unknown>;
  const displayName = requiredText(body.displayName, 'Display name', LIMITS.displayName);
  const phone = optionalText(body.phone, 'Phone', LIMITS.phone);
  const neighborhood = optionalText(body.neighborhood, 'Neighborhood', LIMITS.neighborhood);
  for (const check of [displayName, phone, neighborhood]) {
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }
  }

  try {
    await pool.execute<ResultSetHeader>(
      'UPDATE users SET display_name = ?, phone = ?, neighborhood = ? WHERE id = ?',
      [
        (displayName as { value: string }).value,
        (phone as { value: string | null }).value,
        (neighborhood as { value: string | null }).value,
        req.user!.userId,
      ]
    );

    const [rows] = await pool.execute<ProfileRow[]>(
      'SELECT id, email, username, display_name, phone, neighborhood FROM users WHERE id = ?',
      [req.user!.userId]
    );
    res.json(rows[0]);
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
