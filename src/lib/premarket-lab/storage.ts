// Snapshot storage for the Pre-Market Data Science Lab.
// Dual adapter: bun:sqlite under Bun (app runtime), better-sqlite3 under Node.
// Additive tables in market_history.db — never mutates production Trade tables.

import { randomUUID } from "node:crypto";
import type {
  PreopenStudyDay, FeatureRow, CombinedQuantScore, Provenance,
  ShadowSession, ShadowPrediction, OptionSimResult, WilsonInterval, OutcomeStatus,
} from "./types";

const DB_PATH = process.env.MARKET_HISTORY_DB || "db/market_history.db";

type SqlRun = { changes: number };
type Row = Record<string, any>;

interface DbAdapter {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: any[]): SqlRun;
    get(...params: any[]): Row | undefined;
    all(...params: any[]): Row[];
  };
}

let _db: DbAdapter | null = null;

function openDb(): DbAdapter {
  // Prefer Bun's native sqlite when running under Bun
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const stmt = db.prepare(sql);
        return {
          run: (...params) => {
            const r = stmt.run(...(params as any));
            return { changes: Number(r?.changes ?? 0) };
          },
          get: (...params) => stmt.get(...(params as any)) as Row | undefined,
          all: (...params) => stmt.all(...(params as any)) as Row[],
        };
      },
    };
  } catch {
    // Node / tsx path
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    const db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    return db as DbAdapter;
  }
}

export function getLabDb(): DbAdapter {
  if (_db) return _db;
  _db = openDb();
  initLabSchema(_db);
  return _db;
}

export function initLabSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS preopen_cm_snapshots (
      id TEXT PRIMARY KEY,
      trade_date TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      published_at TEXT,
      symbol TEXT NOT NULL,
      previous_close REAL,
      iep REAL,
      final_price REAL,
      change_pct REAL,
      final_qty REAL,
      turnover REAL,
      buy_qty REAL,
      sell_qty REAL,
      imbalance_qty REAL,
      best_bid REAL,
      best_ask REAL,
      quality TEXT NOT NULL,
      provenance TEXT NOT NULL,
      UNIQUE(trade_date, symbol, captured_at)
    );
    CREATE INDEX IF NOT EXISTS idx_preopen_cm_date ON preopen_cm_snapshots(trade_date);

    CREATE TABLE IF NOT EXISTS preopen_fno_snapshots (
      id TEXT PRIMARY KEY,
      trade_date TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      published_at TEXT,
      instrument_type TEXT NOT NULL,
      symbol TEXT NOT NULL,
      identifier TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      previous_close REAL,
      iep REAL,
      final_price REAL,
      change_pct REAL,
      final_qty REAL,
      turnover REAL,
      buy_qty REAL,
      sell_qty REAL,
      imbalance_qty REAL,
      best_bid REAL,
      best_ask REAL,
      quality TEXT NOT NULL,
      provenance TEXT NOT NULL,
      UNIQUE(trade_date, identifier, captured_at)
    );
    CREATE INDEX IF NOT EXISTS idx_preopen_fno_date ON preopen_fno_snapshots(trade_date);
    CREATE INDEX IF NOT EXISTS idx_preopen_fno_sym ON preopen_fno_snapshots(symbol, trade_date);

    CREATE TABLE IF NOT EXISTS preopen_study_days (
      id TEXT PRIMARY KEY,
      trade_date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      payload TEXT NOT NULL,
      quality_score INTEGER NOT NULL,
      quality_overall TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(trade_date, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_study_date ON preopen_study_days(trade_date);

    CREATE TABLE IF NOT EXISTS premarket_features (
      id TEXT PRIMARY KEY,
      trade_date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      as_of TEXT NOT NULL,
      target TEXT,
      label INTEGER,
      features TEXT NOT NULL,
      sources TEXT NOT NULL,
      calc_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(trade_date, symbol, target, calc_version)
    );
    CREATE INDEX IF NOT EXISTS idx_features_date ON premarket_features(trade_date);

    CREATE TABLE IF NOT EXISTS premarket_model_runs (
      id TEXT PRIMARY KEY,
      model_name TEXT NOT NULL,
      target TEXT NOT NULL,
      feature_set TEXT NOT NULL,
      train_start TEXT,
      train_end TEXT,
      test_start TEXT,
      test_end TEXT,
      metrics TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_target ON premarket_model_runs(target, created_at);

    CREATE TABLE IF NOT EXISTS premarket_scores (
      id TEXT PRIMARY KEY,
      trade_date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      score REAL NOT NULL,
      bias TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(trade_date, symbol, created_at)
    );
    CREATE INDEX IF NOT EXISTS idx_scores_date ON premarket_scores(trade_date);

    CREATE TABLE IF NOT EXISTS shadow_sessions (
      id TEXT PRIMARY KEY,
      trade_date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      feature_as_of TEXT NOT NULL,
      lab_score REAL,
      lab_bias TEXT,
      predictions TEXT NOT NULL,
      sdm TEXT,
      outcomes TEXT,
      research TEXT,
      quality TEXT,
      option_sim_validated INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL,
      outcome_status TEXT NOT NULL DEFAULT 'PENDING_OUTCOME',
      outcome_attempts INTEGER NOT NULL DEFAULT 0,
      outcome_attached_at TEXT,
      recorded_at TEXT,
      research_as_of TEXT,
      UNIQUE(trade_date, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_date ON shadow_sessions(trade_date);
    CREATE INDEX IF NOT EXISTS idx_shadow_sym ON shadow_sessions(symbol, trade_date);

    CREATE TABLE IF NOT EXISTS shadow_predictions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      model TEXT NOT NULL,
      feature_set TEXT,
      p_up REAL,
      pred_label INTEGER,
      as_of TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, model, feature_set, as_of)
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_pred_date ON shadow_predictions(trade_date);

    CREATE TABLE IF NOT EXISTS option_sim_results (
      id TEXT PRIMARY KEY,
      trade_date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      strike REAL,
      expiry TEXT,
      entry REAL,
      stop_loss REAL,
      target REAL,
      outcome TEXT NOT NULL,
      pnl_r REAL,
      mae REAL,
      mfe REAL,
      charges REAL,
      slippage_pts REAL,
      validated INTEGER NOT NULL,
      reason TEXT,
      as_of TEXT NOT NULL,
      created_at TEXT NOT NULL,
      lot_size REAL,
      pnl_inr REAL,
      UNIQUE(trade_date, symbol, side, strike, expiry, as_of)
    );
    CREATE INDEX IF NOT EXISTS idx_opt_sim_date ON option_sim_results(trade_date);

    CREATE TABLE IF NOT EXISTS preopen_capture_audit (
      id TEXT PRIMARY KEY,
      trade_date TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      cm_rows INTEGER,
      fno_rows INTEGER,
      quality_overall TEXT,
      quality_score INTEGER,
      research_as_of TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_capture_audit_date ON preopen_capture_audit(trade_date);
  `);

  // Phase 12 additive migrations for rows created before these columns existed.
  const ensureCol = (table: string, col: string, ddl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  ensureCol("shadow_sessions", "outcome_status", "outcome_status TEXT NOT NULL DEFAULT 'PENDING_OUTCOME'");
  ensureCol("shadow_sessions", "outcome_attempts", "outcome_attempts INTEGER NOT NULL DEFAULT 0");
  ensureCol("shadow_sessions", "outcome_attached_at", "outcome_attached_at TEXT");
  ensureCol("shadow_sessions", "recorded_at", "recorded_at TEXT");
  ensureCol("shadow_sessions", "research_as_of", "research_as_of TEXT");
  ensureCol("option_sim_results", "lot_size", "lot_size REAL");
  ensureCol("option_sim_results", "pnl_inr", "pnl_inr REAL");
  // Indexes that depend on Phase 12 columns (after ALTER)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_shadow_outcome_status ON shadow_sessions(outcome_status);
  `);
}

function json(v: unknown): string {
  return JSON.stringify(v ?? null);
}

export function saveCmSnapshot(
  tradeDate: string,
  capturedAt: string,
  rows: Array<{ symbol: string; previousClose: number | null; iep: number | null; finalPrice: number | null; pChange: number | null; finalQuantity: number | null; totalTurnover: number | null; totalBuyQuantity: number | null; totalSellQuantity: number | null; bestBid: number | null; bestAsk: number | null }>,
  publishedAt: string | null,
  quality: string,
  provenance: Provenance,
): number {
  const db = getLabDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO preopen_cm_snapshots
    (id, trade_date, captured_at, published_at, symbol, previous_close, iep, final_price, change_pct,
     final_qty, turnover, buy_qty, sell_qty, imbalance_qty, best_bid, best_ask, quality, provenance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let n = 0;
  const prov = json(provenance);
  for (const r of rows) {
    const imb =
      r.totalBuyQuantity != null && r.totalSellQuantity != null
        ? r.totalBuyQuantity - r.totalSellQuantity
        : null;
    const res = stmt.run(
      randomUUID(), tradeDate, capturedAt, publishedAt, r.symbol,
      r.previousClose, r.iep, r.finalPrice, r.pChange,
      r.finalQuantity, r.totalTurnover, r.totalBuyQuantity, r.totalSellQuantity,
      imb, r.bestBid, r.bestAsk, quality, prov,
    );
    n += res.changes;
  }
  return n;
}

export function saveFnoSnapshot(
  tradeDate: string,
  capturedAt: string,
  rows: Array<{ instrumentType: string; symbol: string; identifier: string; expiryDate: string; previousClose: number | null; iep: number | null; finalPrice: number | null; pChange: number | null; finalQuantity: number | null; totalTurnover: number | null; totalBuyQuantity: number | null; totalSellQuantity: number | null; bestBid: number | null; bestAsk: number | null }>,
  publishedAt: string | null,
  quality: string,
  provenance: Provenance,
): number {
  const db = getLabDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO preopen_fno_snapshots
    (id, trade_date, captured_at, published_at, instrument_type, symbol, identifier, expiry_date,
     previous_close, iep, final_price, change_pct, final_qty, turnover, buy_qty, sell_qty,
     imbalance_qty, best_bid, best_ask, quality, provenance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let n = 0;
  const prov = json(provenance);
  for (const r of rows) {
    const imb =
      r.totalBuyQuantity != null && r.totalSellQuantity != null
        ? r.totalBuyQuantity - r.totalSellQuantity
        : null;
    const res = stmt.run(
      randomUUID(), tradeDate, capturedAt, publishedAt, r.instrumentType, r.symbol, r.identifier, r.expiryDate,
      r.previousClose, r.iep, r.finalPrice, r.pChange,
      r.finalQuantity, r.totalTurnover, r.totalBuyQuantity, r.totalSellQuantity,
      imb, r.bestBid, r.bestAsk, quality, prov,
    );
    n += res.changes;
  }
  return n;
}

export function saveStudyDay(day: PreopenStudyDay): void {
  const db = getLabDb();
  db.prepare(`
    INSERT INTO preopen_study_days (id, trade_date, symbol, payload, quality_score, quality_overall, created_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(trade_date, symbol) DO UPDATE SET
      payload=excluded.payload,
      quality_score=excluded.quality_score,
      quality_overall=excluded.quality_overall,
      created_at=excluded.created_at
  `).run(randomUUID(), day.tradeDate, day.symbol, json(day), day.quality.score, day.quality.overall, new Date().toISOString());
}

export function getStudyDay(tradeDate: string, symbol: string): PreopenStudyDay | null {
  const db = getLabDb();
  const row = db.prepare("SELECT payload FROM preopen_study_days WHERE trade_date=? AND symbol=?").get(tradeDate, symbol);
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as PreopenStudyDay;
  } catch {
    return null;
  }
}

export function listStudyDays(opts: { symbol?: string; from?: string; to?: string; limit?: number } = {}): PreopenStudyDay[] {
  const db = getLabDb();
  const clauses: string[] = [];
  const params: any[] = [];
  if (opts.symbol) { clauses.push("symbol=?"); params.push(opts.symbol); }
  if (opts.from) { clauses.push("trade_date>=?"); params.push(opts.from); }
  if (opts.to) { clauses.push("trade_date<=?"); params.push(opts.to); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(opts.limit ?? 500, 5000);
  const rows = db.prepare(`SELECT payload FROM preopen_study_days ${where} ORDER BY trade_date DESC LIMIT ?`).all(...params, limit);
  const out: PreopenStudyDay[] = [];
  for (const r of rows) {
    try { out.push(JSON.parse(r.payload)); } catch { /* skip */ }
  }
  return out;
}

export function saveFeatures(row: FeatureRow & { target?: string; label?: number | null }): void {
  const db = getLabDb();
  db.prepare(`
    INSERT INTO premarket_features (id, trade_date, symbol, as_of, target, label, features, sources, calc_version, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(trade_date, symbol, target, calc_version) DO UPDATE SET
      as_of=excluded.as_of, label=excluded.label, features=excluded.features, sources=excluded.sources
  `).run(
    randomUUID(), row.tradeDate, row.symbol, row.asOf,
    row.target ?? null, row.label ?? null,
    json(row.features), json(row.source), row.calcVersion, new Date().toISOString(),
  );
}

export function loadFeatures(opts: { symbol?: string; from?: string; to?: string; target?: string; calcVersion?: string } = {}): Array<FeatureRow & { target?: string; label?: number | null }> {
  const db = getLabDb();
  const clauses: string[] = [];
  const params: any[] = [];
  if (opts.symbol) { clauses.push("symbol=?"); params.push(opts.symbol); }
  if (opts.from) { clauses.push("trade_date>=?"); params.push(opts.from); }
  if (opts.to) { clauses.push("trade_date<=?"); params.push(opts.to); }
  if (opts.target) { clauses.push("target=?"); params.push(opts.target); }
  if (opts.calcVersion) { clauses.push("calc_version=?"); params.push(opts.calcVersion); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM premarket_features ${where} ORDER BY trade_date ASC`).all(...params);
  return rows.map((r) => {
    let features: Record<string, number | null> = {};
    let sources: string[] = [];
    try { features = JSON.parse(r.features); } catch { /* */ }
    try { sources = JSON.parse(r.sources); } catch { /* */ }
    return {
      tradeDate: r.trade_date,
      symbol: r.symbol,
      asOf: r.as_of,
      features,
      source: sources as any,
      calcVersion: r.calc_version,
      target: r.target ?? undefined,
      label: r.label,
    };
  });
}

export function saveModelRun(run: {
  modelName: string; target: string; featureSet: string;
  trainStart?: string; trainEnd?: string; testStart?: string; testEnd?: string;
  metrics: unknown;
}): void {
  const db = getLabDb();
  db.prepare(`
    INSERT INTO premarket_model_runs (id, model_name, target, feature_set, train_start, train_end, test_start, test_end, metrics, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(randomUUID(), run.modelName, run.target, run.featureSet, run.trainStart ?? null, run.trainEnd ?? null, run.testStart ?? null, run.testEnd ?? null, json(run.metrics), new Date().toISOString());
}

export function listModelRuns(limit = 50): any[] {
  const db = getLabDb();
  const rows = db.prepare("SELECT * FROM premarket_model_runs ORDER BY created_at DESC LIMIT ?").all(limit);
  return rows.map((r) => {
    let metrics: any = {};
    try { metrics = JSON.parse(r.metrics); } catch { /* */ }
    return { ...r, metrics };
  });
}

export function saveScore(tradeDate: string, symbol: string, score: CombinedQuantScore): void {
  const db = getLabDb();
  db.prepare(`
    INSERT INTO premarket_scores (id, trade_date, symbol, score, bias, payload, created_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(randomUUID(), tradeDate, symbol, score.score, score.bias, json(score), new Date().toISOString());
}

export function getLatestScore(symbol?: string): any | null {
  const db = getLabDb();
  const row = symbol
    ? db.prepare("SELECT payload FROM premarket_scores WHERE symbol=? ORDER BY created_at DESC LIMIT 1").get(symbol)
    : db.prepare("SELECT payload FROM premarket_scores ORDER BY created_at DESC LIMIT 1").get();
  if (!row) return null;
  try { return JSON.parse(row.payload); } catch { return null; }
}

export function saveShadowSession(s: ShadowSession): string {
  const db = getLabDb();
  const id = s.id || randomUUID();
  const optionSim =
    s.optionSimValidated == null ? null : s.optionSimValidated ? 1 : 0;
  const outcomeStatus = s.outcomeStatus || "PENDING_OUTCOME";
  const outcomeAttempts = s.outcomeAttempts ?? 0;
  db.prepare(`
    INSERT INTO shadow_sessions
    (id, trade_date, symbol, feature_as_of, lab_score, lab_bias, predictions, sdm, outcomes, research, quality, option_sim_validated, notes, created_at,
     outcome_status, outcome_attempts, outcome_attached_at, recorded_at, research_as_of)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(trade_date, symbol) DO UPDATE SET
      feature_as_of=excluded.feature_as_of,
      lab_score=excluded.lab_score,
      lab_bias=excluded.lab_bias,
      predictions=excluded.predictions,
      sdm=excluded.sdm,
      outcomes=excluded.outcomes,
      research=excluded.research,
      quality=excluded.quality,
      option_sim_validated=excluded.option_sim_validated,
      notes=excluded.notes,
      created_at=excluded.created_at,
      outcome_status=excluded.outcome_status,
      outcome_attempts=excluded.outcome_attempts,
      outcome_attached_at=excluded.outcome_attached_at,
      recorded_at=excluded.recorded_at,
      research_as_of=excluded.research_as_of
  `).run(
    id, s.tradeDate, s.symbol, s.featureAsOf,
    s.labScore, s.labBias,
    json(s.predictions), json(s.sdm), json(s.outcomes), json(s.research), json(s.quality),
    optionSim, json(s.notes || []), s.createdAt || new Date().toISOString(),
    outcomeStatus, outcomeAttempts, s.outcomeAttachedAt ?? null,
    s.recordedAt ?? s.createdAt ?? new Date().toISOString(),
    s.researchAsOf ?? s.research?.asOf ?? null,
  );
  // Flatten predictions for query / compare
  if (s.predictions?.length) {
    const pStmt = db.prepare(`
      INSERT OR IGNORE INTO shadow_predictions
      (id, session_id, trade_date, symbol, model, feature_set, p_up, pred_label, as_of, notes, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const p of s.predictions) {
      pStmt.run(
        randomUUID(), id, s.tradeDate, s.symbol, p.model, p.featureSet ?? null,
        p.pUp, p.predLabel ?? null, p.asOf, p.notes ?? null, new Date().toISOString(),
      );
    }
  }
  return id;
}

function parseJson<T>(v: string | null | undefined, fallback: T): T {
  if (v == null) return fallback;
  try {
    const x = JSON.parse(v);
    return (x ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function getShadowSession(tradeDate: string, symbol: string): ShadowSession | null {
  const db = getLabDb();
  const row = db.prepare("SELECT * FROM shadow_sessions WHERE trade_date=? AND symbol=?").get(tradeDate, symbol);
  if (!row) return null;
  return rowToShadow(row);
}

function rowToShadow(r: any): ShadowSession {
  const opt = r.option_sim_validated;
  return {
    id: r.id,
    tradeDate: r.trade_date,
    symbol: r.symbol,
    featureAsOf: r.feature_as_of,
    labScore: r.lab_score,
    labBias: r.lab_bias,
    predictions: parseJson<ShadowPrediction[]>(r.predictions, []),
    sdm: parseJson(r.sdm, null),
    outcomes: parseJson(r.outcomes, null),
    research: parseJson(r.research, null),
    quality: parseJson(r.quality, null),
    optionSimValidated: opt == null ? null : !!opt,
    notes: parseJson<string[]>(r.notes, []),
    createdAt: r.created_at,
    outcomeStatus: (r.outcome_status as OutcomeStatus) || "PENDING_OUTCOME",
    outcomeAttempts: r.outcome_attempts ?? 0,
    outcomeAttachedAt: r.outcome_attached_at ?? null,
    recordedAt: r.recorded_at ?? r.created_at ?? null,
    researchAsOf: r.research_as_of ?? null,
  };
}

export function listShadowSessions(opts: { symbol?: string; from?: string; to?: string; limit?: number } = {}): ShadowSession[] {
  const db = getLabDb();
  const clauses: string[] = [];
  const params: any[] = [];
  if (opts.symbol) { clauses.push("symbol=?"); params.push(opts.symbol); }
  if (opts.from) { clauses.push("trade_date>=?"); params.push(opts.from); }
  if (opts.to) { clauses.push("trade_date<=?"); params.push(opts.to); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(opts.limit ?? 500, 5000);
  const rows = db.prepare(`SELECT * FROM shadow_sessions ${where} ORDER BY trade_date DESC LIMIT ?`).all(...params, limit);
  return rows.map(rowToShadow);
}

export function saveOptionSim(r: OptionSimResult): void {
  const db = getLabDb();
  db.prepare(`
    INSERT INTO option_sim_results
    (id, trade_date, symbol, side, strike, expiry, entry, stop_loss, target, outcome, pnl_r, mae, mfe, charges, slippage_pts, validated, reason, as_of, created_at, lot_size, pnl_inr)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(trade_date, symbol, side, strike, expiry, as_of) DO UPDATE SET
      entry=excluded.entry, stop_loss=excluded.stop_loss, target=excluded.target,
      outcome=excluded.outcome, pnl_r=excluded.pnl_r, mae=excluded.mae, mfe=excluded.mfe,
      charges=excluded.charges, slippage_pts=excluded.slippage_pts, validated=excluded.validated,
      reason=excluded.reason, lot_size=excluded.lot_size, pnl_inr=excluded.pnl_inr
  `).run(
    randomUUID(), r.tradeDate, r.symbol, r.side, r.strike, r.expiry,
    r.entry, r.stopLoss, r.target, r.outcome, r.pnlR, r.mae, r.mfe,
    r.charges, r.slippagePts, r.validated ? 1 : 0, r.reason ?? null, r.asOf,
    new Date().toISOString(), r.lotSize ?? null, r.pnlInr ?? null,
  );
}

export function listOptionSims(opts: { symbol?: string; from?: string; to?: string; limit?: number } = {}): OptionSimResult[] {
  const db = getLabDb();
  const clauses: string[] = [];
  const params: any[] = [];
  if (opts.symbol) { clauses.push("symbol=?"); params.push(opts.symbol); }
  if (opts.from) { clauses.push("trade_date>=?"); params.push(opts.from); }
  if (opts.to) { clauses.push("trade_date<=?"); params.push(opts.to); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(opts.limit ?? 500, 5000);
  const rows = db.prepare(`SELECT * FROM option_sim_results ${where} ORDER BY trade_date DESC LIMIT ?`).all(...params, limit);
  return rows.map((r) => ({
    tradeDate: r.trade_date,
    symbol: r.symbol,
    side: r.side,
    strike: r.strike,
    expiry: r.expiry,
    entry: r.entry,
    stopLoss: r.stop_loss,
    target: r.target,
    outcome: r.outcome,
    pnlR: r.pnl_r,
    mae: r.mae,
    mfe: r.mfe,
    charges: r.charges,
    slippagePts: r.slippage_pts,
    validated: !!r.validated,
    reason: r.reason ?? undefined,
    asOf: r.as_of,
    lotSize: r.lot_size ?? null,
    pnlInr: r.pnl_inr ?? null,
  }));
}

/** Phase 12 — sessions whose outcomes are not yet final. */
export function listPendingOutcomes(opts: { limit?: number } = {}): ShadowSession[] {
  const db = getLabDb();
  const limit = Math.min(opts.limit ?? 500, 5000);
  const rows = db.prepare(
    "SELECT * FROM shadow_sessions WHERE outcome_status = 'PENDING_OUTCOME' ORDER BY trade_date ASC LIMIT ?",
  ).all(limit);
  return rows.map(rowToShadow);
}

/** Phase 12 — update outcome lifecycle fields without touching predictions. */
export function setOutcomeStatus(
  tradeDate: string,
  symbol: string,
  status: OutcomeStatus,
  opts: {
    outcomes?: ShadowSession["outcomes"];
    attempts?: number;
    attachedAt?: string | null;
    note?: string;
  } = {},
): boolean {
  const db = getLabDb();
  const existing = db.prepare(
    "SELECT id, notes, outcome_attempts FROM shadow_sessions WHERE trade_date=? AND symbol=?",
  ).get(tradeDate, symbol) as any;
  if (!existing) return false;

  let notes: string[] = [];
  try { notes = parseJson<string[]>(existing.notes, []); } catch { notes = []; }
  if (opts.note) notes.push(opts.note);

  const attempts = opts.attempts ?? (existing.outcome_attempts ?? 0) + 1;
  const attachedAt =
    status === "OUTCOME_RECORDED" || status === "OUTCOME_UNAVAILABLE"
      ? opts.attachedAt ?? new Date().toISOString()
      : null;

  db.prepare(`
    UPDATE shadow_sessions
    SET outcome_status=?, outcome_attempts=?, outcome_attached_at=?,
        outcomes=COALESCE(?, outcomes), notes=?
    WHERE trade_date=? AND symbol=?
  `).run(
    status, attempts, attachedAt,
    opts.outcomes !== undefined ? json(opts.outcomes) : null,
    json(notes), tradeDate, symbol,
  );
  return true;
}

/** Append-only capture audit (full history; never overwrites prior rows). */
export function appendCaptureAudit(entry: {
  tradeDate: string;
  capturedAt: string;
  cmRows: number;
  fnoRows: number;
  qualityOverall: string;
  qualityScore: number;
  researchAsOf?: string | null;
  notes?: string;
}): void {
  const db = getLabDb();
  db.prepare(`
    INSERT INTO preopen_capture_audit
    (id, trade_date, captured_at, cm_rows, fno_rows, quality_overall, quality_score, research_as_of, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    randomUUID(), entry.tradeDate, entry.capturedAt, entry.cmRows, entry.fnoRows,
    entry.qualityOverall, entry.qualityScore, entry.researchAsOf ?? null,
    entry.notes ?? null, new Date().toISOString(),
  );
}

export function listCaptureAudit(tradeDate?: string, limit = 50): any[] {
  const db = getLabDb();
  if (tradeDate) {
    return db.prepare(
      "SELECT * FROM preopen_capture_audit WHERE trade_date=? ORDER BY captured_at DESC LIMIT ?",
    ).all(tradeDate, limit);
  }
  return db.prepare(
    "SELECT * FROM preopen_capture_audit ORDER BY captured_at DESC LIMIT ?",
  ).all(limit);
}

export function shadowCoverageStats(): {
  sessions: number; withOutcomes: number; withSdm: number; withResearch: number;
  optionSimValidated: number; optionSimNotValidated: number; dateRange: [string, string] | null;
  pendingOutcomes: number; recordedOutcomes: number; unavailableOutcomes: number;
} {
  const db = getLabDb();
  const one = (sql: string) => db.prepare(sql).get();
  const sessions = one("SELECT COUNT(*) n FROM shadow_sessions")?.n ?? 0;
  const withOutcomes = one("SELECT COUNT(*) n FROM shadow_sessions WHERE outcomes IS NOT NULL AND outcomes != 'null'")?.n ?? 0;
  const withSdm = one("SELECT COUNT(*) n FROM shadow_sessions WHERE sdm IS NOT NULL AND sdm != 'null'")?.n ?? 0;
  const withResearch = one("SELECT COUNT(*) n FROM shadow_sessions WHERE research IS NOT NULL AND research != 'null'")?.n ?? 0;
  const optionSimValidated = one("SELECT COUNT(*) n FROM option_sim_results WHERE validated=1")?.n ?? 0;
  const optionSimNotValidated = one("SELECT COUNT(*) n FROM option_sim_results WHERE validated=0")?.n ?? 0;
  const pendingOutcomes = one("SELECT COUNT(*) n FROM shadow_sessions WHERE outcome_status='PENDING_OUTCOME'")?.n ?? 0;
  const recordedOutcomes = one("SELECT COUNT(*) n FROM shadow_sessions WHERE outcome_status='OUTCOME_RECORDED'")?.n ?? 0;
  const unavailableOutcomes = one("SELECT COUNT(*) n FROM shadow_sessions WHERE outcome_status='OUTCOME_UNAVAILABLE'")?.n ?? 0;
  const range = one("SELECT MIN(trade_date) a, MAX(trade_date) b FROM shadow_sessions");
  return {
    sessions, withOutcomes, withSdm, withResearch,
    optionSimValidated, optionSimNotValidated,
    pendingOutcomes, recordedOutcomes, unavailableOutcomes,
    dateRange: range?.a ? [range.a, range.b] : null,
  };
}

export function wilsonInterval(successes: number, n: number, z = 1.96): WilsonInterval {
  if (!Number.isFinite(n) || n <= 0) {
    return { n: 0, successes: 0, rate: null, lower: null, upper: null, insufficient: true };
  }
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lower = Math.max(0, (center - margin) / denom);
  const upper = Math.min(1, (center + margin) / denom);
  return {
    n,
    successes,
    rate: p,
    lower,
    upper,
    insufficient: n < 30,
  };
}

export function coverageStats(): {
  cmDays: number; fnoDays: number; studyDays: number; featureRows: number; modelRuns: number; scoreRows: number;
  cmRange: [string, string] | null; fnoRange: [string, string] | null;
} {
  const db = getLabDb();
  const one = (sql: string) => db.prepare(sql).get();
  const cmDays = one("SELECT COUNT(DISTINCT trade_date) n FROM preopen_cm_snapshots")?.n ?? 0;
  const fnoDays = one("SELECT COUNT(DISTINCT trade_date) n FROM preopen_fno_snapshots")?.n ?? 0;
  const studyDays = one("SELECT COUNT(DISTINCT trade_date) n FROM preopen_study_days")?.n ?? 0;
  const featureRows = one("SELECT COUNT(*) n FROM premarket_features")?.n ?? 0;
  const modelRuns = one("SELECT COUNT(*) n FROM premarket_model_runs")?.n ?? 0;
  const scoreRows = one("SELECT COUNT(*) n FROM premarket_scores")?.n ?? 0;
  const cmRange = one("SELECT MIN(trade_date) a, MAX(trade_date) b FROM preopen_cm_snapshots");
  const fnoRange = one("SELECT MIN(trade_date) a, MAX(trade_date) b FROM preopen_fno_snapshots");
  return {
    cmDays, fnoDays, studyDays, featureRows, modelRuns, scoreRows,
    cmRange: cmRange?.a ? [cmRange.a, cmRange.b] : null,
    fnoRange: fnoRange?.a ? [fnoRange.a, fnoRange.b] : null,
  };
}
