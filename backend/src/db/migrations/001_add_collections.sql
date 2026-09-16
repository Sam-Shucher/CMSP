-- One-time migration: adds multi-collection ("group") support to an existing
-- database that predates it. Safe to run once; every existing user and mini
-- ends up in the "Chicago" collection as a starting point — re-sort people
-- and minis into Coast2Coast/dojo afterward via the admin panel.
--
-- Run as: sudo mariadb < backend/src/db/migrations/001_add_collections.sql
--
-- Do this BEFORE deploying the new backend code — the app's queries expect
-- these tables and columns to already exist.

USE mini_library;

-- 1. Create the collections themselves.
CREATE TABLE IF NOT EXISTS collections (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  name       VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO collections (name) VALUES ('Chicago'), ('Coast2Coast'), ('dojo');

-- 2. Create the membership table and put every existing user into Chicago.
CREATE TABLE IF NOT EXISTS collection_memberships (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  user_id       INT NOT NULL,
  collection_id INT NOT NULL,
  joined_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, collection_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);

INSERT IGNORE INTO collection_memberships (user_id, collection_id)
  SELECT id, (SELECT id FROM collections WHERE name = 'Chicago') FROM users;

-- 3. Add collection_id to minis, backfill to Chicago, then lock it down.
ALTER TABLE minis ADD COLUMN IF NOT EXISTS collection_id INT NULL;
UPDATE minis SET collection_id = (SELECT id FROM collections WHERE name = 'Chicago') WHERE collection_id IS NULL;
ALTER TABLE minis MODIFY collection_id INT NOT NULL;

-- Only add the foreign key if it isn't already there (safe to re-run).
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = 'mini_library' AND TABLE_NAME = 'minis' AND CONSTRAINT_NAME = 'fk_minis_collection'
);
SET @add_fk := IF(@fk_exists = 0,
  'ALTER TABLE minis ADD CONSTRAINT fk_minis_collection FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @add_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4. Add collection_id to approved_emails, backfill, then swap the old
-- email-only UNIQUE constraint for a (email, collection) one — the same
-- email can now be invited into more than one collection separately.
ALTER TABLE approved_emails ADD COLUMN IF NOT EXISTS collection_id INT NULL;
UPDATE approved_emails SET collection_id = (SELECT id FROM collections WHERE name = 'Chicago') WHERE collection_id IS NULL;
ALTER TABLE approved_emails MODIFY collection_id INT NOT NULL;

SET @old_unique_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = 'mini_library' AND TABLE_NAME = 'approved_emails' AND INDEX_NAME = 'email'
);
SET @drop_old_unique := IF(@old_unique_exists > 0, 'ALTER TABLE approved_emails DROP INDEX email', 'SELECT 1');
PREPARE stmt FROM @drop_old_unique;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @new_unique_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = 'mini_library' AND TABLE_NAME = 'approved_emails' AND INDEX_NAME = 'email_collection_id'
);
SET @add_new_unique := IF(@new_unique_exists = 0,
  'ALTER TABLE approved_emails ADD UNIQUE KEY email_collection_id (email, collection_id)',
  'SELECT 1');
PREPARE stmt FROM @add_new_unique;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists2 := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = 'mini_library' AND TABLE_NAME = 'approved_emails' AND CONSTRAINT_NAME = 'fk_approved_emails_collection'
);
SET @add_fk2 := IF(@fk_exists2 = 0,
  'ALTER TABLE approved_emails ADD CONSTRAINT fk_approved_emails_collection FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @add_fk2;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Done. Verify with:
--   SELECT * FROM collections;
--   SELECT u.username, c.name FROM collection_memberships cm JOIN users u ON u.id=cm.user_id JOIN collections c ON c.id=cm.collection_id;
