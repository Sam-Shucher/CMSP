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
};
