-- Server-side sessions. The login cookie now carries only a session id; the
-- session row decides whether it's still valid, so logging out (or "log out
-- everywhere") takes effect immediately instead of when the cookie expires.
-- A session ends after SESSION_IDLE_DAYS without use or SESSION_LIFETIME_DAYS
-- total (see backend/src/config.ts). New table only, so naturally idempotent.

USE mini_library;

CREATE TABLE IF NOT EXISTS sessions (
  id           CHAR(64) PRIMARY KEY,
  user_id      INT NOT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME NOT NULL,
  revoked_at   DATETIME NULL,
  INDEX idx_sessions_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
