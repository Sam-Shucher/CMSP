-- Sets: a named group of one owner's own minis, borrowed together as a unit
-- (a boxed army, a Kill Team) instead of one at a time. A new table (sets)
-- plus one nullable column on minis (set_id) recording which set, if any,
-- each mini belongs to. Deleting a set ungroups its minis (ON DELETE SET
-- NULL) rather than deleting them.

USE mini_library;

CREATE TABLE IF NOT EXISTS sets (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  name          VARCHAR(100) NOT NULL,
  owner_id      INT NOT NULL,
  collection_id INT NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sets_collection (collection_id),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);

ALTER TABLE minis ADD COLUMN IF NOT EXISTS set_id INT NULL;

-- MariaDB has no ADD CONSTRAINT IF NOT EXISTS, so check first — the usual
-- dance for a foreign key that might already be there from an earlier run.
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = 'mini_library' AND TABLE_NAME = 'minis' AND CONSTRAINT_NAME = 'fk_minis_set'
);
SET @add_fk := IF(@fk_exists = 0,
  'ALTER TABLE minis ADD CONSTRAINT fk_minis_set FOREIGN KEY (set_id) REFERENCES sets(id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @add_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE INDEX IF NOT EXISTS idx_minis_set ON minis (set_id);
