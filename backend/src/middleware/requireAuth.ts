import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { jwtSecret } from '../config';
import { touchSession } from '../db/sessions';

// What's inside the signed login cookie. Deliberately minimal: who you are,
// which server-side session this is, and which collection you've selected.
// No role — roles live on collection memberships and are always read fresh
// from the database (see requireCollectionMembership).
export interface JwtPayload {
  sid: string;
  userId: number;
  username: string;
  // The collection the user most recently selected (see /api/auth/select-collection).
  // Absent until they pick one. Never trusted alone for access control —
  // requireCollectionMembership re-verifies it on every request.
  collectionId?: number;
  // Set by requireCollectionMembership from the database: the user's role in
  // the active collection. Never read from the cookie.
  role?: string;
}

// Express's Request type doesn't have a `user` field by default.
// We extend it here so route handlers can read req.user after this middleware runs.
export interface AuthRequest extends Request {
  user?: JwtPayload;
}

// Protects routes that need a logged-in user. Two checks, both required:
//   1. the cookie's signature is ours and it hasn't expired, and
//   2. its server-side session is still live — not logged out, not idle too
//      long, not past its lifetime (db/sessions.ts).
export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  // cookie-parser populates req.cookies, but this must hold up even if it
  // somehow didn't run — no cookies means no session, not a crash.
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const token: unknown = cookies?.token;

  if (typeof token !== 'string' || !token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  let payload: Partial<JwtPayload>;
  try {
    // Pinning the algorithm stops a token from choosing how it gets checked.
    // What's inside is still unverified data — the checks below vet it.
    payload = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] }) as Partial<JwtPayload>;
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  // Cookies issued before server-side sessions existed have no session id —
  // they can't be logged out, so they're no longer accepted.
  if (typeof payload.sid !== 'string' || typeof payload.userId !== 'number') {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  try {
    if (!(await touchSession(payload.sid, payload.userId))) {
      res.clearCookie('token');
      res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
      return;
    }
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
    return;
  }

  const { sid, userId, username, collectionId } = payload as JwtPayload;
  req.user = { sid, userId, username, ...(collectionId ? { collectionId } : {}) };
  next();
}
