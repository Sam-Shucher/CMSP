import { ResultSetHeader } from 'mysql2';
import { pool } from '../db/connection';
import { authCookie, testSessionId } from './helpers';

// Shared seeding helpers for *.integration.test.ts files that run against the
// real Docker MariaDB (see docker-compose.test.yml).

export async function assertDatabaseReachable(): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    throw new Error(
      'Could not reach the test database. Start it first with:\n' +
      '  docker compose -f docker-compose.test.yml up -d\n' +
      `Original error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// Children before parents, because of foreign keys.
export async function resetDatabase(): Promise<void> {
  for (const table of [
    'notifications', 'holds', 'hold_watchers', 'bookings',
    'loan_condition_photos', 'loan_condition_reports', 'loan_messages',
    'cart_items', 'loans', 'mini_tags', 'mini_images', 'minis', 'sets', 'tags',
    'approved_emails', 'collection_memberships', 'sessions', 'push_subscriptions', 'users', 'collections',
  ]) {
    await pool.query(`DELETE FROM ${table}`);
  }
}

export async function createCollection(name: string): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>('INSERT INTO collections (name) VALUES (?)', [name]);
  return result.insertId;
}

// A live session row matching the id authCookie() puts in its cookies.
export async function createTestSession(userId: number): Promise<string> {
  const id = testSessionId(userId);
  await pool.execute(
    'INSERT IGNORE INTO sessions (id, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL 7 DAY)',
    [id, userId]
  );
  return id;
}

export interface TestUser {
  userId: number;
  username: string;
  collectionId: number;
  cookie: string;
}

// `role` is the user's role in that collection.
export async function createUser(username: string, collectionId: number, role: 'user' | 'admin' = 'user'): Promise<TestUser> {
  const [result] = await pool.execute<ResultSetHeader>(
    'INSERT INTO users (email, username, password_hash, display_name) VALUES (?, ?, ?, ?)',
    [`${username}@example.com`, username, 'not-a-real-hash', `${username} display`]
  );
  const userId = result.insertId;
  await pool.execute(
    'INSERT INTO collection_memberships (user_id, collection_id, role) VALUES (?, ?, ?)',
    [userId, collectionId, role]
  );
  await createTestSession(userId);
  return { userId, username, collectionId, cookie: authCookie({ userId, username, collectionId }) };
}

// Same person, acting in a different collection they also belong to.
export async function joinCollection(user: TestUser, collectionId: number, role: 'user' | 'admin' = 'user'): Promise<TestUser> {
  await pool.execute(
    'INSERT INTO collection_memberships (user_id, collection_id, role) VALUES (?, ?, ?)',
    [user.userId, collectionId, role]
  );
  return {
    ...user,
    collectionId,
    cookie: authCookie({ userId: user.userId, username: user.username, collectionId }),
  };
}

export async function createMini(owner: TestUser, name: string): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    'INSERT INTO minis (name, owner_id, collection_id) VALUES (?, ?, ?)',
    [name, owner.userId, owner.collectionId]
  );
  return result.insertId;
}
