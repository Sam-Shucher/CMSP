-- Removing someone from their last group deletes their account, and until now
-- their loans went with it (ON DELETE CASCADE). A borrower who lost minis and
-- was then removed vanished from the admins' lost/wounded tally and from every
-- owner's mini history. Loans now outlive the account: the person's id becomes
-- NULL and their display name is saved on the loan first
-- (services/membership.ts), the way audit_log keeps names.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; MODIFY is a no-op the second time; a
-- CASCADE key is only dropped if one is there, and the SET NULL key only added
-- if it isn't. The keys created by schema.sql / migration 004 are unnamed, so
-- they're found by what they do rather than by name.

USE mini_library;

ALTER TABLE loans ADD COLUMN IF NOT EXISTS removed_borrower_name VARCHAR(100) NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS removed_owner_name VARCHAR(100) NULL;

-- borrower_id: drop the CASCADE key, allow NULL, add a SET NULL key.
SET @old_fk := (
  SELECT kcu.CONSTRAINT_NAME
  FROM information_schema.KEY_COLUMN_USAGE kcu
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
   AND rc.TABLE_NAME = kcu.TABLE_NAME
  WHERE kcu.TABLE_SCHEMA = 'mini_library' AND kcu.TABLE_NAME = 'loans'
    AND kcu.COLUMN_NAME = 'borrower_id' AND kcu.REFERENCED_TABLE_NAME = 'users'
    AND rc.DELETE_RULE = 'CASCADE'
  LIMIT 1
);
SET @drop_fk := IF(@old_fk IS NULL, 'SELECT 1', CONCAT('ALTER TABLE loans DROP FOREIGN KEY `', @old_fk, '`'));
PREPARE stmt FROM @drop_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE loans MODIFY borrower_id INT NULL;

SET @fk_exists := (
  SELECT COUNT(*)
  FROM information_schema.KEY_COLUMN_USAGE kcu
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
   AND rc.TABLE_NAME = kcu.TABLE_NAME
  WHERE kcu.TABLE_SCHEMA = 'mini_library' AND kcu.TABLE_NAME = 'loans'
    AND kcu.COLUMN_NAME = 'borrower_id' AND kcu.REFERENCED_TABLE_NAME = 'users'
    AND rc.DELETE_RULE = 'SET NULL'
);
SET @add_fk := IF(@fk_exists = 0,
  'ALTER TABLE loans ADD CONSTRAINT fk_loans_borrower_kept FOREIGN KEY (borrower_id) REFERENCES users(id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @add_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- owner_id: the same.
SET @old_fk := (
  SELECT kcu.CONSTRAINT_NAME
  FROM information_schema.KEY_COLUMN_USAGE kcu
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
   AND rc.TABLE_NAME = kcu.TABLE_NAME
  WHERE kcu.TABLE_SCHEMA = 'mini_library' AND kcu.TABLE_NAME = 'loans'
    AND kcu.COLUMN_NAME = 'owner_id' AND kcu.REFERENCED_TABLE_NAME = 'users'
    AND rc.DELETE_RULE = 'CASCADE'
  LIMIT 1
);
SET @drop_fk := IF(@old_fk IS NULL, 'SELECT 1', CONCAT('ALTER TABLE loans DROP FOREIGN KEY `', @old_fk, '`'));
PREPARE stmt FROM @drop_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE loans MODIFY owner_id INT NULL;

SET @fk_exists := (
  SELECT COUNT(*)
  FROM information_schema.KEY_COLUMN_USAGE kcu
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
   AND rc.TABLE_NAME = kcu.TABLE_NAME
  WHERE kcu.TABLE_SCHEMA = 'mini_library' AND kcu.TABLE_NAME = 'loans'
    AND kcu.COLUMN_NAME = 'owner_id' AND kcu.REFERENCED_TABLE_NAME = 'users'
    AND rc.DELETE_RULE = 'SET NULL'
);
SET @add_fk := IF(@fk_exists = 0,
  'ALTER TABLE loans ADD CONSTRAINT fk_loans_owner_kept FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @add_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
