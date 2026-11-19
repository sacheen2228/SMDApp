-- P0 — Historical Data Integrity Foundation (2026-11-19)
--
-- ADDITIVE ONLY. `ALTER TABLE ... ADD COLUMN` — no DROP, no DELETE, no data
-- rewrite. Existing rows keep their values; the new columns are NULL for
-- historical rows (recorded as MISSING, never back-filled with a guessed time).
--
-- Apply with:
--   bunx prisma db execute --file ...   (NOT applicable — this is the
--   market-history SQLite sidecar, opened by better-sqlite3)
-- The sidecar applies the identical ALTERs on start (market-history/src/db/index.ts,
-- PROVENANCE_COLUMNS), so this file is the reviewable record of the change.
--
-- Recovery: a consistent backup (VACUUM INTO) of db/market_history.db was
-- taken before the change at /tmp/opencode/p0-backup/market_history.consistent.db.
-- Rollback: SQLite cannot DROP a column before 3.35; restoring the backup file
-- is the rollback path (no data is lost by keeping the columns).

ALTER TABLE market_snapshots ADD COLUMN provider_timestamp TEXT;
ALTER TABLE market_snapshots ADD COLUMN collected_at TEXT;
ALTER TABLE market_snapshots ADD COLUMN source TEXT;

ALTER TABLE chain_ticks ADD COLUMN provider_timestamp TEXT;
ALTER TABLE chain_ticks ADD COLUMN source TEXT;
ALTER TABLE chain_ticks ADD COLUMN is_estimated INTEGER;
ALTER TABLE chain_ticks ADD COLUMN expiry TEXT;

ALTER TABLE candles ADD COLUMN source TEXT;
