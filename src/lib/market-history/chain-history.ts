// Wave 3a — multi-interval snapshot reader for the market-history sidecar.
//
// The Daily Derivatives engine needs the SAME contract's value NOW and at
// 1 / 3 / 5 / 15 / 30 minutes ago (OI, ΔOI, premium, volume, IV) plus the
// PCR / Max-Pain history. This module reads the recorder's own tables
// (`chain_ticks`, `market_snapshots`, and the rolled-up `chain_5m`) and
// applies the alignment rules that make those comparisons honest:
//
//   · same expiry, same strike, same option type — never across expiries
//   · NO LOOK-AHEAD — a past value is always strictly older than the as-of
//   · same provider lineage for the compared pair
//   · a comparable underlying reference (spot) — adjusted or excluded
//   · never a snapshot from another trading session
//   · a missing interval is null — never interpolated, never carried forward
//
// READ-ONLY. The DB is opened readonly; nothing here writes, migrates or
// vacuums the live database.
//
// The DB path is resolved LAZILY (at first use) from MARKET_HISTORY_DB, the
// same convention as `src/lib/premarket-lab/storage.ts` and
// `src/lib/market-history/db.ts` — a test can point it at a temp file.

import path from "node:path";

// ── Configuration ────────────────────────────────────────────────

/** The intervals the Daily Derivatives plan requires. */
export const DEFAULT_INTERVALS_MIN = [1, 3, 5, 15, 30];

/** IST has no DST — a fixed +05:30 offset is exact. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Trading session (IST): 09:15 → 15:30. */
export const SESSION_OPEN_IST = { hour: 9, minute: 15 };
export const SESSION_CLOSE_IST = { hour: 15, minute: 30 };

export interface ChainHistoryQuery {
  symbol: string;
  /** Contract expiry in ANY of the recorded provider formats. */
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  /** The as-of timestamp — the reader never looks past it. */
  asOf: string;
  intervals?: number[];
  /**
   * How old a snapshot may be and still stand in for a target time.
   * The recorder writes every 60 s (30 s on monthly expiry), so 120 s
   * tolerates one missed minute. Anything older is NOT carried forward.
   */
  maxStalenessMs?: number;
  /** Maximum tolerated difference of the underlying reference (percent). */
  referenceTolerancePct?: number;
  /**
   * "exclude" — a drifted (or unknown) underlying reference disqualifies
   *            the snapshot (the default; fail closed)
   * "adjust"  — a drifted reference is delta-adjusted instead of excluded
   * "ignore"  — no reference check at all (explicit opt-out)
   */
  referenceMode?: "exclude" | "adjust" | "ignore";
  /**
   * "exact"   — the compared pair must come from the same source (default)
   * "lineage" — the same provider family (nse / bse / breeze / mo / ...)
   * "any"     — no source constraint (the consumer's explicit opt-out)
   */
  sourcePolicy?: "exact" | "lineage" | "any";
  /** Treat rows with an UNKNOWN expiry as belonging to the contract. */
  allowUnknownExpiry?: boolean;
}

export interface SessionWindow {
  date: string;
  start: string;
  end: string;
  timezone: "IST";
}

export interface ChainSnapshotPoint {
  timestamp: string;
  /** Age against the as-of timestamp. */
  ageMs: number;
  ltp: number | null;
  oi: number | null;
  oiChg: number | null;
  iv: number | null;
  volume: number | null;
  delta: number | null;
  bid: number | null;
  ask: number | null;
  /** The underlying reference the snapshot was taken against. */
  spot: number | null;
  source: string | null;
  expiry: string | null;
  providerTimestamp: string | null;
  granularity: "raw" | "5m-rollup";
  /** True for a rolled-up bucket (5-minute granularity, not a point value). */
  approximate: boolean;
}

export interface ChainIntervalChange {
  oi: number | null;
  oiChg: number | null;
  premium: number | null;
  premiumPct: number | null;
  volume: number | null;
  iv: number | null;
}

export interface ChainIntervalResult {
  intervalMinutes: number;
  targetTime: string;
  status: "available" | "missing";
  reason: string | null;
  past: ChainSnapshotPoint | null;
  change: ChainIntervalChange | null;
  reference: {
    spotNow: number | null;
    spotPast: number | null;
    driftPct: number | null;
    tolerancePct: number;
    adjusted: boolean;
    /** The premium-space correction applied (delta × Δspot). */
    adjustment: number | null;
  } | null;
}

export interface AggregateIntervalResult {
  intervalMinutes: number;
  targetTime: string;
  status: "available" | "missing";
  reason: string | null;
  timestamp: string | null;
  ageMs: number | null;
  value: number | null;
  change: number | null;
  source: string | null;
}

export interface AggregateHistory {
  /** The aggregate is symbol-scoped — market_snapshots carries no expiry. */
  scope: "symbol";
  current: { timestamp: string; ageMs: number; value: number | null; source: string | null } | null;
  intervals: Record<string, AggregateIntervalResult>;
}

export interface ChainCoverage {
  symbol: string;
  window: { from: string; to: string };
  session: SessionWindow;
  /** Distinct market_snapshots timestamps for the symbol inside the window. */
  snapshotsInWindow: number;
  /** chain_ticks rows for symbol + strike + type inside the window. */
  chainRowsInWindow: number;
  /** Rows that survived the expiry / strike / type alignment. */
  contractRows: number;
  ageMs: { min: number | null; max: number | null };
  sourceMix: Record<string, number>;
  excluded: Array<{ reason: string; count: number }>;
  excludedTotal: number;
  intervals: Record<
    string,
    { status: "available" | "missing"; reason: string | null; ageMs: number | null; source: string | null }
  >;
  rollup: { rows: number; used: number; reason: string | null };
}

export interface ChainHistoryPolicy {
  intervals: number[];
  maxStalenessMs: number;
  referenceTolerancePct: number;
  referenceMode: "exclude" | "adjust" | "ignore";
  sourcePolicy: "exact" | "lineage" | "any";
  allowUnknownExpiry: boolean;
}

export interface ChainHistoryResult {
  symbol: string;
  /** The expiry the comparison was made against (normalized). */
  expiry: string | null;
  expiryInput: string;
  strike: number;
  optionType: "CE" | "PE";
  asOf: string;
  session: SessionWindow;
  /** The rules the numbers were produced under — always stated. */
  policy: ChainHistoryPolicy;
  current: ChainSnapshotPoint | null;
  currentReason: string | null;
  intervals: Record<string, ChainIntervalResult>;
  pcrOi: AggregateHistory;
  pcrVol: AggregateHistory;
  maxPain: AggregateHistory;
  coverage: ChainCoverage;
}

// ── Expiry normalization ─────────────────────────────────────────
//
// The recorder stores the expiry in whatever format the provider published:
// "26-Nov-2026" (NSE), "2026-11-26" (canonical), "26 Nov 2026" (BSE).
// Comparing the raw strings would split one contract into three, so every
// expiry is normalized to an ISO calendar day before it is compared.

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function normalizeExpiry(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  // 2026-11-26 (optionally followed by a time part)
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (m) return `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`;

  // 26-Nov-2026 / 26 Nov 2026
  m = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/.exec(raw);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (!mon) return null;
    return `${m[3]}-${mon}-${pad2(Number(m[1]))}`;
  }

  // Nov-26-2026 / Nov 26 2026
  m = /^([A-Za-z]{3})[A-Za-z]*[-\s](\d{1,2})[-\s](\d{4})$/.exec(raw);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (!mon) return null;
    return `${m[3]}-${mon}-${pad2(Number(m[2]))}`;
  }

  return null;
}

// ── Session helpers ──────────────────────────────────────────────

export function sessionWindowFor(iso: string): SessionWindow {
  const t = Date.parse(iso);
  const base = new Date((Number.isFinite(t) ? t : Date.now()) + IST_OFFSET_MS);
  const y = base.getUTCFullYear();
  const mo = base.getUTCMonth();
  const da = base.getUTCDate();
  const start = new Date(
    Date.UTC(y, mo, da, SESSION_OPEN_IST.hour, SESSION_OPEN_IST.minute, 0) - IST_OFFSET_MS,
  ).toISOString();
  const end = new Date(
    Date.UTC(y, mo, da, SESSION_CLOSE_IST.hour, SESSION_CLOSE_IST.minute, 0) - IST_OFFSET_MS,
  ).toISOString();
  return { date: `${y}-${pad2(mo + 1)}-${pad2(da)}`, start, end, timezone: "IST" };
}

// ── Provider lineage ─────────────────────────────────────────────
//
// The recorder runs a provider race, so the source flips minute to minute.
// A comparison is only allowed inside ONE lineage.

const SOURCE_LINEAGE: Record<string, string> = {
  breeze: "breeze",
  "icici-breeze": "breeze",
  motilal: "mo",
  "motilal-api": "mo",
  mo: "mo",
  nse: "nse",
  "nse-api": "nse",
  "nse-mcp": "nse",
  bse: "bse",
  "bse-api": "bse",
  "data-layer": "data-layer",
};

export function sourceLineage(source: string | null | undefined): string {
  if (!source) return "unknown";
  return SOURCE_LINEAGE[source.toLowerCase()] ?? source.toLowerCase();
}

function sourceCompatible(
  candidate: string | null,
  anchor: string | null,
  policy: "exact" | "lineage" | "any",
): boolean {
  if (policy === "any") return true;
  if (!candidate || !anchor) return false;
  if (candidate === anchor) return true;
  if (policy === "lineage") return sourceLineage(candidate) === sourceLineage(anchor);
  return false;
}

// ── DB access (read-only) ────────────────────────────────────────

export function marketHistoryDbPath(): string {
  return process.env.MARKET_HISTORY_DB || path.join(process.cwd(), "db", "market_history.db");
}

interface SqliteHandle {
  all(sql: string, params: any[]): any[];
  get(sql: string, params: any[]): any | undefined;
  close(): void;
}

function openReadonly(dbPath: string): SqliteHandle {
  // Bun first: better-sqlite3 ABORTS the Bun process (NAPI fatal error), so
  // it must never be loaded when Bun is the runtime.
  if (typeof (globalThis as any).Bun !== "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    return {
      all: (sql, params) => db.query(sql).all(...(params as any[])) as any[],
      get: (sql, params) => db.query(sql).get(...(params as any[])) as any,
      close: () => db.close(),
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true });
  return {
    all: (sql, params) => db.prepare(sql).all(...params) as any[],
    get: (sql, params) => db.prepare(sql).get(...params) as any,
    close: () => db.close(),
  };
}

let _handle: SqliteHandle | null = null;
let _handlePath: string | null = null;

function getHandle(): SqliteHandle {
  const want = marketHistoryDbPath();
  if (_handle && _handlePath === want) return _handle;
  if (_handle) {
    try { _handle.close(); } catch { /* ignore */ }
  }
  _handle = openReadonly(want);
  _handlePath = want;
  return _handle;
}

/** Close the cached handle (tests / hot reloads). */
export function closeChainHistoryDb(): void {
  if (_handle) {
    try { _handle.close(); } catch { /* ignore */ }
  }
  _handle = null;
  _handlePath = null;
}

/**
 * The columns the reader needs. It is also the fixture schema used by the
 * offline test suite — the live schema is owned by
 * `market-history/src/db/index.ts` (this table mirrors it).
 */
export const READER_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS market_snapshots (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 1,
    feature_version INTEGER NOT NULL DEFAULT 1,
    engine_version TEXT NOT NULL DEFAULT '1.0.0',
    symbol TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    spot REAL, futures REAL, india_vix REAL,
    pcr_oi REAL, pcr_vol REAL, max_pain REAL,
    iv REAL, atr REAL, vwap REAL, volume REAL,
    breadth_adv INTEGER, breadth_dec INTEGER,
    features TEXT, ai_scores TEXT, payload TEXT,
    provider_timestamp TEXT, collected_at TEXT, source TEXT, freshness TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_snap_symbol_ts ON market_snapshots(symbol, timestamp);

  CREATE TABLE IF NOT EXISTS chain_ticks (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    strike REAL NOT NULL,
    type TEXT NOT NULL,
    ltp REAL, oi REAL, oi_chg REAL, iv REAL,
    delta REAL, theta REAL, gamma REAL, vega REAL, volume REAL,
    expiry TEXT, provider_timestamp TEXT, source TEXT, is_estimated INTEGER,
    bid REAL, ask REAL
  );
  CREATE INDEX IF NOT EXISTS idx_chain_sym_ts ON chain_ticks(symbol, timestamp, strike);

  CREATE TABLE IF NOT EXISTS chain_5m (
    symbol TEXT NOT NULL,
    bucket TEXT NOT NULL,
    strike INTEGER NOT NULL,
    type TEXT NOT NULL,
    ltp_open REAL, ltp_high REAL, ltp_low REAL, ltp_close REAL,
    oi_min REAL, oi_max REAL, oi_last REAL,
    oi_chg_sum REAL, volume_sum REAL, iv_avg REAL,
    samples INTEGER NOT NULL DEFAULT 0,
    source TEXT, provider_timestamp TEXT, first_ts TEXT, last_ts TEXT,
    bid_min REAL, bid_max REAL, bid_last REAL,
    ask_min REAL, ask_max REAL, ask_last REAL
  );
`;

function tableColumns(handle: SqliteHandle, table: string): Set<string> {
  try {
    const rows = handle.all(`PRAGMA table_info(${table})`, []);
    return new Set(rows.map((r: any) => String(r.name)));
  } catch {
    return new Set();
  }
}

// ── Raw row shapes ───────────────────────────────────────────────

interface RawChainRow {
  timestamp: string;
  ltp: number | null;
  oi: number | null;
  oi_chg: number | null;
  iv: number | null;
  delta: number | null;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  expiry: string | null;
  source: string | null;
  provider_timestamp: string | null;
  spot: number | null;
}

interface RawAggregateRow {
  timestamp: string;
  spot: number | null;
  pcr_oi: number | null;
  pcr_vol: number | null;
  max_pain: number | null;
  source: string | null;
}

interface RawRollupRow {
  bucket: string;
  strike: number;
  type: string;
  ltp_close: number | null;
  oi_last: number | null;
  iv_avg: number | null;
  source: string | null;
  first_ts: string | null;
  last_ts: string | null;
  expiry: string | null;
}

// ── The reader ───────────────────────────────────────────────────

function num(v: any): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function diff(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return a - b;
}

interface NormalizedQuery extends ChainHistoryQuery {
  intervals: number[];
  maxStalenessMs: number;
  referenceTolerancePct: number;
  referenceMode: "exclude" | "adjust" | "ignore";
  sourcePolicy: "exact" | "lineage" | "any";
  expiryNormalized: string | null;
  asOfMs: number;
}

function normalizeQuery(q: ChainHistoryQuery): NormalizedQuery {
  const intervals = (q.intervals ?? DEFAULT_INTERVALS_MIN)
    .filter((m) => Number.isFinite(m) && m > 0)
    .sort((a, b) => a - b);
  return {
    ...q,
    intervals,
    maxStalenessMs: q.maxStalenessMs ?? 120_000,
    referenceTolerancePct: q.referenceTolerancePct ?? 1,
    referenceMode: q.referenceMode ?? "exclude",
    sourcePolicy: q.sourcePolicy ?? "exact",
    allowUnknownExpiry: q.allowUnknownExpiry === true,
    expiryNormalized: normalizeExpiry(q.expiry),
    asOfMs: Date.parse(q.asOf),
  };
}

function emptyResult(q: NormalizedQuery, reason: string): ChainHistoryResult {
  const session = sessionWindowFor(q.asOf);
  const intervals: Record<string, ChainIntervalResult> = {};
  for (const mins of q.intervals) {
    intervals[String(mins)] = {
      intervalMinutes: mins,
      targetTime: new Date(q.asOfMs - mins * 60_000).toISOString(),
      status: "missing",
      reason,
      past: null,
      change: null,
      reference: null,
    };
  }
  const emptyAggregate: AggregateHistory = { scope: "symbol", current: null, intervals: {} };
  for (const mins of q.intervals) {
    emptyAggregate.intervals[String(mins)] = {
      intervalMinutes: mins,
      targetTime: new Date(q.asOfMs - mins * 60_000).toISOString(),
      status: "missing",
      reason,
      timestamp: null,
      ageMs: null,
      value: null,
      change: null,
      source: null,
    };
  }
  return {
    symbol: q.symbol,
    expiry: q.expiryNormalized,
    expiryInput: q.expiry,
    strike: q.strike,
    optionType: q.optionType,
    asOf: q.asOf,
    session,
    policy: {
      intervals: q.intervals,
      maxStalenessMs: q.maxStalenessMs,
      referenceTolerancePct: q.referenceTolerancePct,
      referenceMode: q.referenceMode,
      sourcePolicy: q.sourcePolicy,
      allowUnknownExpiry: q.allowUnknownExpiry,
    },
    current: null,
    currentReason: reason,
    intervals,
    pcrOi: { ...emptyAggregate, intervals: { ...emptyAggregate.intervals } },
    pcrVol: { ...emptyAggregate, intervals: { ...emptyAggregate.intervals } },
    maxPain: { ...emptyAggregate, intervals: { ...emptyAggregate.intervals } },
    coverage: {
      symbol: q.symbol,
      window: { from: q.asOf, to: q.asOf },
      session,
      snapshotsInWindow: 0,
      chainRowsInWindow: 0,
      contractRows: 0,
      ageMs: { min: null, max: null },
      sourceMix: {},
      excluded: [{ reason, count: 1 }],
      excludedTotal: 1,
      intervals: {},
      rollup: { rows: 0, used: 0, reason },
    },
  };
}

/**
 * The alignment algorithm. Pure — it takes the raw rows and returns the
 * result, so it can be reasoned about (and tested) without a database.
 */
export function buildChainHistory(
  chainRows: RawChainRow[],
  aggregateRows: RawAggregateRow[],
  rollupRows: RawRollupRow[],
  rollupReason: string | null,
  query: ChainHistoryQuery,
): ChainHistoryResult {
  const q = normalizeQuery(query);
  const session = sessionWindowFor(q.asOf);
  const sessionStartMs = Date.parse(session.start);
  const sessionEndMs = Date.parse(session.end);
  const asOfMs = q.asOfMs;

  // Exclusion accounting — a row is counted once per reason.
  const exclusionSets = new Map<string, Set<string>>();
  const exclude = (reason: string, key: string): void => {
    let set = exclusionSets.get(reason);
    if (!set) {
      set = new Set();
      exclusionSets.set(reason, set);
    }
    set.add(key);
  };

  // ── 1. No look-ahead + session containment ────────────────────
  const inSession: RawChainRow[] = [];
  for (const r of chainRows) {
    const t = Date.parse(r.timestamp);
    if (!Number.isFinite(t)) {
      exclude("invalid_timestamp", r.timestamp);
      continue;
    }
    if (t > asOfMs) {
      exclude("look_ahead", r.timestamp);
      continue;
    }
    if (t < sessionStartMs || t > sessionEndMs) {
      exclude("outside_session", r.timestamp);
      continue;
    }
    inSession.push(r);
  }

  // ── 2. Same expiry only ───────────────────────────────────────
  const contract: RawChainRow[] = [];
  for (const r of inSession) {
    const nx = normalizeExpiry(r.expiry);
    if (!nx) {
      if (q.allowUnknownExpiry) {
        contract.push(r);
        continue;
      }
      exclude("expiry_unknown", r.timestamp);
      continue;
    }
    if (q.expiryNormalized && nx !== q.expiryNormalized) {
      exclude("expiry_mismatch", r.timestamp);
      continue;
    }
    contract.push(r);
  }
  contract.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  // ── 3. The anchor — the "now" value ──────────────────────────
  const anchor = contract.length ? contract[contract.length - 1] : null;
  const anchorAgeMs = anchor ? asOfMs - Date.parse(anchor.timestamp) : null;
  const anchorStale = anchor != null && anchorAgeMs != null && anchorAgeMs > q.maxStalenessMs;

  const toPoint = (r: RawChainRow, ageMs: number, approximate = false): ChainSnapshotPoint => ({
    timestamp: r.timestamp,
    ageMs,
    ltp: num(r.ltp),
    oi: num(r.oi),
    oiChg: num(r.oi_chg),
    iv: num(r.iv),
    volume: num(r.volume),
    delta: num(r.delta),
    bid: num(r.bid),
    ask: num(r.ask),
    spot: num(r.spot),
    source: r.source ?? null,
    expiry: r.expiry ?? null,
    providerTimestamp: r.provider_timestamp ?? null,
    granularity: approximate ? "5m-rollup" : "raw",
    approximate,
  });

  const current = anchor ? toPoint(anchor, anchorAgeMs!) : null;

  // ── 4. The intervals ──────────────────────────────────────────
  const intervals: Record<string, ChainIntervalResult> = {};
  const coverageIntervals: ChainCoverage["intervals"] = {};

  for (const mins of q.intervals) {
    const targetMs = asOfMs - mins * 60_000;
    const targetTime = new Date(targetMs).toISOString();
    const key = String(mins);

    const missing = (reason: string, past: ChainSnapshotPoint | null = null): ChainIntervalResult => {
      const result: ChainIntervalResult = {
        intervalMinutes: mins,
        targetTime,
        status: "missing",
        reason,
        past,
        change: null,
        reference: null,
      };
      intervals[key] = result;
      coverageIntervals[key] = {
        status: "missing",
        reason,
        ageMs: past?.ageMs ?? null,
        source: past?.source ?? null,
      };
      return result;
    };

    if (!anchor) {
      missing("no_snapshot_at_or_before_as_of");
      continue;
    }
    if (anchorStale) {
      missing("anchor_stale");
      continue;
    }

    // Candidates: the newest rows at or before the target (NO look-ahead).
    const candidates = contract.filter((r) => Date.parse(r.timestamp) <= targetMs);
    // Inside the staleness window — an older row is NOT carried forward.
    const inWindow = candidates.filter(
      (r) => targetMs - Date.parse(r.timestamp) <= q.maxStalenessMs,
    );

    // The newest row inside the staleness window that shares the anchor's
    // provider lineage. A newer row from another lineage is EXCLUDED (and
    // reported) instead of being compared across lineages.
    let chosen: RawChainRow | null = null;
    for (let i = inWindow.length - 1; i >= 0; i--) {
      const r = inWindow[i];
      if (sourceCompatible(r.source, anchor.source, q.sourcePolicy)) {
        chosen = r;
        break;
      }
      exclude("source_mismatch", `${r.timestamp}|${mins}`);
    }

    if (!chosen) {
      if (inWindow.length) missing("source_mismatch");
      else if (candidates.length) missing("stale_beyond_window");
      else missing("no_snapshot_in_window");
      continue;
    }

    const pastAgeMs = targetMs - Date.parse(chosen.timestamp);
    const pastPoint = toPoint(chosen, asOfMs - Date.parse(chosen.timestamp));

    // ── 5. The underlying reference must be comparable ──────────
    const spotNow = num(anchor.spot);
    const spotPast = num(chosen.spot);
    let driftPct: number | null = null;
    let adjusted = false;
    let adjustment: number | null = null;

    if (q.referenceMode !== "ignore") {
      if (spotNow == null || spotPast == null || spotNow <= 0) {
        exclude("reference_unknown", `${chosen.timestamp}|${mins}`);
        missing("reference_unknown", pastPoint);
        continue;
      }
      driftPct = (Math.abs(spotPast - spotNow) / spotNow) * 100;
      if (driftPct > q.referenceTolerancePct) {
        if (q.referenceMode === "adjust") {
          const delta = num(chosen.delta);
          if (delta == null) {
            exclude("reference_drift", `${chosen.timestamp}|${mins}`);
            missing("reference_drift", pastPoint);
            continue;
          }
          adjusted = true;
          adjustment = delta * (spotNow - spotPast);
        } else {
          exclude("reference_drift", `${chosen.timestamp}|${mins}`);
          missing("reference_drift", pastPoint);
          continue;
        }
      }
    }

    // ── 6. The changes ──────────────────────────────────────────
    const nowLtp = num(anchor.ltp);
    const pastLtp = num(chosen.ltp);
    const adjustedPastLtp = pastLtp == null ? null : pastLtp + (adjustment ?? 0);
    const premium = diff(nowLtp, adjustedPastLtp);
    const change: ChainIntervalChange = {
      oi: diff(num(anchor.oi), num(chosen.oi)),
      oiChg: diff(num(anchor.oi_chg), num(chosen.oi_chg)),
      premium,
      premiumPct:
        premium != null && adjustedPastLtp != null && adjustedPastLtp !== 0
          ? (premium / Math.abs(adjustedPastLtp)) * 100
          : null,
      volume: diff(num(anchor.volume), num(chosen.volume)),
      iv: diff(num(anchor.iv), num(chosen.iv)),
    };

    const result: ChainIntervalResult = {
      intervalMinutes: mins,
      targetTime,
      status: "available",
      reason: null,
      past: pastPoint,
      change,
      reference: {
        spotNow,
        spotPast,
        driftPct,
        tolerancePct: q.referenceTolerancePct,
        adjusted,
        adjustment,
      },
    };
    intervals[key] = result;
    coverageIntervals[key] = {
      status: "available",
      reason: null,
      ageMs: pastAgeMs,
      source: chosen.source ?? null,
    };
  }

  // ── 7. PCR / Max Pain history (symbol-scoped) ─────────────────
  const aggregateFor = (field: "pcr_oi" | "pcr_vol" | "max_pain"): AggregateHistory => {
    const sorted = [...aggregateRows].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
    const eligible = sorted.filter((r) => {
      const t = Date.parse(r.timestamp);
      return Number.isFinite(t) && t <= asOfMs && t >= sessionStartMs && t <= sessionEndMs;
    });
    const latest = eligible.length ? eligible[eligible.length - 1] : null;
    const currentValue = latest ? num(latest[field]) : null;

    const aggIntervals: Record<string, AggregateIntervalResult> = {};
    for (const mins of q.intervals) {
      const targetMs = asOfMs - mins * 60_000;
      const targetTime = new Date(targetMs).toISOString();
      const key = String(mins);
      const candidates = eligible.filter((r) => Date.parse(r.timestamp) <= targetMs);
      const inWindow = candidates.filter(
        (r) => targetMs - Date.parse(r.timestamp) <= q.maxStalenessMs,
      );
      const picked = inWindow.length ? inWindow[inWindow.length - 1] : null;
      if (!picked) {
        aggIntervals[key] = {
          intervalMinutes: mins,
          targetTime,
          status: "missing",
          reason: candidates.length ? "stale_beyond_window" : "no_snapshot_in_window",
          timestamp: null,
          ageMs: null,
          value: null,
          change: null,
          source: null,
        };
        continue;
      }
      const value = num(picked[field]);
      aggIntervals[key] = {
        intervalMinutes: mins,
        targetTime,
        status: "available",
        reason: null,
        timestamp: picked.timestamp,
        ageMs: asOfMs - Date.parse(picked.timestamp),
        value,
        change: diff(currentValue, value),
        source: picked.source ?? null,
      };
    }

    return {
      scope: "symbol",
      current: latest
        ? {
            timestamp: latest.timestamp,
            ageMs: asOfMs - Date.parse(latest.timestamp),
            value: currentValue,
            source: latest.source ?? null,
          }
        : null,
      intervals: aggIntervals,
    };
  };

  // ── 8. Coverage ───────────────────────────────────────────────
  const ages = contract.map((r) => asOfMs - Date.parse(r.timestamp));
  const sourceMix: Record<string, number> = {};
  for (const r of contract) {
    const s = r.source ?? "unknown";
    sourceMix[s] = (sourceMix[s] ?? 0) + 1;
  }
  const excluded = [...exclusionSets.entries()]
    .map(([reason, set]) => ({ reason, count: set.size }))
    .sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason));

  const lookbackMs =
    (q.intervals.length ? Math.max(...q.intervals) : 30) * 60_000 + q.maxStalenessMs;

  const coverage: ChainCoverage = {
    symbol: q.symbol,
    window: {
      from: new Date(asOfMs - lookbackMs).toISOString(),
      to: q.asOf,
    },
    session,
    snapshotsInWindow: new Set(aggregateRows.map((r) => r.timestamp)).size,
    chainRowsInWindow: chainRows.length,
    contractRows: contract.length,
    ageMs: {
      min: ages.length ? Math.min(...ages) : null,
      max: ages.length ? Math.max(...ages) : null,
    },
    sourceMix,
    excluded,
    excludedTotal: excluded.reduce((sum, e) => sum + e.count, 0),
    intervals: coverageIntervals,
    rollup: {
      rows: rollupRows.length,
      used: 0,
      reason: rollupReason,
    },
  };

  return {
    symbol: q.symbol,
    expiry: q.expiryNormalized,
    expiryInput: q.expiry,
    strike: q.strike,
    optionType: q.optionType,
    asOf: q.asOf,
    session,
    policy: {
      intervals: q.intervals,
      maxStalenessMs: q.maxStalenessMs,
      referenceTolerancePct: q.referenceTolerancePct,
      referenceMode: q.referenceMode,
      sourcePolicy: q.sourcePolicy,
      allowUnknownExpiry: q.allowUnknownExpiry,
    },
    current,
    currentReason: current
      ? anchorStale
        ? "stale_anchor"
        : null
      : chainRows.length
        ? "no_usable_snapshot"
        : "no_snapshot_at_or_before_as_of",
    intervals,
    pcrOi: aggregateFor("pcr_oi"),
    pcrVol: aggregateFor("pcr_vol"),
    maxPain: aggregateFor("max_pain"),
    coverage,
  };
}

// ── The DB-backed entry point ────────────────────────────────────

function fetchChainRows(handle: SqliteHandle, q: NormalizedQuery, lookbackMs: number): RawChainRow[] {
  const cols = tableColumns(handle, "chain_ticks");
  if (!cols.size) return [];
  const book = cols.has("bid") || cols.has("ask");
  const select = [
    "ct.timestamp AS timestamp",
    "ct.ltp AS ltp",
    "ct.oi AS oi",
    "ct.oi_chg AS oi_chg",
    "ct.iv AS iv",
    "ct.delta AS delta",
    "ct.volume AS volume",
    cols.has("expiry") ? "ct.expiry AS expiry" : "NULL AS expiry",
    cols.has("source") ? "ct.source AS source" : "NULL AS source",
    cols.has("provider_timestamp")
      ? "ct.provider_timestamp AS provider_timestamp"
      : "NULL AS provider_timestamp",
    book ? "ct.bid AS bid" : "NULL AS bid",
    book ? "ct.ask AS ask" : "NULL AS ask",
    "ms.spot AS spot",
  ].join(", ");
  const sql = `
    SELECT ${select}
    FROM chain_ticks ct
    LEFT JOIN market_snapshots ms ON ms.id = ct.snapshot_id
    WHERE ct.symbol = ? AND ct.strike = ? AND ct.type = ?
      AND ct.timestamp >= ? AND ct.timestamp <= ?
    ORDER BY ct.timestamp ASC`;
  return handle.all(sql, [
    q.symbol,
    q.strike,
    q.optionType,
    new Date(q.asOfMs - lookbackMs).toISOString(),
    q.asOf,
  ]) as RawChainRow[];
}

function fetchAggregateRows(
  handle: SqliteHandle,
  q: NormalizedQuery,
  lookbackMs: number,
): RawAggregateRow[] {
  const cols = tableColumns(handle, "market_snapshots");
  if (!cols.size) return [];
  const pick = (name: string): string => (cols.has(name) ? `ms.${name}` : "NULL");
  const sql = `
    SELECT ms.timestamp AS timestamp, ${pick("spot")} AS spot,
           ${pick("pcr_oi")} AS pcr_oi, ${pick("pcr_vol")} AS pcr_vol,
           ${pick("max_pain")} AS max_pain, ${pick("source")} AS source
    FROM market_snapshots ms
    WHERE ms.symbol = ? AND ms.timestamp >= ? AND ms.timestamp <= ?
    ORDER BY ms.timestamp ASC`;
  return handle.all(sql, [
    q.symbol,
    new Date(q.asOfMs - lookbackMs).toISOString(),
    q.asOf,
  ]) as RawAggregateRow[];
}

function fetchRollupRows(
  handle: SqliteHandle,
  q: NormalizedQuery,
  lookbackMs: number,
): { rows: RawRollupRow[]; reason: string | null } {
  const cols = tableColumns(handle, "chain_5m");
  if (!cols.size) return { rows: [], reason: "no_rollup_table" };
  // The rollup has NO expiry column: a bucket can mix expiries at the same
  // strike, so it can never be attributed to one contract. Until the rollup
  // carries the expiry, it is read but NOT used for an expiry-scoped
  // comparison — and that is reported, never hidden.
  if (!cols.has("expiry")) {
    const count = handle.get("SELECT COUNT(*) AS c FROM chain_5m", []) as any;
    return { rows: [], reason: `rollup_has_no_expiry_column (${count?.c ?? 0} rows ignored)` };
  }
  const rows = handle.all(
    `SELECT bucket, strike, type, ltp_close, oi_last, iv_avg, source, first_ts, last_ts, expiry
     FROM chain_5m
     WHERE symbol = ? AND strike = ? AND type = ? AND last_ts >= ? AND last_ts <= ?
     ORDER BY last_ts ASC`,
    [
      q.symbol,
      q.strike,
      q.optionType,
      new Date(q.asOfMs - lookbackMs).toISOString(),
      q.asOf,
    ],
  ) as RawRollupRow[];
  return { rows, reason: rows.length ? null : "no_rollup_rows_in_window" };
}

/**
 * Read the multi-interval snapshot history for one contract.
 *
 * READ-ONLY: the market-history DB is opened readonly and never written.
 */
export function readChainHistory(query: ChainHistoryQuery): ChainHistoryResult {
  const q = normalizeQuery(query);
  if (!Number.isFinite(q.asOfMs)) {
    return emptyResult(q, "invalid_as_of");
  }
  const lookbackMs =
    (q.intervals.length ? Math.max(...q.intervals) : 30) * 60_000 + q.maxStalenessMs;

  let handle: SqliteHandle;
  try {
    handle = getHandle();
  } catch (e: any) {
    return emptyResult(q, `db_unavailable: ${String(e?.message ?? e)}`);
  }

  try {
    const chainRows = fetchChainRows(handle, q, lookbackMs);
    const aggregateRows = fetchAggregateRows(handle, q, lookbackMs);
    const rollup = fetchRollupRows(handle, q, lookbackMs);
    return buildChainHistory(chainRows, aggregateRows, rollup.rows, rollup.reason, query);
  } catch (e: any) {
    return emptyResult(q, `db_error: ${String(e?.message ?? e)}`);
  }
}
