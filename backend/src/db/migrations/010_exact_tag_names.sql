-- Tag names are compared exactly. The default collation ignored accents and
-- treated every emoji as the same character, so tagging a mini "🔥" attached
-- an existing "🐉" tag instead (and "cafe" became "café"). Tags are already
-- lowercased by the app, so an exact (binary) comparison loses nothing.

USE mini_library;

ALTER TABLE tags MODIFY name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;
