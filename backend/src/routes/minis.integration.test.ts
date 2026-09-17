import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { createApp } from '../app';
import { pool } from '../db/connection';
import { authCookie } from '../test/helpers';
import { createTestSession } from '../test/dbHelpers';

// These tests hit a real MariaDB (see ../../../docker-compose.test.yml) instead
// of a mocked pool, so they catch SQL that only breaks against a real server —
// e.g. a GROUP BY the server's sql_mode rejects, or a column that doesn't exist.
// Requires: docker compose -f docker-compose.test.yml up -d

const app = createApp();

beforeAll(async () => {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    throw new Error(
      'Could not reach the test database. Start it first with:\n' +
      '  docker compose -f docker-compose.test.yml up -d\n' +
      `Original error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
});

afterAll(async () => {
  await pool.end();
});

// Clean slate between tests — order matters because of FK constraints.
beforeEach(async () => {
  await pool.query('DELETE FROM mini_tags');
  await pool.query('DELETE FROM mini_images');
  await pool.query('DELETE FROM minis');
  await pool.query('DELETE FROM tags');
  await pool.query('DELETE FROM approved_emails');
  await pool.query('DELETE FROM collection_memberships');
  await pool.query('DELETE FROM sessions');
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM collections');
});

async function createCollection(name: string): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>('INSERT INTO collections (name) VALUES (?)', [name]);
  return result.insertId;
}

// Creates a user and joins them to a collection (creating one named after
// them if none is given) — returns both ids since almost every test needs
// the collectionId to build an authCookie.
async function createTestUser(
  overrides: Partial<{ email: string; username: string; role: string; collectionId: number }> = {}
): Promise<{ userId: number; collectionId: number }> {
  const passwordHash = await bcrypt.hash('irrelevant-password', 4); // low rounds — speed, not security, in tests
  const [result] = await pool.execute<ResultSetHeader>(
    'INSERT INTO users (email, username, password_hash, display_name) VALUES (?, ?, ?, ?)',
    [
      overrides.email ?? 'owner@example.com',
      overrides.username ?? 'owner',
      passwordHash,
      'Owner Name',
    ]
  );
  const userId = result.insertId;

  // `role` is the user's role in this collection.
  const collectionId = overrides.collectionId ?? (await createCollection(`${overrides.username ?? 'owner'}'s collection`));
  await pool.execute(
    'INSERT INTO collection_memberships (user_id, collection_id, role) VALUES (?, ?, ?)',
    [userId, collectionId, overrides.role ?? 'user']
  );
  await createTestSession(userId);

  return { userId, collectionId };
}

describe('GET /api/minis (real database)', () => {
  it('returns an empty array when no minis exist yet', async () => {
    const { userId, collectionId } = await createTestUser();

    const res = await request(app)
      .get('/api/minis')
      .set('Cookie', authCookie({ userId, username: 'owner', role: 'user', collectionId }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns a mini with its tags correctly joined and price as a number', async () => {
    const { userId, collectionId } = await createTestUser();
    const [miniResult] = await pool.execute<ResultSetHeader>(
      'INSERT INTO minis (name, description, owner_id, collection_id, price) VALUES (?, ?, ?, ?, ?)',
      ['Dire Wolf', 'A wolf', userId, collectionId, 5]
    );
    const miniId = miniResult.insertId;

    await pool.execute('INSERT IGNORE INTO tags (name) VALUES (?)', ['painted']);
    const [[tagRow]] = await pool.query<RowDataPacket[]>('SELECT id FROM tags WHERE name = ?', ['painted']);
    await pool.execute('INSERT INTO mini_tags (mini_id, tag_id) VALUES (?, ?)', [miniId, tagRow.id]);

    const res = await request(app)
      .get('/api/minis')
      .set('Cookie', authCookie({ userId, username: 'owner', role: 'user', collectionId }));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ name: 'Dire Wolf', tags: ['painted'], price: 5 });
  });

  it('filters by search term and by tag against the real WHERE clauses', async () => {
    const { userId, collectionId } = await createTestUser();
    await pool.execute('INSERT INTO minis (name, owner_id, collection_id) VALUES (?, ?, ?)', ['Dire Wolf', userId, collectionId]);
    await pool.execute('INSERT INTO minis (name, owner_id, collection_id) VALUES (?, ?, ?)', ['Beholder', userId, collectionId]);

    const cookie = authCookie({ userId, username: 'owner', role: 'user', collectionId });
    const res = await request(app).get('/api/minis?q=wolf').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Dire Wolf');
  });
});

describe('Collection isolation (real database)', () => {
  it('never returns another collection\'s minis in the list, even to an admin of their own collection', async () => {
    const chicago = await createTestUser({ username: 'chicago-owner', email: 'chicago@example.com' });
    const dojo = await createTestUser({ username: 'dojo-owner', email: 'dojo@example.com', role: 'admin' });

    await pool.execute('INSERT INTO minis (name, owner_id, collection_id) VALUES (?, ?, ?)', ['Chicago Wolf', chicago.userId, chicago.collectionId]);
    await pool.execute('INSERT INTO minis (name, owner_id, collection_id) VALUES (?, ?, ?)', ['Dojo Wolf', dojo.userId, dojo.collectionId]);

    const dojoAdminCookie = authCookie({ userId: dojo.userId, username: 'dojo-owner', role: 'admin', collectionId: dojo.collectionId });
    const listRes = await request(app).get('/api/minis').set('Cookie', dojoAdminCookie);

    expect(listRes.status).toBe(200);
    expect(listRes.body.map((m: { name: string }) => m.name)).toEqual(['Dojo Wolf']);
  });

  it('never leaks another collection\'s tag names into the tag filter list', async () => {
    const chicago = await createTestUser({ username: 'chicago-owner', email: 'chicago@example.com' });
    const dojo = await createTestUser({ username: 'dojo-owner', email: 'dojo@example.com' });

    const chicagoCookie = authCookie({ userId: chicago.userId, username: 'chicago-owner', role: 'user', collectionId: chicago.collectionId });
    const dojoCookie = authCookie({ userId: dojo.userId, username: 'dojo-owner', role: 'user', collectionId: dojo.collectionId });

    await request(app).post('/api/minis').set('Cookie', chicagoCookie).field('name', 'Chicago Wolf').field('tags', 'painted,secret-project');
    await request(app).post('/api/minis').set('Cookie', dojoCookie).field('name', 'Dojo Wolf').field('tags', 'painted,unpainted');

    const chicagoTags = await request(app).get('/api/minis/tags').set('Cookie', chicagoCookie);
    const dojoTags = await request(app).get('/api/minis/tags').set('Cookie', dojoCookie);

    expect(chicagoTags.body).toEqual(['painted', 'secret-project']);
    expect(dojoTags.body).toEqual(['painted', 'unpainted']);
  });

  it('does not show tags that no mini uses any more', async () => {
    const { userId, collectionId } = await createTestUser();
    const cookie = authCookie({ userId, username: 'owner', role: 'user', collectionId });

    const created = await request(app).post('/api/minis').set('Cookie', cookie).field('name', 'Dire Wolf').field('tags', 'old-tag');
    await request(app).patch(`/api/minis/${created.body.miniId}`).set('Cookie', cookie).field('name', 'Dire Wolf').field('tags', 'new-tag');

    const tags = await request(app).get('/api/minis/tags').set('Cookie', cookie);
    expect(tags.body).toEqual(['new-tag']);
  });

  it('returns 404 (not the other collection\'s data) when fetching a mini by id across collections', async () => {
    const chicago = await createTestUser({ username: 'chicago-owner', email: 'chicago@example.com' });
    const dojo = await createTestUser({ username: 'dojo-owner', email: 'dojo@example.com', role: 'admin' });

    const [miniResult] = await pool.execute<ResultSetHeader>(
      'INSERT INTO minis (name, owner_id, collection_id) VALUES (?, ?, ?)',
      ['Chicago Wolf', chicago.userId, chicago.collectionId]
    );

    const dojoAdminCookie = authCookie({ userId: dojo.userId, username: 'dojo-owner', role: 'admin', collectionId: dojo.collectionId });
    const res = await request(app).get(`/api/minis/${miniResult.insertId}`).set('Cookie', dojoAdminCookie);

    expect(res.status).toBe(404);
  });

  it('rejects editing another collection\'s mini even for an admin who owns nothing there', async () => {
    const chicago = await createTestUser({ username: 'chicago-owner', email: 'chicago@example.com' });
    const dojo = await createTestUser({ username: 'dojo-owner', email: 'dojo@example.com', role: 'admin' });

    const [miniResult] = await pool.execute<ResultSetHeader>(
      'INSERT INTO minis (name, owner_id, collection_id) VALUES (?, ?, ?)',
      ['Chicago Wolf', chicago.userId, chicago.collectionId]
    );

    const dojoAdminCookie = authCookie({ userId: dojo.userId, username: 'dojo-owner', role: 'admin', collectionId: dojo.collectionId });
    const editRes = await request(app)
      .patch(`/api/minis/${miniResult.insertId}`)
      .set('Cookie', dojoAdminCookie)
      .field('name', 'Hijacked Wolf');

    expect(editRes.status).toBe(404);
  });

  it('rejects a user acting under a collection they do not belong to at all', async () => {
    const { userId } = await createTestUser();
    const someoneElsesCollection = await createCollection('Not Yours');

    const res = await request(app)
      .get('/api/minis')
      .set('Cookie', authCookie({ userId, username: 'owner', role: 'user', collectionId: someoneElsesCollection }));

    expect(res.status).toBe(403);
  });
});

describe('Multiple photos per mini (real database)', () => {
  it('creates a mini with tags AND multiple photos without duplicating tags (the cross-join trap)', async () => {
    const { userId, collectionId } = await createTestUser();
    const cookie = authCookie({ userId, username: 'owner', role: 'user', collectionId });

    const createRes = await request(app)
      .post('/api/minis')
      .set('Cookie', cookie)
      .field('name', 'Beholder')
      .field('tags', 'boss,painted')
      .attach('images', Buffer.from('fake-png-bytes'), { filename: 'a.png', contentType: 'image/png' })
      .attach('images', Buffer.from('fake-png-bytes'), { filename: 'b.png', contentType: 'image/png' })
      .attach('images', Buffer.from('fake-png-bytes'), { filename: 'c.png', contentType: 'image/png' });
    expect(createRes.status).toBe(201);

    const res = await request(app).get(`/api/minis/${createRes.body.miniId}`).set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(['boss', 'painted']); // not duplicated by the 3-way image join
    expect(res.body.images).toHaveLength(3);
  });

  it('rejects a request that would exceed 3 total photos on edit', async () => {
    const { userId, collectionId } = await createTestUser();
    const cookie = authCookie({ userId, username: 'owner', role: 'user', collectionId });

    const createRes = await request(app)
      .post('/api/minis')
      .set('Cookie', cookie)
      .field('name', 'Beholder')
      .attach('images', Buffer.from('fake-png-bytes'), { filename: 'a.png', contentType: 'image/png' })
      .attach('images', Buffer.from('fake-png-bytes'), { filename: 'b.png', contentType: 'image/png' })
      .attach('images', Buffer.from('fake-png-bytes'), { filename: 'c.png', contentType: 'image/png' });

    const getRes = await request(app).get(`/api/minis/${createRes.body.miniId}`).set('Cookie', cookie);
    const editRes = await request(app)
      .patch(`/api/minis/${createRes.body.miniId}`)
      .set('Cookie', cookie)
      .field('name', 'Beholder')
      .field('existingImages', JSON.stringify(getRes.body.images))
      .attach('images', Buffer.from('fake-png-bytes'), { filename: 'd.png', contentType: 'image/png' });

    expect(editRes.status).toBe(400);
  });
});

describe('POST /api/minis then PATCH /api/minis/:id (real database)', () => {
  it('creates a mini with tags, then edits its name/tags end-to-end', async () => {
    const { userId, collectionId } = await createTestUser();
    const cookie = authCookie({ userId, username: 'owner', role: 'user', collectionId });

    const createRes = await request(app)
      .post('/api/minis')
      .set('Cookie', cookie)
      .field('name', 'Beholder')
      .field('tags', 'boss,painted');
    expect(createRes.status).toBe(201);

    const editRes = await request(app)
      .patch(`/api/minis/${createRes.body.miniId}`)
      .set('Cookie', cookie)
      .field('name', 'Beholder (Repainted)')
      .field('tags', 'boss');

    expect(editRes.status).toBe(200);
    expect(editRes.body.name).toBe('Beholder (Repainted)');
    expect(editRes.body.tags).toEqual(['boss']);
  });

  it('rejects an edit from a user who does not own the mini', async () => {
    const collectionId = await createCollection('Shared Collection');
    const owner = await createTestUser({ email: 'owner@example.com', username: 'owner', collectionId });
    const other = await createTestUser({ email: 'other@example.com', username: 'other', collectionId });

    const createRes = await request(app)
      .post('/api/minis')
      .set('Cookie', authCookie({ userId: owner.userId, username: 'owner', role: 'user', collectionId }))
      .field('name', 'Beholder');

    const editRes = await request(app)
      .patch(`/api/minis/${createRes.body.miniId}`)
      .set('Cookie', authCookie({ userId: other.userId, username: 'other', role: 'user', collectionId }))
      .field('name', 'Stolen Beholder');

    expect(editRes.status).toBe(403);
  });
});

describe('DELETE /api/minis/:id (real database)', () => {
  it('deletes the mini and it no longer appears in the list or by id', async () => {
    const { userId, collectionId } = await createTestUser();
    const cookie = authCookie({ userId, username: 'owner', role: 'user', collectionId });

    const createRes = await request(app)
      .post('/api/minis')
      .set('Cookie', cookie)
      .field('name', 'Beholder');

    const deleteRes = await request(app)
      .delete(`/api/minis/${createRes.body.miniId}`)
      .set('Cookie', cookie);
    expect(deleteRes.status).toBe(200);

    const getRes = await request(app).get(`/api/minis/${createRes.body.miniId}`).set('Cookie', cookie);
    expect(getRes.status).toBe(404);

    const listRes = await request(app).get('/api/minis').set('Cookie', cookie);
    expect(listRes.body).toHaveLength(0);
  });

  it('rejects deletion from a user who does not own the mini', async () => {
    const collectionId = await createCollection('Shared Collection');
    const owner = await createTestUser({ email: 'owner@example.com', username: 'owner', collectionId });
    const other = await createTestUser({ email: 'other@example.com', username: 'other', collectionId });

    const createRes = await request(app)
      .post('/api/minis')
      .set('Cookie', authCookie({ userId: owner.userId, username: 'owner', role: 'user', collectionId }))
      .field('name', 'Beholder');

    const deleteRes = await request(app)
      .delete(`/api/minis/${createRes.body.miniId}`)
      .set('Cookie', authCookie({ userId: other.userId, username: 'other', role: 'user', collectionId }));

    expect(deleteRes.status).toBe(403);
  });
});

describe('GET /api/minis — fuzzy search (real database)', () => {
  it('finds a misspelled search term against a real dataset', async () => {
    const { userId, collectionId } = await createTestUser();
    const cookie = authCookie({ userId, username: 'owner', role: 'user', collectionId });

    await request(app).post('/api/minis').set('Cookie', cookie).field('name', 'Tabaxi Bard');
    await request(app).post('/api/minis').set('Cookie', cookie).field('name', 'Goblin Grunt');

    const res = await request(app).get('/api/minis?q=tabaxe').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Tabaxi Bard');
  });
});
