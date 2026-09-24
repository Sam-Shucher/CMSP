import { Router, Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { rows, firstRow, change, insert } from '../db/query';
import { requireAuthAllowingTemporaryPassword, JwtPayload } from '../middleware/requireAuth';
import { route } from '../utils/route';
import { validateUsername, validatePassword } from '../utils/validation';
import { jwtSecret, SESSION_LIFETIME_DAYS } from '../config';
import { rateLimit } from '../middleware/rateLimit';
import { emailAddress, optionalText, positiveId, LIMITS } from '../utils/inputs';
import { createSession, revokeSession, revokeAllSessions } from '../db/sessions';
import { hashPassword, verifyPassword, needsRehash } from '../utils/passwords';

const router = Router();

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

// Slow down password guessing: per account (so one password can't be guessed
// slowly from many addresses) and per address (so one attacker can't spray a
// common password across every account).
const loginLimitByAccount = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  max: 10,
  key: req => {
    const { email } = (req.body ?? {}) as { email?: unknown };
    return typeof email === 'string' && email.trim() ? `login:${email.trim().toLowerCase()}` : undefined;
  },
});
const loginLimitByAddress = rateLimit({ windowMs: FIFTEEN_MINUTES, max: 30, key: req => `login-ip:${req.ip}` });
const registerLimitByAddress = rateLimit({ windowMs: ONE_HOUR, max: 10, key: req => `register-ip:${req.ip}` });

// Logging in with an unknown email still runs a full comparison — against a
// hash of a throwaway value, made at the same cost as everyone's real one — so
// the reply takes just as long and can't reveal which emails have accounts.
// Built on the first login rather than at startup, so a slow machine isn't
// held up booting, and cached for the life of the process.
let equalizerHash: Promise<string> | null = null;
function timingEqualizer(): Promise<string> {
  equalizerHash ??= hashPassword(crypto.randomUUID());
  return equalizerHash;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  must_change_password: number;
  temp_password_expired: number | null; // 1 once a temporary password has run out
}

interface MembershipRow {
  collection_id: number;
  role: string | null;
}

interface CollectionRow {
  id: number;
  name: string;
  role: string;
  show_prices?: number | null; // only selected by GET /collections
}

function roleName(role: unknown): 'admin' | 'user' {
  return role === 'admin' ? 'admin' : 'user';
}

// Signs the login cookie: who you are, your server-side session id, and your
// selected collection. httpOnly = page JavaScript can never read it, so an
// injected script can't steal it.
function setAuthCookie(res: Response, payload: JwtPayload): void {
  const { sid, userId, username, collectionId } = payload;
  const token = jwt.sign(
    { sid, userId, username, ...(collectionId ? { collectionId } : {}) },
    jwtSecret(),
    { algorithm: 'HS256', expiresIn: `${SESSION_LIFETIME_DAYS}d` }
  );
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // HTTPS only in prod
    // Strict: the cookie is never attached to a request started by another
    // website. Safe for this app — every authenticated call is a same-site fetch.
    sameSite: 'strict',
    maxAge: SESSION_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
  });
}

// POST /api/auth/register
// Creates a new user account. The email MUST already be on at least one
// collection's invite list. Registering joins every collection whose invite
// list contains the email — so someone pre-invited to two collections at
// once only has to sign up once. New members start as regular users.
router.post('/register', registerLimitByAddress, route(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!body.email || !body.username || !body.password) {
    res.status(400).json({ error: 'Email, username, and password are required' });
    return;
  }
  if (typeof body.username !== 'string' || typeof body.password !== 'string') {
    res.status(400).json({ error: 'Username and password must be text' });
    return;
  }

  // Same rules the register page checks — enforced here too, since the API
  // can be called directly without going through the page.
  for (const result of [validateUsername(body.username), validatePassword(body.password)]) {
    if (!result.valid) {
      res.status(400).json({ error: result.error });
      return;
    }
  }

  const emailCheck = emailAddress(body.email);
  const displayNameCheck = optionalText(body.displayName, 'Display name', LIMITS.displayName);
  const phoneCheck = optionalText(body.phone, 'Phone', LIMITS.phone);
  const neighborhoodCheck = optionalText(body.neighborhood, 'Neighborhood', LIMITS.neighborhood);
  for (const check of [emailCheck, displayNameCheck, phoneCheck, neighborhoodCheck]) {
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }
  }

  const username = body.username;
  const password = body.password;
  const email = (emailCheck as { value: string }).value;
  const displayName = (displayNameCheck as { value: string | null }).value ?? username;
  const phone = (phoneCheck as { value: string | null }).value;
  const neighborhood = (neighborhoodCheck as { value: string | null }).value;

  const approved = await rows<MembershipRow>(
    'SELECT collection_id FROM approved_emails WHERE email = ?',
    [email]
  );
  if (approved.length === 0) {
    res.status(403).json({ error: 'This email is not on the invite list. Ask an admin to add you.' });
    return;
  }

  // Make sure nobody has already claimed this email or username
  const existing = await firstRow<{ id: number }>(
    'SELECT id FROM users WHERE email = ? OR username = ?',
    [email, username]
  );
  if (existing) {
    res.status(409).json({ error: 'Email or username already taken' });
    return;
  }

  // Deliberately slow (see utils/passwords.ts): every guess against a stolen
  // database costs an attacker the same work it costs us once here.
  const passwordHash = await hashPassword(password);

  const account = await insert(
    'INSERT INTO users (email, username, password_hash, display_name, phone, neighborhood) VALUES (?, ?, ?, ?, ?, ?)',
    [email, username, passwordHash, displayName, phone, neighborhood]
  );
  const userId = account.id;

  // Join every collection that invited this email, in one statement.
  await change(
    `INSERT IGNORE INTO collection_memberships (user_id, collection_id) VALUES ${approved.map(() => '(?, ?)').join(', ')}`,
    approved.flatMap(invite => [userId, invite.collection_id])
  );

  // Only auto-select a collection when there's exactly one — otherwise the
  // frontend sends them to the picker before they can do anything else.
  const collectionId = approved.length === 1 ? approved[0].collection_id : undefined;

  const sid = await createSession(userId);
  setAuthCookie(res, { sid, userId, username, collectionId });
  res.status(201).json({ message: 'Account created', username, role: 'user', displayName, collectionId });
}));

async function upgradeStoredHash(userId: number, password: string): Promise<void> {
  try {
    await change('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), userId]);
  } catch (err: unknown) {
    console.error('Upgrading a stored password hash failed:', err);
  }
}

// POST /api/auth/login
// Verifies email + password, starts a server-side session, and issues the cookie.
router.post('/login', loginLimitByAddress, loginLimitByAccount, route(async (req, res) => {
  const { email, password } = (req.body ?? {}) as Record<string, unknown>;

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }
  // Wrong types (objects, arrays) or absurd lengths are never a real login.
  if (typeof email !== 'string' || typeof password !== 'string'
      || email.length > LIMITS.email || password.length > LIMITS.password) {
    res.status(400).json({ error: 'Invalid email or password format' });
    return;
  }

  const user = await firstRow<UserRow>(
    `SELECT id, username, password_hash, display_name, must_change_password,
            temp_password_expires_at < NOW() AS temp_password_expired
     FROM users WHERE email = ?`,
    [email.trim().toLowerCase()]
  );

  // Always run exactly one full comparison — against the stand-in hash when
  // the email has no account — so both cases take the same time.
  const passwordMatches = await verifyPassword(password, user?.password_hash ?? await timingEqualizer());
  if (!user || !passwordMatches) {
    // Same error for "no such user" and "wrong password", so the message
    // can't be used to find out which emails have accounts.
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  // The password is right, but if it's a temporary one an admin set, it may
  // have run out — they need a fresh one rather than a way in.
  if (Number(user.temp_password_expired) === 1) {
    res.status(401).json({ error: 'That temporary password has expired — ask an admin to set a new one.' });
    return;
  }

  const { id, username, display_name } = user;

  // Enter the collection automatically only when there's exactly one;
  // otherwise the app asks which one first.
  const memberships = await rows<MembershipRow>(
    'SELECT collection_id, role FROM collection_memberships WHERE user_id = ?',
    [id]
  );
  const only = memberships.length === 1 ? memberships[0] : undefined;

  const sid = await createSession(id);
  setAuthCookie(res, { sid, userId: id, username, collectionId: only?.collection_id });
  res.json({
    message: 'Logged in',
    username,
    role: roleName(only?.role),
    displayName: display_name,
    collectionId: only?.collection_id,
    // The app asks for a new password before letting them do anything else.
    mustChangePassword: Boolean(user.must_change_password),
  });

  // Their password is right, so we hold it for the only moment we ever will:
  // if it was stored at a weaker cost than we use now, upgrade it. After the
  // reply, so nobody waits through a second hash, and best-effort — a failed
  // upgrade is logged and simply retried at their next sign-in.
  if (needsRehash(user.password_hash)) void upgradeStoredHash(id, password);
}));

// POST /api/auth/logout
// Ends this session on the server — so even a copy of the cookie stops
// working — and clears the cookie. Always succeeds, even with a bad cookie.
router.post('/logout', route(async (req, res) => {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const token = cookies?.token;
  if (typeof token === 'string') {
    try {
      const payload = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'], ignoreExpiration: true }) as Partial<JwtPayload>;
      if (typeof payload.sid === 'string') await revokeSession(payload.sid);
    } catch {
      // Not a cookie we issued, or the database is unreachable — nothing to revoke.
    }
  }
  res.clearCookie('token');
  res.json({ message: 'Logged out' });
}));

// POST /api/auth/logout-all
// "Log out everywhere": ends every session this user has, on every device.
router.post('/logout-all', requireAuthAllowingTemporaryPassword, route(async (req, res) => {
  await revokeAllSessions(req.user!.userId);
  res.clearCookie('token');
  res.json({ message: 'Logged out everywhere' });
}));

// GET /api/auth/me
// Restores the logged-in state on page load: who you are, which collection
// you're in, and your role IN that collection (read fresh from the database).
// If you've been removed from that collection, it's dropped so the app sends
// you back to the group picker; a deleted account is logged out.
router.get('/me', requireAuthAllowingTemporaryPassword, route(async (req, res) => {
  const { userId, collectionId } = req.user!;
  const me = await firstRow<{ username: string; collection_role: string | null; must_change_password: number }>(
    `SELECT u.username, u.must_change_password, cm.role AS collection_role
     FROM users u
     LEFT JOIN collection_memberships cm ON cm.user_id = u.id AND cm.collection_id = ?
     WHERE u.id = ?`,
    [collectionId ?? null, userId]
  );
  if (!me) {
    res.clearCookie('token');
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }
  const stillMember = collectionId !== undefined && me.collection_role !== null;
  res.json({
    userId,
    username: me.username,
    role: stillMember ? roleName(me.collection_role) : 'user',
    mustChangePassword: Boolean(me.must_change_password),
    ...(stillMember ? { collectionId } : {}),
  });
}));

// GET /api/auth/collections
// The collections the current user belongs to, with their role in each —
// used to render the group picker — and whether each shows prices, so the
// app knows whether to offer a price field and a "sort by price".
router.get('/collections', requireAuthAllowingTemporaryPassword, route(async (req, res) => {
  const mine = await rows<CollectionRow>(
    `SELECT c.id, c.name, cm.role, c.show_prices FROM collections c
     JOIN collection_memberships cm ON cm.collection_id = c.id
     WHERE cm.user_id = ?
     ORDER BY c.name`,
    [req.user!.userId]
  );
  res.json(mine.map(c => ({ id: c.id, name: c.name, role: roleName(c.role), showPrices: c.show_prices !== 0 })));
}));

// POST /api/auth/select-collection
// Switches the active collection. Re-verifies membership against the
// database (never trusts the request body alone) before re-issuing the
// cookie for the same session with the new collection, and reports the
// user's role there so the app can show the right view.
router.post('/select-collection', requireAuthAllowingTemporaryPassword, route(async (req, res) => {
  const idCheck = positiveId((req.body as { collectionId?: unknown } | undefined)?.collectionId);
  if (!idCheck.ok) {
    res.status(400).json({ error: 'collectionId is required' });
    return;
  }
  const collectionId = idCheck.value;

  const collection = await firstRow<CollectionRow>(
    `SELECT c.id, c.name, cm.role FROM collections c
     JOIN collection_memberships cm ON cm.collection_id = c.id
     WHERE cm.user_id = ? AND c.id = ?`,
    [req.user!.userId, collectionId]
  );

  if (!collection) {
    res.status(403).json({ error: 'You are not a member of that collection' });
    return;
  }

  const { sid, userId, username } = req.user!;
  setAuthCookie(res, { sid, userId, username, collectionId: collection.id });
  res.json({ userId, username, collectionId: collection.id, collectionName: collection.name, role: roleName(collection.role) });
}));

export default router;
