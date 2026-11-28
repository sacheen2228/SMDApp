// ============================================================================
// DAILY DERIVATIVES — HISTORICAL REPLAY / NO-LOOK-AHEAD VALIDATION
//
// Replays the DD trade-decision engine against historical snapshots from the
// market-history archive, enforcing strict no-look-ahead semantics:
//
//   • At each evaluation timestamp t, ONLY data with timestamp <= t is used.
//   • The decision (TAKE / WAIT / NO TRADE) is computed from that point-in-time
//     data using the SAME code path as the live engine (buildStructureOptionPlan
//     + evaluatePlanTrade).
//   • For TAKE decisions, the outcome is determined by looking forward from t:
//     did the option premium hit TP1 before SL, or vice versa?
//   • Results are aggregated per symbol: win rate, expectancy, profit factor,
//     max drawdown, sample size.
//
// READ-ONLY. The DB is opened readonly; nothing here writes, migrates or
// vacuums the live database.
//
// USAGE:
//
//   import { replayDailyDerivatives } from "@/lib/daily-derivatives-replay";
//   const result = await replayDailyDerivatives({
//     symbol: "NIFTY",
//     from: "2026-11-20T09:15:00Z",
//     to: "2026-11-27T15:30:00Z",
//   });
//   console.log(result.summary);
// ============================================================================

import path from "node:path";

interface SqliteHandle {
  all(sql: string, params: any[]): any[];
  get(sql: string, params: any[]): any | undefined;
  close(): void;
}

function openReadonly(dbPath: string): SqliteHandle {
  if (typeof (globalThis as any).Bun !== "undefined") {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    return {
      all: (sql, params) => db.query(sql).all(...(params as any[])) as any[],
      get: (sql, params) => db.query(sql).get(...(params as any[])) as any,
      close: () => db.close(),
    };
  }
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
  const want = process.env.MARKET_HISTORY_DB || path.join(process.cwd(), "db", "market_history.db");
  if (_handle && _handlePath === want) return _handle;
  if (_handle) { try { _handle.close(); } catch { /* ignore */ } }
  _handle = openReadonly(want);
  _handlePath = want;
  return _handle;
}

export function closeReplayDb(): void {
  if (_handle) { try { _handle.close(); } catch { /* ignore */ } }
  _handle = null;
  _handlePath = null;
}

// ============================================================================
// Types
// ============================================================================

export interface ReplayConfig {
  symbol: string;            // "NIFTY" | "SENSEX"
  from: string;              // ISO timestamp, IST session start
  to: string;                // ISO timestamp, IST session close
  evalIntervalSec?: number;  // how often to evaluate (default 300 = 5 min)
  holdWindowSec?: number;    // how long to track a TAKE outcome (default 2h)
  lotSize?: number;          // NIFTY=65, SENSEX=20
  capital?: number;          // default 50000
}

export interface ReplayTrade {
  evalTime: string;          // when the decision was made
  symbol: string;
  optionType: "CE" | "PE";
  strike: number;
  entryPremium: number;
  stopLoss: number;
  targets: number[];
  lots: number;
  deployed: number;
  riskAmount: number;
  rr: number;
  decision: "TAKE" | "WAIT" | "NO TRADE";
  reason: string | null;

  // Outcome (only populated for TAKE):
  outcome: "TP1" | "TP2" | "TP3" | "SL" | "OPEN" | null;
  outcomeTime: string | null;
  exitPremium: number | null;
  pnlR: number | null;       // P&L in R multiples
  pnlRupee: number | null;   // P&L in rupees
  maxFavorableR: number | null;  // best R reached (MFE)
  maxAdverseR: number | null;  // worst R reached (MAE)
}

export interface ReplayResult {
  config: ReplayConfig;
  totalEvaluations: number;
  totalTakes: number;
  totalWaits: number;
  totalNoTrades: number;
  wins: number;
  losses: number;
  opens: number;
  winRate: number;           // wins / (wins + losses)
  expectancyR: number;       // avg R per trade (takes only)
  expectancyRupee: number;   // avg ₹ per trade (takes only)
  profitFactor: number;      // gross wins / gross losses
  maxDrawdownR: number;      // running max drawdown in R
  maxDrawdownRupee: number;  // running max drawdown in ₹
  trades: ReplayTrade[];
  equityCurve: Array<{ time: string; cumulativeR: number; cumulativeRupee: number }>;

  /** EXPERIMENTAL: this replay is a conceptual prototype, NOT a validated backtest.
   *  Win rate, expectancy, profit factor and drawdown are NOT proven historical
   *  performance. See limitations below. */
  experimental: boolean;

  /** Human-readable limitations of this replay engine. */
  limitations: string[];
}

// ============================================================================
// Helpers
// ============================================================================

function num(v: any): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function diff(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return a - b;
}

function parseIsoMs(s: string): number {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

// ============================================================================
// Data access — read-only snapshots from market-history DB
// ============================================================================

interface ChainRow {
  timestamp: string;
  strike: number;
  type: "CE" | "PE";
  ltp: number | null;
  oi: number | null;
  oiChg: number | null;
  iv: number | null;
  volume: number | null;
  delta: number | null;
  spot: number | null;
  source: string | null;
}

function fetchChainRows(handle: SqliteHandle, symbol: string, fromMs: number, toMs: number): ChainRow[] {
  const rows = handle.all(
    `SELECT ct.timestamp, ct.strike, ct.type, ct.ltp, ct.oi, ct.oi_chg, ct.iv,
            ct.volume, ct.delta, ms.spot, ct.source
     FROM chain_ticks ct
     LEFT JOIN market_snapshots ms ON ms.id = ct.snapshot_id
     WHERE ct.symbol = ? AND ct.timestamp >= ? AND ct.timestamp <= ?
     ORDER BY ct.timestamp ASC`,
    [symbol, new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
  ) as any[];
  return rows.map((r: any) => ({
    timestamp: r.timestamp,
    strike: Number(r.strike),
    type: r.type === "CE" ? "CE" : "PE",
    ltp: num(r.ltp),
    oi: num(r.oi),
    oiChg: num(r.oi_chg),
    iv: num(r.iv),
    volume: num(r.volume),
    delta: num(r.delta),
    spot: num(r.spot),
    source: r.source ?? null,
  }));
}

interface SnapRow {
  timestamp: string;
  spot: number | null;
  pcr_oi: number | null;
  india_vix: number | null;
  max_pain: number | null;
}

function fetchSnapshots(handle: SqliteHandle, symbol: string, fromMs: number, toMs: number): SnapRow[] {
  const rows = handle.all(
    `SELECT timestamp, spot, pcr_oi, india_vix, max_pain
     FROM market_snapshots
     WHERE symbol = ? AND timestamp >= ? AND timestamp <= ?
     ORDER BY timestamp ASC`,
    [symbol, new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
  ) as any[];
  return rows.map((r: any) => ({
    timestamp: r.timestamp,
    spot: num(r.spot),
    pcr_oi: num(r.pcr_oi),
    india_vix: num(r.india_vix),
    max_pain: num(r.max_pain),
  }));
}

// ============================================================================
// Snapshot state — what was known at time t
// ============================================================================

interface SnapshotState {
  spot: number | null;
  pcr: number | null;
  indiaVix: number | null;
  maxPain: number | null;
  strikes: Map<number, Map<"CE" | "PE", ChainRow>>;
}

function buildSnapshot(chainRows: ChainRow[], snapRows: SnapRow[], tMs: number): SnapshotState {
  const strikes = new Map<number, Map<"CE" | "PE", ChainRow>>();
  for (const r of chainRows) {
    const t = parseIsoMs(r.timestamp);
    if (!Number.isFinite(t) || t > tMs) continue;
    let byType = strikes.get(r.strike);
    if (!byType) { byType = new Map(); strikes.set(r.strike, byType); }
    const existing = byType.get(r.type);
    if (!existing || parseIsoMs(existing.timestamp) < t) {
      byType.set(r.type, r);
    }
  }

  let spot = null, pcr = null, indiaVix = null, maxPain = null;
  for (let i = snapRows.length - 1; i >= 0; i--) {
    const r = snapRows[i];
    const t = parseIsoMs(r.timestamp);
    if (!Number.isFinite(t) || t > tMs) continue;
    spot = r.spot ?? spot;
    pcr = r.pcr_oi ?? pcr;
    indiaVix = r.india_vix ?? indiaVix;
    maxPain = r.max_pain ?? maxPain;
    break;
  }

  return { spot, pcr, indiaVix, maxPain, strikes };
}

// ============================================================================
// The DD decision logic — same as DailyDerivatives.buildCard, but pure
// ============================================================================

import { buildStructureOptionPlan, type StructureOptionPlanInput } from "@/lib/option-plan";
import { evaluatePlanTrade } from "@/lib/DailyDerivatives";
import { GATE_CONFIG } from "@/lib/agent-brain-gate";
import { PLAN_CONFIG } from "@/lib/option-plan";

function makeStructureInput(state: SnapshotState, strike: number, optionType: "CE" | "PE", lotSize: number, expiry: string, tMs: number): StructureOptionPlanInput | null {
  const byType = state.strikes.get(strike);
  if (!byType) return null;
  const leg = byType.get(optionType);
  if (!leg || !leg.ltp || leg.ltp <= 0) return null;

  // Underlying structure levels from the snapshot: entry = live LTP,
  // stop = 20% below entry (structural default), target = 40% above entry.
  const entryTrigger = state.spot ?? leg.ltp;
  const stop = leg.ltp * 0.8;   // 20% stop below entry
  const target1 = leg.ltp * 1.4; // 2R target above entry

  if (!entryTrigger || !stop || !target1) return null;

  return {
    symbol: configLotSizeSymbol,
    optionType,
    entryPremium: leg.ltp,
    strike,
    expiry,
    lotSize,
    underlying: {
      entry: entryTrigger,
      stop,
      target1,
    },
    deployedAmount: PLAN_CONFIG.defaultDeployedAmount,
    confirmation: {
      ema: true,
      vwapVolume: true,
      atr: true,
      oiChain: leg.oiChg != null ? (optionType === "CE" ? leg.oiChg > 0 : leg.oiChg < 0) : false,
      srLiquidity: true,
      underlyingPremium: leg.delta != null ? Math.abs(leg.delta) >= 0.3 && Math.abs(leg.delta) <= 0.8 : false,
    },
    now: new Date(tMs),
  };
}

// Config values used by makeStructureInput (set from ReplayConfig)
let configLotSize: number;
let configLotSizeSymbol: string;

// ============================================================================
// Main replay engine
// ============================================================================

export async function replayDailyDerivatives(config: ReplayConfig): Promise<ReplayResult> {
  configLotSize = config.lotSize ?? (config.symbol === "SENSEX" ? 20 : 65);
  configLotSizeSymbol = config.symbol;

  const handle = getHandle();
  const fromMs = parseIsoMs(config.from);
  const toMs = parseIsoMs(config.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error(`Invalid from/to timestamps: from=${config.from}, to=${config.to}`);
  }

  const evalIntervalSec = config.evalIntervalSec ?? 300;
  const holdWindowMs = (config.holdWindowSec ?? 7200) * 1000;

  const chainRows = fetchChainRows(handle, config.symbol, fromMs, toMs);
  const snapRows = fetchSnapshots(handle, config.symbol, fromMs, toMs);

  // Build evaluation timestamps: every evalIntervalSec from fromMs to toMs
  const evalTimes: number[] = [];
  for (let t = fromMs; t <= toMs; t += evalIntervalSec * 1000) {
    evalTimes.push(t);
  }

  const trades: ReplayTrade[] = [];
  let cumulativeR = 0;
  let cumulativeRupee = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  let maxDrawdownRupee = 0;
  let wins = 0, losses = 0, opens = 0;

  for (const tMs of evalTimes) {
    const state = buildSnapshot(chainRows, snapRows, tMs);
    if (!state.spot) continue;

    const strikes = Array.from(state.strikes.keys()).sort((a, b) => a - b);
    for (const strike of strikes) {
      for (const optionType of ["CE", "PE"] as const) {
        const expiry = "2026-12-31"; // far future expiry for replay
        const input = makeStructureInput(state, strike, optionType, configLotSize, expiry, tMs);
        if (!input) continue;

        const plan = buildStructureOptionPlan(input);
        if (!plan.ok || !plan.tradable || plan.lots < 1) continue;

        const decision = evaluatePlanTrade({
          optionType,
          tradable: true,
          lots: plan.lots,
          rr: plan.rr,
          entry: plan.entry,
          stopLoss: plan.stopLoss,
          targets: plan.targets,
          marketOpen: true,
          delta: 0.5,
          theta: -2,
          oiChg: 0,
          ema: { trend: "UP", adx: 25, plusDI: 25, minusDI: 15, emaFast: state.spot ?? 0, emaSlow: state.spot ?? 0, atr: state.spot ? state.spot * 0.01 : 0, gapAtr: 0.5 },
          cvdVerdict: "NEUTRAL",
          chop: false,
          chopAssessment: { chop: false, score: 30, reasons: [], rvol: 1 },
          bid: null,
          ask: null,
          chainFreshness: "LIVE",
          candleAgeMs: 300_000,
        });

        if (decision.decision !== "TAKE") continue;

        const outcome = evaluateOutcome(chainRows, strike, optionType, tMs, plan.entry, plan.stopLoss, plan.targets, holdWindowMs, configLotSize);

        const trade: ReplayTrade = {
          evalTime: new Date(tMs).toISOString(),
          symbol: config.symbol,
          optionType,
          strike,
          entryPremium: plan.entry,
          stopLoss: plan.stopLoss,
          targets: plan.targets,
          lots: plan.lots,
          deployed: plan.deployed,
          riskAmount: plan.riskAmount,
          rr: plan.rr,
          decision: "TAKE",
          reason: plan.notes.join(" · "),
          outcome: outcome.outcome,
          outcomeTime: outcome.exitTime,
          exitPremium: outcome.exitPremium,
          pnlR: outcome.pnlR,
          pnlRupee: outcome.pnlRupee,
          maxFavorableR: outcome.maxFavorableR,
          maxAdverseR: outcome.maxAdverseR,
        };
        trades.push(trade);

        if (outcome.pnlR != null) {
          cumulativeR += outcome.pnlR;
          cumulativeRupee += outcome.pnlRupee ?? 0;
          peakR = Math.max(peakR, cumulativeR);
          maxDrawdownR = Math.max(maxDrawdownR, peakR - cumulativeR);
          maxDrawdownRupee = Math.max(maxDrawdownRupee, peakR - cumulativeRupee);

          if (outcome.outcome === "TP1" || outcome.outcome === "TP2" || outcome.outcome === "TP3") wins++;
          else if (outcome.outcome === "SL") losses++;
          else opens++;
        }
      }
    }
  }

  const totalTakes = wins + losses + opens;
  const winRate = (wins + losses) > 0 ? wins / (wins + losses) : 0;
  const expectancyR = (wins + losses) > 0 ? cumulativeR / (wins + losses) : 0;
  const expectancyRupee = (wins + losses) > 0 ? cumulativeRupee / (wins + losses) : 0;
  const grossWins = trades.filter(t => t.pnlR != null && t.pnlR > 0).reduce((s, t) => s + (t.pnlRupee ?? 0), 0);
  const grossLosses = trades.filter(t => t.pnlR != null && t.pnlR < 0).reduce((s, t) => s + Math.abs(t.pnlRupee ?? 0), 0);
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

  const equityCurve = trades
    .filter(t => t.pnlR != null)
    .sort((a, b) => parseIsoMs(a.evalTime) - parseIsoMs(b.evalTime))
    .reduce((acc, t) => {
      const prev = acc[acc.length - 1];
      acc.push({
        time: t.evalTime,
        cumulativeR: (prev ? prev.cumulativeR : 0) + (t.pnlR ?? 0),
        cumulativeRupee: (prev ? prev.cumulativeRupee : 0) + (t.pnlRupee ?? 0),
      });
      return acc;
    }, [] as Array<{ time: string; cumulativeR: number; cumulativeRupee: number }>);

  closeReplayDb();

  return {
    config: configWithDefaults(config),
    totalEvaluations: evalTimes.length,
    totalTakes,
    totalWaits: evalTimes.length - totalTakes,
    totalNoTrades: 0,
    wins,
    losses,
    opens,
    winRate,
    expectancyR,
    expectancyRupee,
    profitFactor,
    maxDrawdownR,
    maxDrawdownRupee,
    trades,
    equityCurve,
    experimental: true,
    limitations: [
      "EXPERIMENTAL prototype — results are NOT validated historical performance.",
      "EMA/ADX/VWAP/candlestick inputs are hardcoded assumptions, not computed from replayed candles.",
      "Seller context and reversal-buyer role inputs are not passed to evaluatePlanTrade.",
      "Close-to-close only — no intra-candle sweep detection; TP/SL ordering within a candle is not modeled.",
      "Far-future expiry (2026-12-31) used for all strikes — time decay/greeks are not realistic.",
      "No bid/ask, spread, slippage, or transaction cost modeling — P&L is overstated relative to real trading.",
      "Hardcoded far-future expiry means Greeks/time-decay are not realistic.",
    ],
  };
}

// ============================================================================
// Outcome evaluation — forward-simulate from evalTime to find TP/SL hit
// ============================================================================

function evaluateOutcome(
  chainRows: ChainRow[],
  strike: number,
  optionType: "CE" | "PE",
  evalTimeMs: number,
  entry: number,
  stopLoss: number,
  targets: number[],
  holdWindowMs: number,
  lotSize: number,
): { outcome: "TP1" | "TP2" | "TP3" | "SL" | "OPEN" | null; exitTime: string | null; exitPremium: number | null; pnlR: number | null; pnlRupee: number | null; maxFavorableR: number | null; maxAdverseR: number | null } {
  const relevant = chainRows.filter(r =>
    r.strike === strike && r.type === optionType && parseIsoMs(r.timestamp) > evalTimeMs &&
    parseIsoMs(r.timestamp) <= evalTimeMs + holdWindowMs
  ).sort((a, b) => parseIsoMs(a.timestamp) - parseIsoMs(b.timestamp));

  if (relevant.length === 0) {
    return { outcome: "OPEN", exitTime: null, exitPremium: null, pnlR: null, pnlRupee: null, maxFavorableR: null, maxAdverseR: null };
  }

  let maxFavorableR: number | null = null;
  let maxAdverseR: number | null = null;
  let exitPremium: number | null = null;
  let exitTime: string | null = null;
  let outcome: "TP1" | "TP2" | "TP3" | "SL" | "OPEN" = "OPEN";

  const risk = entry - stopLoss;
  const sortedTargets = targets.slice().sort((a, b) => a - b);

  for (const r of relevant) {
    const ltp = r.ltp;
    if (ltp == null) continue;

    const isCE = optionType === "CE";
    const pnlPoints = isCE ? (ltp - entry) : (entry - ltp);
    const pnlR = risk > 0 ? pnlPoints / risk : null;

    if (pnlR != null) {
      if (maxFavorableR == null || pnlR > maxFavorableR) maxFavorableR = pnlR;
      if (maxAdverseR == null || pnlR < maxAdverseR) maxAdverseR = pnlR;
    }

    if (outcome === "OPEN") {
      const slHit = isCE ? ltp <= stopLoss : ltp >= stopLoss;
      if (slHit) {
        outcome = "SL";
        exitPremium = ltp;
        exitTime = r.timestamp;
        break;
      }
      for (let i = 0; i < sortedTargets.length; i++) {
        const tpHit = isCE ? ltp >= sortedTargets[i] : ltp <= sortedTargets[i];
        if (tpHit) {
          outcome = (["TP1", "TP2", "TP3"][i]) as "TP1" | "TP2" | "TP3";
          exitPremium = ltp;
          exitTime = r.timestamp;
          break;
        }
      }
      if (outcome !== "OPEN") break;
    }
  }

  let pnlR: number | null = null;
  let pnlRupee: number | null = null;
  const exitPx = exitPremium ?? (relevant.length > 0 ? relevant[relevant.length - 1].ltp : null);
  if (exitPx != null && risk > 0) {
    const exitPnlPoints = isCE ? (exitPx - entry) : (entry - exitPx);
    pnlR = exitPnlPoints / risk;
    pnlRupee = exitPnlPoints * lotSize;
  }

  return { outcome, exitTime, exitPremium, pnlR, pnlRupee, maxFavorableR, maxAdverseR };
}

// ============================================================================
// Config helper
// ============================================================================

function configWithDefaults(config: ReplayConfig): ReplayConfig {
  return {
    symbol: config.symbol,
    from: config.from,
    to: config.to,
    evalIntervalSec: config.evalIntervalSec ?? 300,
    holdWindowSec: config.holdWindowSec ?? 7200,
    lotSize: config.lotSize ?? (config.symbol === "SENSEX" ? 20 : 65),
    capital: config.capital ?? 50_000,
  };
}

// ============================================================================
// Batch replay for multiple symbols/dates
// ============================================================================

export async function replayMultiple(configs: ReplayConfig[]): Promise<ReplayResult[]> {
  const results: ReplayResult[] = [];
  for (const cfg of configs) {
    results.push(await replayDailyDerivatives(cfg));
  }
  closeReplayDb();
  return results;
}
