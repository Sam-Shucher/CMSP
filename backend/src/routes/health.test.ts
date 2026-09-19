import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// A probe for whoever is watching the Pi (the tunnel, a cron check, you with a
// phone in a car park): is the app up, and can it still reach its database?
vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../db/connection';
import { createApp } from '../app';
import { resetRateLimits } from '../middleware/rateLimit';
import { HEALTH_MAX_PER_MINUTE } from './health';

const app = createApp();
const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  execute.mockReset();
  resetRateLimits();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/health', () => {
  it('says all is well, without being logged in', async () => {
    execute.mockResolvedValueOnce([[{ ok: 1 }]]);

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('answers 503 when the database can\'t be reached, so a probe can tell', async () => {
    execute.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false });
  });

  // It's reachable from the internet without a login, so it says nothing about
  // versions, paths, or why the database is unhappy.
  it('gives away nothing but up or down', async () => {
    execute.mockRejectedValueOnce(new Error('Access denied for user root@10.1.2.3 (using password: YES)'));

    const res = await request(app).get('/api/health');

    expect(JSON.stringify(res.body)).not.toMatch(/root|password|denied|10\.1\.2\.3/i);
    expect(Object.keys(res.body as object)).toEqual(['ok']);
  });

  it('asks the database only one cheap question', async () => {
    execute.mockResolvedValueOnce([[{ ok: 1 }]]);

    await request(app).get('/api/health');

    expect(execute).toHaveBeenCalledTimes(1);
    expect((execute.mock.calls[0][0] as string).toUpperCase()).toContain('SELECT 1');
  });

  // Public and unauthenticated: a loop hitting it shouldn't become a way to
  // keep the Pi's database busy.
  it('rate limits a caller hammering it', async () => {
    execute.mockResolvedValue([[{ ok: 1 }]]);

    for (let i = 0; i < HEALTH_MAX_PER_MINUTE; i++) {
      expect((await request(app).get('/api/health')).status).toBe(200);
    }
    const blocked = await request(app).get('/api/health');

    expect(blocked.status).toBe(429);
  });
});
