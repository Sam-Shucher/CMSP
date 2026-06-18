import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production';

// The data we embed inside the JWT when a user logs in.
// This is what gets decoded and attached to req.user on each request.
export interface JwtPayload {
  userId: number;
  username: string;
  role: string;
}

// Express's Request type doesn't have a `user` field by default.
// We extend it here so route handlers can read req.user after this middleware runs.
export interface AuthRequest extends Request {
  user?: JwtPayload;
}

// Middleware that protects routes. Attach it to any route that requires login.
// Reads the JWT from the httpOnly cookie (set at login), verifies its signature,
// and attaches the decoded payload to req.user so route handlers can use it.
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token: string | undefined = req.cookies?.token;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    // jwt.verify throws if the token is expired or the signature doesn't match our secret
    req.user = jwt.verify(token, JWT_SECRET) as JwtPayload;
    next(); // token is valid — let the request continue to the route handler
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}
