-- 2026-10-19 — separate column for the UNDERLYING price
--
-- WHY: `spot_price` in this ledger stores the OPTION PREMIUM (the value the signal
-- engine worked with), not the underlying index/equity level. Any downstream delta,
-- OTM-step or strike-distance computation that treats spot_price as spot is wrong.
-- The underlying gets its own nullable column; existing rows stay NULL because the
-- premium must never be copied into it.
--
-- Apply: node -e "const D=require('better-sqlite3');const db=new D('data/trade_audit.db');db.exec(require('fs').readFileSync('migrations/20261019_underlying_spot.sql','utf8'))"
-- (idempotent: the ALTER is skipped when the column already exists)

ALTER TABLE trades ADD COLUMN underlying_spot REAL;
