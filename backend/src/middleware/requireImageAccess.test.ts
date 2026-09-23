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
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('collection_memberships'),
      ['/uploads/1700000000-abc.png', 7, '/uploads/1700000000-abc.png', 7, 7]
    );
  });

  // A condition photo belongs to a loan, and a loan is only ever visible to
  // its two people — so the second branch asks about the loan, not about
  // membership of the collection.
  it('asks whether a condition photo\'s asker is on that loan, either side', async () => {
    execute.mockResolvedValueOnce([[{ found: 1 }]]);

    await requireImageAccess(reqFor('/1700000000-abc.png'), mockRes(), vi.fn());

    const [sql] = execute.mock.calls[0];
    expect(String(sql)).toContain('loan_condition_photos');
    expect(String(sql)).toMatch(/l\.borrower_id = \? OR l\.owner_id = \?/);
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
