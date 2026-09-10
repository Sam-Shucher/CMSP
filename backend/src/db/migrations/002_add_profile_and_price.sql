-- Run once against an existing database:
--   mysql -u root -p mini_library < backend/src/db/migrations/002_add_profile_and_price.sql
-- Safe to re-run — IF NOT EXISTS skips columns that are already there.

USE mini_library;

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone        VARCHAR(20)  NULL AFTER display_name;
ALTER TABLE users ADD COLUMN IF NOT EXISTS neighborhood VARCHAR(100) NULL AFTER phone;

ALTER TABLE minis ADD COLUMN IF NOT EXISTS price DECIMAL(6,2) NOT NULL DEFAULT 0.00 AFTER image_path;
