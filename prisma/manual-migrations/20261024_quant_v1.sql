-- 2026-10-24 — UNIVERSAL_QUANT_V1 Phase A (isolated paper-trading quant engine)
-- Additive only: 4 new tables, no existing table touched.
-- Apply:
--   bunx prisma db execute --file prisma/manual-migrations/20261024_quant_v1.sql --schema prisma/schema.prisma
--   bun run db:generate
-- Ids are generated in code (qid() in src/lib/quant/quant-types.ts).

CREATE TABLE IF NOT EXISTS "QuantPaperTrade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tradeId" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL DEFAULT 'UNIVERSAL_QUANT_V1',
    "mode" TEXT NOT NULL DEFAULT 'SHADOW',
    "strategy" TEXT NOT NULL,
    "regime" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "tradingsymbol" TEXT,
    "strike" REAL,
    "optionType" TEXT,
    "expiry" TEXT,
    "lotSize" INTEGER,
    "quantity" INTEGER,
    "lots" INTEGER,
    "entryPrice" REAL,
    "entryTime" DATETIME,
    "stopLoss" REAL,
    "currentStopLoss" REAL,
    "tp1" REAL,
    "tp2" REAL,
    "tp3" REAL,
    "tp4" REAL,
    "tpHitLevel" TEXT,
    "trailingHighWater" REAL,
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "exitPrice" REAL,
    "exitTime" DATETIME,
    "exitReason" TEXT,
    "realizedPnl" REAL,
    "unrealizedPnl" REAL,
    "estCosts" REAL,
    "riskAmount" REAL,
    "maxLossPlanned" REAL,
    "confidence" REAL,
    "dataQuality" REAL,
    "decisionId" TEXT,
    "provenance" TEXT,
    "monitorDegraded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "QuantPaperTrade_tradeId_key" ON "QuantPaperTrade"("tradeId");
CREATE INDEX IF NOT EXISTS "QuantPaperTrade_status_idx" ON "QuantPaperTrade"("status");
CREATE INDEX IF NOT EXISTS "QuantPaperTrade_symbol_idx" ON "QuantPaperTrade"("symbol");
CREATE INDEX IF NOT EXISTS "QuantPaperTrade_createdAt_idx" ON "QuantPaperTrade"("createdAt");

CREATE TABLE IF NOT EXISTS "QuantTradeEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tradeId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "level" REAL,
    "fillPrice" REAL,
    "quantityExited" INTEGER,
    "remainingQuantity" INTEGER,
    "realizedPnl" REAL,
    "note" TEXT,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "QuantTradeEvent_eventId_key" ON "QuantTradeEvent"("eventId");
CREATE INDEX IF NOT EXISTS "QuantTradeEvent_tradeId_idx" ON "QuantTradeEvent"("tradeId");
CREATE INDEX IF NOT EXISTS "QuantTradeEvent_ts_idx" ON "QuantTradeEvent"("ts");

CREATE TABLE IF NOT EXISTS "QuantAlertOutbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "alertType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "chatId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME
);
CREATE UNIQUE INDEX IF NOT EXISTS "QuantAlertOutbox_eventId_key" ON "QuantAlertOutbox"("eventId");
CREATE UNIQUE INDEX IF NOT EXISTS "QuantAlertOutbox_idempotencyKey_key" ON "QuantAlertOutbox"("idempotencyKey");

CREATE TABLE IF NOT EXISTS "QuantDecisionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "decisionId" TEXT NOT NULL,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "regime" TEXT,
    "winnerStrategy" TEXT,
    "blockReason" TEXT,
    "payload" TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "QuantDecisionLog_decisionId_key" ON "QuantDecisionLog"("decisionId");
CREATE INDEX IF NOT EXISTS "QuantDecisionLog_ts_idx" ON "QuantDecisionLog"("ts");
CREATE INDEX IF NOT EXISTS "QuantDecisionLog_symbol_idx" ON "QuantDecisionLog"("symbol");
