-- Adds the mini_images table (up to 3 photos per mini). Purely a new table,
-- so CREATE TABLE IF NOT EXISTS makes this naturally idempotent — safe to
-- run against a database that already has it.

USE mini_library;

CREATE TABLE IF NOT EXISTS mini_images (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  mini_id    INT NOT NULL,
  image_path VARCHAR(500) NOT NULL,
  position   TINYINT NOT NULL DEFAULT 0,
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE CASCADE
);
