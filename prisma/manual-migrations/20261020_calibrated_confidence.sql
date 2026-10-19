-- 2026-10-20 — expose the CALIBRATED confidence next to the stated one
--
-- The gate floors on calibrated confidence (stated mapped through the realised
-- win-rate of its own band). Storing both makes the decision auditable.
--
-- Apply:
--   bunx prisma db execute --file prisma/manual-migrations/20261020_calibrated_confidence.sql --schema prisma/schema.prisma

ALTER TABLE "CandidateLog" ADD COLUMN "calibratedConfidence" REAL;
