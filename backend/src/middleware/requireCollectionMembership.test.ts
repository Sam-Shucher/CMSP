import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'express';

vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../db/connection';
import { requireCollectionMembership, CollectionRequest } from './requireCollectionMembership';

const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  execute.mockReset();
});

describe('requireCollectionMembership', () => {
  it('calls next() and attaches req.collectionId when the DB confirms membership', async () => {
    execute.mockResolvedValueOnce([[{ id: 1 }]]); // membership row found

    const req = { user: { userId: 1, username: 'owner', role: 'user', collectionId: 5 } } as unknown as CollectionRequest;
    const res = mockRes();
    const next = vi.fn();

    await requireCollectionMembership(req, res, next);

    expect(next).toHaveBeenCalledWith(); // called with no error
    expect(req.collectionId).toBe(5);
  });

  it('rejects with 403 when the DB shows no membership row (even though the JWT claims one)', async () => {
    execute.mockResolvedValueOnce([[]]); // no membership row — e.g. an admin removed them since the token was issued

    const req = { user: { userId: 1, username: 'owner', role: 'user', collectionId: 5 } } as unknown as CollectionRequest;
    const res = mockRes();
    const next = vi.fn();

    await requireCollectionMembership(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  // The role inside a login cookie is a snapshot from when they logged in —
  // good for up to 7 days. Access decisions must use the role as it is NOW.
  it('replaces a stale admin role from the cookie with the current role from the database', async () => {
    execute.mockResolvedValueOnce([[{ role: 'user' }]]); // demoted since they logged in

    const req = { user: { userId: 1, username: 'boss', role: 'admin', collectionId: 5 } } as unknown as CollectionRequest;
    const next = vi.fn();
    await requireCollectionMembership(req, mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(req.user!.role).toBe('user');
  });

  it('picks up a promotion immediately, without logging in again', async () => {
    execute.mockResolvedValueOnce([[{ role: 'admin' }]]);

    const req = { user: { userId: 1, username: 'grunt', role: 'user', collectionId: 5 } } as unknown as CollectionRequest;
    await requireCollectionMembership(req, mockRes(), vi.fn());

    expect(req.user!.role).toBe('admin');
  });

  it('treats any unexpected role value from the database as a plain user', async () => {
    execute.mockResolvedValueOnce([[{ role: null }]]);

    const req = { user: { userId: 1, username: 'boss', role: 'admin', collectionId: 5 } } as unknown as CollectionRequest;
    await requireCollectionMembership(req, mockRes(), vi.fn());

    expect(req.user!.role).toBe('user');
  });

  it('fails closed with a 500 (never next()) if the membership check itself errors', async () => {
    execute.mockRejectedValueOnce(new Error('connection lost'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = { user: { userId: 1, username: 'owner', role: 'user', collectionId: 5 } } as unknown as CollectionRequest;
    const res = mockRes();
    const next = vi.fn();

    await requireCollectionMembership(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
    expect(req.collectionId).toBeUndefined();
  });

  it('checks membership for the user in the token, against the collection in the token', async () => {
    execute.mockResolvedValueOnce([[{ id: 1 }]]);

    const req = { user: { userId: 7, username: 'owner', role: 'user', collectionId: 5 } } as unknown as CollectionRequest;
    await requireCollectionMembership(req, mockRes(), vi.fn());

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('collection_memberships'), [7, 5]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('role'), [7, 5]);
  });

  it('rejects with 400 when no collection has been selected yet', async () => {
    const req = { user: { userId: 1, username: 'owner', role: 'user' } } as unknown as CollectionRequest;
    const res = mockRes();
    const next = vi.fn();

    await requireCollectionMembership(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(execute).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
