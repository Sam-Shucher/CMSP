-- Indexes for the queries that run constantly: browsing a collection, working
-- out whether each mini is out, and the Loans page poll. Nothing about the
-- app's behaviour changes -- these only stop MariaDB from scanning whole
-- tables as a collection fills up and loan history accumulates.
--
-- Each is a composite whose first column already has an index of its own (from
-- a foreign key); the second column is what saves the sort or the row-by-row
-- filter. Safe to run repeatedly: IF NOT EXISTS.

USE mini_library;

-- GET /api/minis: WHERE collection_id = ? ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_minis_collection_created ON minis (collection_id, created_at);

-- The photo subquery in MINI_SELECT, once per mini row: ORDER BY position
CREATE INDEX IF NOT EXISTS idx_mini_images_mini_position ON mini_images (mini_id, position);

-- activeLoanStatusSql, once per mini row:
--   WHERE mini_id = ? AND status IN ('negotiating', 'adventuring')
CREATE INDEX IF NOT EXISTS idx_loans_mini_status ON loans (mini_id, status);

-- GET /api/loans, polled every 30 seconds by anyone on the Loans page:
--   WHERE collection_id = ? AND (borrower_id = ? OR owner_id = ?)
-- Two indexes, so the optimiser can merge them for the OR instead of scanning.
CREATE INDEX IF NOT EXISTS idx_loans_collection_borrower ON loans (collection_id, borrower_id);
CREATE INDEX IF NOT EXISTS idx_loans_collection_owner ON loans (collection_id, owner_id);
