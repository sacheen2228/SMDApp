// Durable OI baseline store — persists owned option-chain OI observations so
// the Daily Derivatives seller-intelligence baseline survives application
// restarts.
//
// Reuses the existing application SQLite database (`db/custom.db`, the same
// file Prisma manages via DATABASE_URL) through bun:sqlite. No new database
// file, no Redis/Postgres, no Prisma migration — an idempotent
// `CREATE TABLE IF NOT EXISTS` is the only schema change, applied on first
// use.
//
// Every stored row is a single OI observation (never a full option-chain
// payload):
//   symbol, expiry, strike, type, oi, observed_at, session, source,
//   provenance, quality, created_at
//
// The in-memory Maps in seller-intelligence.ts (`baselineRing`,
// `lastOiObservation`) remain the fast within-process source of truth. This
// store is consulted only when the in-memory Maps are empty (new process,
// new day after restart) to reconstruct a baseline, and every observation is
// written here so it survives a restart.
//
// Write failures fail safely: a baseline is simply unavailable (UNVERIFIED /
// UNAVAILABLE), never fabricated.

import path from "node:path";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Bounded retention: drop observations older than this many IST days. */
const RETENTION_DAYS = 7;

export interface OiBaselineObservation {
  symbol: string;
  expiry: string;
  strike: number;
  type: "CE" | "PE";
  oi: number;
  observedAt: number;
  session: string; // IST trading date YYYY-MM-DD
  source: string; // provider / source lineage
  provenance: "observed" | "reconstructed";
  quality: "OK" | "STALE" | "UNAVAILABLE";
  createdAt: number;
}

export interface OiBaselineRow {
  oi: number;
  observedAt: number;
  session: string;
  source: string;
}

function resolveDbPath(): string {
  const env = process.env.OI_BASELINE_DB || process.env.DATABASE_URL;
  if (typeof env === "string" && env.length > 0) {
    const stripped = env.startsWith("file:") ? env.slice("file:".length) : env;
    if (stripped.length > 0) return stripped;
  }
  return path.join(process.cwd(), "db", "custom.db");
}

let _handle: any = null;
let _handlePath: string | null = null;

/** Detect the SQLite runtime at module load. Bun provides bun:sqlite;
 *  Node provides better-sqlite3. better-sqlite3 must never be required
 *  under Bun (it aborts the process — see chain-history.ts), so bun:sqlite
 *  is tried first and better-sqlite3 is the Node fallback. */
let IS_BUN_SQLITE: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("bun:sqlite");
  IS_BUN_SQLITE = true;
} catch {
  IS_BUN_SQLITE = false;
}

/** Schema applied on first use. Idempotent — no migration, no data change. */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS oi_baseline_observations (
    id               TEXT PRIMARY KEY,
    symbol           TEXT NOT NULL,
    expiry           TEXT NOT NULL,
    strike           REAL NOT NULL,
    type             TEXT NOT NULL,
    oi               REAL NOT NULL,
    observed_at      INTEGER NOT NULL,
    session          TEXT NOT NULL,
    source           TEXT NOT NULL,
    provenance       TEXT NOT NULL,
    quality          TEXT NOT NULL,
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_oi_baseline_contract_session
    ON oi_baseline_observations(symbol, expiry, strike, type, session);
  CREATE INDEX IF NOT EXISTS idx_oi_baseline_contract_observed
    ON oi_baseline_observations(symbol, expiry, strike, type, observed_at);
  CREATE INDEX IF NOT EXISTS idx_oi_baseline_session
    ON oi_baseline_observations(session);
`;

function openHandle(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  let Database: any;
  if (IS_BUN_SQLITE) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bunSqlite = require("bun:sqlite") as typeof import("bun:sqlite");
    Database = bunSqlite.Database;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const betterSqlite3 = require("better-sqlite3") as typeof import("better-sqlite3");
    Database = betterSqlite3.Database;
  }

  const db = new Database(resolveDbPath());
  if (IS_BUN_SQLITE) {
    db.query("PRAGMA journal_mode = WAL").run();
    db.query("PRAGMA busy_timeout = 5000").run();
  } else {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
  }
  try {
    // Both runtimes support db.exec() for multi-statement DDL.
    db.exec(SCHEMA_SQL);
    console.log("[OI baseline store] initialized at", resolveDbPath());
  } catch (e) {
    // Do not silently conceal initialization failures; make them diagnosable.
    console.error("[OI baseline store] initialization failed:", String(e?.message ?? e));
  }
  return db;
}

/** Execute a parameterized write statement, runtime-agnostic. */
function runSql(db: any, sql: string, params: any[]): any {
  if (IS_BUN_SQLITE) {
    return db.query(sql).run(...params);
  }
  return db.prepare(sql).run(...params);
}

/** Execute a parameterized read statement returning one row, runtime-agnostic. */
function getSql(db: any, sql: string, params: any[]): any {
  if (IS_BUN_SQLITE) {
    return db.query(sql).get(...params);
  }
  return db.prepare(sql).get(...params);
}

function getHandle(): any {
  const want = resolveDbPath();
  if (_handle && _handlePath === want) return _handle;
  if (_handle) {
    try { _handle.close(); } catch { /* ignore */ }
  }
  _handle = openHandle();
  _handlePath = want;
  return _handle;
}

/** Close the cached handle (tests / hot reloads). */
export function closeOiBaselineDb(): void {
  if (_handle) {
    try { _handle.close(); } catch { /* ignore */ }
  }
  _handle = null;
  _handlePath = null;
}

function istDay(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function observationId(
  symbol: string,
  expiry: string,
  strike: number,
  type: string,
  observedAt: number
): string {
  return `${symbol}|${expiry}|${strike}|${type}|${observedAt}`;
}

/** Record one OI observation. Idempotent — identical (contract, observedAt)
 *  duplicates are ignored, so re-recording never creates false changes or
 *  overwrites history. Never overwrites an existing row. */
export function recordOiObservation(obs: OiBaselineObservation): boolean {
  let inserted = false;
  try {
    const db = getHandle();
    const id = observationId(
      obs.symbol,
      obs.expiry,
      obs.strike,
      obs.type,
      obs.observedAt
    );
    const res = runSql(
      db,
      `INSERT OR IGNORE INTO oi_baseline_observations
       (id, symbol, expiry, strike, type, oi, observed_at, session, source, provenance, quality, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        obs.symbol,
        obs.expiry,
        obs.strike,
        obs.type,
        obs.oi,
        obs.observedAt,
        obs.session,
        obs.source,
        obs.provenance,
        obs.quality,
        obs.createdAt,
      ]
    );
    inserted = res.changes > 0;
  } catch {
    // Storage failure fails safely: caller treats baseline as unavailable.
    inserted = false;
  }
  return inserted;
}

/** Session-first observation for a contract within a session (INTRADAY seed).
 *  Returns the earliest observation in `session`. */
export function getSessionFirstObservation(
  symbol: string,
  expiry: string,
  strike: number,
  type: string,
  session: string
): OiBaselineRow | null {
  try {
    const db = getHandle();
    const row = getSql(
      db,
      `SELECT oi, observed_at, session, source
       FROM oi_baseline_observations
       WHERE symbol = ? AND expiry = ? AND strike = ? AND type = ? AND session = ?
       ORDER BY observed_at ASC
       LIMIT 1`,
      [symbol, expiry, strike, type, session]
    ) as
      | { oi: number; observed_at: number; session: string; source: string }
      | undefined;
    if (!row) return null;
    return { oi: row.oi, observedAt: row.observed_at, session: row.session, source: row.source };
  } catch {
    return null;
  }
}

/** Latest observation from a strictly earlier session (OVERNIGHT source).
 *  Returns the newest observation with session < beforeSession. */
export function getLatestPriorObservation(
  symbol: string,
  expiry: string,
  strike: number,
  type: string,
  beforeSession: string
): OiBaselineRow | null {
  try {
    const db = getHandle();
    const row = getSql(
      db,
      `SELECT oi, observed_at, session, source
       FROM oi_baseline_observations
       WHERE symbol = ? AND expiry = ? AND strike = ? AND type = ? AND session < ?
       ORDER BY observed_at DESC
       LIMIT 1`,
      [symbol, expiry, strike, type, beforeSession]
    ) as
      | { oi: number; observed_at: number; session: string; source: string }
      | undefined;
    if (!row) return null;
    return { oi: row.oi, observedAt: row.observed_at, session: row.session, source: row.source };
  } catch {
    return null;
  }
}

/** Bounded retention: drop observations older than RETENTION_DAYS IST days.
 *  Best-effort; failures are ignored. */
export function pruneOldObservations(): void {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000 + IST_OFFSET_MS);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    const db = getHandle();
    runSql(db, `DELETE FROM oi_baseline_observations WHERE session < ?`, [cutoffIso]);
  } catch {
    /* ignore — retention is best-effort */
  }
}
