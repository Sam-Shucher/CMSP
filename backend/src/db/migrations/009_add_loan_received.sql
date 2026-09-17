-- The borrower's "Got it": after the owner confirms the handoff (which starts
-- the loan and its clock), the borrower acknowledges they have the mini.
-- It's a record for both sides — it doesn't change the loan's status or due date.

USE mini_library;

ALTER TABLE loans ADD COLUMN IF NOT EXISTS received_at DATETIME NULL AFTER handed_off_at;
