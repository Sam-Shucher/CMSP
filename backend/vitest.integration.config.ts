import { defineConfig } from 'vitest/config';
import { INTEGRATION_ENV } from './src/test/integrationEnv';

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
    // Brings the test database up to date with every migration before any file runs.
    globalSetup: ['./src/test/integrationGlobalSetup.ts'],
    env: INTEGRATION_ENV,
  },
});
