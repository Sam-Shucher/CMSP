import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Integration tests need a live database (see vitest.integration.config.ts)
    // and are excluded from the regular unit test run.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    setupFiles: ['./src/test/unitSetup.ts'],
    env: {
      // Hashing at the real cost would add seconds to every suite.
      PASSWORD_COST: '5',
      // Upload tests write real files — keep them out of backend/uploads.
      UPLOADS_DIR: path.join(os.tmpdir(), 'mini-library-unit-test-uploads'),
    },
  },
});
