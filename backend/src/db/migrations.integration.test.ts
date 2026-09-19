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

  // An index added to schema.sql alone would never reach the Pi — the same
  // trap as a column, and just as invisible, because everything still works,
  // only slower and slower as the collection grows.
  //
  // Compared by what an index DOES (table, columns in order, uniqueness) and
  // not by its name: a foreign key's index is auto-named by MariaDB under
  // schema.sql ("collection_id") and named explicitly by the migration that
  // created it ("fk_minis_collection"). Same index, different label, and
  // renaming live indexes on the Pi to satisfy a test would be all risk and
  // no gain.
  it('produces the same indexes either way, whatever they are named', async () => {
    const indexQuery = `
      SELECT TABLE_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS COLUMNS
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
      GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE
      ORDER BY TABLE_NAME, COLUMNS, NON_UNIQUE
    `;

    const [freshIndexes] = await connection.query(indexQuery, [FRESH_DB]);
    const [upgradedIndexes] = await connection.query(indexQuery, [UPGRADED_DB]);

    expect(upgradedIndexes).toEqual(freshIndexes);
  });
});

// The queries these back run on every browse, every detail view, and every
// 30-second poll of the Loans page. Without them MariaDB scans; with a few
// hundred minis and a year of loans that is the difference people feel.
describe('indexes the hot queries need', () => {
  const EXPECTED: [string, string, string[]][] = [
    // GET /api/minis: WHERE collection_id = ? ORDER BY created_at DESC
    ['minis', 'idx_minis_collection_created', ['collection_id', 'created_at']],
    // The per-mini status subquery: WHERE mini_id = ? AND status IN (...)
    ['loans', 'idx_loans_mini_status', ['mini_id', 'status']],
    // GET /api/loans: WHERE collection_id = ? AND (borrower_id = ? OR owner_id = ?)
    ['loans', 'idx_loans_collection_borrower', ['collection_id', 'borrower_id']],
    ['loans', 'idx_loans_collection_owner', ['collection_id', 'owner_id']],
    // The photo subquery, which orders by position.
    ['mini_images', 'idx_mini_images_mini_position', ['mini_id', 'position']],
  ];

  it.each(EXPECTED)('%s has %s', async (table: string, index: string, columns: string[]) => {
    const [found] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?
       ORDER BY SEQ_IN_INDEX`,
      [FRESH_DB, table, index]
    );

    expect(found.map(row => row.COLUMN_NAME)).toEqual(columns);
  });
});
