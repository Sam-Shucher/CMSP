import { Router, Response } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { route, idFrom } from '../utils/route';
import { requireCollectionMembership, CollectionRequest } from '../middleware/requireCollectionMembership';
import {
  placeHold, leaveHold, watchMini, unwatchMini, holdSummary, listMyHolds, HoldFailure,
} from '../services/holds';

const router = Router();

// Holds are scoped to the caller's active collection, like the minis themselves.
router.use(requireAuth, requireCollectionMembership);

// Any id that isn't a positive whole number simply matches no mini.
function miniIdFrom(req: CollectionRequest, res: Response): number | null {
  const id = idFrom(req.params.miniId);
  if (id === null) res.status(404).json({ error: 'Mini not found' });
  return id;
}

function fail(res: Response, failure: HoldFailure): void {
  res.status(failure.status).json({ error: failure.error, ...(failure.code ? { code: failure.code } : {}) });
}

// GET /api/holds — your holds (with positions) and notify-list entries
router.get('/', route(async (req, res) => {
  res.json(await listMyHolds(req.user!.userId, req.collectionId!));
}));

// GET /api/holds/minis/:miniId — the line for one mini, as you're allowed to see it
router.get('/minis/:miniId', route(async (req, res) => {
  const miniId = miniIdFrom(req, res);
  if (miniId === null) return;
  const summary = await holdSummary(miniId, req.user!.userId, req.collectionId!);
  if (!summary) {
    res.status(404).json({ error: 'Mini not found' });
    return;
  }
  res.json(summary);
}));

// POST /api/holds/minis/:miniId — get in line
router.post('/minis/:miniId', route(async (req, res) => {
  const miniId = miniIdFrom(req, res);
  if (miniId === null) return;
  const result = await placeHold(miniId, req.user!.userId, req.collectionId!);
  if (!result.ok) return fail(res, result);
  res.status(201).json({ position: result.position });
}));

// DELETE /api/holds/minis/:miniId — leave the line
router.delete('/minis/:miniId', route(async (req, res) => {
  const miniId = miniIdFrom(req, res);
  if (miniId === null) return;
  const result = await leaveHold(miniId, req.user!.userId, req.collectionId!);
  if (!result.ok) return fail(res, result);
  res.json({ message: 'Left the line' });
}));

// POST /api/holds/minis/:miniId/watch — notify me when a spot opens
router.post('/minis/:miniId/watch', route(async (req, res) => {
  const miniId = miniIdFrom(req, res);
  if (miniId === null) return;
  const result = await watchMini(miniId, req.user!.userId, req.collectionId!);
  if (!result.ok) return fail(res, result);
  res.json({ watching: true });
}));

// DELETE /api/holds/minis/:miniId/watch — stop notifying me
router.delete('/minis/:miniId/watch', route(async (req, res) => {
  const miniId = miniIdFrom(req, res);
  if (miniId === null) return;
  const result = await unwatchMini(miniId, req.user!.userId, req.collectionId!);
  if (!result.ok) return fail(res, result);
  res.json({ watching: false });
}));

export default router;
