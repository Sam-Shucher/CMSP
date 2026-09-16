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
