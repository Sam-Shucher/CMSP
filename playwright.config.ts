import { defineConfig } from '@playwright/test';
import { BASE_URL, E2E_DB, E2E_PORT, DB, UPLOADS_DIR } from './tests/support/seed.cjs';

// End-to-end tests: real Chrome driving the real production build (the same
// single server the Pi runs), against its own throwaway database.
//
//   docker compose -f docker-compose.test.yml up -d
//   npm run test:e2e
export default defineConfig({
  testDir: './tests',
  // One shared database, so tests run one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    channel: 'chrome', // the installed Google Chrome — no separate browser download
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Signs each seeded user in once and saves their session for the tests.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'e2e', testMatch: /.*\.spec\.ts/, dependencies: ['setup'] },
  ],
  webServer: {
    command: 'node tests/support/prepare.cjs && node backend/dist/index.js',
    url: `${BASE_URL}/login`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'production',
      PORT: String(E2E_PORT),
      FRONTEND_URL: BASE_URL,
      DB_HOST: DB.host,
      DB_PORT: String(DB.port),
      DB_USER: DB.user,
      DB_PASS: DB.password,
      DB_NAME: E2E_DB,
      JWT_SECRET: 'e2e-only-secret-0123456789abcdef0123456789abcdef',
      UPLOADS_DIR,
    },
  },
});
