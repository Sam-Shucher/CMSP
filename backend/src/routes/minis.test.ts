import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { authCookie } from '../test/helpers';

// Mock the DB layer entirely — these are route/permission tests, not DB integration tests.
vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../db/connection';
import { createApp } from '../app';

const app = createApp();
const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;

const COLLECTION_A = 10;
const COLLECTION_B = 20;

const OWNER = { userId: 1, username: 'owner', role: 'user', collectionId: COLLECTION_A };
const OTHER = { userId: 2, username: 'other', role: 'user', collectionId: COLLECTION_A };
const ADMIN = { userId: 3, username: 'boss', role: 'admin', collectionId: COLLECTION_A };
// Same site-wide admin role, but currently acting in a DIFFERENT collection —
// this is the case that must never be allowed to touch collection A's minis.
const ADMIN_OTHER_COLLECTION = { userId: 3, username: 'boss', role: 'admin', collectionId: COLLECTION_B };
const NOT_A_MEMBER = { userId: 4, username: 'outsider', role: 'user', collectionId: COLLECTION_B };

// The requireCollectionMembership middleware's DB check, confirming the
// caller really belongs to the collection their JWT claims — this is always
// the first execute() call on every route in this file.
const MEMBERSHIP_CONFIRMED = [[{ id: 1 }]];
const NOT_A_MEMBER_ROW = [[]];

function tinyPng(): Buffer {
  // Smallest possible valid PNG — enough to satisfy multer's image/* fileFilter.
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
    'hex'
  );
}

// A single mini row, shaped like the join query in minis.ts returns it.
function miniRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 42,
    name: 'Dire Wolf',
    description: 'A wolf',
    price: '0.00',
    available: 1,
    owner_name: 'Owner Name',
    owner_username: 'owner',
    owner_id: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    tags: null,
    images: null,
    ...overrides,
  };
}

beforeEach(() => {
  execute.mockReset();
});

describe('Collection access control', () => {
  it('rejects every route with 403 when the caller is not a member of their claimed collection', async () => {
    execute.mockResolvedValueOnce(NOT_A_MEMBER_ROW);

    const res = await request(app).get('/api/minis').set('Cookie', authCookie(NOT_A_MEMBER));

    expect(res.status).toBe(403);
  });

  it('rejects with 400 when no collection has been selected at all', async () => {
    const res = await request(app)
      .get('/api/minis')
      .set('Cookie', authCookie({ userId: 1, username: 'owner', role: 'user' })); // no collectionId

    expect(res.status).toBe(400);
  });
});

describe('GET /api/minis — fuzzy search', () => {
  it('finds a mini whose name is misspelled in the search term', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[
        miniRow({ id: 1, name: 'Tabaxi Bard' }),
        miniRow({ id: 2, name: 'Goblin Grunt' }),
      ]]);

    const res = await request(app)
      .get('/api/minis?q=tabaxe')
      .set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Tabaxi Bard');
  });

  it('excludes minis that do not match at all', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[
        miniRow({ id: 1, name: 'Tabaxi Bard' }),
        miniRow({ id: 2, name: 'Goblin Grunt' }),
      ]]);

    const res = await request(app)
      .get('/api/minis?q=beholder')
      .set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('scopes the list query to the caller\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/minis').set('Cookie', authCookie(OWNER));

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('m.collection_id = ?'),
      expect.arrayContaining([COLLECTION_A])
    );
  });
});

describe('GET /api/minis/:id', () => {
  it('returns the mini with images split into an array', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[miniRow({ images: '/uploads/a.png,/uploads/b.png' })]]);

    const res = await request(app)
      .get('/api/minis/42')
      .set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.images).toEqual(['/uploads/a.png', '/uploads/b.png']);
  });

  it('returns an empty images array when the mini has no photos', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[miniRow({ images: null })]]);

    const res = await request(app)
      .get('/api/minis/42')
      .set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.images).toEqual([]);
  });

  it('returns 404 when the mini does not exist', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get('/api/minis/999')
      .set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(404);
  });

  it('returns 404 (not 403) for a mini that exists but belongs to a different collection', async () => {
    // The query itself (id + collection_id) returns nothing — same as "doesn't exist" —
    // so a probing request can't even confirm another collection's mini exists.
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get('/api/minis/42')
      .set('Cookie', authCookie(ADMIN_OTHER_COLLECTION));

    expect(res.status).toBe(404);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('m.collection_id = ?'),
      ['42', COLLECTION_B]
    );
  });
});

describe('POST /api/minis — photos', () => {
  it('accepts up to 3 images and stores one mini_images row per photo', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([{ insertId: 42 }]) // INSERT INTO minis
      .mockResolvedValueOnce([{}])                // DELETE mini_tags (setTags, unconditional)
      .mockResolvedValueOnce([{}])                // DELETE mini_images (setImages, unconditional)
      .mockResolvedValueOnce([{}])                // INSERT INTO mini_images (photo 1)
      .mockResolvedValueOnce([{}]);                // INSERT INTO mini_images (photo 2)

    const res = await request(app)
      .post('/api/minis')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .attach('images', tinyPng(), 'front.png')
      .attach('images', tinyPng(), 'back.png');

    expect(res.status).toBe(201);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO minis'),
      expect.arrayContaining([COLLECTION_A])
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO mini_images'),
      expect.arrayContaining([42, 0])
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO mini_images'),
      expect.arrayContaining([42, 1])
    );
  });

  it('rejects a 4th photo with a clean 400 instead of a server error', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app)
      .post('/api/minis')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .attach('images', tinyPng(), 'a.png')
      .attach('images', tinyPng(), 'b.png')
      .attach('images', tinyPng(), 'c.png')
      .attach('images', tinyPng(), 'd.png');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/most 3/i);
  });
});

describe('PATCH /api/minis/:id — photos', () => {
  it('lets the owner keep some existing photos and add a new one, within the cap of 3', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])                                   // ownership lookup
      .mockResolvedValueOnce([[{ image_path: '/uploads/old1.png' }, { image_path: '/uploads/old2.png' }]]) // current images
      .mockResolvedValueOnce([{}])                                                   // UPDATE minis
      .mockResolvedValueOnce([{}])                                                   // DELETE mini_tags (setTags)
      .mockResolvedValueOnce([{}])                                                   // DELETE mini_images
      .mockResolvedValueOnce([{}])                                                   // INSERT kept image
      .mockResolvedValueOnce([{}])                                                   // INSERT new image
      .mockResolvedValueOnce([[miniRow({ images: '/uploads/old1.png,/uploads/new.png' })]]); // re-fetch

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .field('existingImages', JSON.stringify(['/uploads/old1.png']))
      .attach('images', tinyPng(), 'new.png');

    expect(res.status).toBe(200);
    expect(res.body.images).toEqual(['/uploads/old1.png', '/uploads/new.png']);
  });

  it('rejects keeping 3 existing photos plus a new one (4 total) with 400', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[
        { image_path: '/uploads/a.png' },
        { image_path: '/uploads/b.png' },
        { image_path: '/uploads/c.png' },
      ]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .field('existingImages', JSON.stringify(['/uploads/a.png', '/uploads/b.png', '/uploads/c.png']))
      .attach('images', tinyPng(), 'new.png');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/most 3/i);
  });

  it('rejects a non-owner, non-admin with 403', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[{ owner_id: 1 }]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OTHER))
      .field('name', 'Stolen Wolf');

    expect(res.status).toBe(403);
  });

  it('lets an admin edit someone else\'s mini in the SAME collection', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[miniRow()]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(ADMIN))
      .field('name', 'Dire Wolf');

    expect(res.status).toBe(200);
  });

  it('returns 404 for an admin acting in a DIFFERENT collection than the mini — role alone is never enough', async () => {
    // Ownership lookup includes collection_id, so it finds nothing for this admin's active collection.
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(ADMIN_OTHER_COLLECTION))
      .field('name', 'Hijacked Wolf');

    expect(res.status).toBe(404);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('collection_id'),
      ['42', COLLECTION_B]
    );
  });

  it('returns 404 when the mini does not exist', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .patch('/api/minis/999')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Ghost Wolf');

    expect(res.status).toBe(404);
  });

  it('rejects a blank name with 400', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .field('name', '   ');

    expect(res.status).toBe(400);
  });

  it('rejects a negative price with 400', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[]]);

    const res = await request(app)
      .patch('/api/minis/42')
      .set('Cookie', authCookie(OWNER))
      .field('name', 'Dire Wolf')
      .field('price', '-3');

    expect(res.status).toBe(400);
  });

  it('returns 401 with no auth cookie', async () => {
    const res = await request(app).patch('/api/minis/42').field('name', 'Wolf');
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/minis/:id', () => {
  it('lets the owner delete their own mini', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])            // ownership lookup
      .mockResolvedValueOnce([[{ image_path: '/uploads/a.png' }]]) // images to clean up
      .mockResolvedValueOnce([{}]);                           // DELETE FROM minis

    const res = await request(app)
      .delete('/api/minis/42')
      .set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM minis'), ['42']);
  });

  it('lets an admin delete someone else\'s mini in the SAME collection', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 1 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{}]);

    const res = await request(app)
      .delete('/api/minis/42')
      .set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(200);
  });

  it('returns 404 for an admin acting in a DIFFERENT collection than the mini', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .delete('/api/minis/42')
      .set('Cookie', authCookie(ADMIN_OTHER_COLLECTION));

    expect(res.status).toBe(404);
  });

  it('rejects a non-owner, non-admin with 403', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[{ owner_id: 1 }]]);

    const res = await request(app)
      .delete('/api/minis/42')
      .set('Cookie', authCookie(OTHER));

    expect(res.status).toBe(403);
  });

  it('returns 404 when the mini does not exist', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .delete('/api/minis/999')
      .set('Cookie', authCookie(OWNER));

    expect(res.status).toBe(404);
  });

  it('returns 401 with no auth cookie', async () => {
    const res = await request(app).delete('/api/minis/42');
    expect(res.status).toBe(401);
  });
});
