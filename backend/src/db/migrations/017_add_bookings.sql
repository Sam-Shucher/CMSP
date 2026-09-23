-- "I need this for game night on the 14th". A hold answers "tell me when it's
-- free"; a booking claims a date range up front. No two bookings on the same
-- mini may overlap — services/bookings.ts enforces that inside a transaction
-- that locks the mini row, the same way the hold line does.
--
-- A brand new table, so this is one CREATE TABLE IF NOT EXISTS with no ALTERs
-- to guard: running it against a database that already has it (a fresh
-- install built from schema.sql) does nothing.

USE mini_library;

CREATE TABLE IF NOT EXISTS bookings (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  mini_id       INT NOT NULL,
  collection_id INT NOT NULL,
  user_id       INT NOT NULL,
  starts_on     DATE NOT NULL,
  ends_on       DATE NOT NULL,
  note          VARCHAR(255) NULL,
  loan_id       INT NULL,
  started_at    DATETIME NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_bookings_mini_dates (mini_id, starts_on, ends_on),
  INDEX idx_bookings_collection_user (collection_id, user_id),
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE SET NULL
);
