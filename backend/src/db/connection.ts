import mysql, { RowDataPacket } from 'mysql2/promise';
import 'dotenv/config';

// A connection pool keeps several DB connections open and reuses them.
// This is faster than opening a new connection on every request.
// connectionLimit: 10 means at most 10 simultaneous queries.
export const pool = mysql.createPool({
  host:             process.env.DB_HOST     ?? 'localhost',
  port:             Number(process.env.DB_PORT) || 3306, // lets integration tests point at a dockerized DB on a non-default port
  user:             process.env.DB_USER     ?? 'root',
  password:         process.env.DB_PASS     ?? '',
  database:         process.env.DB_NAME     ?? 'mini_library',
  waitForConnections: true,
  connectionLimit:  10,
  charset:          'utf8mb4', // supports emoji and non-ASCII characters
});

// How far apart this process's clock and the database's are, in minutes, as
// this app reads them. Times the database stamps itself (NOW()) and times this
// process writes (a loan's due date) are compared with each other, so the two
// have to agree — they do when both run on the Pi with its system timezone.
// A database set to another timezone shows up here as whole hours of skew.
export async function databaseClockSkewMinutes(): Promise<number> {
  const [result] = await pool.query<RowDataPacket[]>('SELECT NOW() AS now');
  const databaseNow = new Date(result[0].now as Date).getTime();
  return Math.round(Math.abs(databaseNow - Date.now()) / 60_000);
}

// Called once on startup to confirm the DB credentials work.
// Throws if the connection fails, which causes index.ts to exit with an error.
export async function verifyConnection(): Promise<void> {
  const conn = await pool.getConnection();
  conn.release(); // immediately return it to the pool — we just needed to verify
  console.log('MySQL connected successfully');
}
