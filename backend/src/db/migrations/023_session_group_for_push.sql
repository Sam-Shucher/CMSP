-- Someone in two groups got phone notifications from both, whichever one the
-- app was showing — and tapping one from the other group opened the Loans page
-- of the group they were in. The bell already showed one group at a time;
-- phones now do too. Each session remembers the group its cookie is in
-- (db/sessions.ts), and services/push.ts sends a group's notice only to
-- devices signed in there. The other group's notices wait in its bell.
--
-- Existing sessions start with none and pick it up on their next request.
-- Until then a phone would go quiet, so anyone in exactly one group gets that
-- group filled in now; someone in several has to open the app once.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the fill-in only touches rows
-- that have no group yet.

USE mini_library;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS collection_id INT NULL AFTER user_id;

UPDATE sessions s
JOIN (
  SELECT user_id, MIN(collection_id) AS collection_id
  FROM collection_memberships
  GROUP BY user_id
  HAVING COUNT(*) = 1
) only_group ON only_group.user_id = s.user_id
SET s.collection_id = only_group.collection_id
WHERE s.collection_id IS NULL;
