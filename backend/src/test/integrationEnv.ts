import os from 'os';
import path from 'path';

// The docker-compose.test.yml database, shared by the integration config and its global setup.
export const INTEGRATION_ENV = {
  DB_HOST: '127.0.0.1',
  DB_PORT: '3307',
  DB_USER: 'root',
  DB_PASS: 'test_root_password',
  DB_NAME: 'mini_library',
  JWT_SECRET: 'integration-test-secret',
  PASSWORD_COST: '5', // hashing at the real cost would add seconds to every suite
  NODE_ENV: 'test',
  UPLOADS_DIR: path.join(os.tmpdir(), 'mini-library-integration-test-uploads'),
  // Phone notifications off, even if backend/.env has keys (dotenv never
  // overrides a variable that's already set). push.integration.test.ts turns
  // them on for itself, with web-push mocked.
  VAPID_PUBLIC_KEY: '',
  VAPID_PRIVATE_KEY: '',
  // The app needs its clock and the database's to agree (see
  // db/connection.ts's databaseClockSkewMinutes) — on the Pi both use the
  // system timezone. The test container runs MariaDB in UTC, so the tests do
  // too, whatever timezone this machine is in. The group's own days and hours
  // are unaffected: they come from APP_TIMEZONE (Chicago by default).
  // timezones.integration.test.ts deliberately breaks this agreement.
  TZ: 'UTC',
};
