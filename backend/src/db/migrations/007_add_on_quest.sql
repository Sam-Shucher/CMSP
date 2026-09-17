-- "On a Quest": an owner can take their own mini out (e.g. to bring it to a
-- game) with one click — no negotiation or loan. While on_quest_since is set,
-- nobody else can add it to a cart or check it out. on_quest_until is an
-- optional "back by" date shown to others.

USE mini_library;

ALTER TABLE minis ADD COLUMN IF NOT EXISTS on_quest_since DATETIME NULL;
ALTER TABLE minis ADD COLUMN IF NOT EXISTS on_quest_until DATE NULL;
