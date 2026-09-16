import jwt from 'jsonwebtoken';
import { JwtPayload } from '../middleware/requireAuth';

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production';

// Signs a token identical in shape to the one auth.ts issues at login, so
// route tests can simulate "logged in as this user" without hitting /login.
export function authCookie(payload: JwtPayload): string {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  return `token=${token}`;
}
