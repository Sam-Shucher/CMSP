import { Router, Request } from 'express';
import { requireAuth, AuthRequest } from '../middleware/requireAuth';
import { rateLimit } from '../middleware/rateLimit';
import { route } from '../utils/route';
import { parsePushSubscription, parsePushEndpoint } from '../utils/pushSubscription';
import { pushPublicKey, saveSubscription, removeSubscription, pushTest } from '../services/push';

// Phone notifications (Web Push). A device belongs to a person, not a group —
// it gets their notices from every group they're in, each titled with the
// group's name — so these need a login but no group.

const router = Router();
router.use(requireAuth);

const perPerson = (name: string) => (req: Request) => `${name}:${(req as AuthRequest).user?.userId ?? req.ip}`;

// The app re-sends its subscription each time it opens; this is far above that.
const subscribeLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  key: perPerson('push-subscribe'),
  message: () => 'Too many notification changes — try again later.',
});
// Each test is a real request from the Pi out to the push services.
const testLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  key: perPerson('push-test'),
  message: retryAfter => `That's a lot of tests — try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
});

const NOT_SET_UP = 'Phone notifications aren\'t set up on this server yet';

// GET /api/push/key — what the browser needs to subscribe; null when push
// isn't set up here, so the page can say so instead of offering a dead switch.
router.get('/key', (_req, res) => {
  res.json({ publicKey: pushPublicKey() });
});

// POST /api/push/subscriptions — PushSubscription.toJSON() from this device
router.post('/subscriptions', subscribeLimit, route(async (req, res) => {
  if (!pushPublicKey()) {
    res.status(503).json({ error: NOT_SET_UP });
    return;
  }
  const subscription = parsePushSubscription(req.body);
  if (!subscription.ok) {
    res.status(400).json({ error: subscription.error });
    return;
  }
  // Tied to this sign-in: when it ends, so do this device's notices.
  await saveSubscription(req.user!.userId, req.user!.sid, subscription.value);
  res.json({ message: 'Notifications on' });
}));

// DELETE /api/push/subscriptions { endpoint } — this device, turned off or signed out
router.delete('/subscriptions', subscribeLimit, route(async (req, res) => {
  const endpoint = parsePushEndpoint((req.body as { endpoint?: unknown } | undefined)?.endpoint);
  if (!endpoint.ok) {
    res.status(400).json({ error: endpoint.error });
    return;
  }
  await removeSubscription(req.user!.userId, endpoint.value);
  res.json({ message: 'Notifications off' });
}));

// POST /api/push/test — "did it work?" on the Profile page
router.post('/test', testLimit, route(async (req, res) => {
  if (!pushPublicKey()) {
    res.status(503).json({ error: NOT_SET_UP });
    return;
  }
  res.json({ sent: await pushTest(req.user!.userId) });
}));

export default router;
