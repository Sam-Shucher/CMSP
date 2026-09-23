-- Two small changes, both about things outliving what they belonged to.
--
-- 1. A phone kept getting someone's notices after their sign-in there had
--    expired or gone idle — only an explicit sign-out stopped it. Each device
--    now remembers the session that turned notifications on; services/push.ts
--    only sends while that session is live, and the row goes when the session
--    is purged. Existing rows have no session and so get nothing until the app
--    next opens, which re-sends the subscription with one (frontend resyncPush).
--
-- 2. A removed member's sets stayed on the Sets page, empty, forever — their
--    minis were archived but the sets weren't. Sets now archive with them.
--
-- Idempotent: ADD COLUMN / CREATE INDEX IF NOT EXISTS, and the foreign key is
-- only added if it isn't there already.

USE mini_library;

ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS session_id CHAR(64) NULL;
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_session ON push_subscriptions (session_id);

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = 'mini_library' AND TABLE_NAME = 'push_subscriptions'
    AND COLUMN_NAME = 'session_id' AND REFERENCED_TABLE_NAME = 'sessions'
);
SET @add_fk := IF(@fk_exists = 0,
  'ALTER TABLE push_subscriptions ADD CONSTRAINT fk_push_subscriptions_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @add_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE sets ADD COLUMN IF NOT EXISTS archived_at DATETIME NULL;
CREATE INDEX IF NOT EXISTS idx_sets_archived ON sets (archived_at);
