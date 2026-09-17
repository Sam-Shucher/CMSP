import jwt from 'jsonwebtoken';
import { JwtPayload } from '../middleware/requireAuth';
import { jwtSecret } from '../config';

// What the mocked createSession returns in unit tests (see test/unitSetup.ts).
export const TEST_SESSION_ID = 'test-session-id';

// The session id authCookie uses for a user unless told otherwise. Integration
// tests create a real session row with this id (test/dbHelpers.ts), so a
// cookie from authCookie works against the real database too.
export function testSessionId(userId: number): string {
  return `test-session-${userId}`;
}

// Signs a token identical in shape to the one auth.ts issues at login, so
// route tests can simulate "logged in as this user" without hitting /login.
// `role` is accepted for readability at call sites but never trusted by the
// server, which always reads roles from the database.
export function authCookie(payload: Omit<JwtPayload, 'sid'> & { sid?: string; role?: string }): string {
  const token = jwt.sign(
    { sid: testSessionId(payload.userId), ...payload },
    jwtSecret(),
    { algorithm: 'HS256', expiresIn: '7d' }
  );
  return `token=${token}`;
}
