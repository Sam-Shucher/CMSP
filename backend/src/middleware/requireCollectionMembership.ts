import { Response, NextFunction } from 'express';
import { RowDataPacket } from 'mysql2';
import { pool } from '../db/connection';
import { AuthRequest } from './requireAuth';

export interface CollectionRequest extends AuthRequest {
  // Set by this middleware once membership is confirmed. Optional in the
  // type (like AuthRequest.user) since TypeScript can't verify the
  // middleware ran first — route handlers use req.collectionId! the same
  // way they already use req.user!.
  collectionId?: number;
}

// Gates every collection-scoped route (minis, admin). The JWT's collectionId
// is only ever treated as a *request* — this middleware re-verifies it
// against collection_memberships on every call before trusting it, so a
// membership revoked after the token was issued is caught immediately
// instead of waiting for the token to expire. This is the core of the
// access-control boundary between collections: nothing downstream may query
// mini data without going through here first.
export async function requireCollectionMembership(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const collectionId = req.user?.collectionId;

  if (!collectionId) {
    res.status(400).json({ error: 'Select a collection first' });
    return;
  }

  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT id FROM collection_memberships WHERE user_id = ? AND collection_id = ?',
      [req.user!.userId, collectionId]
    );

    if (rows.length === 0) {
      res.status(403).json({ error: 'You are not a member of this collection' });
      return;
    }

    (req as CollectionRequest).collectionId = collectionId;
    next();
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}
