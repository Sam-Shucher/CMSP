-- Holds: a line of up to 3 people waiting for a mini that isn't available.
-- When the mini is confirmed back, the first person's hold automatically
-- becomes their request (a negotiating loan). Line order is by id.
-- hold_watchers: people who asked to be told when a full line opens up.
-- notifications: the in-app bell.
-- loans.overdue_notified_at: so "overdue" is only announced once per loan.

USE mini_library;

CREATE TABLE IF NOT EXISTS holds (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  mini_id    INT NOT NULL,
  user_id    INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (mini_id, user_id),
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS hold_watchers (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  mini_id    INT NOT NULL,
  user_id    INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (mini_id, user_id),
  FOREIGN KEY (mini_id) REFERENCES minis(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

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

ALTER TABLE loans ADD COLUMN IF NOT EXISTS overdue_notified_at DATETIME NULL;
