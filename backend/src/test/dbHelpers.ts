import { ResultSetHeader } from 'mysql2';
import { pool } from '../db/connection';
import { authCookie } from './helpers';

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
    'cart_items', 'loans', 'mini_tags', 'mini_images', 'minis', 'tags',
    'approved_emails', 'collection_memberships', 'users', 'collections',
  ]) {
    await pool.query(`DELETE FROM ${table}`);
  }
}

export async function createCollection(name: string): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>('INSERT INTO collections (name) VALUES (?)', [name]);
  return result.insertId;
}

export interface TestUser {
  userId: number;
  username: string;
  collectionId: number;
  cookie: string;
}

export async function createUser(username: string, collectionId: number, role: 'user' | 'admin' = 'user'): Promise<TestUser> {
  const [result] = await pool.execute<ResultSetHeader>(
    'INSERT INTO users (email, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)',
    [`${username}@example.com`, username, 'not-a-real-hash', `${username} display`, role]
  );
  const userId = result.insertId;
  await pool.execute('INSERT INTO collection_memberships (user_id, collection_id) VALUES (?, ?)', [userId, collectionId]);
  return { userId, username, collectionId, cookie: authCookie({ userId, username, role, collectionId }) };
}

// Same person, acting in a different collection they also belong to.
export async function joinCollection(user: TestUser, collectionId: number): Promise<TestUser> {
  await pool.execute('INSERT INTO collection_memberships (user_id, collection_id) VALUES (?, ?)', [user.userId, collectionId]);
  return {
    ...user,
    collectionId,
    cookie: authCookie({ userId: user.userId, username: user.username, role: 'user', collectionId }),
  };
}

export async function createMini(owner: TestUser, name: string): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    'INSERT INTO minis (name, owner_id, collection_id) VALUES (?, ?, ?)',
    [name, owner.userId, owner.collectionId]
  );
  return result.insertId;
}
