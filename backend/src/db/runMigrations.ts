// Applies every not-yet-applied file in db/migrations/, in filename order,
// and records each one in a schema_migrations table so it's never run twice
// and never accidentally skipped. This replaces manually pasting SQL on the
// Pi in some remembered order — the exact mistake that caused three
// production outages (mini_images, phone/neighborhood, collections) before
// this existed. Run automatically by scripts/rpi-update.sh and
// scripts/rpi-setup.sh on every deploy; safe to run any number of times.
//
// Usage: npm run migrate  (dev)  /  node dist/db/runMigrations.js  (prod)
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import { RowDataPacket } from 'mysql2';

// Resolved relative to this file (backend/dist/db/runMigrations.js at
// runtime), not the caller's working directory — plain `dotenv/config`
// looks for `.env` in process.cwd(), which silently found nothing (and fell
// back to root/no-password) the one time this was invoked from the repo
// root instead of backend/. This can't repeat that mistake regardless of
// where it's called from.
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '../../.env') });

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

interface AppliedRow extends RowDataPacket {
  filename: string;
}

// Both options exist so tests can point the runner at a scratch database and
// a scratch migrations folder; a real deploy passes neither.
export interface RunMigrationsOptions {
  database?: string;
  migrationsDir?: string;
  log?: (line: string) => void;
}

// Returns the filenames it applied this run (empty when already up to date).
export async function runMigrations(options: RunMigrationsOptions = {}): Promise<string[]> {
  const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR;
  const log = options.log ?? console.log;
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASS ?? '',
    database: options.database ?? process.env.DB_NAME ?? 'mini_library',
    // Migration files can contain several statements (ALTERs, then a
    // backfill UPDATE, etc.) — a single query() call runs all of them.
    multipleStatements: true,
  });

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         INT PRIMARY KEY AUTO_INCREMENT,
        filename   VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const [appliedRows] = await connection.query<AppliedRow[]>('SELECT filename FROM schema_migrations');
    const applied = new Set(appliedRows.map(r => r.filename));

    const files = fs.existsSync(migrationsDir)
      ? fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
      : [];

    const appliedNow: string[] = [];
    for (const file of files) {
      if (applied.has(file)) {
        log(`  skip   ${file} (already applied)`);
        continue;
      }

      log(`  apply  ${file}`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      // Recorded only after the SQL succeeds — a failing migration stops the
      // run (so later ones don't apply on top of it) and gets retried next deploy.
      await connection.query(sql);
      await connection.execute('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
      appliedNow.push(file);
    }

    log('Migrations up to date.');
    return appliedNow;
  } finally {
    await connection.end();
  }
}

// Only run automatically when invoked directly (node dist/db/runMigrations.js),
// not when imported by a test.
if (require.main === module) {
  runMigrations().catch((err: unknown) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
