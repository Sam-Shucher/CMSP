import { Router, Response } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireCollectionMembership, CollectionRequest } from '../middleware/requireCollectionMembership';
import { listNotifications, markNotificationRead, markAllNotificationsRead } from '../db/notifications';

const router = Router();

// Your notifications for the group you're currently in.
router.use(requireAuth, requireCollectionMembership);

// GET /api/notifications — newest 50, plus the unread count
router.get('/', async (req: CollectionRequest, res: Response): Promise<void> => {
  try {
    res.json(await listNotifications(req.user!.userId, req.collectionId!));
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/notifications/read-all
router.post('/read-all', async (req: CollectionRequest, res: Response): Promise<void> => {
  try {
    await markAllNotificationsRead(req.user!.userId, req.collectionId!);
    res.json({ message: 'All read' });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/notifications/:id/read — only your own; anything else is 404
router.post('/:id/read', async (req: CollectionRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: 'Notification not found' });
    return;
  }
  try {
    if (!(await markNotificationRead(id, req.user!.userId, req.collectionId!))) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }
    res.json({ message: 'Read' });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
