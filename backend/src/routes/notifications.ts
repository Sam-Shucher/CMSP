import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireCollectionMembership } from '../middleware/requireCollectionMembership';
import { route, idFrom } from '../utils/route';
import {
  listNotifications, markNotificationRead, markNotificationUnread,
  markAllNotificationsRead, dismissNotification,
} from '../db/notifications';

const router = Router();

// Your notifications for the group you're currently in.
router.use(requireAuth, requireCollectionMembership);

// GET /api/notifications — newest 50, plus the unread count
router.get('/', route(async (req, res) => {
  res.json(await listNotifications(req.user!.userId, req.collectionId!));
}));

// POST /api/notifications/read-all
router.post('/read-all', route(async (req, res) => {
  await markAllNotificationsRead(req.user!.userId, req.collectionId!);
  res.json({ message: 'All read' });
}));

// Each of these acts on one of your own notifications; anything else is 404.
function oneNotification(
  apply: (id: number, userId: number, collectionId: number) => Promise<boolean>,
  message: string
) {
  return route(async (req, res) => {
    const id = idFrom(req.params.id);
    const done = id !== null && await apply(id, req.user!.userId, req.collectionId!);
    if (!done) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }
    res.json({ message });
  });
}

// POST /api/notifications/:id/read
router.post('/:id/read', oneNotification(markNotificationRead, 'Read'));

// POST /api/notifications/:id/unread — stops the two-day countdown
router.post('/:id/unread', oneNotification(markNotificationUnread, 'Unread'));

// DELETE /api/notifications/:id — dismissed for good
router.delete('/:id', oneNotification(dismissNotification, 'Dismissed'));

export default router;
