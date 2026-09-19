-- Run once: mysql -u root -p < backend/src/db/schema.sql

CREATE DATABASE IF NOT EXISTS mini_library
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE mini_library;

-- A collection is a fully separate group of people and minis (e.g. "Chicago",
-- "Coast2Coast", "dojo"). Nothing about a collection is visible to someone
-- who isn't a member of it — see collection_memberships below.
CREATE TABLE IF NOT EXISTS collections (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  name       VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Invite list — only emails here can register, scoped per collection. The
-- same email can be invited into more than one collection at once (hence
-- UNIQUE on the pair, not on email alone), and registering joins every
-- collection whose invite list contains that email.
CREATE TABLE IF NOT EXISTS approved_emails (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  email         VARCHAR(255) NOT NULL,
  collection_id INT NOT NULL,
  added_by      INT NULL,
  added_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (email, collection_id),
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  email         VARCHAR(255) UNIQUE NOT NULL,
  username      VARCHAR(50)  UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name  VARCHAR(100) NOT NULL,
  phone         VARCHAR(20)  NULL,
  neighborhood  VARCHAR(100) NULL,
  role          ENUM('user', 'admin') DEFAULT 'user', -- legacy, unused: roles are per collection (collection_memberships.role)
  -- Set when an admin hands out a temporary password: the app asks for a new
  -- one before anything else, and the temporary one stops working after a week.
  must_change_password     BOOLEAN NOT NULL DEFAULT FALSE,
  temp_password_expires_at DATETIME NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Which collections a user belongs to (many-to-many), and their role in each.
-- This is the only thing that grants access to a collection's minis or admin
-- panel — an admin of one collection has no special powers in another.
CREATE TABLE IF NOT EXISTS collection_memberships (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  user_id       INT NOT NULL,
  collection_id INT NOT NULL,
  joined_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  role          ENUM('user', 'admin') NOT NULL DEFAULT 'user',
  UNIQUE (user_id, collection_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);

-- Server-side login sessions. The cookie holds only the session id; a session
-- ends when revoked (logout), after a stretch of inactivity, or at expires_at.
CREATE TABLE IF NOT EXISTS sessions (
  id           CHAR(64) PRIMARY KEY,
  user_id      INT NOT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME NOT NULL,
  revoked_at   DATETIME NULL,
  INDEX idx_sessions_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- A named group of one owner's own minis, borrowed together as a unit (a
-- boxed army, a Kill Team) instead of one at a time. Membership lives on
-- minis.set_id below, not here — deleting a set (ON DELETE SET NULL there)
-- just ungroups its minis, it never touches the minis themselves.
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

CREATE TABLE IF NOT EXISTS minis (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  name          VARCHAR(255) NOT NULL,
  description   TEXT,
  owner_id      INT NOT NULL,
  collection_id INT NOT NULL,
  image_path    VARCHAR(500), -- legacy single-photo column, superseded by mini_images below
  price         DECIMAL(6,2) NOT NULL DEFAULT 0.00,
  available     BOOLEAN DEFAULT TRUE, -- legacy, unused: availability is derived from loans below
  on_quest_since DATETIME NULL, -- set while the owner has taken it out themselves ("On a Quest")
  on_quest_until DATE NULL,     -- optional "back by" date while on a quest
  set_id        INT NULL, -- optional: this mini is part of an owner's named set (see sets above)
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Browsing a collection: WHERE collection_id = ? ORDER BY created_at DESC.
  INDEX idx_minis_collection_created (collection_id, created_at),
  INDEX idx_minis_set (set_id),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (set_id) REFERENCES sets(id) ON DELETE SET NULL
);

-- Up to 3 photos per mini (position 0-2, enforced in application code).
CREATE TABLE IF NOT EXISTS mini_images (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  mini_id    INT NOT NULL,
  image_path VARCHAR(500) NOT NULL,
  position   TINYINT NOT NULL DEFAULT 0,
  -- Every mini row's photo subquery: WHERE mini_id = ? ORDER BY position.
  INDEX idx_mini_images_mini_position (mini_id, position),
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  id   INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin UNIQUE NOT NULL -- exact: 🔥 ≠ 🐉, cafe ≠ café
);

CREATE TABLE IF NOT EXISTS mini_tags (
  mini_id INT NOT NULL,
  tag_id  INT NOT NULL,
  PRIMARY KEY (mini_id, tag_id),
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id)  REFERENCES tags(id)  ON DELETE CASCADE
);

-- A borrower's basket. Adding a mini here reserves nothing — only checkout does.
CREATE TABLE IF NOT EXISTS cart_items (
  id       INT PRIMARY KEY AUTO_INCREMENT,
  user_id  INT NOT NULL,
  mini_id  INT NOT NULL,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, mini_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE CASCADE
);

-- One row per mini per checkout. A mini is "available" when it has no
-- negotiating/adventuring loan. Terms (when/where/how/duration) are agreed
-- two-key style: both approval flags must be set on the same terms, and any
-- edit clears the other side's approval. Only the owner sets duration and
-- confirms the handoff, which starts the clock (due_at).
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
  received_at       DATETIME NULL, -- borrower's "Got it", after the handoff
  due_at            DATETIME NULL,
  returned_at       DATETIME NULL,
  cancelled_by      INT NULL,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  overdue_notified_at DATETIME NULL, -- set once "overdue" has been announced
  -- Is this mini out? Asked once per mini on every browse.
  INDEX idx_loans_mini_status (mini_id, status),
  -- Your loans in this group, either side of the deal — polled every 30s.
  INDEX idx_loans_collection_borrower (collection_id, borrower_id),
  INDEX idx_loans_collection_owner (collection_id, owner_id),
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (borrower_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Holds: up to 3 people waiting (in id order) for a mini that isn't available.
-- When it's confirmed back, the first hold automatically becomes a request.
CREATE TABLE IF NOT EXISTS holds (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  mini_id    INT NOT NULL,
  user_id    INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (mini_id, user_id),
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- People who want to hear when a full hold line opens up.
CREATE TABLE IF NOT EXISTS hold_watchers (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  mini_id    INT NOT NULL,
  user_id    INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (mini_id, user_id),
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- In-app notifications (the bell), per user and collection.
CREATE TABLE IF NOT EXISTS notifications (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  user_id       INT NOT NULL,
  collection_id INT NOT NULL,
  type          VARCHAR(40) NOT NULL,
  message       VARCHAR(255) NOT NULL,
  mini_id       INT NULL,
  loan_id       INT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  read_at       DATETIME NULL,
  INDEX idx_notifications_inbox (user_id, collection_id, read_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE SET NULL,
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE SET NULL
);

-- Bootstrap: create at least one collection, then add your own email to its
-- invite list so you can be the first to register into it:
-- INSERT INTO collections (name) VALUES ('Chicago');
-- INSERT INTO approved_emails (email, collection_id) VALUES ('your@email.com', (SELECT id FROM collections WHERE name = 'Chicago'));
-- After registering, make yourself an admin of that collection:
-- UPDATE collection_memberships SET role = 'admin'
--   WHERE user_id = (SELECT id FROM users WHERE email = 'your@email.com')
--     AND collection_id = (SELECT id FROM collections WHERE name = 'Chicago');