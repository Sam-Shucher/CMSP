// Applies every not-yet-applied file in db/migrations/, in filename order,
// and records each one in a schema_migrations table so it's never run twice
// and never accidentally skipped. This replaces manually pasting SQL on the
// Pi in some remembered order — the exact mistake that caused three
// production outages (mini_images, phone/neighborhood, collections) before
// this existed. Run automatically by scripts/rpi-update.sh and
// scripts/rpi-setup.sh on every deploy; safe to run any number of times.
//
// Usage: npm run migrate  (dev)  /  node dist/db/runMigrations.js  (prod)
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import { RowDataPacket } from 'mysql2';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

interface AppliedRow extends RowDataPacket {
  filename: string;
}

export async function runMigrations(): Promise<void> {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASS ?? '',
    database: process.env.DB_NAME ?? 'mini_library',
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

    const files = fs.existsSync(MIGRATIONS_DIR)
      ? fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
      : [];

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  skip   ${file} (already applied)`);
        continue;
      }

      console.log(`  apply  ${file}`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await connection.query(sql);
      await connection.execute('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
    }

    console.log('Migrations up to date.');
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
