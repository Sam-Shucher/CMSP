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
    env: {
      DB_HOST: '127.0.0.1',
      DB_PORT: '3307',
      DB_USER: 'root',
      DB_PASS: 'test_root_password',
      DB_NAME: 'mini_library',
      JWT_SECRET: 'integration-test-secret',
      NODE_ENV: 'test',
    },
  },
});
