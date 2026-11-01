-- 2026-10-24 — UNIVERSAL_QUANT_V1 Phase C: trailing ATR premium persistence.
-- The position monitor's ATR trail (applyTrail) was a documented no-op because
-- the premium-space ATR proxy produced by buildQuantPlan was never stored on
-- the trade row. Additive only: one nullable column.
-- Apply:
--   bunx prisma db execute --file prisma/manual-migrations/20261024_quant_trailing_atr.sql --schema prisma/schema.prisma
--   bun run db:generate
-- NULL = plan had no ATR premium (e.g. invalid entry) — trailing stays a
-- documented no-op (the monitor never invents a number).

ALTER TABLE "QuantPaperTrade" ADD COLUMN "trailingAtrPremium" REAL;
