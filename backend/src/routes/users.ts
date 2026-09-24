import { Router } from 'express';
import { firstRow, change } from '../db/query';
import { requireAuth, requireAuthAllowingTemporaryPassword } from '../middleware/requireAuth';
import { route } from '../utils/route';
import { requiredText, optionalText, LIMITS } from '../utils/inputs';
import { validatePassword } from '../utils/validation';
import { hashPassword, verifyPassword } from '../utils/passwords';
import { revokeOtherSessions } from '../db/sessions';

const router = Router();

interface ProfileRow {
  id: number;
  email: string;
  username: string;
  display_name: string;
  phone: string | null;
  neighborhood: string | null;
}

const PROFILE_SELECT = 'SELECT id, email, username, display_name, phone, neighborhood FROM users WHERE id = ?';

// GET /api/users/me
// Returns the logged-in user's own profile fields (beyond what's in the JWT).
router.get('/me', requireAuth, route(async (req, res) => {
  res.json(await firstRow<ProfileRow>(PROFILE_SELECT, [req.user!.userId]));
}));

// PATCH /api/users/me
// Lets a user update their own display name, phone, and neighborhood.
// Email, username, and role are not editable here.
router.patch('/me', requireAuth, route(async (req, res) => {
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
  if (!displayName.ok || !phone.ok || !neighborhood.ok) return; // narrowing for TypeScript; the loop above already replied

  await change(
    'UPDATE users SET display_name = ?, phone = ?, neighborhood = ? WHERE id = ?',
    [displayName.value, phone.value, neighborhood.value, req.user!.userId]
  );

  res.json(await firstRow<ProfileRow>(PROFILE_SELECT, [req.user!.userId]));
}));

// PATCH /api/users/me/password  { currentPassword, newPassword }
// Changing your own password — either because you want to, or because an admin
// gave you a temporary one and the app is insisting. Knowing the current
// password is required, so someone who walks up to an unlocked screen can't
// take the account over.
router.patch('/me/password', requireAuthAllowingTemporaryPassword, route(async (req, res) => {
  const { currentPassword, newPassword } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    res.status(400).json({ error: 'Your current and new passwords are both required' });
    return;
  }

  const strength = validatePassword(newPassword);
  if (!strength.valid) {
    res.status(400).json({ error: strength.error });
    return;
  }
  if (newPassword === currentPassword) {
    res.status(400).json({ error: 'Your new password must be different from the current one' });
    return;
  }

  const user = await firstRow<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [req.user!.userId]);
  if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
    res.status(401).json({ error: 'That current password isn\'t right' });
    return;
  }

  await change(
    `UPDATE users
     SET password_hash = ?, must_change_password = FALSE, temp_password_expires_at = NULL
     WHERE id = ?`,
    [await hashPassword(newPassword), req.user!.userId]
  );
  // Anyone signed in as them elsewhere — including whoever prompted the change
  // — is signed out; this device stays put.
  await revokeOtherSessions(req.user!.userId, req.user!.sid);

  res.json({ message: 'Password changed' });
}));

export default router;
