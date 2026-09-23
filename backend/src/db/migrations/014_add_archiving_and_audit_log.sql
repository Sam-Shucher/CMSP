-- A grace period on member removal, and an audit trail for it. A removed
-- member's minis are now archived (hidden, restorable) instead of deleted
-- outright when they still belong to another collection — see
-- services/membership.ts and maintenance/housekeeping.ts.

USE mini_library;

ALTER TABLE minis ADD COLUMN IF NOT EXISTS archived_at DATETIME NULL;
CREATE INDEX IF NOT EXISTS idx_minis_archived ON minis (archived_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id             INT PRIMARY KEY AUTO_INCREMENT,
  collection_id  INT NOT NULL,
  actor_id       INT NULL,
  actor_name     VARCHAR(100) NOT NULL,
  action         VARCHAR(40) NOT NULL,
  target_user_id INT NULL,
  target_name    VARCHAR(100) NULL,
  details        VARCHAR(500) NOT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_log_collection_created (collection_id, created_at),
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL
);
