import { Router } from 'express';
import { firstValue } from '../db/query';
import { rateLimit } from '../middleware/rateLimit';

// Is the app up, and can it still reach its database? Deliberately the only
// route that answers without a login — a probe (the tunnel, a cron job, you on
// your phone) needs an answer before anyone is signed in.

const router = Router();

// Generous for a monitor checking every few seconds, mean to a loop.
export const HEALTH_MAX_PER_MINUTE = 60;

const limit = rateLimit({
  windowMs: 60 * 1000,
  max: HEALTH_MAX_PER_MINUTE,
  key: req => `health:${req.ip}`,
});

// The answer is one bit: ok or not. Anyone on the internet can ask, so it says
// nothing about versions, hostnames, or why the database is unhappy — that
// belongs in the server's own log, not in a public reply.
router.get('/', limit, async (_req, res) => {
  try {
    await firstValue<number>('SELECT 1 AS ok');
    res.json({ ok: true });
  } catch (err: unknown) {
    console.error('Health check failed:', err instanceof Error ? err.message : err);
    res.status(503).json({ ok: false });
  }
});

export default router;
