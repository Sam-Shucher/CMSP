import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth, AuthRequest } from './requireAuth';
import { jwtSecret } from '../config';
import { touchSession } from '../db/sessions';

const JWT_SECRET = jwtSecret();
const PAYLOAD = { sid: 'session-1', userId: 1, username: 'owner', collectionId: 5 };

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.clearCookie = vi.fn().mockReturnValue(res);
  return res as Response;
}

async function run(cookies: Record<string, string> | undefined) {
  const req = { cookies } as unknown as AuthRequest;
  const res = mockRes();
  const next = vi.fn();
  await requireAuth(req, res, next);
  return { req, res, next };
}

beforeEach(() => {
  vi.mocked(touchSession).mockReset().mockResolvedValue(true);
});

describe('requireAuth', () => {
  it('attaches the decoded user and continues for a valid token with a live session', async () => {
    const { req, res, next } = await run({ token: jwt.sign(PAYLOAD, JWT_SECRET, { expiresIn: '1h' }) });

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toMatchObject(PAYLOAD);
    expect(res.status).not.toHaveBeenCalled();
    expect(touchSession).toHaveBeenCalledWith('session-1', 1);
  });

  it('rejects a request with no token with 401', async () => {
    const { res, next } = await run({});

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a request with no cookies at all with 401', async () => {
    const { res, next } = await run(undefined);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a forged token signed with a different secret, without a database lookup', async () => {
    const forged = jwt.sign({ ...PAYLOAD, role: 'admin' }, 'attacker-guessed-secret');
    const { req, res, next } = await run({ token: forged });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(touchSession).not.toHaveBeenCalled();
  });

  it('rejects an expired token', async () => {
    const expired = jwt.sign({ ...PAYLOAD, exp: Math.floor(Date.now() / 1000) - 60 }, JWT_SECRET);
    const { res, next } = await run({ token: expired });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired session' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a tampered token (payload edited after signing)', async () => {
    const [header, , signature] = jwt.sign(PAYLOAD, JWT_SECRET).split('.');
    const evilPayload = Buffer.from(JSON.stringify({ ...PAYLOAD, userId: 2 })).toString('base64url');
    const { res, next } = await run({ token: `${header}.${evilPayload}.${signature}` });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an unsigned token that claims it needs no signature ("alg: none")', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(PAYLOAD)).toString('base64url');
    const { res, next } = await run({ token: `${header}.${body}.` });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a token signed with the old hardcoded fallback secret', async () => {
    const { res, next } = await run({ token: jwt.sign(PAYLOAD, 'change-me-in-production') });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects garbage that is not a JWT', async () => {
    const { res, next } = await run({ token: 'not-a-jwt' });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  // Validly signed cookies from before sessions existed carry no session id.
  // They must stop working, or every old 7-day cookie would bypass logout.
  it('rejects an old-style token with no session id', async () => {
    const { userId, username, collectionId } = PAYLOAD;
    const { res, next } = await run({ token: jwt.sign({ userId, username, role: 'admin', collectionId }, JWT_SECRET) });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(touchSession).not.toHaveBeenCalled();
  });

  it('rejects a validly signed token whose session was logged out, expired, or idle too long', async () => {
    vi.mocked(touchSession).mockResolvedValue(false);

    const { res, next } = await run({ token: jwt.sign(PAYLOAD, JWT_SECRET) });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Your session has ended. Please sign in again.' });
    expect(res.clearCookie).toHaveBeenCalledWith('token');
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed if the session check itself errors', async () => {
    vi.mocked(touchSession).mockRejectedValue(new Error('connection lost'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { res, next } = await run({ token: jwt.sign(PAYLOAD, JWT_SECRET) });

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });
});
