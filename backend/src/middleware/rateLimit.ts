import { Request, Response, NextFunction } from 'express';

// A small in-memory rate limiter. The app is a single process on one Pi, so
// memory is the right place to count — no extra service needed. Counts reset
// when the server restarts, which is fine for slowing down password guessing.

interface Options {
  windowMs: number;
  max: number;
  // What to count by (IP address, email being logged into). Returning
  // undefined skips limiting for that request.
  key: (req: Request) => string | undefined;
  // What the caller is told when they hit it. The default is worded for a
  // sign-in form; anything else should say what it means there.
  message?: (retryAfterSeconds: number) => string;
  now?: () => number; // injectable clock for tests
}

const defaultMessage = (retryAfterSeconds: number): string =>
  `Too many attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`;

type Limiter = ((req: Request, res: Response, next: NextFunction) => void) & { reset: () => void };

const limiters = new Set<Limiter>();
const MAX_TRACKED_KEYS = 10_000;

export function rateLimit({ windowMs, max, key, message = defaultMessage, now = Date.now }: Options): Limiter {
  const hits = new Map<string, { count: number; resetAt: number }>();

  const limiter = ((req: Request, res: Response, next: NextFunction): void => {
    const k = key(req);
    if (!k) {
      next();
      return;
    }

    const time = now();
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= time) {
      // Keep memory bounded if someone sprays many different keys.
      if (hits.size >= MAX_TRACKED_KEYS) {
        for (const [storedKey, stored] of hits) {
          if (stored.resetAt <= time) hits.delete(storedKey);
        }
        if (hits.size >= MAX_TRACKED_KEYS) hits.clear();
      }
      entry = { count: 0, resetAt: time + windowMs };
      hits.set(k, entry);
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfterSeconds = Math.ceil((entry.resetAt - time) / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: message(retryAfterSeconds) });
      return;
    }
    next();
  }) as Limiter;

  limiter.reset = () => hits.clear();
  limiters.add(limiter);
  return limiter;
}

export function resetRateLimits(): void {
  for (const limiter of limiters) limiter.reset();
}
