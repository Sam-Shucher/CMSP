-- A message thread per loan: "running 20 minutes late" next to the structured
-- terms, so what was agreed stays in the app instead of in a text thread.
-- read_at is when the other person on the loan saw the message.
--
-- A brand-new table, so this is a single CREATE TABLE IF NOT EXISTS with no
-- ALTERs to guard — running it against a database that already has it (a
-- fresh install built from schema.sql) does nothing.

USE mini_library;

CREATE TABLE IF NOT EXISTS loan_messages (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  loan_id    INT NOT NULL,
  author_id  INT NOT NULL,
  body       VARCHAR(500) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  read_at    DATETIME NULL,
  INDEX idx_loan_messages_loan (loan_id, id),
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);
