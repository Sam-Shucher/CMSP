import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

// The test this whole session's outages were missing: it builds a database
// two different ways and proves they land in the same place.
//
//   FRESH_DB    = schema.sql applied directly (what a brand-new install gets)
//   UPGRADED_DB = schema.baseline.sql (day-zero) + every migrations/*.sql file
//                 in order (what an existing install gets after upgrading)
//
// If a schema.sql change (a new column on an EXISTING table, say) isn't also
// captured as a migration, UPGRADED_DB won't have it and this test fails —
// exactly the gap that let mini_images, phone/neighborhood, and collections
// each reach code before they ever reached the Pi's actual database.
//
// Requires: docker compose -f docker-compose.test.yml up -d

const FRESH_DB = 'mini_library_drift_fresh';
const UPGRADED_DB = 'mini_library_drift_upgraded';

let connection: mysql.Connection;

// schema.sql and every migration hardcode "mini_library" as the database
// name (so they're directly runnable via `mariadb < file.sql` on the Pi) —
// substituting the name here lets two differently-named copies coexist on
// the same test server without touching those files.
async function applySqlAs(dbName: string, sql: string): Promise<void> {
  await connection.query(sql.replace(/mini_library/g, dbName));
}

beforeAll(async () => {
  connection = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3307,
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASS ?? 'test_root_password',
    multipleStatements: true,
  });

  try {
    await connection.query('SELECT 1');
  } catch (err) {
    throw new Error(
      'Could not reach the test database. Start it first with:\n' +
      '  docker compose -f docker-compose.test.yml up -d\n' +
      `Original error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  await connection.query(`DROP DATABASE IF EXISTS ${FRESH_DB}`);
  await connection.query(`DROP DATABASE IF EXISTS ${UPGRADED_DB}`);

  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await applySqlAs(FRESH_DB, schemaSql);

  const baselineSql = fs.readFileSync(path.join(__dirname, 'schema.baseline.sql'), 'utf8');
  await applySqlAs(UPGRADED_DB, baselineSql);

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const migrationSql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await applySqlAs(UPGRADED_DB, migrationSql);
  }
});

afterAll(async () => {
  await connection.query(`DROP DATABASE IF EXISTS ${FRESH_DB}`);
  await connection.query(`DROP DATABASE IF EXISTS ${UPGRADED_DB}`);
  await connection.end();
});

describe('schema.sql vs baseline + migrations', () => {
  it('produces identical tables and columns either way', async () => {
    const columnsQuery = `
      SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, COLUMN_NAME
    `;

    const [freshColumns] = await connection.query(columnsQuery, [FRESH_DB]);
    const [upgradedColumns] = await connection.query(columnsQuery, [UPGRADED_DB]);

    expect(upgradedColumns).toEqual(freshColumns);
  });

  it('produces identical foreign keys either way', async () => {
    const fkQuery = `
      SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY TABLE_NAME, COLUMN_NAME
    `;

    const [freshFks] = await connection.query(fkQuery, [FRESH_DB]);
    const [upgradedFks] = await connection.query(fkQuery, [UPGRADED_DB]);

    expect(upgradedFks).toEqual(freshFks);
  });
});
