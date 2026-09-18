-- Admin-led password reset. There's no email in this app, so when someone is
-- locked out an admin sets a temporary password and tells them in person (the
-- admin can see their phone number). must_change_password makes the app ask
-- for a new one before they can do anything else, and the temporary password
-- stops working after a week.

USE mini_library;

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS temp_password_expires_at DATETIME NULL;
