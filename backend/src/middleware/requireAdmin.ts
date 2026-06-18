import { Response, NextFunction } from 'express';
import { AuthRequest } from './requireAuth';

// Middleware that gates routes to admin users only.
// Must be used AFTER requireAuth — it assumes req.user is already populated.
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
