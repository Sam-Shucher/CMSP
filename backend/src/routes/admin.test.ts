import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { authCookie } from '../test/helpers';

vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../db/connection';
import { createApp } from '../app';

const app = createApp();
const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;

const ADMIN = { userId: 1, username: 'boss', role: 'admin' };
const USER = { userId: 2, username: 'grunt', role: 'user' };

beforeEach(() => {
  execute.mockReset();
});

describe('DELETE /api/admin/users/:id', () => {
  it('lets an admin delete a different user', async () => {
    execute.mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .delete('/api/admin/users/2')
      .set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM users'), ['2']);
  });

  it('blocks an admin from deleting their own account', async () => {
    const res = await request(app)
      .delete('/api/admin/users/1')
      .set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns 404 when the target user does not exist', async () => {
    execute.mockResolvedValueOnce([{ affectedRows: 0 }]);

    const res = await request(app)
      .delete('/api/admin/users/999')
      .set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(404);
  });

  it('rejects a non-admin with 403', async () => {
    const res = await request(app)
      .delete('/api/admin/users/2')
      .set('Cookie', authCookie(USER));

    expect(res.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns 401 with no auth cookie', async () => {
    const res = await request(app).delete('/api/admin/users/2');
    expect(res.status).toBe(401);
  });
});
