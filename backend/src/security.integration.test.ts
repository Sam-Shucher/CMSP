import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { createApp } from './app';
import { pool } from './db/connection';
import { resetRateLimits } from './middleware/rateLimit';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, createMini, joinCollection, TestUser,
} from './test/dbHelpers';

// Attacks played out against the real database, end to end.
// Requires: docker compose -f docker-compose.test.yml up -d

let uploadsDir: string;
let app: ReturnType<typeof createApp>;

let chicago: number;
let dojo: number;
let admin: TestUser;
let member: TestUser;
let dojoMember: TestUser;

beforeAll(async () => {
  await assertDatabaseReachable();
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-security-'));
  app = createApp({ uploadsDir });
});

afterAll(async () => {
  fs.rmSync(uploadsDir, { recursive: true, force: true });
  await pool.end();
});

beforeEach(async () => {
  resetRateLimits();
  await resetDatabase();
  chicago = await createCollection('Chicago');
  dojo = await createCollection('dojo');
  admin = await createUser('boss', chicago, 'admin');
  member = await createUser('grunt', chicago);
  dojoMember = await createUser('ninja', dojo);
});

async function tableCount(): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'mini_library'"
  );
  return Number(rows[0].n);
}

async function addPhoto(miniId: number, filename: string): Promise<string> {
  fs.writeFileSync(path.join(uploadsDir, filename), `PHOTO:${filename}`);
  const imagePath = `/uploads/${filename}`;
  await pool.execute('INSERT INTO mini_images (mini_id, image_path, position) VALUES (?, ?, 0)', [miniId, imagePath]);
  return imagePath;
}

describe('revoked access takes effect immediately, despite a 7-day login cookie', () => {
  it('a demoted admin loses admin powers on their very next request', async () => {
    const victimMini = await createMini(member, 'Dire Wolf');
    expect((await request(app).get('/api/admin/users').set('Cookie', admin.cookie)).status).toBe(200);

    await pool.execute("UPDATE collection_memberships SET role = 'user' WHERE user_id = ? AND collection_id = ?", [admin.userId, chicago]);

    expect((await request(app).get('/api/admin/users').set('Cookie', admin.cookie)).status).toBe(403);
    expect((await request(app).patch(`/api/admin/users/${member.userId}/role`).set('Cookie', admin.cookie).send({ role: 'admin' })).status).toBe(403);
    expect((await request(app).delete(`/api/minis/${victimMini}`).set('Cookie', admin.cookie)).status).toBe(403);
    expect((await request(app).get('/api/auth/me').set('Cookie', admin.cookie)).body.role).toBe('user');
  });

  it('a member removed from a group loses access to it on their very next request', async () => {
    await createMini(admin, 'Beholder');
    expect((await request(app).get('/api/minis').set('Cookie', member.cookie)).status).toBe(200);

    const res = await request(app).delete(`/api/admin/users/${member.userId}`).set('Cookie', admin.cookie);
    expect(res.status).toBe(200);

    for (const url of ['/api/minis', '/api/cart', '/api/loans']) {
      expect((await request(app).get(url).set('Cookie', member.cookie)).status).not.toBe(200);
    }
  });

  it('a deleted account is logged out', async () => {
    await pool.execute('DELETE FROM users WHERE id = ?', [member.userId]);

    const res = await request(app).get('/api/auth/me').set('Cookie', member.cookie);

    expect(res.status).toBe(401);
  });
});

// A parameter is data, never SQL — MySQL turns '5 OR 1=1' into the number 5
// rather than running it. That same coercion would make /api/minis/5abc act on
// mini 5, so an id in a URL has to be a plain positive number or nothing.
describe('ids in URLs', () => {
  it.each([
    ['trailing junk', '5abc'],
    ['SQL in the id', "5 OR 1=1"],
    ['a word', 'abc'],
    ['negative', '-5'],
    ['a decimal', '5.5'],
  ])('refuses %s instead of acting on a nearby row', async (_why, id) => {
    const miniId = await createMini(member, 'Dire Wolf');
    const realId = String(miniId);
    expect(realId.startsWith('5') || true).toBe(true); // ids vary per run; the point is the shape below

    const res = await request(app).get(`/api/minis/${encodeURIComponent(id)}`).set('Cookie', member.cookie);

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('name');
  });

  it('a number with junk on the end never reaches the row with that number', async () => {
    const miniId = await createMini(member, 'Dire Wolf');

    const fuzzy = await request(app).get(`/api/minis/${miniId}abc`).set('Cookie', member.cookie);
    const exact = await request(app).get(`/api/minis/${miniId}`).set('Cookie', member.cookie);

    expect(fuzzy.status).toBe(404);
    expect(exact.body).toMatchObject({ name: 'Dire Wolf' });
  });

  it('holds for the other things addressed by id, too', async () => {
    const miniId = await createMini(admin, 'Owlbear');
    await request(app).post('/api/cart').set('Cookie', member.cookie).send({ miniId });
    const checkout = await request(app).post('/api/cart/checkout').set('Cookie', member.cookie);
    const loanId = checkout.body.created[0].loanId as number;

    expect((await request(app).patch(`/api/loans/${loanId}abc/terms`).set('Cookie', member.cookie).send({ where: 'x' })).status).toBe(404);
    expect((await request(app).post(`/api/minis/${miniId}abc/take-out`).set('Cookie', admin.cookie).send({})).status).toBe(404);
    expect((await request(app).delete(`/api/minis/${miniId}abc`).set('Cookie', admin.cookie)).status).toBe(404);
    // ...and the real loan is untouched by any of it.
    expect((await request(app).get('/api/loans').set('Cookie', member.cookie)).body).toHaveLength(1);
  });
});

describe('hostile text is stored and returned as plain data', () => {
  const SQL = "Robert'); DROP TABLE minis;--";
  const XSS = '<img src=x onerror="fetch(\'/api/admin/users\')">';

  it('in mini names, descriptions, tags, and searches — and every table survives', async () => {
    const tablesBefore = await tableCount();

    const created = await request(app).post('/api/minis').set('Cookie', member.cookie)
      .field('name', SQL)
      .field('description', XSS)
      .field('tags', "x' OR '1'='1, <script>alert(1)</script>");
    expect(created.status).toBe(201);

    const byId = await request(app).get(`/api/minis/${created.body.miniId}`).set('Cookie', member.cookie);
    expect(byId.body).toMatchObject({ name: SQL, description: XSS, tags: ["<script>alert(1)</script>", "x' or '1'='1"] });

    const searched = await request(app).get('/api/minis').query({ q: "' OR 1=1 --" }).set('Cookie', member.cookie);
    expect(searched.status).toBe(200);
    const tagged = await request(app).get('/api/minis').query({ tag: "x' OR '1'='1" }).set('Cookie', member.cookie);
    expect(tagged.body.map((m: { name: string }) => m.name)).toEqual([SQL]);

    expect(await tableCount()).toBe(tablesBefore);
    const [[{ n }]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM minis');
    expect(Number(n)).toBe(1);
  });

  it('in profile fields and loan terms', async () => {
    const tablesBefore = await tableCount();

    const profile = await request(app).patch('/api/users/me').set('Cookie', member.cookie)
      .send({ displayName: SQL, neighborhood: XSS });
    expect(profile.body).toMatchObject({ display_name: SQL, neighborhood: XSS });

    const miniId = await createMini(admin, 'Owlbear');
    await request(app).post('/api/cart').set('Cookie', member.cookie).send({ miniId });
    const checkout = await request(app).post('/api/cart/checkout').set('Cookie', member.cookie);
    const loanId = checkout.body.created[0].loanId;

    const terms = await request(app).patch(`/api/loans/${loanId}/terms`).set('Cookie', member.cookie)
      .send({ where: SQL, how: XSS });
    expect(terms.body).toMatchObject({ handoffWhere: SQL, handoffHow: XSS });

    expect(await tableCount()).toBe(tablesBefore);
  });

  it('usernames containing SQL are refused outright at registration', async () => {
    await pool.execute('INSERT INTO approved_emails (email, collection_id) VALUES (?, ?)', ['new@example.com', chicago]);

    const res = await request(app).post('/api/auth/register')
      .send({ email: 'new@example.com', username: "admin'--", password: 'validpass1' });

    expect(res.status).toBe(400);
    const [[{ n }]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM users WHERE username LIKE 'admin%'");
    expect(Number(n)).toBe(0);
  });

  it('SQL in a login attempt logs nobody in', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: "' OR '1'='1' --@x.co", password: "' OR '1'='1" });

    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('photos', () => {
  it('cannot be stolen or deleted by "keeping" another member\'s photo on your own mini', async () => {
    const victimMini = await createMini(admin, 'Victim Wolf');
    const victimPhoto = await addPhoto(victimMini, '1700000000-victim.png');
    const attackerMini = await createMini(member, 'Attacker Mini');

    await request(app).patch(`/api/minis/${attackerMini}`).set('Cookie', member.cookie)
      .field('name', 'Attacker Mini')
      .field('existingImages', JSON.stringify([victimPhoto]));
    const attackerView = await request(app).get(`/api/minis/${attackerMini}`).set('Cookie', member.cookie);
    expect(attackerView.body.images).toEqual([]);

    await request(app).delete(`/api/minis/${attackerMini}`).set('Cookie', member.cookie);

    const victimView = await request(app).get(`/api/minis/${victimMini}`).set('Cookie', admin.cookie);
    expect(victimView.body.images).toEqual([victimPhoto]);
    expect(fs.existsSync(path.join(uploadsDir, '1700000000-victim.png'))).toBe(true);
  });

  it('are only served to members of the photo\'s collection', async () => {
    const miniId = await createMini(admin, 'Chicago Wolf');
    const photo = await addPhoto(miniId, '1700000001-chicago.png');

    const asMember = await request(app).get(photo).set('Cookie', member.cookie);
    const asOtherCollection = await request(app).get(photo).set('Cookie', dojoMember.cookie);
    const anonymous = await request(app).get(photo);

    expect(asMember.status).toBe(200);
    expect(asMember.body.toString()).toContain('PHOTO:1700000001-chicago.png');
    expect(asOtherCollection.status).toBe(404);
    expect(anonymous.status).toBe(401);
  });

  it('are not served for files on disk that no mini uses', async () => {
    fs.writeFileSync(path.join(uploadsDir, '1700000002-orphan.png'), 'ORPHAN');

    const res = await request(app).get('/uploads/1700000002-orphan.png').set('Cookie', member.cookie);

    expect(res.status).toBe(404);
  });
});

describe('collections stay sealed from each other', () => {
  it('an outsider cannot see, add to cart, or request another collection\'s mini by guessing its id', async () => {
    const chicagoMini = await createMini(admin, 'Chicago Wolf');

    expect((await request(app).get(`/api/minis/${chicagoMini}`).set('Cookie', dojoMember.cookie)).status).toBe(404);
    expect((await request(app).post('/api/cart').set('Cookie', dojoMember.cookie).send({ miniId: chicagoMini })).status).toBe(404);
    expect((await request(app).patch(`/api/minis/${chicagoMini}`).set('Cookie', dojoMember.cookie).field('name', 'Mine now')).status).toBe(404);
    expect((await request(app).delete(`/api/minis/${chicagoMini}`).set('Cookie', dojoMember.cookie)).status).toBe(404);

    const [[row]] = await pool.query<RowDataPacket[]>('SELECT name FROM minis WHERE id = ?', [chicagoMini]);
    expect(row.name).toBe('Chicago Wolf');
  });

  it('an outsider cannot switch into a collection they don\'t belong to', async () => {
    const res = await request(app).post('/api/auth/select-collection').set('Cookie', dojoMember.cookie).send({ collectionId: chicago });

    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('an admin of one collection cannot see or manage another collection\'s members or invites', async () => {
    const [invite] = await pool.execute<ResultSetHeader>(
      'INSERT INTO approved_emails (email, collection_id) VALUES (?, ?)', ['dojo-invite@example.com', dojo]
    );

    const users = await request(app).get('/api/admin/users').set('Cookie', admin.cookie);
    expect(users.body.map((u: { username: string }) => u.username)).not.toContain('ninja');

    expect((await request(app).delete(`/api/admin/approved-emails/${invite.insertId}`).set('Cookie', admin.cookie)).status).toBe(404);
    expect((await request(app).delete(`/api/admin/users/${dojoMember.userId}`).set('Cookie', admin.cookie)).status).toBe(404);
    expect((await request(app).patch(`/api/admin/users/${dojoMember.userId}/role`).set('Cookie', admin.cookie).send({ role: 'admin' })).status).toBe(404);

    const [[row]] = await pool.query<RowDataPacket[]>('SELECT role FROM collection_memberships WHERE user_id = ?', [dojoMember.userId]);
    expect(row.role).toBe('user');
  });
});

describe('roles belong to one collection at a time', () => {
  it('an admin of Chicago who is a plain member of dojo has no admin powers in dojo', async () => {
    const adminInDojo = await joinCollection(admin, dojo, 'user');
    const dojoMini = await createMini(dojoMember, 'Dojo Wolf');

    expect((await request(app).get('/api/admin/users').set('Cookie', adminInDojo.cookie)).status).toBe(403);
    expect((await request(app).patch(`/api/admin/users/${dojoMember.userId}/role`).set('Cookie', adminInDojo.cookie).send({ role: 'admin' })).status).toBe(403);
    expect((await request(app).delete(`/api/minis/${dojoMini}`).set('Cookie', adminInDojo.cookie)).status).toBe(403);
    expect((await request(app).patch(`/api/minis/${dojoMini}`).set('Cookie', adminInDojo.cookie).field('name', 'Taken')).status).toBe(403);

    // ...while still being an admin back in Chicago.
    expect((await request(app).get('/api/admin/users').set('Cookie', admin.cookie)).status).toBe(200);
  });

  it('making someone an admin in one collection leaves their role everywhere else alone', async () => {
    const memberInDojo = await joinCollection(member, dojo, 'user');

    const res = await request(app).patch(`/api/admin/users/${member.userId}/role`).set('Cookie', admin.cookie).send({ role: 'admin' });
    expect(res.status).toBe(200);

    expect((await request(app).get('/api/admin/users').set('Cookie', member.cookie)).status).toBe(200);
    expect((await request(app).get('/api/admin/users').set('Cookie', memberInDojo.cookie)).status).toBe(403);
  });

  it('shows the role each member holds in the collection being administered', async () => {
    await joinCollection(member, dojo, 'admin');

    const res = await request(app).get('/api/admin/users').set('Cookie', admin.cookie);

    const roles = Object.fromEntries(res.body.map((u: { username: string; role: string }) => [u.username, u.role]));
    expect(roles).toEqual({ boss: 'admin', grunt: 'user' });
  });

  it('an admin cannot change their own role', async () => {
    const res = await request(app).patch(`/api/admin/users/${admin.userId}/role`).set('Cookie', admin.cookie).send({ role: 'user' });

    expect(res.status).toBe(400);
    const [[row]] = await pool.query<RowDataPacket[]>('SELECT role FROM collection_memberships WHERE user_id = ? AND collection_id = ?', [admin.userId, chicago]);
    expect(row.role).toBe('admin');
  });

  it('the group picker and /me report the role for each collection', async () => {
    const adminInDojo = await joinCollection(admin, dojo, 'user');

    const collections = await request(app).get('/api/auth/collections').set('Cookie', admin.cookie);
    expect(collections.body).toEqual([
      { id: chicago, name: 'Chicago', role: 'admin' },
      { id: dojo, name: 'dojo', role: 'user' },
    ]);

    expect((await request(app).get('/api/auth/me').set('Cookie', admin.cookie)).body.role).toBe('admin');
    expect((await request(app).get('/api/auth/me').set('Cookie', adminInDojo.cookie)).body.role).toBe('user');

    const switched = await request(app).post('/api/auth/select-collection').set('Cookie', admin.cookie).send({ collectionId: dojo });
    expect(switched.body).toMatchObject({ collectionId: dojo, role: 'user' });
  });
});

describe('private user data', () => {
  it('regular members never receive other people\'s email addresses or phone numbers', async () => {
    await pool.execute("UPDATE users SET phone = '555-0100' WHERE id = ?", [admin.userId]);
    const miniId = await createMini(admin, 'Dire Wolf');
    await request(app).post('/api/cart').set('Cookie', member.cookie).send({ miniId });
    await request(app).post('/api/cart/checkout').set('Cookie', member.cookie);

    for (const url of ['/api/minis', `/api/minis/${miniId}`, '/api/cart', '/api/loans']) {
      const res = await request(app).get(url).set('Cookie', member.cookie);
      expect(res.text).not.toContain('boss@example.com');
      expect(res.text).not.toContain('555-0100');
    }
  });

  it('password hashes never appear in any response', async () => {
    const responses = await Promise.all([
      request(app).get('/api/auth/me').set('Cookie', admin.cookie),
      request(app).get('/api/users/me').set('Cookie', admin.cookie),
      request(app).get('/api/admin/users').set('Cookie', admin.cookie),
      request(app).get('/api/minis').set('Cookie', admin.cookie),
    ]);
    for (const res of responses) {
      expect(res.text).not.toContain('password');
      expect(res.text).not.toContain('not-a-real-hash');
    }
  });
});
