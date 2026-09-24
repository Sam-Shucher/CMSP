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
  -- Some groups don't want a dollar figure on every mini. Off hides price
  -- everywhere in this group (routes/minis.ts) without touching the stored
  -- prices, so turning it back on brings them back as they were.
  show_prices BOOLEAN NOT NULL DEFAULT TRUE,
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
-- collection_id is the group the sign-in is in now (the cookie's, kept in step
-- by db/sessions.ts), so phone notifications reach only the group being shown.
-- No foreign key: a deleted group's id just matches no notice.
CREATE TABLE IF NOT EXISTS sessions (
  id           CHAR(64) PRIMARY KEY,
  user_id      INT NOT NULL,
  collection_id INT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME NOT NULL,
  revoked_at   DATETIME NULL,
  INDEX idx_sessions_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Phones and browsers that said yes to notifications (Web Push). One row per
-- device, keyed by the push service's URL for it — the same device signing in
-- as someone else takes the row over, rather than notifying both people.
-- Removed when the person turns it off, signs out there, signs out
-- everywhere, or the push service says the device is gone (404/410).
-- session_id is the sign-in that turned it on: notices only go to a device
-- while that session is live, so one that expired or went idle stops getting
-- them, and the row goes with the session when it's purged.
-- ASCII, since these are URLs and base64url keys, which also keeps the unique
-- index on a 1000-character endpoint well inside InnoDB's key size.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  user_id    INT NOT NULL,
  endpoint   VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  p256dh     VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  auth       VARCHAR(50) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_id CHAR(64) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_push_subscriptions_endpoint (endpoint),
  INDEX idx_push_subscriptions_user (user_id),
  INDEX idx_push_subscriptions_session (session_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- A named group of one owner's own minis, borrowed together as a unit (a
-- boxed army, a Kill Team) instead of one at a time. Membership lives on
-- minis.set_id below, not here — deleting a set (ON DELETE SET NULL there)
-- just ungroups its minis, it never touches the minis themselves.
-- archived_at: its owner was removed from the group — hidden with their minis,
-- back if they're restored to that owner, purged with them after the grace period.
CREATE TABLE IF NOT EXISTS sets (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  name          VARCHAR(100) NOT NULL,
  owner_id      INT NOT NULL,
  collection_id INT NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  archived_at   DATETIME NULL,
  INDEX idx_sets_collection (collection_id),
  INDEX idx_sets_archived (archived_at),
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
  -- Set when the owner is removed from the collection but keeps another one —
  -- hides the mini everywhere while giving an admin a window to restore it
  -- before maintenance/housekeeping.ts permanently deletes it.
  archived_at   DATETIME NULL,
  -- Set by ending a loan as lost/critically wounded (routes/loans.ts) — hides
  -- the mini from browse either way. No auto-purge: the owner (or an admin)
  -- decides what happens next, by deleting it or, for critically_wounded,
  -- clearing it back into service (POST /api/minis/:id/clear-condition).
  -- Named condition_flag, not condition — that word is reserved in MariaDB.
  condition_flag  ENUM('lost', 'critically_wounded') NULL,
  condition_since DATETIME NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Browsing a collection: WHERE collection_id = ? ORDER BY created_at DESC.
  INDEX idx_minis_collection_created (collection_id, created_at),
  INDEX idx_minis_set (set_id),
  INDEX idx_minis_archived (archived_at),
  INDEX idx_minis_condition (condition_flag),
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
  -- NULL once that person's account is deleted: the loan itself stays, so a
  -- mini's history and the admins' lost/wounded tally don't lose it, under
  -- the name saved in removed_borrower_name / removed_owner_name.
  borrower_id       INT NULL,
  owner_id          INT NULL,
  status            ENUM('negotiating', 'adventuring', 'returned', 'cancelled', 'lost', 'critically_wounded') NOT NULL DEFAULT 'negotiating',
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
  removed_borrower_name VARCHAR(100) NULL, -- their display name, saved as their account was deleted
  removed_owner_name    VARCHAR(100) NULL,
  -- Is this mini out? Asked once per mini on every browse.
  INDEX idx_loans_mini_status (mini_id, status),
  -- Your loans in this group, either side of the deal — polled every 30s.
  INDEX idx_loans_collection_borrower (collection_id, borrower_id),
  INDEX idx_loans_collection_owner (collection_id, owner_id),
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (borrower_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL
);

-- What state a mini was in at each end of a loan, so "the spear was already
-- bent" is a fact rather than an argument. One report per person per phase:
-- the owner and the borrower each get their own say at the handoff and at the
-- return, and neither can edit or replace what they filed. No name snapshot
-- here (unlike audit_log): a loan is already CASCADE-deleted with either
-- person's account, so a report can never outlive the people it is about.
CREATE TABLE IF NOT EXISTS loan_condition_reports (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  loan_id    INT NOT NULL,
  phase      ENUM('handoff', 'return') NOT NULL,
  author_id  INT NOT NULL,
  note       VARCHAR(1000) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (loan_id, phase, author_id),
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Up to 3 photos per report (position 0-2, enforced in application code),
-- exactly like mini_images. maintenance/housekeeping.ts counts these as
-- in-use files, so its sweep never deletes one.
CREATE TABLE IF NOT EXISTS loan_condition_photos (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  report_id  INT NOT NULL,
  image_path VARCHAR(500) NOT NULL,
  position   TINYINT NOT NULL DEFAULT 0,
  INDEX idx_loan_condition_photos_report (report_id, position),
  FOREIGN KEY (report_id) REFERENCES loan_condition_reports(id) ON DELETE CASCADE
);

-- A loan's message thread — "running 20 minutes late", "front door, ring
-- twice" — so what was agreed stays in the app instead of in a text thread.
-- Only the loan's two people can see it, so each message has exactly one
-- reader: read_at is when the OTHER person saw it. Never edited or deleted;
-- it goes with the loan (CASCADE), like a condition report.
CREATE TABLE IF NOT EXISTS loan_messages (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  loan_id    INT NOT NULL,
  author_id  INT NOT NULL,
  body       VARCHAR(500) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  read_at    DATETIME NULL,
  -- The thread in order, and the counts on every loan row: WHERE loan_id = ?.
  INDEX idx_loan_messages_loan (loan_id, id),
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);

-- "I need this for game night on the 14th" — a claim on a date range, where a
-- hold (below) is a claim on a place in a queue. No two bookings on the same
-- mini may overlap; services/bookings.ts enforces that in a transaction that
-- locks the mini row, the same way the hold line does.
--
-- A booking constrains the loan CALENDAR: a handoff or extension whose due
-- date reaches someone else's booked window is refused (routes/loans.ts).
-- started_at/loan_id are set once housekeeping turns it into a request on its
-- first day; a booking whose window passes without that is a no-show and is
-- swept away with a notice.
CREATE TABLE IF NOT EXISTS bookings (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  mini_id       INT NOT NULL,
  collection_id INT NOT NULL,
  user_id       INT NOT NULL,
  starts_on     DATE NOT NULL,
  ends_on       DATE NOT NULL,
  note          VARCHAR(255) NULL, -- "game night at the shop"
  loan_id       INT NULL,          -- the request it became, once it started
  started_at    DATETIME NULL,     -- set even if the loan is later deleted
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- Overlap checks and the calendar for one mini: WHERE mini_id = ? ORDER BY starts_on.
  INDEX idx_bookings_mini_dates (mini_id, starts_on, ends_on),
  -- "My bookings in this group", and the hourly sweep's WHERE starts_on <= CURDATE().
  INDEX idx_bookings_collection_user (collection_id, user_id),
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE SET NULL
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

-- A trace of admin actions with real consequences (removing a member,
-- restoring an archived mini) — who did it, to/about whom, and when.
-- actor/target are SET NULL rather than CASCADE, with the name snapshotted
-- alongside: an account is deleted the moment its owner leaves their last
-- collection, and the whole point of this log is to survive that.
CREATE TABLE IF NOT EXISTS audit_log (
  id             INT PRIMARY KEY AUTO_INCREMENT,
  collection_id  INT NOT NULL,
  actor_id       INT NULL,
  actor_name     VARCHAR(100) NOT NULL,
  action         VARCHAR(40) NOT NULL, -- 'member_removed' | 'mini_restored'
  target_user_id INT NULL,
  target_name    VARCHAR(100) NULL,
  details        VARCHAR(500) NOT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_log_collection_created (collection_id, created_at),
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Bootstrap: create at least one collection, then add your own email to its
-- invite list so you can be the first to register into it:
-- INSERT INTO collections (name) VALUES ('Chicago');
-- INSERT INTO approved_emails (email, collection_id) VALUES ('your@email.com', (SELECT id FROM collections WHERE name = 'Chicago'));
-- After registering, make yourself an admin of that collection:
-- UPDATE collection_memberships SET role = 'admin'
--   WHERE user_id = (SELECT id FROM users WHERE email = 'your@email.com')
--     AND collection_id = (SELECT id FROM collections WHERE name = 'Chicago');