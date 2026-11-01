-- 2026-10-23 — Trade.expiry column
--
-- WHY manual: this database was created with `prisma db push` (no migration history),
-- so `prisma migrate dev` wants a destructive RESET. This file is the reviewable,
-- additive migration. Apply once:
--   bunx prisma db execute --file prisma/manual-migrations/20261023_add_trade_expiry.sql --schema prisma/schema.prisma
-- Then regenerate the client: bunx prisma generate
--
-- SAFETY: purely additive, nullable. NULL for equity trades and for any option
-- trade registered before this migration. The TIGER monitor's MO quote guard
-- fail-closes on NULL expiry ("the trade expiry is unknown"), so the tracker
-- now persists expiry on registration and restores it on reload.

ALTER TABLE "Trade" ADD COLUMN "expiry" TEXT;
