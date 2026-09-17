import { vi } from 'vitest';

// Unit tests mock the database pool one query at a time. Every authenticated
// request also checks its server-side session (db/sessions.ts); rather than
// add that lookup to hundreds of mock sequences, unit tests use this stand-in
// where every session is live. Tests that care about sessions control these
// mocks directly (requireAuth.test.ts, auth.test.ts), sessions.test.ts tests
// the real module, and the integration tests use real sessions end to end.
// Photo uploads in unit tests land in a scratch folder (UPLOADS_DIR in
// vitest.config.ts); make sure it exists.
import fs from 'fs';
if (process.env.UPLOADS_DIR) fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

vi.mock('../db/sessions', () => ({
  createSession: vi.fn(async () => 'test-session-id'),
  touchSession: vi.fn(async () => true),
  revokeSession: vi.fn(async () => {}),
  revokeAllSessions: vi.fn(async () => {}),
  purgeEndedSessions: vi.fn(async () => 0),
}));
