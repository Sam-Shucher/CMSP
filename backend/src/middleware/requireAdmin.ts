import { Response, NextFunction } from 'express';
import { AuthRequest } from './requireAuth';

// Middleware that gates routes to admin users only.
// Must be used AFTER requireCollectionMembership, which refreshes req.user.role
// from the database — on its own the role would be the stale copy from the cookie.
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
