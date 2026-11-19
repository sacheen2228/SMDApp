import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { config } from "../config";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL"); // safe concurrent reads while writes happen
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id                  TEXT PRIMARY KEY,
    strategy_id         TEXT NOT NULL,
    strategy_version    TEXT NOT NULL,
    created_at_ist      TEXT NOT NULL,
    symbol              TEXT NOT NULL,
    exchange            TEXT NOT NULL,
    instrument_type     TEXT NOT NULL,
    spot_price          REAL NOT NULL,   -- NOTE: historically stores the OPTION PREMIUM, not the underlying
    underlying_spot     REAL,             -- UNDERLYING level at signal time (NULL when unknown — never copied from spot_price)
    strike_price        REAL,
    expiry              TEXT,
    option_type         TEXT,
    entry_price         REAL NOT NULL,
    stop_loss           REAL NOT NULL,
    tp1                 REAL NOT NULL,
    tp2                 REAL,
    tp3                 REAL,
    quantity            REAL NOT NULL DEFAULT 1,
    risk_reward_ratio   REAL NOT NULL,
    signal_confidence   REAL NOT NULL,
    ai_confidence       REAL,
    probability_score   REAL,
    trend_direction     TEXT NOT NULL,
    signal_reason       TEXT NOT NULL,
    market_session      TEXT NOT NULL,
    user_account        TEXT,
    market_context_json TEXT NOT NULL,

    status              TEXT NOT NULL DEFAULT 'open',
    entry_filled        INTEGER NOT NULL DEFAULT 1,
    highest_price       REAL,
    lowest_price        REAL,
    mfe                 REAL,
    mae                 REAL,
    tp1_hit             INTEGER NOT NULL DEFAULT 0,
    tp1_hit_at          TEXT,
    tp2_hit             INTEGER NOT NULL DEFAULT 0,
    tp2_hit_at          TEXT,
    tp3_hit             INTEGER NOT NULL DEFAULT 0,
    tp3_hit_at          TEXT,
    sl_hit              INTEGER NOT NULL DEFAULT 0,
    trailing_stop       REAL,
    trailing_stop_hit   INTEGER NOT NULL DEFAULT 0,
    last_price          REAL,
    last_update_at      TEXT,

    exit_price          REAL,
    exit_time           TEXT,
    exit_reason         TEXT,
    gross_pnl           REAL,
    fees                REAL NOT NULL DEFAULT 0,
    net_pnl             REAL,
    roi_pct             REAL,
    r_multiple          REAL,
    time_in_trade_sec   INTEGER,

    verification_json   TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_trades_strategy       ON trades (strategy_id);
  CREATE INDEX IF NOT EXISTS idx_trades_symbol         ON trades (symbol);
  CREATE INDEX IF NOT EXISTS idx_trades_status         ON trades (status);
  CREATE INDEX IF NOT EXISTS idx_trades_created_at     ON trades (created_at_ist);
  CREATE INDEX IF NOT EXISTS idx_trades_market_session ON trades (market_session);
  CREATE INDEX IF NOT EXISTS idx_trades_confidence     ON trades (signal_confidence);
  CREATE INDEX IF NOT EXISTS idx_trades_strategy_status ON trades (strategy_id, status);

  -- Durable queue table: every recorder write goes through here first so
  -- ingestion never blocks on SQLite contention, and failed jobs can be
  -- retried without losing data on process restart.
  CREATE TABLE IF NOT EXISTS job_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type      TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending', -- pending | processing | done | failed
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_queue_status ON job_queue (status);
`);

/** Idempotent additive migration: the underlying price gets its own column.
 *  Existing rows stay NULL — the premium in spot_price is never copied. */
function ensureUnderlyingSpotColumn(): void {
  const cols = db.prepare("PRAGMA table_info(trades)").all().map((c: any) => c.name);
  if (!cols.includes("underlying_spot")) db.exec("ALTER TABLE trades ADD COLUMN underlying_spot REAL;");
}
ensureUnderlyingSpotColumn();

// Migration: quantity column (position sizing) added Oct 2026. Existing rows
// stay at 1 until scripts/backfill-quantity.ts rewrites them with real size.
const tradeCols0 = db.prepare("PRAGMA table_info(trades)").all() as Array<{ name: string }>;
if (!tradeCols0.some((c) => c.name === "quantity")) {
  db.exec("ALTER TABLE trades ADD COLUMN quantity REAL NOT NULL DEFAULT 1");
}
// Migration: archived flag — retired/dead recorders (option-chain-api, SMC,
// pre-gate July strategies) are set to 1 so /api/stats shows the LIVE book
// (SMART_MONEY + BTST + gated strategies) instead of historical dead systems.
const tradeCols1 = db.prepare("PRAGMA table_info(trades)").all() as Array<{ name: string }>;
if (!tradeCols1.some((c) => c.name === "archived")) {
  db.exec("ALTER TABLE trades ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
}

export default db;
