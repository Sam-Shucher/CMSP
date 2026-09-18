import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';

// Runs tests against the real MariaDB container started by
// docker-compose.test.yml (repo root), instead of the mocked pool the
// regular unit tests use. Catches SQL that's only broken against a real
// server — bad GROUP BY clauses, missing columns, etc.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 15000, // DB round-trips are slower than mocked calls
    // Every file wipes and reseeds the same mini_library database in
    // beforeEach, so files must not run concurrently or they'd delete each
    // other's rows mid-test.
    fileParallelism: false,
    env: {
      DB_HOST: '127.0.0.1',
      DB_PORT: '3307',
      DB_USER: 'root',
      DB_PASS: 'test_root_password',
      DB_NAME: 'mini_library',
      JWT_SECRET: 'integration-test-secret',
      PASSWORD_COST: '5', // hashing at the real cost would add seconds to every suite
      NODE_ENV: 'test',
      UPLOADS_DIR: path.join(os.tmpdir(), 'mini-library-integration-test-uploads'),
    },
  },
});
