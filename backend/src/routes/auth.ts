import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
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

interface CollectionIdRow extends RowDataPacket {
  collection_id: number;
}

interface CollectionRow extends RowDataPacket {
  id: number;
  name: string;
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
// Creates a new user account. The email MUST already be on at least one
// collection's invite list. Registering joins every collection whose invite
// list contains the email — so someone pre-invited to two collections at
// once only has to sign up once.
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { email, username, password, displayName, phone, neighborhood } = req.body as Record<string, string>;

  if (!email || !username || !password) {
    res.status(400).json({ error: 'Email, username, and password are required' });
    return;
  }

  try {
    // Check the invite lists — RowDataPacket is mysql2's type for SELECT rows
    const [approved] = await pool.execute<CollectionIdRow[]>(
      'SELECT collection_id FROM approved_emails WHERE email = ?',
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
      'INSERT INTO users (email, username, password_hash, display_name, phone, neighborhood) VALUES (?, ?, ?, ?, ?, ?)',
      [email.toLowerCase(), username, passwordHash, displayName || username, phone?.trim() || null, neighborhood?.trim() || null]
    );
    const userId: number = result.insertId;

    // Join every collection that invited this email
    for (const row of approved) {
      await pool.execute<ResultSetHeader>(
        'INSERT IGNORE INTO collection_memberships (user_id, collection_id) VALUES (?, ?)',
        [userId, row.collection_id]
      );
    }

    // Only auto-select a collection when there's exactly one — otherwise the
    // frontend sends them to the picker before they can do anything else.
    const collectionId = approved.length === 1 ? approved[0].collection_id : undefined;

    setAuthCookie(res, { userId, username, role: 'user', ...(collectionId ? { collectionId } : {}) });
    res.status(201).json({
      message: 'Account created',
      username,
      role: 'user',
      displayName: displayName || username,
      collectionId,
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

    // Auto-select the collection only when it's unambiguous — same rule as registration.
    const [memberships] = await pool.execute<CollectionIdRow[]>(
      'SELECT collection_id FROM collection_memberships WHERE user_id = ?',
      [id]
    );
    const collectionId = memberships.length === 1 ? memberships[0].collection_id : undefined;

    setAuthCookie(res, { userId: id, username, role, ...(collectionId ? { collectionId } : {}) });
    res.json({ message: 'Logged in', username, role, displayName: display_name, collectionId });
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

// GET /api/auth/collections
// Returns the collections the current user belongs to — used to render the
// "select a collection" picker after login/registration.
router.get('/collections', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.execute<CollectionRow[]>(
      `SELECT c.id, c.name FROM collections c
       JOIN collection_memberships cm ON cm.collection_id = c.id
       WHERE cm.user_id = ?
       ORDER BY c.name`,
      [req.user!.userId]
    );
    res.json(rows);
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/select-collection
// Switches the active collection. Re-verifies membership against the
// database (never trusts the request body alone) before re-issuing the
// auth cookie with the new collectionId baked in.
router.post('/select-collection', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { collectionId } = req.body as { collectionId?: number };

  if (!collectionId) {
    res.status(400).json({ error: 'collectionId is required' });
    return;
  }

  try {
    const [rows] = await pool.execute<CollectionRow[]>(
      `SELECT c.id, c.name FROM collections c
       JOIN collection_memberships cm ON cm.collection_id = c.id
       WHERE cm.user_id = ? AND c.id = ?`,
      [req.user!.userId, collectionId]
    );

    if (rows.length === 0) {
      res.status(403).json({ error: 'You are not a member of that collection' });
      return;
    }

    // Built explicitly (not spread from req.user) — the decoded JWT also carries
    // exp/iat claims that would collide with the expiresIn option when re-signing.
    const updatedPayload: JwtPayload = {
      userId: req.user!.userId,
      username: req.user!.username,
      role: req.user!.role,
      collectionId: rows[0].id,
    };
    setAuthCookie(res, updatedPayload);
    res.json({ ...updatedPayload, collectionName: rows[0].name });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
