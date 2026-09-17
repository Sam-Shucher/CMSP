-- Phase 2, part 1: the cart and library-style loans (checkout, two-key
-- negotiation of when/where/how/duration, handoff, return). Both tables are
-- brand new, so CREATE TABLE IF NOT EXISTS makes this naturally idempotent.

USE mini_library;

CREATE TABLE IF NOT EXISTS cart_items (
  id       INT PRIMARY KEY AUTO_INCREMENT,
  user_id  INT NOT NULL,
  mini_id  INT NOT NULL,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, mini_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS loans (
  id                INT PRIMARY KEY AUTO_INCREMENT,
  mini_id           INT NOT NULL,
  collection_id     INT NOT NULL,
  borrower_id       INT NOT NULL,
  owner_id          INT NOT NULL,
  status            ENUM('negotiating', 'adventuring', 'returned', 'cancelled') NOT NULL DEFAULT 'negotiating',
  handoff_when      DATETIME NULL,
  handoff_where     VARCHAR(255) NULL,
  handoff_how       VARCHAR(255) NULL,
  duration_days     INT NULL,
  borrower_approved BOOLEAN NOT NULL DEFAULT FALSE,
  owner_approved    BOOLEAN NOT NULL DEFAULT FALSE,
  handed_off_at     DATETIME NULL,
  due_at            DATETIME NULL,
  returned_at       DATETIME NULL,
  cancelled_by      INT NULL,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (borrower_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL
);
