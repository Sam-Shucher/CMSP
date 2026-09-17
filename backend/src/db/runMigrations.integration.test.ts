import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mysql from 'mysql2/promise';
import { RowDataPacket } from 'mysql2';
import { runMigrations } from './runMigrations';

// migrations.integration.test.ts proves the migration FILES are right. This
// proves the RUNNER that applies them on every deploy is right: it applies
// everything once, in order, skips what's already applied, and stops at a
// broken migration without recording it.
//
// Requires: docker compose -f docker-compose.test.yml up -d

const TEST_DB = 'mini_library_runner_test';
const REAL_MIGRATIONS = path.join(__dirname, 'migrations');

let admin: mysql.Connection;
let migrationsDir: string;

// Migration files hardcode "USE mini_library;" so they run as-is on the Pi —
// copy them with the name swapped so this test never touches the real schema.
function copyMigration(file: string): void {
  const sql = fs.readFileSync(path.join(REAL_MIGRATIONS, file), 'utf8').replace(/mini_library/g, TEST_DB);
  fs.writeFileSync(path.join(migrationsDir, file), sql);
}

async function appliedFilenames(): Promise<string[]> {
  const [rows] = await admin.query<RowDataPacket[]>(`SELECT filename FROM ${TEST_DB}.schema_migrations ORDER BY id`);
  return rows.map(r => r.filename as string);
}

async function tableNames(): Promise<string[]> {
  const [rows] = await admin.query<RowDataPacket[]>(
    'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
    [TEST_DB]
  );
  return rows.map(r => r.name as string);
}

const quiet = () => {};

beforeAll(async () => {
  admin = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3307,
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASS ?? 'test_root_password',
    multipleStatements: true,
  });
});

beforeEach(async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  const baseline = fs.readFileSync(path.join(__dirname, 'schema.baseline.sql'), 'utf8');
  await admin.query(baseline.replace(/mini_library/g, TEST_DB));

  migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  for (const file of fs.readdirSync(REAL_MIGRATIONS).filter(f => f.endsWith('.sql'))) copyMigration(file);
});

afterEach(() => {
  fs.rmSync(migrationsDir, { recursive: true, force: true });
});

afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.end();
});

describe('runMigrations', () => {
  it('applies every migration to a day-zero database, in filename order, and records each', async () => {
    const expected = fs.readdirSync(REAL_MIGRATIONS).filter(f => f.endsWith('.sql')).sort();

    const applied = await runMigrations({ database: TEST_DB, migrationsDir, log: quiet });

    expect(applied).toEqual(expected);
    expect(await appliedFilenames()).toEqual(expected);
    expect(await tableNames()).toEqual(expect.arrayContaining(['collections', 'mini_images', 'cart_items', 'loans']));
  });

  it('is safe to run again — a second deploy applies nothing and changes nothing', async () => {
    await runMigrations({ database: TEST_DB, migrationsDir, log: quiet });
    const tablesAfterFirst = await tableNames();

    const appliedSecond = await runMigrations({ database: TEST_DB, migrationsDir, log: quiet });

    expect(appliedSecond).toEqual([]);
    expect(await appliedFilenames()).toHaveLength(fs.readdirSync(REAL_MIGRATIONS).filter(f => f.endsWith('.sql')).length);
    expect(await tableNames()).toEqual(tablesAfterFirst);
  });

  it('applies only the new migration when one is added later', async () => {
    await runMigrations({ database: TEST_DB, migrationsDir, log: quiet });
    fs.writeFileSync(
      path.join(migrationsDir, '999_add_test_column.sql'),
      `USE ${TEST_DB};\nALTER TABLE collections ADD COLUMN IF NOT EXISTS runner_test_note VARCHAR(20) NULL;\n`
    );

    const applied = await runMigrations({ database: TEST_DB, migrationsDir, log: quiet });

    expect(applied).toEqual(['999_add_test_column.sql']);
    const [cols] = await admin.query<RowDataPacket[]>(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'collections' AND COLUMN_NAME = 'runner_test_note'",
      [TEST_DB]
    );
    expect(cols).toHaveLength(1);
  });

  it('stops at a broken migration, does not record it, and does not run the ones after it', async () => {
    await runMigrations({ database: TEST_DB, migrationsDir, log: quiet });
    fs.writeFileSync(path.join(migrationsDir, '900_broken.sql'), `USE ${TEST_DB};\nALTER TABLE no_such_table ADD COLUMN x INT;\n`);
    fs.writeFileSync(
      path.join(migrationsDir, '901_after_broken.sql'),
      `USE ${TEST_DB};\nCREATE TABLE IF NOT EXISTS should_not_exist (id INT PRIMARY KEY);\n`
    );

    await expect(runMigrations({ database: TEST_DB, migrationsDir, log: quiet })).rejects.toThrow();

    const recorded = await appliedFilenames();
    expect(recorded).not.toContain('900_broken.sql');
    expect(recorded).not.toContain('901_after_broken.sql');
    expect(await tableNames()).not.toContain('should_not_exist');
  });

  it('picks up an existing install that ran every migration by hand before the runner existed', async () => {
    // The Pi's real history: SQL pasted manually, no schema_migrations table.
    for (const file of fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
      await admin.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    }

    // Every migration is idempotent, so re-applying them all must not fail.
    await expect(runMigrations({ database: TEST_DB, migrationsDir, log: quiet })).resolves.toHaveLength(
      fs.readdirSync(REAL_MIGRATIONS).filter(f => f.endsWith('.sql')).length
    );
  });

  it('treats a missing migrations folder as nothing to apply, rather than crashing', async () => {
    const applied = await runMigrations({ database: TEST_DB, migrationsDir: path.join(migrationsDir, 'does-not-exist'), log: quiet });

    expect(applied).toEqual([]);
    expect(await appliedFilenames()).toEqual([]);
  });

  describe('005: roles move from the user to each collection membership', () => {
    const upTo = (name: string) => fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql') && f < name);

    async function applyOnly(files: string[]): Promise<void> {
      for (const file of files.sort()) {
        await admin.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
      }
    }

    async function membershipRole(userId: number, collectionId: number): Promise<string> {
      const [[row]] = await admin.query<RowDataPacket[]>(
        `SELECT role FROM ${TEST_DB}.collection_memberships WHERE user_id = ? AND collection_id = ?`, [userId, collectionId]
      );
      return row.role as string;
    }

    it('makes existing site-wide admins admins of every collection they already belong to', async () => {
      await applyOnly(upTo('005'));
      const [users] = await admin.query<import('mysql2').ResultSetHeader>(
        `INSERT INTO ${TEST_DB}.users (email, username, password_hash, display_name, role) VALUES
         ('boss@x.co', 'boss', 'h', 'Boss', 'admin'), ('grunt@x.co', 'grunt', 'h', 'Grunt', 'user')`
      );
      const boss = users.insertId;
      const grunt = boss + 1;
      const [[chicago]] = await admin.query<RowDataPacket[]>(`SELECT id FROM ${TEST_DB}.collections WHERE name = 'Chicago'`);
      const [[dojo]] = await admin.query<RowDataPacket[]>(`SELECT id FROM ${TEST_DB}.collections WHERE name = 'dojo'`);
      await admin.query(
        `INSERT INTO ${TEST_DB}.collection_memberships (user_id, collection_id) VALUES (?, ?), (?, ?), (?, ?)`,
        [boss, chicago.id, boss, dojo.id, grunt, chicago.id]
      );

      await runMigrations({ database: TEST_DB, migrationsDir, log: quiet });

      expect(await membershipRole(boss, chicago.id)).toBe('admin');
      expect(await membershipRole(boss, dojo.id)).toBe('admin');
      expect(await membershipRole(grunt, chicago.id)).toBe('user');
    });

    it('never re-promotes someone demoted later, even if the file runs again', async () => {
      await applyOnly(upTo('005'));
      const [user] = await admin.query<import('mysql2').ResultSetHeader>(
        `INSERT INTO ${TEST_DB}.users (email, username, password_hash, display_name, role) VALUES ('boss@x.co', 'boss', 'h', 'Boss', 'admin')`
      );
      const [[chicago]] = await admin.query<RowDataPacket[]>(`SELECT id FROM ${TEST_DB}.collections WHERE name = 'Chicago'`);
      await admin.query(`INSERT INTO ${TEST_DB}.collection_memberships (user_id, collection_id) VALUES (?, ?)`, [user.insertId, chicago.id]);
      await runMigrations({ database: TEST_DB, migrationsDir, log: quiet });

      await admin.query(`UPDATE ${TEST_DB}.collection_memberships SET role = 'user' WHERE user_id = ?`, [user.insertId]);
      await admin.query(fs.readFileSync(path.join(migrationsDir, '005_per_collection_roles.sql'), 'utf8'));

      expect(await membershipRole(user.insertId, chicago.id)).toBe('user');
    });
  });

  it('ignores non-.sql files in the migrations folder', async () => {
    fs.writeFileSync(path.join(migrationsDir, 'README.md'), 'not a migration');

    const applied = await runMigrations({ database: TEST_DB, migrationsDir, log: quiet });

    expect(applied).not.toContain('README.md');
  });
});
