-- A note and up to three photos at each end of a loan, so "the spear was
-- already bent" is a fact instead of an argument. One report per person per
-- phase ('handoff' | 'return'): the owner and the borrower each get their own
-- say at each end, and neither can edit or replace what they filed.
--
-- Both tables are brand new, so this is a pair of CREATE TABLE IF NOT EXISTS
-- with no ALTERs to guard — running it against a database that already has
-- them (a fresh install built from schema.sql) does nothing.

USE mini_library;

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

CREATE TABLE IF NOT EXISTS loan_condition_photos (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  report_id  INT NOT NULL,
  image_path VARCHAR(500) NOT NULL,
  position   TINYINT NOT NULL DEFAULT 0,
  INDEX idx_loan_condition_photos_report (report_id, position),
  FOREIGN KEY (report_id) REFERENCES loan_condition_reports(id) ON DELETE CASCADE
);
