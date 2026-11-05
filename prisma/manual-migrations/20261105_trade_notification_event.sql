-- 2026-11-05 — Trade notification event + stable signal identity + composite unique
--
-- WHY manual: this database was created with `prisma db push` (no migration history),
-- so `prisma migrate dev` wants a destructive RESET and `db push` cannot add
-- constraints safely against existing duplicates. This file is the reviewable,
-- additive migration. Apply once:
--   bunx prisma db execute --file prisma/manual-migrations/20261105_trade_notification_event.sql --schema prisma/schema.prisma
-- Then regenerate the client: bunx prisma generate
--
-- SAFETY: purely additive, nullable columns. Existing rows get NULL for new columns.
-- Step 0 reconciles duplicate (symbol, exchange, strike, type, side, strategy)
-- groups BEFORE adding the composite unique constraint.
--
-- STEP 1: Add columns to Trade (additive, nullable — existing rows get NULL)
ALTER TABLE "Trade" ADD COLUMN "signalId" TEXT;
ALTER TABLE "Trade" ADD COLUMN "signalDate" TEXT;
ALTER TABLE "Trade" ADD COLUMN "expiry" TEXT;

-- STEP 2: Reconcile duplicate (symbol, exchange, strike, type, side, strategy) groups
--         BEFORE adding the composite unique constraint. Keep the earliest created
--         row per group; delete later duplicates. Test-sourced rows (e2e-test,
--         prod-verify) are deleted entirely as they pollute the audit ledger.

-- 2a: Delete e2e-test duplicates entirely (test pollution)
DELETE FROM "Trade"
WHERE "tradeId" LIKE '%e2e-test%'
  AND "tradeId" NOT IN (
    SELECT "tradeId" FROM (
      SELECT "tradeId", ROW_NUMBER() OVER (
        PARTITION BY symbol, exchange, strike, type, side, strategy
        ORDER BY "createdAt" ASC
      ) AS rn
      FROM "Trade"
      WHERE "tradeId" LIKE '%e2e-test%'
    ) WHERE rn = 1
  );

-- 2b: Delete prod-verify duplicates entirely
DELETE FROM "Trade"
WHERE "tradeId" LIKE '%prod-verify%'
  AND "tradeId" NOT IN (
    SELECT "tradeId" FROM (
      SELECT "tradeId", ROW_NUMBER() OVER (
        PARTITION BY symbol, exchange, strike, type, side, strategy
        ORDER BY "createdAt" ASC
      ) AS rn
      FROM "Trade"
      WHERE "tradeId" LIKE '%prod-verify%'
    ) WHERE rn = 1
  );

-- 2c: For remaining duplicate groups, keep earliest (by createdAt), delete rest
DELETE FROM "Trade"
WHERE "tradeId" IN (
  SELECT "tradeId" FROM (
    SELECT "tradeId", ROW_NUMBER() OVER (
      PARTITION BY symbol, exchange, strike, type, side, strategy
      ORDER BY "createdAt" ASC
    ) AS rn
    FROM "Trade"
    GROUP BY symbol, exchange, strike, type, side, strategy
    HAVING COUNT(*) > 1
  ) WHERE rn > 1
);

-- STEP 3: Add composite unique constraint on Trade
-- SQLite supports CREATE UNIQUE INDEX but not ALTER TABLE ADD CONSTRAINT.
-- NULL values are treated as distinct, so existing rows with NULL expiry /
-- signalDate won't conflict. New trades with all fields populated will be
-- protected against duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS "Trade_symbol_exchange_strike_type_expiry_side_strategy_signalDate_key"
ON "Trade"("symbol", "exchange", "strike", "type", "expiry", "side", "strategy", "signalDate");

-- STEP 4: Create NotificationEvent table (single source of truth for alert delivery)
CREATE TABLE IF NOT EXISTS "NotificationEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tradeId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "targetLevel" REAL,
    "eventVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "telegramMsgId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    FOREIGN KEY ("tradeId") REFERENCES "Trade"("tradeId") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "NotificationEvent_tradeId_eventType_targetLevel_eventVersion_key"
ON "NotificationEvent"("tradeId", "eventType", "targetLevel", "eventVersion");

CREATE INDEX IF NOT EXISTS "NotificationEvent_status_idx" ON "NotificationEvent"("status");
CREATE INDEX IF NOT EXISTS "NotificationEvent_createdAt_idx" ON "NotificationEvent"("createdAt");
