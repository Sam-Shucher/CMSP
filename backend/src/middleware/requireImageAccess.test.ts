import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'express';

vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../db/connection';
import { requireImageAccess } from './requireImageAccess';
import { AuthRequest } from './requireAuth';

const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function reqFor(path: string, userId = 7) {
  return { path, user: { userId, username: 'u', role: 'user' } } as unknown as AuthRequest;
}

beforeEach(() => {
  execute.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('requireImageAccess', () => {
  it('lets a member of the photo\'s collection see it', async () => {
    execute.mockResolvedValueOnce([[{ found: 1 }]]);
    const next = vi.fn();

    await requireImageAccess(reqFor('/1700000000-abc.png'), mockRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('collection_memberships'), ['/uploads/1700000000-abc.png', 7]);
  });

  it('hides a photo from someone outside its collection, as if it did not exist', async () => {
    execute.mockResolvedValueOnce([[]]);
    const res = mockRes();
    const next = vi.fn();

    await requireImageAccess(reqFor('/1700000000-abc.png'), res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    '/../.env',
    '/..%2f.env',
    '/sub/dir.png',
    '/',
    '/.hidden',
    '/name with spaces.png',
  ])('refuses odd paths like %s without touching the database', async (path) => {
    const res = mockRes();
    const next = vi.fn();

    await requireImageAccess(reqFor(path), res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed on a database error', async () => {
    execute.mockRejectedValueOnce(new Error('connection lost'));
    const res = mockRes();
    const next = vi.fn();

    await requireImageAccess(reqFor('/a.png'), res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });
});
