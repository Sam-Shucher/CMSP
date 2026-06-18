import mysql from 'mysql2/promise';
import 'dotenv/config';

// A connection pool keeps several DB connections open and reuses them.
// This is faster than opening a new connection on every request.
// connectionLimit: 10 means at most 10 simultaneous queries.
export const pool = mysql.createPool({
  host:             process.env.DB_HOST     ?? 'localhost',
  user:             process.env.DB_USER     ?? 'root',
  password:         process.env.DB_PASS     ?? '',
  database:         process.env.DB_NAME     ?? 'mini_library',
  waitForConnections: true,
  connectionLimit:  10,
  charset:          'utf8mb4', // supports emoji and non-ASCII characters
});

// Called once on startup to confirm the DB credentials work.
// Throws if the connection fails, which causes index.ts to exit with an error.
export async function verifyConnection(): Promise<void> {
  const conn = await pool.getConnection();
  conn.release(); // immediately return it to the pool — we just needed to verify
  console.log('MySQL connected successfully');
}
