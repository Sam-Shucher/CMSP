import { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { pool } from './connection';

// Thin, typed wrappers over mysql2. Without them every query repeats the same
// three steps — destructure the [rows, fields] pair, name a RowDataPacket type,
// then cast each column — which is both noise and a place for `any` to leak in.
//
//   const mini = await firstRow<MiniRow>('SELECT ... WHERE id = ?', [id]);
//   const removed = await change('DELETE FROM holds WHERE id = ?', [id]);
//
// Every call still goes through pool.execute, so SQL is always parameterized
// (never string-built) and the unit tests' mocked pool works unchanged. Pass a
// connection as the last argument to run inside a transaction.

// A pool or a single connection from it — anything that can run a statement.
export type Db = Pick<Pool | PoolConnection, 'execute'>;

// What a placeholder (`?`) may stand for.
export type QueryParam = string | number | boolean | Date | Buffer | null;

// The rows a SELECT returned, as the caller's row type.
export async function rows<T>(sql: string, params: QueryParam[] = [], db: Db = pool): Promise<T[]> {
  const [result] = await db.execute<RowDataPacket[]>(sql, params);
  return result as T[];
}

// The first row, or null when nothing matched.
export async function firstRow<T>(sql: string, params: QueryParam[] = [], db: Db = pool): Promise<T | null> {
  const [result] = await db.execute<RowDataPacket[]>(sql, params);
  return (result[0] as T | undefined) ?? null;
}

// A single value from the first row (COUNT(*), MAX(id), …), or null.
export async function firstValue<T>(sql: string, params: QueryParam[] = [], db: Db = pool): Promise<T | null> {
  const row = await firstRow<Record<string, T>>(sql, params, db);
  return row === null ? null : Object.values(row)[0];
}

// How many rows an INSERT/UPDATE/DELETE touched — the usual "did this land?" check.
export async function change(sql: string, params: QueryParam[] = [], db: Db = pool): Promise<number> {
  const [result] = await db.execute<ResultSetHeader>(sql, params);
  return result.affectedRows;
}

// An INSERT's new id, plus whether the row was actually inserted (INSERT IGNORE
// and conditional INSERT ... SELECT can quietly insert nothing).
export async function insert(sql: string, params: QueryParam[] = [], db: Db = pool): Promise<{ id: number; inserted: boolean }> {
  const [result] = await db.execute<ResultSetHeader>(sql, params);
  return { id: result.insertId, inserted: result.affectedRows > 0 };
}

// Runs work inside one transaction on one connection: committed if it returns,
// rolled back if it throws. Pass the connection it's given to the helpers above.
export async function inTransaction<T>(work: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
