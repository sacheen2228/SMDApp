// Dedicated historical market database (market_history.db).
// Access layer for the Market Recorder / Replay Engine / Evaluation Framework.
// Uses better-sqlite3 (Node-compatible) — no Bun runtime requirement.
import Database from "better-sqlite3";
import type { CanonicalMarketSnapshot, Candle, SmcEvent } from "@/lib/market/canonical";
import { migrateSnapshot } from "@/lib/market/canonical";

const DB_PATH = process.env.MARKET_HISTORY_DB || "db/market_history.db";

let _db: Database.Database | null = null;

export function getMarketHistoryDb(): Database.Database {
  if (_db) return _db;
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  initSchema(db);
  _db = db;
  return db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_snapshots (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      feature_version INTEGER NOT NULL,
      engine_version TEXT NOT NULL,
      symbol TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      spot REAL, futures REAL, india_vix REAL,
      pcr_oi REAL, pcr_vol REAL, max_pain REAL,
      iv REAL, atr REAL, vwap REAL, volume REAL,
      breadth_adv INTEGER, breadth_dec INTEGER,
      features TEXT, ai_scores TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_snap_symbol_ts ON market_snapshots(symbol, timestamp);

    CREATE TABLE IF NOT EXISTS chain_ticks (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      strike REAL NOT NULL,
      type TEXT NOT NULL,
      ltp REAL, oi REAL, oi_chg REAL, iv REAL,
      delta REAL, theta REAL, gamma REAL, vega REAL, volume REAL
    );
    CREATE INDEX IF NOT EXISTS idx_chain_snap ON chain_ticks(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_chain_sym_ts ON chain_ticks(symbol, timestamp, strike);

    CREATE TABLE IF NOT EXISTS candles (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      open REAL, high REAL, low REAL, close REAL, volume REAL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_candle_sym_iv_ts ON candles(symbol, interval, timestamp);

    CREATE TABLE IF NOT EXISTS smc_events (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      snapshot_id TEXT,
      type TEXT NOT NULL,
      direction TEXT,
      price REAL,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_smc_sym_ts ON smc_events(symbol, timestamp);

    CREATE TABLE IF NOT EXISTS evaluation_results (
      id TEXT PRIMARY KEY,
      strategy TEXT NOT NULL,
      symbol TEXT,
      range_start TEXT,
      range_end TEXT,
      metrics TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  // Migrate scanner_results to the ML-ready schema (no real data exists yet).
  migrateScannerTable(db);
  initScannerTable(db);
}

// Drop + recreate scanner_results only if it still uses the legacy schema,
// so existing rows (none in practice) are not silently corrupted.
function migrateScannerTable(db: Database.Database): void {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scanner_results'").get();
  if (!exists) return;
  const cols = db.prepare("PRAGMA table_info(scanner_results)").all() as any[];
  if (!cols.some((c) => c.name === "payload")) {
    db.exec("DROP TABLE IF EXISTS scanner_results");
  }
}

function initScannerTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scanner_results (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      scanner TEXT NOT NULL,
      session_id TEXT,
      snapshot_id TEXT,
      decision TEXT NOT NULL,
      confidence REAL,
      risk_score REAL,
      schema_version INTEGER,
      feature_version INTEGER,
      engine_version TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scan_sym_ts ON scanner_results(symbol, timestamp);
    CREATE INDEX IF NOT EXISTS idx_scan_scanner_ts ON scanner_results(scanner, timestamp);
    CREATE INDEX IF NOT EXISTS idx_scan_session ON scanner_results(session_id);
    CREATE INDEX IF NOT EXISTS idx_scan_decision ON scanner_results(decision);
    CREATE INDEX IF NOT EXISTS idx_scan_snapshot ON scanner_results(snapshot_id);
  `);
}

// Idempotent: UNIQUE(symbol, timestamp) ensures duplicate scheduler ticks
// cannot create duplicate snapshot rows. Returns true if a NEW row was written.
export function insertSnapshot(s: CanonicalMarketSnapshot): boolean {
  const db = getMarketHistoryDb();
  const id = `${s.symbol}-${s.timestamp}`;
  let inserted = false;
  const tx = db.transaction(() => {
    const res = db.prepare(
      `INSERT OR IGNORE INTO market_snapshots
       (id, schema_version, feature_version, engine_version, symbol, timestamp, spot, futures, india_vix,
        pcr_oi, pcr_vol, max_pain, iv, atr, vwap, volume, breadth_adv, breadth_dec, features, ai_scores)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, s.schema_version, s.feature_version, s.engine_version, s.symbol, s.timestamp, s.spot, s.futures, s.indiaVix,
      s.pcrOi, s.pcrVol, s.maxPain, s.iv, s.atr, s.vwap, s.volume,
      s.breadth?.advancers ?? null, s.breadth?.decliners ?? null,
      JSON.stringify(s.features), JSON.stringify(s.aiScores),
    );
    inserted = res.changes > 0;
    if (!inserted) return; // duplicate tick — skip child rows
    const tickStmt = db.prepare(
      `INSERT OR REPLACE INTO chain_ticks
       (id, snapshot_id, symbol, timestamp, strike, type, ltp, oi, oi_chg, iv, delta, theta, gamma, vega, volume)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const leg of s.optionChain) {
      tickStmt.run(
        `${id}-${leg.strike}-${leg.type}`, id, s.symbol, s.timestamp, leg.strike, leg.type,
        leg.ltp, leg.oi, leg.oiChg, leg.iv, leg.greeks.delta, leg.greeks.theta, leg.greeks.gamma, leg.greeks.vega, leg.volume,
      );
    }
    const evStmt = db.prepare(
      `INSERT OR REPLACE INTO smc_events (id, symbol, timestamp, snapshot_id, type, direction, price, details)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    s.smcEvents.forEach((ev, i) => {
      evStmt.run(`${id}-${i}-${ev.type}`, s.symbol, s.timestamp, id, ev.type, ev.direction, ev.price, JSON.stringify(ev.details));
    });
  });
  tx();
  return inserted;
}

export function insertCandles(symbol: string, interval: string, candles: Candle[]): void {
  const db = getMarketHistoryDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO candles (id, symbol, interval, timestamp, open, high, low, close, volume)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const tx = db.transaction(() => {
    for (const c of candles) {
      stmt.run(`${symbol}-${interval}-${c.timestamp}`, symbol, interval, c.timestamp, c.open, c.high, c.low, c.close, c.volume);
    }
  });
  tx();
}

export function readSnapshotById(id: string): CanonicalMarketSnapshot | null {
  const db = getMarketHistoryDb();
  const row = db.prepare("SELECT * FROM market_snapshots WHERE id = ?").get(id) as any;
  if (!row) return null;
  const ticks = db.prepare("SELECT * FROM chain_ticks WHERE snapshot_id = ?").all(id) as any[];
  const optionChain = ticks.map((t) => ({
    strike: t.strike, type: t.type, ltp: t.ltp, oi: t.oi, oiChg: t.oi_chg, iv: t.iv,
    greeks: { delta: t.delta, theta: t.theta, gamma: t.gamma, vega: t.vega }, volume: t.volume,
  }));
  const evs = db.prepare("SELECT * FROM smc_events WHERE snapshot_id = ?").all(id) as any[];
  const smcEvents: SmcEvent[] = evs.map((e) => ({ type: e.type as SmcEvent["type"], direction: e.direction, price: e.price, details: JSON.parse(e.details || "{}") }));
  const snapshot: CanonicalMarketSnapshot = {
    snapshotId: row.id,
    schema_version: row.schema_version, feature_version: row.feature_version, engine_version: row.engine_version,
    symbol: row.symbol, timestamp: row.timestamp, spot: row.spot, futures: row.futures, indiaVix: row.india_vix,
    pcrOi: row.pcr_oi, pcrVol: row.pcr_vol, maxPain: row.max_pain, iv: row.iv, atr: row.atr, vwap: row.vwap, volume: row.volume,
    breadth: row.breadth_adv != null && row.breadth_dec != null ? { advancers: row.breadth_adv, decliners: row.breadth_dec } : null,
    optionChain, smcEvents, volumeProfile: null, aiScores: JSON.parse(row.ai_scores || "{}"), features: JSON.parse(row.features || "{}"),
  };
  return migrateSnapshot(snapshot, row.schema_version);
}

export function readSnapshot(symbol: string, timestamp: string): CanonicalMarketSnapshot | null {
  return readSnapshotById(`${symbol}-${timestamp}`);
}

export function snapshotCount(): number {
  const db = getMarketHistoryDb();
  return (db.prepare("SELECT COUNT(*) c FROM market_snapshots").get() as any).c;
}

// ─── Status helpers ───────────────────────────────────────────────
export function getTotalSnapshots(): number {
  return snapshotCount();
}

export function getLastCaptureTime(symbol?: string): string | null {
  const db = getMarketHistoryDb();
  const row = symbol
    ? (db.prepare("SELECT MAX(timestamp) t FROM market_snapshots WHERE symbol = ?").get(symbol) as any)
    : (db.prepare("SELECT MAX(timestamp) t FROM market_snapshots").get() as any);
  return row?.t ?? null;
}

export function getDbFileSizeBytes(): number {
  try {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const db = getMarketHistoryDb();
    const file = path.join(path.dirname((db as any).name), path.basename((db as any).name));
    const main = fs.existsSync(file) ? fs.statSync(file).size : 0;
    const wal = fs.existsSync(file + "-wal") ? fs.statSync(file + "-wal").size : 0;
    const shm = fs.existsSync(file + "-shm") ? fs.statSync(file + "-shm").size : 0;
    return main + wal + shm;
  } catch {
    return 0;
  }
}

// ─── Replay Engine helpers ──────────────────────────────────────
// Reconstruct a full trading session (all snapshots for a symbol on a date).
export function getSnapshotsForSymbol(symbol: string, date?: string): CanonicalMarketSnapshot[] {
  const db = getMarketHistoryDb();
  let sql = "SELECT id FROM market_snapshots WHERE symbol = ?";
  const params: any[] = [symbol];
  if (date) {
    sql += " AND timestamp LIKE ?";
    params.push(`${date}%`);
  }
  sql += " ORDER BY timestamp ASC";
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((r) => readSnapshotById(r.id)).filter(Boolean) as CanonicalMarketSnapshot[];
}

// Candles for a session (1-minute OHLCV aligned to snapshot day).
export function getSessionCandles(symbol: string, interval: string, date: string): Candle[] {
  const db = getMarketHistoryDb();
  return db
    .prepare("SELECT timestamp, open, high, low, close, volume FROM candles WHERE symbol = ? AND interval = ? AND timestamp LIKE ? ORDER BY timestamp ASC")
    .all(symbol, interval, `${date}%`) as Candle[];
}

// Lightweight per-snapshot rows for integrity validation (no chain deserialization).
export interface SnapshotIntegrityRow {
  timestamp: string;
  spot: number | null;
  chainCount: number;
}
export function getSnapshotIntegrityRows(symbol: string, date?: string): SnapshotIntegrityRow[] {
  const db = getMarketHistoryDb();
  let sql = `SELECT s.timestamp AS timestamp, s.spot AS spot,
    (SELECT COUNT(*) FROM chain_ticks c WHERE c.snapshot_id = s.id) AS chain_count
    FROM market_snapshots s WHERE s.symbol = ?`;
  const params: any[] = [symbol];
  if (date) {
    sql += " AND s.timestamp LIKE ?";
    params.push(`${date}%`);
  }
  sql += " ORDER BY s.timestamp ASC";
  return (db.prepare(sql).all(...params) as any[]).map((r) => ({
    timestamp: r.timestamp,
    spot: r.spot,
    chainCount: r.chain_count,
  }));
}

// ─── ScannerResult (ML training dataset) ────────────────────────
// The full structured ScannerResult is stored as a single `payload` JSON so the
// schema never needs to change when contract fields are added. A handful of scalar
// columns are mirrored for fast filtering/analytics.
export function insertScannerResult(r: {
  id: string;
  symbol: string;
  timestamp: string;
  scanner: string;
  sessionId?: string | null;
  snapshotId?: string | null;
  decision: string;
  confidence?: number | null;
  riskScore?: number | null;
  schemaVersion: number;
  featureVersion: number;
  engineVersion: string;
  payload: string;
  createdAt: string;
}): void {
  const db = getMarketHistoryDb();
  db.prepare(
    `INSERT OR REPLACE INTO scanner_results
     (id, symbol, timestamp, scanner, session_id, snapshot_id, decision, confidence, risk_score,
      schema_version, feature_version, engine_version, payload, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    r.id, r.symbol, r.timestamp, r.scanner, r.sessionId ?? null, r.snapshotId ?? null, r.decision,
    r.confidence ?? null, r.riskScore ?? null, r.schemaVersion, r.featureVersion, r.engineVersion,
    r.payload, r.createdAt,
  );
}

export interface ScannerResultFilter {
  symbol?: string;
  scanner?: string;
  decision?: string;
  sessionId?: string;
  snapshotId?: string;
  date?: string;
  limit?: number;
}

// Retrieve stored ScannerResults (reconstructed from payload). Used by analytics
// and ML export — every row is a training example.
export function getScannerResults(filter: ScannerResultFilter = {}): any[] {
  const db = getMarketHistoryDb();
  const where: string[] = [];
  const params: any[] = [];
  if (filter.symbol) { where.push("symbol = ?"); params.push(filter.symbol); }
  if (filter.scanner) { where.push("scanner = ?"); params.push(filter.scanner); }
  if (filter.decision) { where.push("decision = ?"); params.push(filter.decision); }
  if (filter.sessionId) { where.push("session_id = ?"); params.push(filter.sessionId); }
  if (filter.snapshotId) { where.push("snapshot_id = ?"); params.push(filter.snapshotId); }
  if (filter.date) { where.push("timestamp LIKE ?"); params.push(`${filter.date}%`); }
  const sql = `SELECT payload FROM scanner_results ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY timestamp ASC LIMIT ?`;
  params.push(filter.limit ?? 5000);
  return (db.prepare(sql).all(...params) as any[]).map((r) => JSON.parse(r.payload));
}
