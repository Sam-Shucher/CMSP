-- Web Push: the phones and browsers that said yes to notifications, so a loan
-- request reaches someone without them having to open the site.
--
-- A brand-new table, so this is a single CREATE TABLE IF NOT EXISTS with no
-- ALTERs to guard — running it against a database that already has it (a
-- fresh install built from schema.sql) does nothing.

USE mini_library;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  user_id    INT NOT NULL,
  endpoint   VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  p256dh     VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  auth       VARCHAR(50) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_push_subscriptions_endpoint (endpoint),
  INDEX idx_push_subscriptions_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
