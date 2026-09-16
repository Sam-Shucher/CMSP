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

const COLLECTION_A = 10;
const COLLECTION_B = 20;

const ADMIN = { userId: 1, username: 'boss', role: 'admin', collectionId: COLLECTION_A };
const ADMIN_OTHER_COLLECTION = { userId: 1, username: 'boss', role: 'admin', collectionId: COLLECTION_B };
const USER = { userId: 2, username: 'grunt', role: 'user', collectionId: COLLECTION_A };

const MEMBERSHIP_CONFIRMED = [[{ id: 1 }]];

beforeEach(() => {
  execute.mockReset();
});

describe('Collection access control', () => {
  it('rejects a non-admin with 403 even if they are a member of the collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).get('/api/admin/users').set('Cookie', authCookie(USER));

    expect(res.status).toBe(403);
  });

  it('rejects an admin who is not a member of their claimed collection with 403', async () => {
    execute.mockResolvedValueOnce([[]]); // no membership row

    const res = await request(app).get('/api/admin/users').set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/approved-emails', () => {
  it('scopes the invite list to the admin\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/admin/approved-emails').set('Cookie', authCookie(ADMIN));

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('ae.collection_id = ?'),
      [COLLECTION_A]
    );
  });
});

describe('POST /api/admin/approved-emails', () => {
  it('adds the email scoped to the admin\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([{}]);

    const res = await request(app)
      .post('/api/admin/approved-emails')
      .set('Cookie', authCookie(ADMIN))
      .send({ email: 'friend@example.com' });

    expect(res.status).toBe(201);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO approved_emails'),
      ['friend@example.com', COLLECTION_A, ADMIN.userId]
    );
  });
});

describe('DELETE /api/admin/approved-emails/:id', () => {
  it('deletes an invite row belonging to the admin\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .delete('/api/admin/approved-emails/7')
      .set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('collection_id'), ['7', COLLECTION_A]);
  });

  it('returns 404 for an invite row belonging to a different collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([{ affectedRows: 0 }]);

    const res = await request(app)
      .delete('/api/admin/approved-emails/7')
      .set('Cookie', authCookie(ADMIN_OTHER_COLLECTION));

    expect(res.status).toBe(404);
  });
});

describe('GET /api/admin/users', () => {
  it('only returns members of the admin\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/admin/users').set('Cookie', authCookie(ADMIN));

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('cm.collection_id = ?'),
      [COLLECTION_A]
    );
  });
});

describe('PATCH /api/admin/users/:id/role', () => {
  it('changes the role of a member of the admin\'s active collection', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ id: 1 }]]) // target is a member of this collection
      .mockResolvedValueOnce([{}]);

    const res = await request(app)
      .patch('/api/admin/users/2/role')
      .set('Cookie', authCookie(ADMIN))
      .send({ role: 'admin' });

    expect(res.status).toBe(200);
  });

  it('returns 404 for a user who is not a member of the admin\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .patch('/api/admin/users/2/role')
      .set('Cookie', authCookie(ADMIN))
      .send({ role: 'admin' });

    expect(res.status).toBe(404);
  });

  it('rejects an invalid role value with 400', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app)
      .patch('/api/admin/users/2/role')
      .set('Cookie', authCookie(ADMIN))
      .send({ role: 'superadmin' });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/admin/users/:id (remove from collection)', () => {
  it('removes the membership but keeps the account when they belong to other collections too', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)     // admin's own membership check
      .mockResolvedValueOnce([[{ id: 5 }]])             // target is a member of this collection
      .mockResolvedValueOnce([{}])                       // DELETE FROM collection_memberships
      .mockResolvedValueOnce([[{ count: 1 }]]);          // still a member of 1 other collection

    const res = await request(app)
      .delete('/api/admin/users/2')
      .set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(200);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM users'), expect.anything());
  });

  it('also deletes the account when this was their last collection', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ id: 5 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ count: 0 }]])
      .mockResolvedValueOnce([{}]); // DELETE FROM users

    const res = await request(app)
      .delete('/api/admin/users/2')
      .set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM users'), ['2']);
  });

  it('returns 404 for a user who is not a member of the admin\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .delete('/api/admin/users/2')
      .set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(404);
  });

  it('blocks removing your own membership from your own active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED); // requireCollectionMembership's own check

    const res = await request(app)
      .delete('/api/admin/users/1') // ADMIN.userId
      .set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(400);
  });
});
