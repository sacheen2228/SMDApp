-- 2026-11-20 — EMA 9/21/50 shadow observation columns on CandidateLog
--
-- Phase 8B: shadow-only observation of the EMA 9/21/50 market-structure read
-- for both Intraday Scanner and Weekly Scanner. No live behaviour change:
-- emaStructureShadow stays true, emaStructureLive stays false; this only
-- appends observation columns to the existing candidate ledger.
--
-- WHY manual: this database was created with `prisma db push` (no migration
-- history), so `prisma migrate dev` wants a destructive RESET. This file is
-- the reviewable, additive migration. Apply once:
--   bunx prisma db execute --file prisma/manual-migrations/20261120_ema_shadow_observation.sql --schema prisma/schema.prisma
-- Then regenerate the client: bunx prisma generate
--
-- SAFETY: purely additive. All new columns are NULLable with defaults where
-- sensible; every existing row keeps NULL for the new fields.

ALTER TABLE "CandidateLog" ADD COLUMN "emaAlignment" TEXT;
ALTER TABLE "CandidateLog" ADD COLUMN "emaSetupType" TEXT;
ALTER TABLE "CandidateLog" ADD COLUMN "emaDirection" TEXT;
ALTER TABLE "CandidateLog" ADD COLUMN "emaDirectionalVerdict" TEXT;
ALTER TABLE "CandidateLog" ADD COLUMN "emaOptionsConfirmation" TEXT;
ALTER TABLE "CandidateLog" ADD COLUMN "emaDataQuality" TEXT;
ALTER TABLE "CandidateLog" ADD COLUMN "emaIsStale" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CandidateLog" ADD COLUMN "emaBars" INTEGER;
ALTER TABLE "CandidateLog" ADD COLUMN "existingSignalDirection" TEXT;
ALTER TABLE "CandidateLog" ADD COLUMN "outcome" TEXT;
ALTER TABLE "CandidateLog" ADD COLUMN "observationSource" TEXT;
ALTER TABLE "CandidateLog" ADD COLUMN "instrumentType" TEXT;
ALTER TABLE "CandidateLog" ADD COLUMN "expiryType" TEXT;
ALTER TABLE "CandidateLog" ADD COLUMN "optionType" TEXT;
ALTER TABLE "CandidateLog" ADD COLUMN "isMarketOpen" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "CandidateLog_emaAlignment_idx" ON "CandidateLog"("emaAlignment");
CREATE INDEX "CandidateLog_outcome_idx" ON "CandidateLog"("outcome");
CREATE INDEX "CandidateLog_observationSource_idx" ON "CandidateLog"("observationSource");
