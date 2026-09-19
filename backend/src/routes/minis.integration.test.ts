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

// A real (1×1) PNG — uploads are checked to be actual images.
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
  '0d0a2db40000000049454e44ae426082',
  'hex'
);

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
  await pool.query('DELETE FROM loans');
  await pool.query('DELETE FROM minis');
  await pool.query('DELETE FROM sets');
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

  // The LEFT JOIN sets is a many-to-one, same shape as the existing owner
  // join — but it's new, and GROUP BY m.id with a non-aggregated column from
  // a joined table is exactly the kind of thing sql_mode=ONLY_FULL_GROUP_BY
  // can reject on a real server even when a mocked test can't tell the
  // difference. This proves it against MariaDB, not a mock.
  it('shows which set a mini is part of, and null for one that isn\'t in any', async () => {
    const { userId, collectionId } = await createTestUser();
    const [setResult] = await pool.execute<ResultSetHeader>(
      'INSERT INTO sets (name, owner_id, collection_id) VALUES (?, ?, ?)', ['Blades of Khaine', userId, collectionId]
    );
    await pool.execute(
      'INSERT INTO minis (name, owner_id, collection_id, set_id) VALUES (?, ?, ?, ?)',
      ['Banshee', userId, collectionId, setResult.insertId]
    );
    await pool.execute('INSERT INTO minis (name, owner_id, collection_id) VALUES (?, ?, ?)', ['Loner Wolf', userId, collectionId]);

    const cookie = authCookie({ userId, username: 'owner', role: 'user', collectionId });
    const res = await request(app).get('/api/minis').set('Cookie', cookie);

    expect(res.status).toBe(200);
    const banshee = res.body.find((m: { name: string }) => m.name === 'Banshee');
    const loner = res.body.find((m: { name: string }) => m.name === 'Loner Wolf');
    expect(banshee).toMatchObject({ set_id: setResult.insertId, set_name: 'Blades of Khaine' });
    expect(loner).toMatchObject({ set_id: null, set_name: null });
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

describe('GET /api/minis/:id/history (real database)', () => {
  // Inserted directly rather than played through the negotiation flow — that
  // flow (and the columns it sets) is already exercised end to end in
  // loans.integration.test.ts. What matters here is what the history endpoint
  // does with rows once they exist.
  async function insertLoan(
    miniId: number, collectionId: number, borrowerId: number, ownerId: number,
    overrides: Partial<{ status: string; handedOffAt: Date | null; returnedAt: Date | null; durationDays: number }> = {}
  ): Promise<number> {
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status, handed_off_at, returned_at, duration_days, borrower_approved, owner_approved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
      [
        miniId, collectionId, borrowerId, ownerId,
        overrides.status ?? 'returned',
        overrides.handedOffAt !== undefined ? overrides.handedOffAt : new Date('2026-09-01T18:00:00.000Z'),
        overrides.returnedAt !== undefined ? overrides.returnedAt : new Date('2026-09-15T18:00:00.000Z'),
        overrides.durationDays ?? 14,
      ]
    );
    return result.insertId;
  }

  it('lists completed and ongoing loans, newest handoff first, and leaves out anything that never happened', async () => {
    const owner = await createTestUser({ username: 'olivia', email: 'olivia@example.com' });
    const bruno = await createTestUser({ username: 'bruno', email: 'bruno@example.com', collectionId: owner.collectionId });
    const wendy = await createTestUser({ username: 'wendy', email: 'wendy@example.com', collectionId: owner.collectionId });
    const [miniResult] = await pool.execute<ResultSetHeader>(
      'INSERT INTO minis (name, owner_id, collection_id) VALUES (?, ?, ?)', ['Dire Wolf', owner.userId, owner.collectionId]
    );
    const miniId = miniResult.insertId;

    // A completed loan, further in the past...
    await insertLoan(miniId, owner.collectionId, bruno.userId, owner.userId, {
      handedOffAt: new Date('2026-08-01T18:00:00.000Z'), returnedAt: new Date('2026-08-08T18:00:00.000Z'),
    });
    // ...a more recent one, still out...
    await insertLoan(miniId, owner.collectionId, wendy.userId, owner.userId, {
      status: 'adventuring', handedOffAt: new Date('2026-09-01T18:00:00.000Z'), returnedAt: null,
    });
    // ...and two that never got anywhere, which shouldn't show up at all.
    await insertLoan(miniId, owner.collectionId, bruno.userId, owner.userId, { status: 'negotiating', handedOffAt: null, returnedAt: null });
    await insertLoan(miniId, owner.collectionId, wendy.userId, owner.userId, { status: 'cancelled', handedOffAt: null, returnedAt: null });

    const ownerCookie = authCookie({ userId: owner.userId, username: 'olivia', role: 'user', collectionId: owner.collectionId });
    const res = await request(app).get(`/api/minis/${miniId}/history`).set('Cookie', ownerCookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ borrowerUsername: 'wendy', ongoing: true, returnedAt: null });
    expect(res.body[1]).toMatchObject({ borrowerUsername: 'bruno', ongoing: false, daysOut: 7 });
  });

  it('refuses a member who isn\'t the owner or an admin', async () => {
    const owner = await createTestUser({ username: 'olivia', email: 'olivia@example.com' });
    const bystander = await createTestUser({ username: 'bystander', email: 'bystander@example.com', collectionId: owner.collectionId });
    const [miniResult] = await pool.execute<ResultSetHeader>(
      'INSERT INTO minis (name, owner_id, collection_id) VALUES (?, ?, ?)', ['Dire Wolf', owner.userId, owner.collectionId]
    );

    const bystanderCookie = authCookie({ userId: bystander.userId, username: 'bystander', role: 'user', collectionId: owner.collectionId });
    const res = await request(app).get(`/api/minis/${miniResult.insertId}/history`).set('Cookie', bystanderCookie);

    expect(res.status).toBe(403);
  });

  it('lets a collection admin see it, even for someone else\'s mini', async () => {
    const owner = await createTestUser({ username: 'olivia', email: 'olivia@example.com' });
    const admin = await createTestUser({ username: 'ada', email: 'ada@example.com', role: 'admin', collectionId: owner.collectionId });
    const [miniResult] = await pool.execute<ResultSetHeader>(
      'INSERT INTO minis (name, owner_id, collection_id) VALUES (?, ?, ?)', ['Dire Wolf', owner.userId, owner.collectionId]
    );
    await insertLoan(miniResult.insertId, owner.collectionId, admin.userId, owner.userId);

    const adminCookie = authCookie({ userId: admin.userId, username: 'ada', role: 'admin', collectionId: owner.collectionId });
    const res = await request(app).get(`/api/minis/${miniResult.insertId}/history`).set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('never shows another collection\'s loans for a similarly-owned mini', async () => {
    const chicago = await createTestUser({ username: 'chicago-owner', email: 'chicago@example.com' });
    const dojo = await createTestUser({ username: 'dojo-owner', email: 'dojo@example.com' });
    const chicagoBorrower = await createTestUser({ username: 'chicago-borrower', email: 'cb@example.com', collectionId: chicago.collectionId });

    const [chicagoMini] = await pool.execute<ResultSetHeader>(
      'INSERT INTO minis (name, owner_id, collection_id) VALUES (?, ?, ?)', ['Chicago Wolf', chicago.userId, chicago.collectionId]
    );
    await insertLoan(chicagoMini.insertId, chicago.collectionId, chicagoBorrower.userId, chicago.userId);

    // Same mini id lookup, but as a member of the OTHER collection.
    const dojoCookie = authCookie({ userId: dojo.userId, username: 'dojo-owner', role: 'user', collectionId: dojo.collectionId });
    const res = await request(app).get(`/api/minis/${chicagoMini.insertId}/history`).set('Cookie', dojoCookie);

    expect(res.status).toBe(404);
  });
});

describe('Tags people actually type (real database)', () => {
  // The database used to compare tag names ignoring accents, and treated every
  // emoji as equal — so tagging 🔥 on a mini gave it someone else's 🐉 tag.
  it('keeps tags that differ only by emoji or accent apart', async () => {
    const { userId, collectionId } = await createTestUser();
    const cookie = authCookie({ userId, username: 'owner', role: 'user', collectionId });

    const dragon = await request(app).post('/api/minis').set('Cookie', cookie).field('name', 'Dragon').field('tags', '🐉, café');
    const fire = await request(app).post('/api/minis').set('Cookie', cookie).field('name', 'Fire Elemental').field('tags', '🔥, cafe');

    expect((await request(app).get(`/api/minis/${dragon.body.miniId}`).set('Cookie', cookie)).body.tags.sort()).toEqual(['café', '🐉'].sort());
    expect((await request(app).get(`/api/minis/${fire.body.miniId}`).set('Cookie', cookie)).body.tags.sort()).toEqual(['cafe', '🔥'].sort());

    const filtered = await request(app).get(`/api/minis?tag=${encodeURIComponent('🔥')}`).set('Cookie', cookie);
    expect(filtered.body.map((m: { name: string }) => m.name)).toEqual(['Fire Elemental']);
    expect((await request(app).get('/api/minis/tags').set('Cookie', cookie)).body).toHaveLength(4);
  });
});

describe('Photos that aren\'t really photos (real database)', () => {
  it('refuses a text file named .png and leaves no mini behind', async () => {
    const { userId, collectionId } = await createTestUser();
    const cookie = authCookie({ userId, username: 'owner', role: 'user', collectionId });

    const res = await request(app)
      .post('/api/minis')
      .set('Cookie', cookie)
      .field('name', 'Not A Photo')
      .attach('images', Buffer.from('my shopping list'), { filename: 'notes.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect((await request(app).get('/api/minis').set('Cookie', cookie)).body).toEqual([]);
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
      .attach('images', PNG_BYTES, { filename: 'a.png', contentType: 'image/png' })
      .attach('images', PNG_BYTES, { filename: 'b.png', contentType: 'image/png' })
      .attach('images', PNG_BYTES, { filename: 'c.png', contentType: 'image/png' });
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
      .attach('images', PNG_BYTES, { filename: 'a.png', contentType: 'image/png' })
      .attach('images', PNG_BYTES, { filename: 'b.png', contentType: 'image/png' })
      .attach('images', PNG_BYTES, { filename: 'c.png', contentType: 'image/png' });

    const getRes = await request(app).get(`/api/minis/${createRes.body.miniId}`).set('Cookie', cookie);
    const editRes = await request(app)
      .patch(`/api/minis/${createRes.body.miniId}`)
      .set('Cookie', cookie)
      .field('name', 'Beholder')
      .field('existingImages', JSON.stringify(getRes.body.images))
      .attach('images', PNG_BYTES, { filename: 'd.png', contentType: 'image/png' });

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
