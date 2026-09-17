// Dev-only helper: creates a handful of known test accounts so you can log in
// and recognize rows in the DB while debugging, without ever storing a real
// password in plaintext — these still go through the normal bcrypt hashing.
//
// Run with: npm run seed  (from backend/)
// Safe to re-run — existing rows are skipped instead of erroring.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from './connection';
import { assertSeedAllowed } from './seedGuard';

// The passwords are intentionally simple and documented here — these accounts
// only ever exist in your local/dev database, never in production data.
const COLLECTIONS = ['Chicago', 'Coast2Coast', 'dojo'];

const TEST_USERS = [
  { email: 'alice@test.local', username: 'alice',      password: 'password123', displayName: 'Alice (test)', phone: '555-000-0001', neighborhood: 'Riverside' },
  { email: 'bob@test.local',   username: 'bob',     password: 'password123', displayName: 'Bob (test)',     phone: '555-000-0002', neighborhood: 'Downtown' },
  { email: 'admin@test.local', username: 'admin_test', password: 'password123', displayName: 'Admin (test)', phone: '555-000-0003', neighborhood: 'Uptown' },
];

async function seed(): Promise<void> {
  assertSeedAllowed();

  for (const name of COLLECTIONS) {
    await pool.execute('INSERT IGNORE INTO collections (name) VALUES (?)', [name]);
  }
  const [collectionRows] = await pool.execute<RowDataPacket[]>('SELECT id FROM collections WHERE name = ?', ['Chicago']);
  const chicagoId = collectionRows[0].id as number;

  for (const u of TEST_USERS) {
    // Invite-gate: a user can't register unless their email is approved first
    await pool.execute('INSERT IGNORE INTO approved_emails (email, collection_id) VALUES (?, ?)', [u.email, chicagoId]);

    const [existing] = await pool.execute<RowDataPacket[]>('SELECT id FROM users WHERE email = ?', [u.email]);
    if (existing.length > 0) {
      console.log(`Skipping ${u.email} — already exists`);
      continue;
    }

    const passwordHash = await bcrypt.hash(u.password, 12);
    const [result] = await pool.execute<ResultSetHeader>(
      'INSERT INTO users (email, username, password_hash, display_name, phone, neighborhood) VALUES (?, ?, ?, ?, ?, ?)',
      [u.email, u.username, passwordHash, u.displayName, u.phone, u.neighborhood]
    );
    await pool.execute('INSERT IGNORE INTO collection_memberships (user_id, collection_id) VALUES (?, ?)', [result.insertId, chicagoId]);
    console.log(`Created ${u.email} / ${u.username} — password: ${u.password} — joined Chicago`);
  }

  // Make the admin test account an admin of Chicago so there's something to test the panel with
  await pool.execute(
    "UPDATE collection_memberships SET role = 'admin' WHERE collection_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)",
    [chicagoId, TEST_USERS[2].email]
  );
  console.log(`\nMade ${TEST_USERS[2].email} an admin of Chicago`);

  console.log('\nDone. Log in with any of:');
  TEST_USERS.forEach(u => console.log(`  ${u.email} / ${u.password}`));

  await pool.end();
}

seed().catch(async (err: unknown) => {
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
});
