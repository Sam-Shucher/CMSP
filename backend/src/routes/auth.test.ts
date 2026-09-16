import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { authCookie } from '../test/helpers';

vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../db/connection';
import { createApp } from '../app';

const app = createApp();
const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;

const USER = { userId: 1, username: 'owner', role: 'user' };

beforeEach(() => {
  execute.mockReset();
});

describe('POST /api/auth/register', () => {
  it('joins the single collection that invited the email, and selects it immediately', async () => {
    execute
      .mockResolvedValueOnce([[{ collection_id: 5 }]]) // approved_emails lookup — invited to one collection
      .mockResolvedValueOnce([[]])                       // existing email/username check — none
      .mockResolvedValueOnce([{ insertId: 1 }])          // INSERT INTO users
      .mockResolvedValueOnce([{}]);                      // INSERT IGNORE INTO collection_memberships

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'new@example.com', username: 'newperson', password: 'validpass1' });

    expect(res.status).toBe(201);
    expect(res.body.collectionId).toBe(5);
    expect(res.headers['set-cookie']?.[0]).toMatch(/^token=/);
  });

  it('joins every collection that invited the email, and leaves the choice for later when there is more than one', async () => {
    execute
      .mockResolvedValueOnce([[{ collection_id: 5 }, { collection_id: 6 }]]) // invited to two collections
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([{}]) // membership 1
      .mockResolvedValueOnce([{}]); // membership 2

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'new@example.com', username: 'newperson', password: 'validpass1' });

    expect(res.status).toBe(201);
    expect(res.body.collectionId).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT IGNORE INTO collection_memberships'), [1, 5]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT IGNORE INTO collection_memberships'), [1, 6]);
  });

  it('rejects an email that is not on any collection\'s invite list', async () => {
    execute.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'stranger@example.com', username: 'stranger', password: 'validpass1' });

    expect(res.status).toBe(403);
  });
});

describe('POST /api/auth/login', () => {
  it('auto-selects the collection when the user belongs to exactly one', async () => {
    const passwordHash = await bcrypt.hash('validpass1', 4);
    execute
      .mockResolvedValueOnce([[{ id: 1, username: 'owner', password_hash: passwordHash, role: 'user', display_name: 'Owner' }]])
      .mockResolvedValueOnce([[{ collection_id: 5 }]]);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'validpass1' });

    expect(res.status).toBe(200);
    expect(res.body.collectionId).toBe(5);
  });

  it('leaves the collection unselected when the user belongs to more than one', async () => {
    const passwordHash = await bcrypt.hash('validpass1', 4);
    execute
      .mockResolvedValueOnce([[{ id: 1, username: 'owner', password_hash: passwordHash, role: 'user', display_name: 'Owner' }]])
      .mockResolvedValueOnce([[{ collection_id: 5 }, { collection_id: 6 }]]);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'validpass1' });

    expect(res.status).toBe(200);
    expect(res.body.collectionId).toBeUndefined();
  });
});

describe('GET /api/auth/collections', () => {
  it('returns the collections the current user belongs to', async () => {
    execute.mockResolvedValueOnce([[{ id: 5, name: 'Chicago' }, { id: 6, name: 'dojo' }]]);

    const res = await request(app)
      .get('/api/auth/collections')
      .set('Cookie', authCookie(USER));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 5, name: 'Chicago' }, { id: 6, name: 'dojo' }]);
  });

  it('returns 401 with no auth cookie', async () => {
    const res = await request(app).get('/api/auth/collections');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/select-collection', () => {
  it('selects a collection the user is a member of', async () => {
    execute.mockResolvedValueOnce([[{ id: 6, name: 'dojo' }]]);

    const res = await request(app)
      .post('/api/auth/select-collection')
      .set('Cookie', authCookie(USER))
      .send({ collectionId: 6 });

    expect(res.status).toBe(200);
    expect(res.body.collectionId).toBe(6);
    expect(res.body.collectionName).toBe('dojo');
  });

  it('rejects a collection the user does not belong to', async () => {
    execute.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post('/api/auth/select-collection')
      .set('Cookie', authCookie(USER))
      .send({ collectionId: 99 });

    expect(res.status).toBe(403);
  });

  it('returns 401 with no auth cookie', async () => {
    const res = await request(app).post('/api/auth/select-collection').send({ collectionId: 6 });
    expect(res.status).toBe(401);
  });
});
