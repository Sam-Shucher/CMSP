// Test data and database helpers for the end-to-end suite. CommonJS so both
// the web server command (prepare.cjs) and the TypeScript tests can load it.
//
// Uses its own database (mini_library_e2e) on the Docker test server, so it
// never touches the integration-test database or anything real.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const ROOT = path.resolve(__dirname, '../..');
// Photos uploaded during the tests; wiped before each run (prepare.cjs).
const UPLOADS_DIR = path.join(__dirname, '..', '.uploads');
// Where signed-in sessions are saved by auth.setup.ts.
const AUTH_DIR = path.join(__dirname, '..', '.auth');

const E2E_PORT = 4310;
const BASE_URL = `http://localhost:${E2E_PORT}`;
const E2E_DB = 'mini_library_e2e';

const DB = {
  host: '127.0.0.1',
  port: 3307,
  user: 'root',
  password: 'test_root_password',
};

const PASSWORD = 'correct horse battery 1';

// Everyone the tests act as. `groups` maps collection name → role.
const USERS = {
  olivia: { displayName: 'Olivia Owner', groups: { Chicago: 'user' } },
  bruno: { displayName: 'Bruno Borrower', groups: { Chicago: 'user' } },
  wendy: { displayName: 'Wendy Waiting', groups: { Chicago: 'user' } },
  theo: { displayName: 'Theo Third', groups: { Chicago: 'user' } },
  nina: { displayName: 'Nina Notify', groups: { Chicago: 'user' } },
  ada: { displayName: 'Ada Admin', groups: { Chicago: 'admin', dojo: 'user' } },
  // Only used by the "log out everywhere" test, which ends all of her sessions.
  sam: { displayName: 'Sam Sessions', groups: { Chicago: 'user' } },
};

const emailOf = username => `${username}@e2e.test`;

async function connect(database) {
  try {
    return await mysql.createConnection({ ...DB, database, multipleStatements: true });
  } catch (err) {
    throw new Error(
      'Could not reach the test database for end-to-end tests. Start it first with:\n' +
      '  docker compose -f docker-compose.test.yml up -d\n' +
      `Original error: ${err.message}`
    );
  }
}

async function seedMemberships(conn) {
  await conn.query('DELETE FROM collection_memberships');
  for (const [username, user] of Object.entries(USERS)) {
    for (const [collection, role] of Object.entries(user.groups)) {
      await conn.execute(
        `INSERT INTO collection_memberships (user_id, collection_id, role)
         SELECT u.id, c.id, ? FROM users u, collections c WHERE u.username = ? AND c.name = ?`,
        [role, username, collection]
      );
    }
  }
}

// Fresh database from schema.sql, with the seeded collections and users.
async function recreateDatabase() {
  const conn = await connect();
  try {
    await conn.query(`DROP DATABASE IF EXISTS ${E2E_DB}`);
    const schema = fs.readFileSync(path.join(ROOT, 'backend/src/db/schema.sql'), 'utf8');
    await conn.query(schema.replace(/mini_library/g, E2E_DB));
    await conn.query(`USE ${E2E_DB}`);

    await conn.query("INSERT INTO collections (name) VALUES ('Chicago'), ('dojo')");
    const hash = await bcrypt.hash(PASSWORD, 4); // low cost: speed, not security, in tests
    for (const [username, user] of Object.entries(USERS)) {
      await conn.execute(
        'INSERT INTO users (email, username, password_hash, display_name) VALUES (?, ?, ?, ?)',
        [emailOf(username), username, hash, user.displayName]
      );
    }
    await seedMemberships(conn);
  } finally {
    await conn.end();
  }
}

// Before each test: remove everything tests create, and put memberships and
// roles back — but keep the seeded users and their login sessions.
async function resetData() {
  const conn = await connect(E2E_DB);
  try {
    for (const table of [
      'notifications', 'holds', 'hold_watchers', 'bookings',
      'loan_condition_photos', 'loan_condition_reports',
      'cart_items', 'loans',
      'mini_tags', 'mini_images', 'minis', 'sets', 'tags', 'approved_emails',
    ]) {
      await conn.query(`DELETE FROM ${table}`);
    }
    const seeded = Object.keys(USERS);
    await conn.query(`DELETE FROM users WHERE username NOT IN (${seeded.map(() => '?').join(', ')})`, seeded);
    await seedMemberships(conn);
  } finally {
    await conn.end();
  }
}

async function query(sql, params = []) {
  const conn = await connect(E2E_DB);
  try {
    const [rows] = await conn.execute(sql, params);
    return rows;
  } finally {
    await conn.end();
  }
}

module.exports = {
  ROOT, UPLOADS_DIR, AUTH_DIR, E2E_PORT, BASE_URL, E2E_DB, DB, PASSWORD, USERS,
  emailOf, recreateDatabase, resetData, query,
};
