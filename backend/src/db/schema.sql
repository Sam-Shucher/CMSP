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
  role          ENUM('user', 'admin') DEFAULT 'user',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Which collections a user belongs to (many-to-many). This is the only
-- thing that grants access to a collection's minis or admin panel — a role
-- of 'admin' above is site-wide capability, but an admin still can't touch
-- a collection they aren't a member of.
CREATE TABLE IF NOT EXISTS collection_memberships (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  user_id       INT NOT NULL,
  collection_id INT NOT NULL,
  joined_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, collection_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
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
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);

-- Up to 3 photos per mini (position 0-2, enforced in application code).
CREATE TABLE IF NOT EXISTS mini_images (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  mini_id    INT NOT NULL,
  image_path VARCHAR(500) NOT NULL,
  position   TINYINT NOT NULL DEFAULT 0,
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  id   INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) UNIQUE NOT NULL
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

-- Bootstrap: create at least one collection, then add your own email to its
-- invite list so you can be the first to register into it:
-- INSERT INTO collections (name) VALUES ('Chicago');
-- INSERT INTO approved_emails (email, collection_id) VALUES ('your@email.com', (SELECT id FROM collections WHERE name = 'Chicago'));
-- After registering, promote yourself to (site-wide) admin:
-- UPDATE users SET role = 'admin' WHERE email = 'your@email.com';