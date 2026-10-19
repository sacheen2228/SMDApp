-- 2026-10-19 — candidate_log + underlying spot column
--
-- WHY manual: this database was created with `prisma db push` (no migration history),
-- so `prisma migrate dev` wants a destructive RESET and `db push` wants to DROP the
-- legacy DailyCollectRun/DailyReport tables. Neither is acceptable in production.
-- This file is the reviewable, additive migration. Apply once:
--   bunx prisma db execute --file prisma/manual-migrations/20261019_add_candidate_log.sql --schema prisma/schema.prisma
-- Then regenerate the client: bunx prisma generate
--
-- SAFETY: purely additive. No data is copied. `underlying_spot` stays NULL for every
-- existing row because the old `spot_price` column stores the OPTION PREMIUM, not the
-- underlying price — copying it would poison every downstream delta/OTM computation.

-- 1) Journal: the UNDERLYING price gets its own column (NULL where unknown)
ALTER TABLE "Trade" ADD COLUMN "underlyingSpot" REAL;

-- 2) Candidate log: every candidate from every brain/scanner path, sent or not
CREATE TABLE "CandidateLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "strike" REAL,
    "expiry" TEXT,
    "underlyingSpot" REAL,
    "entryPremium" REAL,
    "stopPremium" REAL,
    "targetPremium" REAL,
    "underlyingStop" REAL,
    "underlyingTarget" REAL,
    "confidence" REAL,
    "rr" REAL,
    "delta" REAL,
    "regime" TEXT,
    "sessionWindow" TEXT,
    "layerStates" TEXT,
    "gateVerdict" TEXT,
    "tier" TEXT,
    "warnings" TEXT,
    "fails" TEXT,
    "sent" BOOLEAN NOT NULL DEFAULT false,
    "wouldBlock" BOOLEAN NOT NULL DEFAULT false,
    "simOutcomeR" REAL,
    "simResolvedTs" DATETIME,
    "configHash" TEXT NOT NULL
);

CREATE INDEX "CandidateLog_ts_idx" ON "CandidateLog"("ts");
CREATE INDEX "CandidateLog_source_idx" ON "CandidateLog"("source");
CREATE INDEX "CandidateLog_simResolvedTs_idx" ON "CandidateLog"("simResolvedTs");
CREATE INDEX "CandidateLog_symbol_idx" ON "CandidateLog"("symbol");
