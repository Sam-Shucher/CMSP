import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import { INTEGRATION_ENV } from './integrationEnv';

// The test container only runs schema.sql when its volume is first created, so a
// container made before a new table or column would never get it. Applying every
// (idempotent) migration first keeps it current, the same way a Pi deploy does.
export default async function setup(): Promise<void> {
  const env = INTEGRATION_ENV;
  let connection: mysql.Connection;
  try {
    connection = await mysql.createConnection({
      host: env.DB_HOST,
      port: Number(env.DB_PORT),
      user: env.DB_USER,
      password: env.DB_PASS,
      database: env.DB_NAME,
      multipleStatements: true,
    });
  } catch (err) {
    throw new Error(
      'Could not reach the test database. Start it first with:\n' +
      '  docker compose -f docker-compose.test.yml up -d\n' +
      `Original error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    const migrationsDir = path.join(__dirname, '../db/migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      await connection.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    }
  } finally {
    await connection.end();
  }
}
