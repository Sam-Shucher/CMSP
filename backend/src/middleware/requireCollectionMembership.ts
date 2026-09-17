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

  // The page says which group it's showing. If that's not the session's group,
  // the person switched groups in another tab — acting now would quietly land
  // in the other group (a mini added there, a request sent there).
  const pageGroup = req.headers?.['x-collection-id'];
  if (typeof pageGroup === 'string' && Number(pageGroup) !== collectionId) {
    res.status(409).json({
      error: 'You switched groups in another tab — this page has been updated to match. Please try again.',
      code: 'group_changed',
    });
    return;
  }

  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT cm.role FROM collection_memberships cm WHERE cm.user_id = ? AND cm.collection_id = ?',
      [req.user!.userId, collectionId]
    );

    if (rows.length === 0) {
      res.status(403).json({ error: 'You are not a member of this collection' });
      return;
    }

    // The user's role IN THIS COLLECTION, as it is right now. Everything
    // downstream — requireAdmin, the admin override on editing someone else's
    // mini — uses this, so being an admin elsewhere grants nothing here, and a
    // demotion takes effect on the very next request.
    req.user!.role = rows[0].role === 'admin' ? 'admin' : 'user';

    (req as CollectionRequest).collectionId = collectionId;
    next();
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}
