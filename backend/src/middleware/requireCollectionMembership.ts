import { Response, NextFunction } from 'express';
import { firstRow } from '../db/query';
import { AuthRequest } from './requireAuth';
import { GroupAccess, GroupAccessRow, groupAccessFrom } from '../utils/groupAccess';

// The group's own settings come along with the membership, so the routes
// behind this never need a second query to learn them.
async function loadMembership(userId: number, collectionId: number): Promise<GroupAccess | null> {
  const row = await firstRow<GroupAccessRow>(
    `SELECT cm.role, c.show_prices
     FROM collection_memberships cm JOIN collections c ON c.id = cm.collection_id
     WHERE cm.user_id = ? AND cm.collection_id = ?`,
    [userId, collectionId]
  );
  return row ? groupAccessFrom(row) : null;
}

export interface CollectionRequest extends AuthRequest {
  // Set by this middleware once membership is confirmed. Optional in the
  // type (like AuthRequest.user) since TypeScript can't verify the
  // middleware ran first — route handlers use req.collectionId! the same
  // way they already use req.user!.
  collectionId?: number;
  // Whether this group shows prices at all (collections.show_prices) — some
  // groups don't want a dollar figure on every mini. Set alongside collectionId.
  showPrices?: boolean;
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
  const pageGroup = req.headers['x-collection-id'];
  if (typeof pageGroup === 'string' && Number(pageGroup) !== collectionId) {
    res.status(409).json({
      error: 'You switched groups in another tab — this page has been updated to match. Please try again.',
      code: 'group_changed',
    });
    return;
  }

  try {
    // requireAuth has usually read this already, in the same query as the
    // session (db/sessions.ts) — it's the same request, so it's just as fresh.
    // Only when it hasn't is the database asked here.
    const preloaded = req.groupAccess?.collectionId === collectionId ? req.groupAccess.membership : undefined;
    const membership = preloaded !== undefined ? preloaded : await loadMembership(req.user!.userId, collectionId);

    if (!membership) {
      res.status(403).json({ error: 'You are not a member of this collection' });
      return;
    }

    // The user's role IN THIS COLLECTION, as it is right now. Everything
    // downstream — requireAdmin, the admin override on editing someone else's
    // mini — uses this, so being an admin elsewhere grants nothing here, and a
    // demotion takes effect on the very next request.
    req.user!.role = membership.role;

    (req as CollectionRequest).collectionId = collectionId;
    (req as CollectionRequest).showPrices = membership.showPrices;
    next();
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}
