import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { RowDataPacket } from 'mysql2';
import { createApp } from '../app';
import { pool } from './connection';
import { purgeEndedSessions } from './sessions';
import { resetRateLimits } from '../middleware/rateLimit';
import { jwtSecret } from '../config';
import { assertDatabaseReachable, resetDatabase, createCollection, createUser } from '../test/dbHelpers';

// Real logins against the real database: the cookie is only as good as the
// session row behind it.
// Requires: docker compose -f docker-compose.test.yml up -d

const app = createApp();
const PASSWORD = 'correct horse battery';

let collectionId: number;
let userId: number;

beforeAll(assertDatabaseReachable);
afterAll(() => pool.end());

beforeEach(async () => {
  resetRateLimits();
  await resetDatabase();
  collectionId = await createCollection('Chicago');
  const [result] = await pool.execute<import('mysql2').ResultSetHeader>(
    'INSERT INTO users (email, username, password_hash, display_name) VALUES (?, ?, ?, ?)',
    ['owner@example.com', 'owner', await bcrypt.hash(PASSWORD, 4), 'Owner']
  );
  userId = result.insertId;
  await pool.execute('INSERT INTO collection_memberships (user_id, collection_id) VALUES (?, ?)', [userId, collectionId]);
});

async function login(): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email: 'owner@example.com', password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie']?.[0] ?? '').split(';')[0];
}

const me = (cookie: string) => request(app).get('/api/auth/me').set('Cookie', cookie);

function sessionIdOf(cookie: string): string {
  return (jwt.decode(cookie.replace('token=', '')) as { sid: string }).sid;
}

async function sessionCount(): Promise<number> {
  const [[row]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [userId]);
  return Number(row.n);
}

describe('server-side sessions', () => {
  it('logging in creates a session, and the cookie works', async () => {
    const cookie = await login();

    expect(await sessionCount()).toBe(1);
    expect((await me(cookie)).status).toBe(200);
  });

  it('logging out ends the session — a saved copy of the cookie stops working', async () => {
    const cookie = await login();
    const stolenCopy = cookie;

    await request(app).post('/api/auth/logout').set('Cookie', cookie);

    const res = await me(stolenCopy);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/session has ended/i);
  });

  it('logging out on one device leaves other devices signed in', async () => {
    const phone = await login();
    const laptop = await login();

    await request(app).post('/api/auth/logout').set('Cookie', phone);

    expect((await me(phone)).status).toBe(401);
    expect((await me(laptop)).status).toBe(200);
  });

  it('"log out everywhere" ends every device\'s session', async () => {
    const phone = await login();
    const laptop = await login();

    const res = await request(app).post('/api/auth/logout-all').set('Cookie', laptop);
    expect(res.status).toBe(200);

    expect((await me(phone)).status).toBe(401);
    expect((await me(laptop)).status).toBe(401);
  });

  it('ends a session unused for more than 2 days', async () => {
    const cookie = await login();
    await pool.execute('UPDATE sessions SET last_seen_at = NOW() - INTERVAL 2 DAY - INTERVAL 1 MINUTE WHERE id = ?', [sessionIdOf(cookie)]);

    expect((await me(cookie)).status).toBe(401);
  });

  it('keeps an active session alive, pushing back the idle cutoff', async () => {
    const cookie = await login();
    await pool.execute('UPDATE sessions SET last_seen_at = NOW() - INTERVAL 1 DAY WHERE id = ?', [sessionIdOf(cookie)]);

    expect((await me(cookie)).status).toBe(200);

    const [[row]] = await pool.query<RowDataPacket[]>(
      'SELECT last_seen_at > NOW() - INTERVAL 1 MINUTE AS fresh FROM sessions WHERE id = ?', [sessionIdOf(cookie)]
    );
    expect(Number(row.fresh)).toBe(1);
  });

  it('ends a session 7 days after login even if it was used every day', async () => {
    const cookie = await login();
    await pool.execute('UPDATE sessions SET expires_at = NOW() - INTERVAL 1 MINUTE, last_seen_at = NOW() WHERE id = ?', [sessionIdOf(cookie)]);

    expect((await me(cookie)).status).toBe(401);
  });

  it('refuses a session id that belongs to a different user', async () => {
    const cookie = await login();
    const [other] = await pool.execute<import('mysql2').ResultSetHeader>(
      'INSERT INTO users (email, username, password_hash, display_name) VALUES (?, ?, ?, ?)',
      ['other@example.com', 'other', 'x', 'Other']
    );
    const forgedForOther = jwt.sign(
      { sid: sessionIdOf(cookie), userId: other.insertId, username: 'other', collectionId },
      jwtSecret(),
      { algorithm: 'HS256' }
    );

    expect((await me(`token=${forgedForOther}`)).status).toBe(401);
  });

  it('refuses old-style cookies from before sessions existed, even though they\'re validly signed', async () => {
    const legacy = jwt.sign({ userId, username: 'owner', role: 'admin', collectionId }, jwtSecret(), { algorithm: 'HS256', expiresIn: '7d' });

    expect((await me(`token=${legacy}`)).status).toBe(401);
  });

  it('switching collections keeps the same session', async () => {
    const second = await createCollection('dojo');
    await pool.execute('INSERT INTO collection_memberships (user_id, collection_id) VALUES (?, ?)', [userId, second]);
    const cookie = await login(); // two collections → none auto-selected

    const switched = await request(app).post('/api/auth/select-collection').set('Cookie', cookie).send({ collectionId: second });
    const newCookie = (switched.headers['set-cookie']?.[0] ?? '').split(';')[0];

    expect(sessionIdOf(newCookie)).toBe(sessionIdOf(cookie));
    expect(await sessionCount()).toBe(1);
  });

  it('deleting an account deletes its sessions', async () => {
    await login();
    await pool.execute('DELETE FROM users WHERE id = ?', [userId]);

    expect(await sessionCount()).toBe(0);
  });
});

describe('purgeEndedSessions', () => {
  it('removes sessions that ended over a day ago and keeps live or recently ended ones', async () => {
    const live = sessionIdOf(await login());
    const loggedOutLongAgo = sessionIdOf(await login());
    const loggedOutJustNow = sessionIdOf(await login());
    const idleForAges = sessionIdOf(await login());
    const expiredLongAgo = sessionIdOf(await login());
    await pool.execute('UPDATE sessions SET revoked_at = NOW() - INTERVAL 2 DAY WHERE id = ?', [loggedOutLongAgo]);
    await pool.execute('UPDATE sessions SET revoked_at = NOW() WHERE id = ?', [loggedOutJustNow]);
    await pool.execute('UPDATE sessions SET last_seen_at = NOW() - INTERVAL 10 DAY WHERE id = ?', [idleForAges]);
    await pool.execute('UPDATE sessions SET expires_at = NOW() - INTERVAL 3 DAY WHERE id = ?', [expiredLongAgo]);

    expect(await purgeEndedSessions()).toBe(3);

    const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM sessions ORDER BY id');
    expect(rows.map(r => r.id).sort()).toEqual([live, loggedOutJustNow].sort());
  });
});

// The session and the caller's membership of their group come back from one
// query (db/sessions.ts's touchSession), so a collection-scoped request costs
// one round trip for access control, not two. On the Pi that's half the
// database traffic of every poll.
describe('access control per request', () => {
  it('checks the session and the group membership in a single query', async () => {
    const member = await createUser('counted', collectionId);
    const execute = vi.spyOn(pool, 'execute');
    try {
      const res = await request(app).get('/api/minis/tags').set('Cookie', member.cookie);

      expect(res.status).toBe(200);
      // One for the session (with the membership), one for the tags themselves.
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      execute.mockRestore();
    }
  });

  it('still refuses a live session in a group they have been removed from', async () => {
    const member = await createUser('removed', collectionId);
    await pool.execute('DELETE FROM collection_memberships WHERE user_id = ?', [member.userId]);

    const res = await request(app).get('/api/minis/tags').set('Cookie', member.cookie);

    expect(res.status).toBe(403);
  });

  it('picks up a promotion to admin on the very next request', async () => {
    const member = await createUser('promoted', collectionId);
    expect((await request(app).get('/api/admin/users').set('Cookie', member.cookie)).status).toBe(403);

    await pool.execute("UPDATE collection_memberships SET role = 'admin' WHERE user_id = ?", [member.userId]);

    expect((await request(app).get('/api/admin/users').set('Cookie', member.cookie)).status).toBe(200);
  });
});
