import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';
import { rateLimit, resetRateLimits } from './rateLimit';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn().mockReturnValue(res);
  return res as Response;
}

function hit(limiter: ReturnType<typeof rateLimit>, req: Partial<Request>) {
  const res = mockRes();
  const next = vi.fn();
  limiter(req as Request, res, next);
  return { res, next };
}

let now = 0;
const clock = () => now;

beforeEach(() => {
  now = 1_000_000;
  resetRateLimits();
});

describe('rateLimit', () => {
  const byIp = () => rateLimit({ windowMs: 60_000, max: 3, key: req => req.ip, now: clock });

  it('lets requests through up to the limit', () => {
    const limiter = byIp();
    for (let i = 0; i < 3; i++) {
      expect(hit(limiter, { ip: '1.2.3.4' }).next).toHaveBeenCalled();
    }
  });

  it('blocks with 429 and a Retry-After once the limit is passed', () => {
    const limiter = byIp();
    for (let i = 0; i < 3; i++) hit(limiter, { ip: '1.2.3.4' });

    const { res, next } = hit(limiter, { ip: '1.2.3.4' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringMatching(/too many attempts/i) });
  });

  it('counts each key separately', () => {
    const limiter = byIp();
    for (let i = 0; i < 3; i++) hit(limiter, { ip: '1.2.3.4' });

    expect(hit(limiter, { ip: '5.6.7.8' }).next).toHaveBeenCalled();
  });

  it('opens up again once the window has passed', () => {
    const limiter = byIp();
    for (let i = 0; i < 4; i++) hit(limiter, { ip: '1.2.3.4' });

    now += 60_001;

    expect(hit(limiter, { ip: '1.2.3.4' }).next).toHaveBeenCalled();
  });

  it('skips limiting when there is no key to count by (e.g. no email sent — validation rejects that)', () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1, key: () => undefined, now: clock });
    hit(limiter, {});

    expect(hit(limiter, {}).next).toHaveBeenCalled();
  });

  it('can be reset (for tests)', () => {
    const limiter = byIp();
    for (let i = 0; i < 4; i++) hit(limiter, { ip: '1.2.3.4' });

    resetRateLimits();

    expect(hit(limiter, { ip: '1.2.3.4' }).next).toHaveBeenCalled();
  });
});
