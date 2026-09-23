-- Two more ways a loan can end: the mini never comes back ("lost"), or it
-- comes back broken ("critically wounded"). Widening the status enum is
-- naturally idempotent (MODIFY, not ADD), so no guard is needed. minis.condition
-- records which one, if either, applies right now — a new column rather than
-- reusing archived_at (see services/membership.ts): the owner keeps full
-- access to a condition-flagged mini so they can clear it, unlike an
-- archived one, whose owner has left the collection entirely.

USE mini_library;

ALTER TABLE loans MODIFY COLUMN status
  ENUM('negotiating', 'adventuring', 'returned', 'cancelled', 'lost', 'critically_wounded')
  NOT NULL DEFAULT 'negotiating';

-- `condition` is a reserved word in MariaDB (stored-procedure exception
-- handling), so the column is condition_flag — the API still calls it
-- "condition" in responses, that's just a JSON key, not SQL.
ALTER TABLE minis ADD COLUMN IF NOT EXISTS condition_flag ENUM('lost', 'critically_wounded') NULL;
ALTER TABLE minis ADD COLUMN IF NOT EXISTS condition_since DATETIME NULL;
CREATE INDEX IF NOT EXISTS idx_minis_condition ON minis (condition_flag);
