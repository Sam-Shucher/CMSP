// Dev-only helper: creates a handful of known test accounts so you can log in
// and recognize rows in the DB while debugging, without ever storing a real
// password in plaintext — these still go through the normal bcrypt hashing.
//
// Run with: npm run seed  (from backend/)
// Safe to re-run — existing rows are skipped instead of erroring.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from './connection';

// The passwords are intentionally simple and documented here — these accounts
// only ever exist in your local/dev database, never in production data.
const TEST_USERS = [
  { email: 'alice@test.local', username: 'alice',   password: 'password123', displayName: 'Alice (test)',   phone: '555-000-0001', neighborhood: 'Riverside' },
  { email: 'bob@test.local',   username: 'bob',     password: 'password123', displayName: 'Bob (test)',     phone: '555-000-0002', neighborhood: 'Downtown' },
  { email: 'admin@test.local', username: 'admin_test', password: 'password123', displayName: 'Admin (test)', phone: '555-000-0003', neighborhood: 'Uptown' },
];

async function seed(): Promise<void> {
  for (const u of TEST_USERS) {
    // Invite-gate: a user can't register unless their email is approved first
    await pool.execute('INSERT IGNORE INTO approved_emails (email) VALUES (?)', [u.email]);

    const [existing] = await pool.execute('SELECT id FROM users WHERE email = ?', [u.email]);
    if ((existing as unknown[]).length > 0) {
      console.log(`Skipping ${u.email} — already exists`);
      continue;
    }

    const passwordHash = await bcrypt.hash(u.password, 12);
    await pool.execute(
      'INSERT INTO users (email, username, password_hash, display_name, phone, neighborhood) VALUES (?, ?, ?, ?, ?, ?)',
      [u.email, u.username, passwordHash, u.displayName, u.phone, u.neighborhood]
    );
    console.log(`Created ${u.email} / ${u.username} — password: ${u.password}`);
  }

  // Give the first test account admin rights so you have something to test the panel with
  await pool.execute("UPDATE users SET role = 'admin' WHERE email = ?", [TEST_USERS[2].email]);
  console.log(`\nPromoted ${TEST_USERS[2].email} to admin`);

  console.log('\nDone. Log in with any of:');
  TEST_USERS.forEach(u => console.log(`  ${u.email} / ${u.password}`));

  await pool.end();
}

seed().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
