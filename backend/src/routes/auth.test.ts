import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authCookie, TEST_SESSION_ID } from '../test/helpers';
import { resetRateLimits } from '../middleware/rateLimit';
import { createSession, revokeSession, revokeAllSessions } from '../db/sessions';

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
  resetRateLimits();
  vi.mocked(createSession).mockClear();
  vi.mocked(revokeSession).mockClear();
  vi.mocked(revokeAllSessions).mockClear();
});

describe('brute-force protection', () => {
  // Every failed login now does a deliberate ~250ms hash; these tests make
  // dozens of attempts and only care about the counting.
  beforeEach(() => {
    vi.spyOn(bcrypt, 'compare').mockImplementation(async () => false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const login = (email: string, ip = '203.0.113.9') =>
    request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ email, password: 'wrongpass1' });

  it('stops password guessing on one account after 10 attempts, before checking the password', async () => {
    execute.mockResolvedValue([[]]);
    for (let i = 0; i < 10; i++) {
      expect((await login('victim@example.com')).status).toBe(401);
    }
    const callsBefore = execute.mock.calls.length;

    const blocked = await login('victim@example.com');

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
    expect(execute.mock.calls.length).toBe(callsBefore);
  });

  it('counts the account the same regardless of email capitalization or spacing', async () => {
    execute.mockResolvedValue([[]]);
    for (let i = 0; i < 10; i++) await login(i % 2 ? 'Victim@Example.com' : ' victim@example.com ');

    expect((await login('VICTIM@EXAMPLE.COM')).status).toBe(429);
  });

  it('still lets a different account log in', async () => {
    execute.mockResolvedValue([[]]);
    for (let i = 0; i < 11; i++) await login('victim@example.com');

    expect((await login('someone-else@example.com')).status).toBe(401);
  });

  it('stops one address from spraying guesses across many accounts', async () => {
    execute.mockResolvedValue([[]]);
    for (let i = 0; i < 30; i++) await login(`user${i}@example.com`, '198.51.100.7');

    expect((await login('fresh@example.com', '198.51.100.7')).status).toBe(429);
    expect((await login('fresh@example.com', '198.51.100.8')).status).toBe(401);
  });

  it('limits account creation attempts from one address', async () => {
    execute.mockResolvedValue([[]]); // not invited
    for (let i = 0; i < 10; i++) {
      await request(app).post('/api/auth/register').set('X-Forwarded-For', '192.0.2.1')
        .send({ email: `new${i}@example.com`, username: `newperson${i}`, password: 'validpass1' });
    }

    const res = await request(app).post('/api/auth/register').set('X-Forwarded-For', '192.0.2.1')
      .send({ email: 'another@example.com', username: 'another1', password: 'validpass1' });

    expect(res.status).toBe(429);
  });
});

describe('login timing', () => {
  // If an unknown email returned instantly but a real one took ~250ms to hash,
  // an attacker could tell which emails have accounts just by timing replies.
  it('still does the full password hash check for an email with no account', async () => {
    execute.mockResolvedValueOnce([[]]);
    const compare = vi.spyOn(bcrypt, 'compare');

    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'validpass1' });

    expect(res.status).toBe(401);
    expect(compare).toHaveBeenCalledTimes(1);
    const [, hash] = compare.mock.calls[0] as [string, string];
    expect(hash).toMatch(/^\$2[aby]\$12\$/); // same cost as real account hashes
    compare.mockRestore();
  });
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
      .mockResolvedValueOnce([{ insertId: 1, affectedRows: 1 }])
      .mockResolvedValueOnce([{}]); // both memberships, one statement

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'new@example.com', username: 'newperson', password: 'validpass1' });

    expect(res.status).toBe(201);
    expect(res.body.collectionId).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT IGNORE INTO collection_memberships'), [1, 5, 1, 6]);
  });

  it('rejects an email that is not on any collection\'s invite list', async () => {
    execute.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'stranger@example.com', username: 'stranger', password: 'validpass1' });

    expect(res.status).toBe(403);
  });

  it.each([
    ['email', { username: 'newperson', password: 'validpass1' }],
    ['username', { email: 'new@example.com', password: 'validpass1' }],
    ['password', { email: 'new@example.com', username: 'newperson' }],
  ])('rejects a registration missing the %s with 400, without touching the database', async (_field, body) => {
    const res = await request(app).post('/api/auth/register').send(body);

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  // The register page validates these too, but anyone can call the API
  // directly — the server has to enforce the same rules itself.
  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(33)],
    ['containing SQL-breaking characters', "bob'; DROP TABLE users; --"],
    ['containing a space', 'bob smith'],
  ])('rejects a username %s with 400, without touching the database', async (_why, username) => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'new@example.com', username, password: 'validpass1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['too short', 'short1'],
    ['longer than bcrypt can use (72 bytes)', 'a'.repeat(73)],
  ])('rejects a password %s with 400, without touching the database', async (_why, password) => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'new@example.com', username: 'newperson', password });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it('accepts a strong password with spaces and symbols, and hashes exactly what was typed', async () => {
    execute
      .mockResolvedValueOnce([[{ collection_id: 5 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([{}]);
    const password = " P@ss w0rd!' OR 1=1 -- ";

    const res = await request(app).post('/api/auth/register').send({ email: 'new@example.com', username: 'newperson', password });

    expect(res.status).toBe(201);
    const insert = execute.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO users'))!;
    const hash = (insert[1] as unknown[])[2] as string;
    expect(await bcrypt.compare(password, hash)).toBe(true);
    expect(await bcrypt.compare(password.trim(), hash)).toBe(false); // never trimmed or altered
  });

  it('rejects an email or username that is already taken with 409', async () => {
    execute
      .mockResolvedValueOnce([[{ collection_id: 5 }]])
      .mockResolvedValueOnce([[{ id: 9 }]]); // someone already has it

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'new@example.com', username: 'newperson', password: 'validpass1' });

    expect(res.status).toBe(409);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO users'), expect.anything());
  });

  it('stores the email lowercased, hashes the password, and defaults the display name to the username', async () => {
    execute
      .mockResolvedValueOnce([[{ collection_id: 5 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([{}]);

    await request(app)
      .post('/api/auth/register')
      .send({ email: 'New@Example.COM', username: 'newperson', password: 'validpass1', phone: '   ' });

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('FROM approved_emails'), ['new@example.com']);
    const insert = execute.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO users'))!;
    const [email, username, passwordHash, displayName, phone, neighborhood] = insert[1] as unknown[];
    expect(email).toBe('new@example.com');
    expect(username).toBe('newperson');
    expect(passwordHash).not.toBe('validpass1');
    expect(await bcrypt.compare('validpass1', passwordHash as string)).toBe(true);
    expect(displayName).toBe('newperson');
    expect(phone).toBeNull(); // blank optional fields are stored as NULL, not ''
    expect(neighborhood).toBeNull();
  });

  it('issues the session cookie as httpOnly and SameSite=Strict', async () => {
    execute
      .mockResolvedValueOnce([[{ collection_id: 5 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([{}]);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'new@example.com', username: 'newperson', password: 'validpass1' });

    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });
});

describe('POST /api/auth/login', () => {
  it('auto-selects the collection when the user belongs to exactly one', async () => {
    const passwordHash = await bcrypt.hash('validpass1', 4);
    execute
      .mockResolvedValueOnce([[{ id: 1, username: 'owner', password_hash: passwordHash, display_name: 'Owner' }]])
      .mockResolvedValueOnce([[{ collection_id: 5, role: 'user' }]]);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'validpass1' });

    expect(res.status).toBe(200);
    expect(res.body.collectionId).toBe(5);
  });

  it('reports the role the user holds in that one collection', async () => {
    const passwordHash = await bcrypt.hash('validpass1', 4);
    execute
      .mockResolvedValueOnce([[{ id: 1, username: 'owner', password_hash: passwordHash, display_name: 'Owner' }]])
      .mockResolvedValueOnce([[{ collection_id: 5, role: 'admin' }]]);

    const res = await request(app).post('/api/auth/login').send({ email: 'owner@example.com', password: 'validpass1' });

    expect(res.body.role).toBe('admin');
  });

  it('starts a new server-side session and puts only its id — not the role — in the cookie', async () => {
    const passwordHash = await bcrypt.hash('validpass1', 4);
    execute
      .mockResolvedValueOnce([[{ id: 1, username: 'owner', password_hash: passwordHash, display_name: 'Owner' }]])
      .mockResolvedValueOnce([[{ collection_id: 5, role: 'admin' }]]);

    const res = await request(app).post('/api/auth/login').send({ email: 'owner@example.com', password: 'validpass1' });

    expect(createSession).toHaveBeenCalledWith(1);
    const token = (res.headers['set-cookie']?.[0] ?? '').split(';')[0].replace('token=', '');
    const payload = jwt.decode(token) as Record<string, unknown>;
    expect(payload).toMatchObject({ sid: TEST_SESSION_ID, userId: 1, collectionId: 5 });
    expect(payload).not.toHaveProperty('role');
  });

  it('does not start a session for a wrong password', async () => {
    const passwordHash = await bcrypt.hash('validpass1', 4);
    execute.mockResolvedValueOnce([[{ id: 1, username: 'owner', password_hash: passwordHash, display_name: 'Owner' }]]);

    await request(app).post('/api/auth/login').send({ email: 'owner@example.com', password: 'wrongpass1' });

    expect(createSession).not.toHaveBeenCalled();
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

  it('logs in a user with no collections, leaving the collection unselected', async () => {
    const passwordHash = await bcrypt.hash('validpass1', 4);
    execute
      .mockResolvedValueOnce([[{ id: 1, username: 'owner', password_hash: passwordHash, role: 'user', display_name: 'Owner' }]])
      .mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'validpass1' });

    expect(res.status).toBe(200);
    expect(res.body.collectionId).toBeUndefined();
  });

  it('matches the email case-insensitively', async () => {
    const passwordHash = await bcrypt.hash('validpass1', 4);
    execute
      .mockResolvedValueOnce([[{ id: 1, username: 'owner', password_hash: passwordHash, role: 'user', display_name: 'Owner' }]])
      .mockResolvedValueOnce([[{ collection_id: 5 }]]);

    await request(app).post('/api/auth/login').send({ email: 'Owner@Example.com', password: 'validpass1' });

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('WHERE email = ?'), ['owner@example.com']);
  });

  it('rejects a wrong password with 401 and sets no cookie', async () => {
    const passwordHash = await bcrypt.hash('validpass1', 4);
    execute.mockResolvedValueOnce([[{ id: 1, username: 'owner', password_hash: passwordHash, role: 'user', display_name: 'Owner' }]]);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'wrongpass1' });

    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('gives an unknown email the exact same response as a wrong password (no account enumeration)', async () => {
    const passwordHash = await bcrypt.hash('validpass1', 4);
    execute.mockResolvedValueOnce([[{ id: 1, username: 'owner', password_hash: passwordHash, role: 'user', display_name: 'Owner' }]]);
    const wrongPassword = await request(app).post('/api/auth/login').send({ email: 'owner@example.com', password: 'wrongpass1' });

    execute.mockResolvedValueOnce([[]]);
    const unknownEmail = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrongpass1' });

    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });

  it.each([
    ['email', { password: 'validpass1' }],
    ['password', { email: 'owner@example.com' }],
  ])('rejects a login missing the %s with 400', async (_field, body) => {
    const res = await request(app).post('/api/auth/login').send(body);

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session cookie', async () => {
    const res = await request(app).post('/api/auth/logout').set('Cookie', authCookie(USER));

    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/^token=;/);
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('ends the session on the server, so a copied cookie stops working too', async () => {
    await request(app).post('/api/auth/logout').set('Cookie', authCookie({ ...USER, sid: 'abc123' }));

    expect(revokeSession).toHaveBeenCalledWith('abc123');
  });

  it('still clears the cookie when there is no valid session to end', async () => {
    const res = await request(app).post('/api/auth/logout').set('Cookie', 'token=garbage');

    expect(res.status).toBe(200);
    expect(revokeSession).not.toHaveBeenCalled();
    expect(res.headers['set-cookie']?.[0]).toMatch(/^token=;/);
  });
});

describe('POST /api/auth/logout-all', () => {
  it('ends every session this user has, on every device', async () => {
    const res = await request(app).post('/api/auth/logout-all').set('Cookie', authCookie(USER));

    expect(res.status).toBe(200);
    expect(revokeAllSessions).toHaveBeenCalledWith(USER.userId);
    expect(res.headers['set-cookie']?.[0]).toMatch(/^token=;/);
  });

  it('requires being logged in', async () => {
    const res = await request(app).post('/api/auth/logout-all');

    expect(res.status).toBe(401);
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });
});

describe('GET /api/auth/me', () => {
  it('returns the logged-in user and their role in the active collection', async () => {
    execute.mockResolvedValueOnce([[{ username: 'owner', collection_role: 'admin' }]]);

    const res = await request(app).get('/api/auth/me').set('Cookie', authCookie({ ...USER, collectionId: 5 }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 1, username: 'owner', role: 'admin', collectionId: 5 });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('collection_memberships'), [5, 1]);
  });

  it('is a plain user when no collection is selected yet', async () => {
    execute.mockResolvedValueOnce([[{ username: 'owner', collection_role: null }]]);

    const res = await request(app).get('/api/auth/me').set('Cookie', authCookie(USER));

    expect(res.body).toEqual({ userId: 1, username: 'owner', role: 'user' });
  });

  it('drops a collection the user was removed from, sending them back to the group picker', async () => {
    execute.mockResolvedValueOnce([[{ username: 'owner', collection_role: null }]]);

    const res = await request(app).get('/api/auth/me').set('Cookie', authCookie({ ...USER, collectionId: 5 }));

    expect(res.body).not.toHaveProperty('collectionId');
    expect(res.body.role).toBe('user');
  });

  it('logs out a user whose account has been deleted', async () => {
    execute.mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/auth/me').set('Cookie', authCookie(USER));

    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']?.[0]).toMatch(/^token=;/);
  });

  it('does not leak token internals like expiry timestamps or the session id', async () => {
    execute.mockResolvedValueOnce([[{ username: 'owner', collection_role: 'user' }]]);

    const res = await request(app).get('/api/auth/me').set('Cookie', authCookie(USER));

    expect(res.body).not.toHaveProperty('iat');
    expect(res.body).not.toHaveProperty('exp');
    expect(res.body).not.toHaveProperty('sid');
  });

  it('returns 401 with no auth cookie', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/collections', () => {
  it('returns the collections the current user belongs to, with their role in each', async () => {
    execute.mockResolvedValueOnce([[{ id: 5, name: 'Chicago', role: 'admin' }, { id: 6, name: 'dojo', role: 'user' }]]);

    const res = await request(app)
      .get('/api/auth/collections')
      .set('Cookie', authCookie(USER));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 5, name: 'Chicago', role: 'admin' }, { id: 6, name: 'dojo', role: 'user' }]);
  });

  it('returns 401 with no auth cookie', async () => {
    const res = await request(app).get('/api/auth/collections');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/select-collection', () => {
  it('selects a collection the user is a member of, reporting their role there', async () => {
    execute.mockResolvedValueOnce([[{ id: 6, name: 'dojo', role: 'admin' }]]);

    const res = await request(app)
      .post('/api/auth/select-collection')
      .set('Cookie', authCookie(USER))
      .send({ collectionId: 6 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 1, username: 'owner', collectionId: 6, collectionName: 'dojo', role: 'admin' });
  });

  it('keeps the same server-side session when switching collections', async () => {
    execute.mockResolvedValueOnce([[{ id: 6, name: 'dojo', role: 'user' }]]);

    const res = await request(app)
      .post('/api/auth/select-collection')
      .set('Cookie', authCookie({ ...USER, sid: 'session-xyz' }))
      .send({ collectionId: 6 });

    const token = (res.headers['set-cookie']?.[0] ?? '').split(';')[0].replace('token=', '');
    expect(jwt.decode(token)).toMatchObject({ sid: 'session-xyz', collectionId: 6 });
    expect(createSession).not.toHaveBeenCalled();
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

  it('rejects a missing collectionId with 400', async () => {
    const res = await request(app).post('/api/auth/select-collection').set('Cookie', authCookie(USER)).send({});

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('re-issues the session cookie with the new collection baked in', async () => {
    execute
      .mockResolvedValueOnce([[{ id: 6, name: 'dojo', role: 'user' }]])
      .mockResolvedValueOnce([[{ username: 'owner', collection_role: 'user' }]]); // the /me check below

    const res = await request(app)
      .post('/api/auth/select-collection')
      .set('Cookie', authCookie({ ...USER, collectionId: 5 }))
      .send({ collectionId: 6 });

    const cookie = res.headers['set-cookie']?.[0] ?? '';
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie.split(';')[0]);
    expect(me.body.collectionId).toBe(6);
  });

  it('checks membership for the logged-in user, not anyone named in the request', async () => {
    execute.mockResolvedValueOnce([[]]);

    await request(app)
      .post('/api/auth/select-collection')
      .set('Cookie', authCookie(USER))
      .send({ collectionId: 6, userId: 99 });

    expect(execute).toHaveBeenCalledWith(expect.any(String), [USER.userId, 6]);
  });
});

describe('hostile or malformed input', () => {
  const VALID = { email: 'new@example.com', username: 'newperson', password: 'validpass1' };

  it.each([
    ['an email that is an object (NoSQL-style injection)', { ...VALID, email: { $ne: null } }],
    ['an email that is not an address', { ...VALID, email: 'not-an-email' }],
    ['an email longer than the database allows', { ...VALID, email: `${'a'.repeat(250)}@example.com` }],
    ['a username sent as an array', { ...VALID, username: ['newperson'] }],
    ['a password sent as a number', { ...VALID, password: 12345678 }],
    ['a display name over 100 characters', { ...VALID, displayName: 'x'.repeat(101) }],
    ['a phone number over 20 characters', { ...VALID, phone: '5'.repeat(21) }],
    ['a neighborhood over 100 characters', { ...VALID, neighborhood: 'x'.repeat(101) }],
    ['a display name that is not text', { ...VALID, displayName: { html: '<script>' } }],
  ])('registration rejects %s with 400, touching nothing', async (_why, body) => {
    const res = await request(app).post('/api/auth/register').send(body);

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['an email object', { email: { $gt: '' }, password: 'validpass1' }],
    ['a password array', { email: 'owner@example.com', password: ['a', 'b'] }],
    ['a huge password', { email: 'owner@example.com', password: 'x'.repeat(5000) }],
  ])('login rejects %s with 400 instead of crashing', async (_why, body) => {
    const res = await request(app).post('/api/auth/login').send(body);

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['text with SQL in it', '6; DROP TABLE collections'],
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['an array', [6]],
  ])('selecting a collection rejects an id that is %s', async (_why, collectionId) => {
    const res = await request(app).post('/api/auth/select-collection').set('Cookie', authCookie(USER)).send({ collectionId });

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('stores a hostile-looking display name as plain data, via a placeholder — never as SQL', async () => {
    execute
      .mockResolvedValueOnce([[{ collection_id: 5 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([{}]);
    const hostile = "Robert'); DROP TABLE users;--";

    const res = await request(app).post('/api/auth/register').send({ ...VALID, displayName: hostile });

    expect(res.status).toBe(201);
    const insert = execute.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO users'))!;
    expect(insert[0]).not.toContain('DROP');
    expect(insert[1]).toContain(hostile);
  });
});

describe('database failures', () => {
  it.each([
    ['POST /api/auth/register', () => request(app).post('/api/auth/register').send({ email: 'new@example.com', username: 'newperson', password: 'validpass1' })],
    ['POST /api/auth/login', () => request(app).post('/api/auth/login').send({ email: 'owner@example.com', password: 'validpass1' })],
    ['GET /api/auth/collections', () => request(app).get('/api/auth/collections').set('Cookie', authCookie(USER))],
    ['POST /api/auth/select-collection', () => request(app).post('/api/auth/select-collection').set('Cookie', authCookie(USER)).send({ collectionId: 6 })],
  ])('%s returns a generic 500 without leaking the error', async (_route, send) => {
    execute.mockRejectedValue(new Error('ER_ACCESS_DENIED: secret connection details'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await send();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Server error' });
  });
});
