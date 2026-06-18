import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from '../db/connection';
import { requireAuth, AuthRequest, JwtPayload } from '../middleware/requireAuth';

const router = Router();
const JWT_SECRET  = process.env.JWT_SECRET ?? 'change-me-in-production';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

// Typed shape of the row we SELECT when logging in
interface UserRow extends RowDataPacket {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  display_name: string;
}

// Signs a JWT with the given payload and writes it as an httpOnly cookie.
// httpOnly = the browser's JavaScript can never read this cookie, which blocks
// XSS attacks from stealing the token. The cookie is sent automatically on
// every request to this domain, so the frontend doesn't need to manage it.
function setAuthCookie(res: Response, payload: JwtPayload): void {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // HTTPS only in prod
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE,
  });
}

// POST /api/auth/register
// Creates a new user account. The email MUST already exist in the approved_emails
// table — that's the invite-only gate. Only the admin can add emails there.
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { email, username, password, displayName } = req.body as Record<string, string>;

  if (!email || !username || !password) {
    res.status(400).json({ error: 'Email, username, and password are required' });
    return;
  }

  try {
    // Check the invite list — RowDataPacket is mysql2's type for SELECT rows
    const [approved] = await pool.execute<RowDataPacket[]>(
      'SELECT id FROM approved_emails WHERE email = ?',
      [email.toLowerCase()]
    );
    if (approved.length === 0) {
      res.status(403).json({ error: 'This email is not on the invite list. Ask an admin to add you.' });
      return;
    }

    // Make sure nobody has already claimed this email or username
    const [existing] = await pool.execute<RowDataPacket[]>(
      'SELECT id FROM users WHERE email = ? OR username = ?',
      [email.toLowerCase(), username]
    );
    if (existing.length > 0) {
      res.status(409).json({ error: 'Email or username already taken' });
      return;
    }

    // bcrypt rounds=12 takes ~250ms to hash — slow enough to deter brute-force attacks
    // but fast enough that users don't notice the delay at login
    const passwordHash = await bcrypt.hash(password, 12);

    // ResultSetHeader is mysql2's type for INSERT/UPDATE/DELETE results — gives us insertId
    const [result] = await pool.execute<ResultSetHeader>(
      'INSERT INTO users (email, username, password_hash, display_name) VALUES (?, ?, ?, ?)',
      [email.toLowerCase(), username, passwordHash, displayName || username]
    );

    // Sign a JWT with the new user's info and send it back as a cookie
    setAuthCookie(res, { userId: result.insertId, username, role: 'user' });
    res.status(201).json({
      message: 'Account created',
      username,
      role: 'user',
      displayName: displayName || username,
    });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
// Verifies email + password and issues an auth cookie on success.
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as Record<string, string>;

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  try {
    const [rows] = await pool.execute<UserRow[]>(
      'SELECT id, username, password_hash, role, display_name FROM users WHERE email = ?',
      [email.toLowerCase()]
    );

    // Compare the submitted password against the stored hash.
    // We check length first to short-circuit — bcrypt.compare still runs in constant
    // time on valid hashes, but there's no hash to compare if the user doesn't exist.
    if (rows.length === 0 || !(await bcrypt.compare(password, rows[0].password_hash))) {
      // Return the same error for both "user not found" and "wrong password"
      // so attackers can't use the error message to enumerate valid emails
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const { id, username, role, display_name } = rows[0];
    setAuthCookie(res, { userId: id, username, role });
    res.json({ message: 'Logged in', username, role, displayName: display_name });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/logout
// Clears the auth cookie. The token isn't revoked on the server
// (we're stateless), but with a 7-day expiry and httpOnly the risk is low.
router.post('/logout', (_req: Request, res: Response): void => {
  res.clearCookie('token');
  res.json({ message: 'Logged out' });
});

// GET /api/auth/me
// Returns the current user's info from the JWT. Used by the frontend on page
// load to restore the logged-in state without a full DB round-trip.
router.get('/me', requireAuth, (req: AuthRequest, res: Response): void => {
  res.json(req.user);
});

export default router;
