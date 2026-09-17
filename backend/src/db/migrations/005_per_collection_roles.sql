-- Makes "admin" a role you hold in a particular collection, instead of a
-- site-wide flag on the user. Being an admin of Chicago no longer says
-- anything about dojo.
--
-- Existing site-wide admins become admins of every collection they already
-- belong to, so nobody loses access on upgrade. That copy happens only when
-- the column is first added — re-running this file later must never
-- re-promote someone who has since been demoted in a collection.
-- users.role is left in place but is no longer read by the app.

USE mini_library;

SET @had_role := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'mini_library' AND TABLE_NAME = 'collection_memberships' AND COLUMN_NAME = 'role'
);

ALTER TABLE collection_memberships
  ADD COLUMN IF NOT EXISTS role ENUM('user', 'admin') NOT NULL DEFAULT 'user';

SET @backfill := IF(@had_role = 0,
  'UPDATE collection_memberships cm JOIN users u ON u.id = cm.user_id SET cm.role = ''admin'' WHERE u.role = ''admin''',
  'SELECT 1');
PREPARE stmt FROM @backfill;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
