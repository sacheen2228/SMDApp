-- P0 — Historical Data Integrity Foundation (2026-11-19)
--
-- Registers the four observation tables in a fresh database AND repairs an
-- existing one. The tables already existed in db/custom.db (created by an
-- earlier `db push` whose schema was later removed from prisma/schema.prisma),
-- but were never registered there — the generated client had no accessors and
-- the next `db push` would have DROPPED them.
--
-- This migration is ADDITIVE and IDEMPOTENT:
--   * CREATE TABLE / CREATE INDEX IF NOT EXISTS — never drops, never rewrites.
--   * No INSERT / UPDATE / DELETE — no historical observation is touched.
--
-- Proof of safety (run before applying):
--   bunx prisma migrate diff \
--     --from-url "file:/home/sachin/Desktop/SDMApp/db/custom.db" \
--     --to-schema-datamodel prisma/schema.prisma --script
--   -> "-- This is an empty migration."  (schema now matches the live DB)
--
-- Rollback: none needed (nothing is removed). To revert the schema file only,
-- restore prisma/schema.prisma from git — the tables are harmless if left.
--
-- Recovery: a verified pre-migration copy of db/custom.db is kept at
-- /tmp/opencode/p0-backup/custom.db.<timestamp> (md5-verified) plus a
-- VACUUM INTO consistent copy where the file was not locked.

CREATE TABLE IF NOT EXISTS "MarketObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instrument" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'NSE',
    "tradingDate" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "interval" TEXT NOT NULL,
    "open" REAL,
    "high" REAL,
    "low" REAL,
    "close" REAL,
    "volume" REAL,
    "ema9" REAL,
    "ema21" REAL,
    "vwap" REAL,
    "atr" REAL,
    "pdh" REAL,
    "pdl" REAL,
    "dataProvider" TEXT NOT NULL,
    "providerTimestamp" DATETIME,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "freshness" TEXT NOT NULL,
    "qualityStatus" TEXT NOT NULL,
    "qualityIssues" TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS "MarketObservation_instrument_idx" ON "MarketObservation"("instrument");
CREATE INDEX IF NOT EXISTS "MarketObservation_exchange_idx" ON "MarketObservation"("exchange");
CREATE INDEX IF NOT EXISTS "MarketObservation_tradingDate_idx" ON "MarketObservation"("tradingDate");
CREATE INDEX IF NOT EXISTS "MarketObservation_timestamp_idx" ON "MarketObservation"("timestamp");
CREATE INDEX IF NOT EXISTS "MarketObservation_interval_idx" ON "MarketObservation"("interval");
CREATE UNIQUE INDEX IF NOT EXISTS "MarketObservation_instrument_exchange_interval_timestamp_key" ON "MarketObservation"("instrument", "exchange", "interval", "timestamp");

CREATE TABLE IF NOT EXISTS "OptionChainSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instrument" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'NSE',
    "expiry" TEXT NOT NULL,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "spotPrice" REAL,
    "spotPriceSource" TEXT,
    "dataProvider" TEXT NOT NULL,
    "providerTimestamp" DATETIME,
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "fallbackReason" TEXT,
    "freshness" TEXT NOT NULL,
    "completeness" TEXT NOT NULL,
    "qualityStatus" TEXT NOT NULL,
    "qualityIssues" TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS "OptionChainSnapshot_instrument_idx" ON "OptionChainSnapshot"("instrument");
CREATE INDEX IF NOT EXISTS "OptionChainSnapshot_exchange_idx" ON "OptionChainSnapshot"("exchange");
CREATE INDEX IF NOT EXISTS "OptionChainSnapshot_expiry_idx" ON "OptionChainSnapshot"("expiry");
CREATE INDEX IF NOT EXISTS "OptionChainSnapshot_collectedAt_idx" ON "OptionChainSnapshot"("collectedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "OptionChainSnapshot_instrument_exchange_expiry_collectedAt_key" ON "OptionChainSnapshot"("instrument", "exchange", "expiry", "collectedAt");

CREATE TABLE IF NOT EXISTS "OptionChainContract" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "strike" REAL NOT NULL,
    "optionType" TEXT NOT NULL,
    "ltp" REAL,
    "oi" REAL,
    "oiChange" REAL,
    "volume" REAL,
    "bid" REAL,
    "ask" REAL,
    "iv" REAL,
    "delta" REAL,
    "gamma" REAL,
    "theta" REAL,
    "vega" REAL,
    "dataSource" TEXT NOT NULL,
    "isEstimated" BOOLEAN NOT NULL DEFAULT false,
    "qualityIssues" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "OptionChainContract_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "OptionChainSnapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "OptionChainContract_snapshotId_idx" ON "OptionChainContract"("snapshotId");
CREATE INDEX IF NOT EXISTS "OptionChainContract_strike_idx" ON "OptionChainContract"("strike");
CREATE INDEX IF NOT EXISTS "OptionChainContract_optionType_idx" ON "OptionChainContract"("optionType");
CREATE UNIQUE INDEX IF NOT EXISTS "OptionChainContract_snapshotId_strike_optionType_key" ON "OptionChainContract"("snapshotId", "strike", "optionType");

CREATE TABLE IF NOT EXISTS "DataQualityLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instrument" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'NSE',
    "expiry" TEXT,
    "strike" REAL,
    "optionType" TEXT,
    "checkType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "checkTimestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" TEXT NOT NULL DEFAULT '{}',
    "resolved" BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS "DataQualityLog_instrument_idx" ON "DataQualityLog"("instrument");
CREATE INDEX IF NOT EXISTS "DataQualityLog_exchange_idx" ON "DataQualityLog"("exchange");
CREATE INDEX IF NOT EXISTS "DataQualityLog_checkType_idx" ON "DataQualityLog"("checkType");
CREATE INDEX IF NOT EXISTS "DataQualityLog_severity_idx" ON "DataQualityLog"("severity");
CREATE INDEX IF NOT EXISTS "DataQualityLog_checkTimestamp_idx" ON "DataQualityLog"("checkTimestamp");
CREATE INDEX IF NOT EXISTS "DataQualityLog_resolved_idx" ON "DataQualityLog"("resolved");
