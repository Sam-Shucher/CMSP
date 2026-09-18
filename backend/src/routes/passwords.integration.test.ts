import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { RowDataPacket } from 'mysql2';
import { createApp } from '../app';
import { pool } from '../db/connection';
import { resetRateLimits } from '../middleware/rateLimit';
import { hashPassword } from '../utils/passwords';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, TestUser,
} from '../test/dbHelpers';

// Losing and regaining a password, against the real database. There's no email
// in this app: an admin sets a temporary password and tells the person directly.
// Requires: docker compose -f docker-compose.test.yml up -d

const app = createApp();
const THEIR_PASSWORD = 'the old password 1';

let chicago: number;
let admin: TestUser;
let member: TestUser;

beforeAll(assertDatabaseReachable);
afterAll(() => pool.end());

beforeEach(async () => {
  resetRateLimits();
  await resetDatabase();
  chicago = await createCollection('Chicago');
  admin = await createUser('boss', chicago, 'admin');
  member = await createUser('forgetful', chicago);
  await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(THEIR_PASSWORD), member.userId]);
});

const login = (email: string, password: string) =>
  request(app).post('/api/auth/login').send({ email, password });

const resetFor = (who: TestUser, by: TestUser = admin) =>
  request(app).post(`/api/admin/users/${who.userId}/reset-password`).set('Cookie', by.cookie);

const changePassword = (who: TestUser, body: Record<string, unknown>) =>
  request(app).patch('/api/users/me/password').set('Cookie', who.cookie).send(body);

async function userRow(userId: number) {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT must_change_password, temp_password_expires_at FROM users WHERE id = ?', [userId]);
  return rows[0];
}

describe('an admin resets a forgotten password', () => {
  it('hands back a temporary password once, for the admin to pass on', async () => {
    const res = await resetFor(member);

    expect(res.status).toBe(200);
    expect(res.body.temporaryPassword).toMatch(/^[a-zA-Z0-9-]{16,}$/);
    expect(res.body).toMatchObject({ displayName: 'forgetful display', expiresInDays: 7 });
    // It is never readable again — only the person it was given to has it now.
    expect((await request(app).get('/api/admin/users').set('Cookie', admin.cookie)).text).not.toContain(res.body.temporaryPassword);
  });

  it('lets them in with the temporary password, and only that one', async () => {
    const { body } = await resetFor(member);

    expect((await login('forgetful@example.com', THEIR_PASSWORD)).status).toBe(401);
    const res = await login('forgetful@example.com', body.temporaryPassword);
    expect(res.status).toBe(200);
    expect(res.body.mustChangePassword).toBe(true);
  });

  it('signs out every device they were signed in on', async () => {
    expect((await request(app).get('/api/loans').set('Cookie', member.cookie)).status).toBe(200);

    await resetFor(member);

    expect((await request(app).get('/api/loans').set('Cookie', member.cookie)).status).toBe(401);
  });

  it('stops working after a week, and says why', async () => {
    const { body } = await resetFor(member);
    await pool.execute('UPDATE users SET temp_password_expires_at = NOW() - INTERVAL 1 HOUR WHERE id = ?', [member.userId]);

    const res = await login('forgetful@example.com', body.temporaryPassword);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('That temporary password has expired — ask an admin to set a new one.');
  });

  it('is refused for someone outside the admin\'s own group, and for the admin themselves', async () => {
    const dojo = await createCollection('dojo');
    const outsider = await createUser('sensei', dojo);

    expect((await resetFor(outsider)).status).toBe(404);
    expect((await resetFor(admin)).status).toBe(400);
    expect(await userRow(admin.userId)).toMatchObject({ must_change_password: 0 });
  });

  it('is refused for a member — only admins of the group can do it', async () => {
    const other = await createUser('nosy', chicago);

    expect((await resetFor(member, other)).status).toBe(403);
  });
});

describe('choosing a new password', () => {
  it('takes the new one, clears the forced change, and leaves other devices signed out', async () => {
    const { body } = await resetFor(member);
    const signIn = await login('forgetful@example.com', body.temporaryPassword);
    const cookie = signIn.headers['set-cookie'];

    const res = await request(app).patch('/api/users/me/password').set('Cookie', cookie)
      .send({ currentPassword: body.temporaryPassword, newPassword: 'a brand new password 2' });

    expect(res.status).toBe(200);
    expect(await userRow(member.userId)).toMatchObject({ must_change_password: 0, temp_password_expires_at: null });
    // Signed in where they are, and the new password works from scratch.
    expect((await request(app).get('/api/loans').set('Cookie', cookie)).status).toBe(200);
    expect((await login('forgetful@example.com', 'a brand new password 2')).status).toBe(200);
    expect((await login('forgetful@example.com', body.temporaryPassword)).status).toBe(401);
  });

  it('needs the current password, and refuses a weak or unchanged one', async () => {
    expect((await changePassword(member, { currentPassword: 'not it', newPassword: 'a fine new password' })).status).toBe(401);
    expect((await changePassword(member, { currentPassword: THEIR_PASSWORD, newPassword: 'short' })).status).toBe(400);
    expect((await changePassword(member, { currentPassword: THEIR_PASSWORD, newPassword: THEIR_PASSWORD })).status).toBe(400);
    expect((await login('forgetful@example.com', THEIR_PASSWORD)).status).toBe(200); // unchanged throughout
  });

  it('signs out their other devices, keeping the one they used', async () => {
    const elsewhere = await login('forgetful@example.com', THEIR_PASSWORD);
    const otherDevice = elsewhere.headers['set-cookie'];

    const res = await changePassword(member, { currentPassword: THEIR_PASSWORD, newPassword: 'a brand new password 2' });

    expect(res.status).toBe(200);
    expect((await request(app).get('/api/loans').set('Cookie', otherDevice)).status).toBe(401);
    expect((await request(app).get('/api/loans').set('Cookie', member.cookie)).status).toBe(200);
  });

  it('tells the app a change is still owed, so it can insist', async () => {
    await resetFor(member);
    const { body } = await resetFor(member);
    const signIn = await login('forgetful@example.com', body.temporaryPassword);

    const me = await request(app).get('/api/auth/me').set('Cookie', signIn.headers['set-cookie']);

    expect(me.body.mustChangePassword).toBe(true);
  });
});
