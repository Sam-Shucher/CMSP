-- A per-group switch for prices: some groups don't want a dollar figure on
-- every mini at all. Off hides price everywhere in that group without
-- touching the stored prices, so turning it back on brings them back.
--
-- Every existing group keeps showing prices (the default), exactly as before.
-- ADD COLUMN IF NOT EXISTS makes this safe to run any number of times.

USE mini_library;

ALTER TABLE collections ADD COLUMN IF NOT EXISTS show_prices BOOLEAN NOT NULL DEFAULT TRUE AFTER name;
