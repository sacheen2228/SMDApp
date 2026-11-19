// Self-contained market-history DB access for the sidecar.
// Opens the SAME physical db/market_history.db as the Node validation scripts.
// Stores every CanonicalMarketSnapshot as a single `payload` JSON so the
// sidecar never needs the (bun-only / alias-heavy) canonical module to
// reconstruct it. Column store is kept for fast summary/version queries.
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { config } from "../config";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL"); // safe concurrent reads while writes happen
db.pragma("foreign_keys = ON");

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
    features TEXT, ai_scores TEXT,
    payload TEXT
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
    delta REAL, theta REAL, gamma REAL, vega REAL, volume REAL,
    expiry TEXT
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

// Add the payload column if an older schema (from the Node validation path)
// created market_snapshots without it.
try {
  db.exec("ALTER TABLE market_snapshots ADD COLUMN payload TEXT;");
} catch {
  /* column already exists */
}

// ─── P0 provenance columns (2026-11-19) ─────────────────────────
// ADDITIVE ONLY — ALTER TABLE ADD COLUMN, never DROP/RECREATE. The recorder
// died silently on 18-Nov partly because nothing recorded WHEN the provider
// published a quote versus WHEN we collected it, so a stale or replayed row
// was indistinguishable from a fresh one.
//
//   market_snapshots.provider_timestamp  provider's own chain/quote time (NULL
//                                       when the provider publishes none)
//   market_snapshots.collected_at        local collection time (always set)
//   market_snapshots.source              'breeze' | 'nse' | 'bse' | NULL
//   chain_ticks.provider_timestamp        same provider time, per leg
//   chain_ticks.source                    same source, per leg
//   chain_ticks.is_estimated              TRUE when greeks/IV were computed
//                                        locally rather than published
//   candles.source                        candle source
const PROVENANCE_COLUMNS: Array<[string, string]> = [
  ["market_snapshots", "provider_timestamp TEXT"],
  ["market_snapshots", "collected_at TEXT"],
  ["market_snapshots", "source TEXT"],
  ["market_snapshots", "freshness TEXT"],
  ["chain_ticks", "provider_timestamp TEXT"],
  ["chain_ticks", "source TEXT"],
  ["chain_ticks", "is_estimated INTEGER"],
  ["chain_ticks", "expiry TEXT"],
  ["candles", "source TEXT"],
];
for (const [table, column] of PROVENANCE_COLUMNS) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column};`);
  } catch {
    /* column already exists */
  }
}

// Canonical provenance view (additive — the raw rows are never rewritten).
//
// The recorder's provider labels changed shape over time: the legacy capture
// path wrote 'breeze' / 'nse' / 'bse', the canonical provider race writes
// 'icici-breeze' / 'mo' / 'nse-api' / 'bse-api' / 'nse-mcp', and the
// data-layer fallback writes 'data-layer'. Research queries must see ONE
// vocabulary, so the legacy labels are mapped onto the canonical ones here
// instead of mutating history.
db.exec(`
  CREATE VIEW IF NOT EXISTS v_snapshots_canonical AS
  SELECT
    ms.*,
    CASE
      WHEN ms.source = 'breeze'       THEN 'icici-breeze'
      WHEN ms.source = 'nse'          THEN 'nse-api'
      WHEN ms.source = 'bse'          THEN 'bse-api'
      WHEN ms.source IS NULL          THEN NULL
      ELSE ms.source
    END AS source_canonical
  FROM market_snapshots ms;
`);

db.exec(`
  CREATE VIEW IF NOT EXISTS v_chain_ticks_canonical AS
  SELECT
    ct.*,
    CASE
      WHEN ct.source = 'breeze'       THEN 'icici-breeze'
      WHEN ct.source = 'nse'          THEN 'nse-api'
      WHEN ct.source = 'bse'          THEN 'bse-api'
      WHEN ct.source IS NULL          THEN NULL
      ELSE ct.source
    END AS source_canonical
  FROM chain_ticks ct;
`);

// Migrate scanner_results to the ML-ready schema (no real data exists yet).
function migrateScannerTable(): void {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scanner_results'")
    .get();
  if (!exists) return;
  const cols = db.prepare("PRAGMA table_info(scanner_results)").all() as any[];
  if (!cols.some((c) => c.name === "payload")) {
    db.exec("DROP TABLE IF EXISTS scanner_results");
  }
}

function initScannerTable(): void {
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

migrateScannerTable();
initScannerTable();

// ─── Snapshot writes ─────────────────────────────────────────────
export function insertSnapshot(s: any): boolean {
  const id = `${s.symbol}-${s.timestamp}`;
  let inserted = false;
  const providerTimestamp = s.providerTimestamp ?? s.provider_timestamp ?? null;
  const collectedAt = s.collectedAt ?? s.collected_at ?? new Date().toISOString();
  const source = s.source ?? null;
  const expiry = s.expiry ?? null;
  const freshness = s.freshness ?? null;
  const tx = db.transaction(() => {
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO market_snapshots
         (id, schema_version, feature_version, engine_version, symbol, timestamp, spot, futures, india_vix,
          pcr_oi, pcr_vol, max_pain, iv, atr, vwap, volume, breadth_adv, breadth_dec, features, ai_scores, payload,
          provider_timestamp, collected_at, source, freshness)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        s.schema_version ?? s.schemaVersion ?? 1,
        s.feature_version ?? s.featureVersion ?? 1,
        s.engine_version ?? s.engineVersion ?? "1.0.0",
        s.symbol,
        s.timestamp,
        s.spot,
        s.futures ?? null,
        s.indiaVix ?? s.india_vix ?? null,
        s.pcrOi ?? s.pcr_oi ?? null,
        s.pcrVol ?? s.pcr_vol ?? null,
        s.maxPain ?? s.max_pain ?? null,
        s.iv ?? null,
        s.atr ?? null,
        s.vwap ?? null,
        s.volume ?? null,
        s.breadth?.advancers ?? s.breadth_adv ?? null,
        s.breadth?.decliners ?? s.breadth_dec ?? null,
        JSON.stringify(s.features ?? {}),
        JSON.stringify(s.aiScores ?? {}),
        JSON.stringify(s),
        providerTimestamp,
        collectedAt,
        source,
        freshness,
      );
    inserted = res.changes > 0;
    if (!inserted) return; // duplicate tick — skip child rows
    const tickStmt = db.prepare(
      `INSERT OR REPLACE INTO chain_ticks
       (id, snapshot_id, symbol, timestamp, strike, type, ltp, oi, oi_chg, iv, delta, theta, gamma, vega, volume,
        provider_timestamp, source, is_estimated, expiry)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const leg of s.optionChain ?? []) {
      tickStmt.run(
        `${id}-${leg.strike}-${leg.type}`, id, s.symbol, s.timestamp, leg.strike, leg.type,
        leg.ltp ?? null, leg.oi ?? null, leg.oiChg ?? null, leg.iv ?? null,
        leg.greeks?.delta ?? null, leg.greeks?.theta ?? null, leg.greeks?.gamma ?? null, leg.greeks?.vega ?? null,
        leg.volume ?? null,
        providerTimestamp, source, leg.estimated === true ? 1 : 0, expiry,
      );
    }
    const evStmt = db.prepare(
      `INSERT OR REPLACE INTO smc_events (id, symbol, timestamp, snapshot_id, type, direction, price, details)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    (s.smcEvents ?? []).forEach((ev: any, i: number) => {
      evStmt.run(`${id}-${i}-${ev.type}`, s.symbol, s.timestamp, id, ev.type, ev.direction, ev.price, JSON.stringify(ev.details ?? {}));
    });
  });
  tx();
  return inserted;
}

export function insertCandles(symbol: string, interval: string, candles: any[], source?: string | null): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO candles (id, symbol, interval, timestamp, open, high, low, close, volume, source)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const tx = db.transaction(() => {
    for (const c of candles) {
      stmt.run(
        `${symbol}-${interval}-${c.timestamp}`, symbol, interval, c.timestamp,
        c.open ?? null, c.high ?? null, c.low ?? null, c.close ?? null, c.volume ?? null,
        source ?? null,
      );
    }
  });
  tx();
}

// ─── P0 coverage / completeness ────────────────────────────────
// Session window (IST): 09:15 → 15:30 = 375 minutes of trading time.
// A day is "covered" only when the captures span the session; the gaps tell
// us exactly WHICH minutes were never recorded (the 18-Nov session recorded
// only 10:02→11:10 because a hung tick held the recorder's flock).
export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_CLOSE_MIN = 15 * 60 + 30;
export const SESSION_MINUTES = SESSION_CLOSE_MIN - SESSION_OPEN_MIN;

function istMinutes(iso: string): number {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return NaN;
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

export interface CoverageRow {
  symbol: string;
  date: string;
  snapshots: number;
  firstSnapshot: string | null;
  lastSnapshot: string | null;
  expectedMinutes: number;
  coveredMinutes: number;
  coveragePct: number;
  gaps: Array<{ from: string; to: string; minutes: number }>;
  candles: number;
  firstCandle: string | null;
  lastCandle: string | null;
  providerTimestamps: number;
  missingProviderTimestamps: number;
}

export function getCaptureCoverage(date: string, symbols?: string[]): CoverageRow[] {
  const syms = symbols && symbols.length ? symbols : ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
  const out: CoverageRow[] = [];
  for (const symbol of syms) {
    const snaps = db
      .prepare(
        `SELECT timestamp, provider_timestamp FROM market_snapshots
         WHERE symbol = ? AND timestamp LIKE ? ORDER BY timestamp`,
      )
      .all(symbol, `${date}%`) as any[];
    const cands = db
      .prepare(
        `SELECT timestamp FROM candles WHERE symbol = ? AND timestamp LIKE ? ORDER BY timestamp`,
      )
      .all(symbol, `${date}%`) as any[];

    const minutes = snaps
      .map((s) => istMinutes(s.timestamp))
      .filter((m: number) => Number.isFinite(m) && m >= SESSION_OPEN_MIN && m <= SESSION_CLOSE_MIN);
    const uniq = Array.from(new Set(minutes)).sort((a: number, b: number) => a - b);

    const gaps: Array<{ from: string; to: string; minutes: number }> = [];
    if (uniq.length) {
      let cursor = SESSION_OPEN_MIN;
      for (const m of uniq) {
        if (m > cursor) {
          gaps.push({
            from: hhmm(cursor),
            to: hhmm(m),
            minutes: m - cursor,
          });
        }
        cursor = Math.max(cursor, m + 1);
      }
      if (cursor <= SESSION_CLOSE_MIN) {
        gaps.push({ from: hhmm(cursor), to: hhmm(SESSION_CLOSE_MIN), minutes: SESSION_CLOSE_MIN - cursor + 1 });
      }
    }

    out.push({
      symbol,
      date,
      snapshots: snaps.length,
      firstSnapshot: snaps.length ? snaps[0].timestamp : null,
      lastSnapshot: snaps.length ? snaps[snaps.length - 1].timestamp : null,
      expectedMinutes: SESSION_MINUTES,
      coveredMinutes: uniq.length,
      coveragePct: SESSION_MINUTES ? Math.round((uniq.length / SESSION_MINUTES) * 1000) / 10 : 0,
      gaps,
      candles: cands.length,
      firstCandle: cands.length ? cands[0].timestamp : null,
      lastCandle: cands.length ? cands[cands.length - 1].timestamp : null,
      providerTimestamps: snaps.filter((s) => s.provider_timestamp != null).length,
      missingProviderTimestamps: snaps.filter((s) => s.provider_timestamp == null).length,
    });
  }
  return out;
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ─── Snapshot reads ──────────────────────────────────────────────
export function readSnapshotById(id: string): any | null {
  const row = db.prepare("SELECT * FROM market_snapshots WHERE id = ?").get(id) as any;
  if (!row) return null;
  if (row.payload) {
    try {
      return JSON.parse(row.payload);
    } catch {
      /* fall through to column reconstruction */
    }
  }
  // Minimal reconstruction for legacy rows without a payload.
  return {
    snapshotId: row.id,
    schema_version: row.schema_version,
    feature_version: row.feature_version,
    engine_version: row.engine_version,
    symbol: row.symbol,
    timestamp: row.timestamp,
    spot: row.spot,
    futures: row.futures,
    indiaVix: row.india_vix,
    pcrOi: row.pcr_oi,
    pcrVol: row.pcr_vol,
    maxPain: row.max_pain,
    iv: row.iv,
    atr: row.atr,
    vwap: row.vwap,
    volume: row.volume,
    breadth: row.breadth_adv != null && row.breadth_dec != null
      ? { advancers: row.breadth_adv, decliners: row.breadth_dec }
      : null,
    optionChain: [],
    smcEvents: [],
    volumeProfile: null,
    aiScores: row.ai_scores ? JSON.parse(row.ai_scores) : {},
    features: row.features ? JSON.parse(row.features) : {},
  };
}

export function readSnapshot(symbol: string, timestamp: string): any | null {
  return readSnapshotById(`${symbol}-${timestamp}`);
}

export function snapshotCount(): number {
  return (db.prepare("SELECT COUNT(*) c FROM market_snapshots").get() as any).c;
}

export function getTotalSnapshots(): number {
  return snapshotCount();
}

export function getLastCaptureTime(symbol?: string): string | null {
  const row = symbol
    ? (db.prepare("SELECT MAX(timestamp) t FROM market_snapshots WHERE symbol = ?").get(symbol) as any)
    : (db.prepare("SELECT MAX(timestamp) t FROM market_snapshots").get() as any);
  return row?.t ?? null;
}

export function getDbFileSizeBytes(): number {
  try {
    const file = config.dbPath;
    const main = fs.existsSync(file) ? fs.statSync(file).size : 0;
    const wal = fs.existsSync(file + "-wal") ? fs.statSync(file + "-wal").size : 0;
    const shm = fs.existsSync(file + "-shm") ? fs.statSync(file + "-shm").size : 0;
    return main + wal + shm;
  } catch {
    return 0;
  }
}

export function getSnapshotsForSymbol(symbol: string, date?: string): any[] {
  let sql = "SELECT id FROM market_snapshots WHERE symbol = ?";
  const params: any[] = [symbol];
  if (date) {
    sql += " AND timestamp LIKE ?";
    params.push(`${date}%`);
  }
  sql += " ORDER BY timestamp ASC";
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((r) => readSnapshotById(r.id)).filter(Boolean);
}

// Lightweight per-snapshot rows for the dashboard (no chain deserialization).
export function getSnapshotsSummary(symbol: string, date?: string): any[] {
  let sql =
    "SELECT symbol, timestamp, spot, india_vix, pcr_oi, max_pain, atr, vwap, volume, schema_version FROM market_snapshots WHERE symbol = ?";
  const params: any[] = [symbol];
  if (date) {
    sql += " AND timestamp LIKE ?";
    params.push(`${date}%`);
  }
  sql += " ORDER BY timestamp ASC LIMIT 2000";
  return db.prepare(sql).all(...params) as any[];
}

export function getSessionCandles(symbol: string, interval: string, date: string): any[] {
  return db
    .prepare(
      "SELECT timestamp, open, high, low, close, volume FROM candles WHERE symbol = ? AND interval = ? AND timestamp LIKE ? ORDER BY timestamp ASC",
    )
    .all(symbol, interval, `${date}%`) as any[];
}

/**
 * Per-strike CE/PE OI for every recorded snapshot of a symbol (one day).
 * Powers the Simple-tab OI panel's time windows (Last 5/10/15/30m, 1/2/3h)
 * and the "Option OI vs Time" chart. Lighter than readSnapshotById: only the
 * OI columns are read, never greeks/ltp.
 *
 * Without an explicit `date` the LATEST recorded day is returned — the panel
 * must never pull every day's history into the browser.
 */
export function getChainOiHistory(symbol: string, date?: string): any[] {
  let day = date;
  if (!day) {
    const latest = db
      .prepare("SELECT MAX(timestamp) t FROM market_snapshots WHERE symbol = ?")
      .get(symbol) as any;
    if (!latest?.t) return [];
    day = String(latest.t).slice(0, 10);
  }
  let sql = `
    SELECT s.timestamp AS timestamp, s.spot AS spot, c.strike AS strike, c.type AS type, c.oi AS oi
    FROM chain_ticks c
    JOIN market_snapshots s ON s.id = c.snapshot_id
    WHERE s.symbol = ? AND s.timestamp LIKE ?`;
  const params: any[] = [symbol, `${day}%`];
  sql += " ORDER BY s.timestamp ASC";
  const rows = db.prepare(sql).all(...params) as any[];
  const byTs = new Map<string, { timestamp: string; spot: number | null; rows: any[] }>();
  for (const r of rows) {
    let snap = byTs.get(r.timestamp);
    if (!snap) {
      snap = { timestamp: r.timestamp, spot: r.spot ?? null, rows: [] };
      byTs.set(r.timestamp, snap);
    }
    const existing = snap.rows.find((x) => x.strike === r.strike);
    if (r.type === "CE") {
      if (existing) existing.ceOi = r.oi ?? 0;
      else snap.rows.push({ strike: r.strike, ceOi: r.oi ?? 0, peOi: 0 });
    } else {
      if (existing) existing.peOi = r.oi ?? 0;
      else snap.rows.push({ strike: r.strike, ceOi: 0, peOi: r.oi ?? 0 });
    }
  }
  return [...byTs.values()];
}

/**
 * Multi-day ΔOI trend analytics — computes per-strike OI change across multiple trading days.
 * Returns daily snapshots with cumulative ΔOI, day-over-day ΔOI, and trend direction.
 * Powers the OI Flow tab's multi-day view and the ΔOI trend chart.
 */
export function getMultiDayOiTrend(symbol: string, days = 5): any[] {
  // Get the latest N distinct dates for this symbol
  const dates = db
    .prepare(
      `SELECT DISTINCT DATE(timestamp) as date 
       FROM market_snapshots 
       WHERE symbol = ? 
       ORDER BY date DESC 
       LIMIT ?`
    )
    .all(symbol, days) as any[];

  if (dates.length === 0) return [];

  const dateStrings = dates.map(d => d.date).reverse(); // chronological order
  const result: any[] = [];

  // For each date, get the last snapshot of the day (end-of-day OI)
  for (const date of dateStrings) {
    const lastSnapshot = db
      .prepare(
        `SELECT id, timestamp, spot, pcr_oi 
         FROM market_snapshots 
         WHERE symbol = ? AND DATE(timestamp) = ? 
         ORDER BY timestamp DESC 
         LIMIT 1`
      )
      .get(symbol, date) as any;

    if (!lastSnapshot) continue;

    // Get per-strike OI for this snapshot
    const strikes = db
      .prepare(
        `SELECT strike, type, oi, oi_chg 
         FROM chain_ticks 
         WHERE snapshot_id = ? 
         ORDER BY strike ASC`
      )
      .all(lastSnapshot.id) as any[];

    // Aggregate CE and PE OI by strike
    const strikeMap = new Map<number, { ceOi: number; peOi: number; ceOiChg: number; peOiChg: number }>();
    for (const s of strikes) {
      const strike = s.strike;
      if (!strikeMap.has(strike)) {
        strikeMap.set(strike, { ceOi: 0, peOi: 0, ceOiChg: 0, peOiChg: 0 });
      }
      const entry = strikeMap.get(strike)!;
      if (s.type === 'CE') {
        entry.ceOi = s.oi || 0;
        entry.ceOiChg = s.oi_chg || 0;
      } else {
        entry.peOi = s.oi || 0;
        entry.peOiChg = s.oi_chg || 0;
      }
    }

    // Calculate totals
    let totalCallOI = 0;
    let totalPutOI = 0;
    let totalCallOIChg = 0;
    let totalPutOIChg = 0;

    const strikeData = Array.from(strikeMap.entries()).map(([strike, data]) => {
      totalCallOI += data.ceOi;
      totalPutOI += data.peOi;
      totalCallOIChg += data.ceOiChg;
      totalPutOIChg += data.peOiChg;

      return {
        strike,
        ceOi: data.ceOi,
        peOi: data.peOi,
        ceOiChg: data.ceOiChg,
        peOiChg: data.peOiChg,
        netOiChg: data.ceOiChg + data.peOiChg,
        // Buildup classification: spot direction × OI change
        // We'll use the day's spot change for classification
      };
    });

    const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : null;

    result.push({
      date,
      timestamp: lastSnapshot.timestamp,
      spot: lastSnapshot.spot,
      pcr,
      totalCallOI,
      totalPutOI,
      totalCallOIChg,
      totalPutOIChg,
      netOIChg: totalCallOIChg + totalPutOIChg,
      strikes: strikeData,
    });
  }

  // Calculate day-over-day ΔOI and trend direction
  for (let i = 1; i < result.length; i++) {
    const prev = result[i - 1];
    const curr = result[i];
    curr.dayOverDayCallOIChg = curr.totalCallOI - prev.totalCallOI;
    curr.dayOverDayPutOIChg = curr.totalPutOI - prev.totalPutOI;
    curr.dayOverDaySpotChg = curr.spot - prev.spot;

    // Classify the day's OI buildup
    if (curr.dayOverDaySpotChg > 0 && curr.dayOverDayCallOIChg > 0) {
      curr.buildupClass = 'LB'; // Long buildup
    } else if (curr.dayOverDaySpotChg < 0 && curr.dayOverDayCallOIChg > 0) {
      curr.buildupClass = 'SB'; // Short buildup
    } else if (curr.dayOverDaySpotChg > 0 && curr.dayOverDayCallOIChg < 0) {
      curr.buildupClass = 'SC'; // Short covering
    } else if (curr.dayOverDaySpotChg < 0 && curr.dayOverDayCallOIChg < 0) {
      curr.buildupClass = 'LU'; // Long unwinding
    } else {
      curr.buildupClass = 'N'; // No change
    }
  }

  return result;
}

/**
 * Get available dates for a symbol (for date range selection UI).
 */
export function getAvailableDates(symbol: string, limit = 10): string[] {
  const dates = db
    .prepare(
      `SELECT DISTINCT DATE(timestamp) as date 
       FROM market_snapshots 
       WHERE symbol = ? 
       ORDER BY date DESC 
       LIMIT ?`
    )
    .all(symbol, limit) as any[];
  return dates.map(d => d.date);
}

export function getSnapshotIntegrityRows(symbol: string, date?: string): any[] {
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

export function getSnapshotVersion(id: string): { engineVersion: string; featureVersion: number } | null {
  const row = db
    .prepare("SELECT engine_version, feature_version FROM market_snapshots WHERE id = ?")
    .get(id) as any;
  if (!row) return null;
  return { engineVersion: String(row.engine_version), featureVersion: Number(row.feature_version) };
}

// ─── ScannerResult (ML training dataset) ────────────────────────
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

export function getScannerResults(filter: ScannerResultFilter = {}): any[] {
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

// Idempotent outcome resolution: merge a patch into the stored `outcome`
// object of an existing scanner result. Never inserts — re-running the
// Outcome Pipeline only overwrites the same id with deterministic values.
export function updateScannerResultOutcome(
  id: string,
  outcomePatch: Record<string, unknown>,
): boolean {
  const row = db.prepare("SELECT payload FROM scanner_results WHERE id = ?").get(id) as
    | { payload: string }
    | undefined;
  if (!row) return false;
  let payload: any;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return false;
  }
  payload.outcome = {
    ...(payload.outcome || {}),
    ...outcomePatch,
    resolvedAt: outcomePatch.resolvedAt ?? new Date().toISOString(),
  };
  db.prepare("UPDATE scanner_results SET payload = ? WHERE id = ?").run(
    JSON.stringify(payload),
    id,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5 — Web Intelligence central store (raw, provenance-rich).
// Source of truth for collected news/web records. The Python Scrapling
// collector POSTs batches here; SMDApp syncs `since=` a timestamp into
// its own enriched local store (Prisma WebRecord). Raw rows are never
// updated after insert — INSERT OR IGNORE on the content-hash PK makes
// every ingest idempotent (collector restart / re-post = 0 duplicates).
// ═══════════════════════════════════════════════════════════════════

db.exec(`
  CREATE TABLE IF NOT EXISTS web_records (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_feed TEXT,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    published_at TEXT NOT NULL,
    collected_at TEXT NOT NULL,
    backfilled INTEGER DEFAULT 0,
    symbols TEXT DEFAULT '[]',
    provenance TEXT DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_web_pub ON web_records(published_at);
  CREATE INDEX IF NOT EXISTS idx_web_col ON web_records(collected_at);
  CREATE INDEX IF NOT EXISTS idx_web_source ON web_records(source);
  CREATE INDEX IF NOT EXISTS idx_web_created ON web_records(created_at);

  CREATE TABLE IF NOT EXISTS web_source_health (
    source TEXT PRIMARY KEY,
    status TEXT DEFAULT 'UNKNOWN',
    last_success_at TEXT,
    last_error_at TEXT,
    last_error TEXT,
    consecutive_failures INTEGER DEFAULT 0,
    total_ok INTEGER DEFAULT 0,
    total_fail INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS web_collector_state (
    id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'OFFLINE',
    last_heartbeat_at TEXT,
    last_collection_at TEXT,
    last_sync_at TEXT,
    records_total INTEGER DEFAULT 0,
    records_this_run INTEGER DEFAULT 0,
    last_error TEXT,
    collector_version TEXT,
    updated_at TEXT NOT NULL
  );
`);

export interface WebRecordRow {
  id: string;
  source: string;
  source_feed?: string | null;
  url: string;
  title: string;
  description?: string | null;
  published_at: string;
  collected_at: string;
  backfilled?: number | null;
  symbols?: string | null;
  provenance?: string | null;
  created_at?: string;
}

// Idempotent batch insert. Never updates existing rows (raw immutability).
export function insertWebRecords(rows: WebRecordRow[]): { inserted: number; duplicates: number } {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO web_records
     (id, source, source_feed, url, title, description, published_at, collected_at,
      backfilled, symbols, provenance, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const res = stmt.run(
        r.id,
        r.source,
        r.source_feed ?? null,
        r.url,
        r.title,
        r.description ?? "",
        r.published_at,
        r.collected_at,
        r.backfilled ? 1 : 0,
        r.symbols ?? "[]",
        r.provenance ?? "{}",
        r.created_at ?? new Date().toISOString(),
      );
      if (res.changes > 0) inserted++;
    }
  });
  tx();
  return { inserted, duplicates: rows.length - inserted };
}

// Incremental sync read: rows INSERTED (created_at) after `sinceIso`.
// NOTE: watermark is created_at (row arrival), NOT collected_at — records
// drained from the collector's offline queue carry an OLD collected_at
// (PC-off honesty) and must still be handed to the sync layer. Their
// original collected_at/published_at travel untouched in the payload.
export function getWebRecordsSince(sinceIso: string | null, limit = 500): WebRecordRow[] {
  const lim = Math.max(1, Math.min(limit, 2000));
  if (!sinceIso) {
    return db
      .prepare("SELECT * FROM web_records ORDER BY created_at ASC LIMIT ?")
      .all(lim) as WebRecordRow[];
  }
  return db
    .prepare(
      "SELECT * FROM web_records WHERE created_at > ? ORDER BY created_at ASC LIMIT ?",
    )
    .all(sinceIso, lim) as WebRecordRow[];
}

/** Rows that arrived on the store BEFORE `beforeIso` (backlog/miss check). */
export function countWebRecordsCreatedBefore(beforeIso: string): number {
  return (
    db.prepare("SELECT COUNT(*) c FROM web_records WHERE created_at < ?").get(beforeIso) as any
  ).c;
}

export function getWebRecordCount(): number {
  return (db.prepare("SELECT COUNT(*) c FROM web_records").get() as any).c as number;
}

export function getWebRecordsNewerThan(iso: string): number {
  return (db.prepare("SELECT COUNT(*) c FROM web_records WHERE collected_at > ?").get(iso) as any)
    .c as number;
}

export function upsertWebSourceHealth(h: {
  source: string;
  status: string;
  ok?: boolean;
  error?: string | null;
  at: string;
}): void {
  const ok = !!h.ok;
  const cur = db.prepare("SELECT * FROM web_source_health WHERE source = ?").get(h.source) as any;
  const next = {
    status: h.status,
    last_success_at: ok ? h.at : (cur?.last_success_at ?? null),
    last_error_at: ok ? (cur?.last_error_at ?? null) : h.at,
    last_error: ok ? (cur?.last_error ?? null) : (h.error ?? "unknown"),
    consecutive_failures: ok ? 0 : (cur?.consecutive_failures ?? 0) + 1,
    total_ok: (cur?.total_ok ?? 0) + (ok ? 1 : 0),
    total_fail: (cur?.total_fail ?? 0) + (ok ? 0 : 1),
    updated_at: h.at,
  };
  if (!cur) {
    db.prepare(
      `INSERT INTO web_source_health
       (source, status, last_success_at, last_error_at, last_error, consecutive_failures, total_ok, total_fail, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      h.source, next.status, next.last_success_at, next.last_error_at, next.last_error,
      next.consecutive_failures, next.total_ok, next.total_fail, next.updated_at,
    );
    return;
  }
  db.prepare(
    `UPDATE web_source_health SET status=?, last_success_at=?, last_error_at=?, last_error=?,
     consecutive_failures=?, total_ok=?, total_fail=?, updated_at=? WHERE source=?`,
  ).run(
    next.status, next.last_success_at, next.last_error_at, next.last_error,
    next.consecutive_failures, next.total_ok, next.total_fail, next.updated_at, h.source,
  );
}

export function getWebSourceHealth(): any[] {
  return db.prepare("SELECT * FROM web_source_health ORDER BY source ASC").all();
}

export function upsertWebCollectorState(s: {
  status?: string;
  lastHeartbeatAt?: string;
  lastCollectionAt?: string;
  lastSyncAt?: string;
  recordsTotal?: number;
  recordsThisRun?: number;
  lastError?: string | null;
  collectorVersion?: string;
  at: string;
}): void {
  const cur = db.prepare("SELECT * FROM web_collector_state WHERE id = 'main'").get() as any;
  if (!cur) {
    db.prepare(
      `INSERT INTO web_collector_state
       (id, status, last_heartbeat_at, last_collection_at, last_sync_at, records_total,
        records_this_run, last_error, collector_version, updated_at)
       VALUES ('main',?,?,?,?,?,?,?,?,?)`,
    ).run(
      s.status ?? "OFFLINE",
      s.lastHeartbeatAt ?? null,
      s.lastCollectionAt ?? null,
      s.lastSyncAt ?? null,
      s.recordsTotal ?? 0,
      s.recordsThisRun ?? 0,
      s.lastError ?? null,
      s.collectorVersion ?? null,
      s.at,
    );
    return;
  }
  db.prepare(
    `UPDATE web_collector_state SET
       status = COALESCE(?, status),
       last_heartbeat_at = COALESCE(?, last_heartbeat_at),
       last_collection_at = COALESCE(?, last_collection_at),
       last_sync_at = COALESCE(?, last_sync_at),
       records_total = COALESCE(?, records_total),
       records_this_run = COALESCE(?, records_this_run),
       last_error = ?,
       collector_version = COALESCE(?, collector_version),
       updated_at = ?
     WHERE id = 'main'`,
  ).run(
    s.status ?? null,
    s.lastHeartbeatAt ?? null,
    s.lastCollectionAt ?? null,
    s.lastSyncAt ?? null,
    s.recordsTotal ?? null,
    s.recordsThisRun ?? null,
    s.lastError === undefined ? cur.last_error : s.lastError,
    s.collectorVersion ?? null,
    s.at,
  );
}

export function getWebCollectorState(): any | null {
  return db.prepare("SELECT * FROM web_collector_state WHERE id = 'main'").get() ?? null;
}
