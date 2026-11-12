// quant-backtest.ts — honest, chronological, NO-look-ahead replay harness for
// UNIVERSAL_QUANT_V1.
//
// ISOLATION: the harness performs NO fetching and NO network. Candles are
// INJECTED (HistoricalCandleSource exists for callers to adapt a provider —
// the harness itself only consumes the supplied series). It never imports the
// candle chain, never sends alerts, never touches broker orders. It reuses the
// engine's own pure pipeline: computeFeatures → classifyRegime →
// evaluateStrategies → selectWinner → buildQuantPlan → assessRisk →
// simulateEntry → evaluateLevels (+ breakeven/trail) → estimateCosts →
// computePerformance.
//
// Chronology guarantee: at step i every decision is built from candles[0..i]
// ONLY (the slice is the cutoff — quant-features' documented caller-owns-the-
// window mode). Entry fills at the decision candle's close (+1 tick slippage
// via simulateEntry); level evaluation begins on the NEXT candle. A decision
// at i therefore never observes candle j > i.
//
// Modes:
//   CHAIN           — a per-step chainProvider supplies a canonical chain and
//                     the real strike-selector gates pick the contract. A
//                     missing/unusable chain records a rejected candidate.
//   UNDERLYING_SIM  — no chainProvider: the underlying close is the premium
//                     proxy. The plan math is identical; spreads, lot-size
//                     constraints and greeks are NOT modeled. BUY_PE decisions
//                     are evaluated on a mirrored series (payoff inversion
//                     around the entry fill: mirrored = 2×fill − underlying) —
//                     a documented linear approximation, no premium model.
//
// Execution policy is the monitor's, unchanged: conservative level ordering
// (SL first), TP1 exits half the remaining quantity, gap-through-SL fills at
// min(ltp, stop), breakeven after TP1 then an ATR trail (when the plan has an
// ATR premium), one open trade at a time. Rows carry GROSS P&L in realizedPnl
// with estCosts separate so computePerformance nets costs exactly once (the
// DB monitor stores net-of-cost realizedPnl — the two conventions must not be
// mixed).

import type { Candle } from "@/lib/market/canonical";
import type { CanonicalOptionChain } from "@/lib/data-layer/chains/option-chain";
import { computeFeatures } from "./quant-features";
import { classifyRegime } from "./quant-market-regime";
import { evaluateStrategies } from "./quant-strategy-selector";
import { selectWinner } from "./quant-signal-engine";
import { selectContract } from "./quant-strike-selector";
import { assessRisk, estimateCosts } from "./quant-risk-manager";
import {
  applyBreakevenAfterTp1,
  applyTrail,
  evaluateLevels,
  simulateEntry,
  statusForStopEvent,
  type QuantExecutionTrade,
  type QuantLevelEvent,
  type QuantObservationTick,
} from "./quant-paper-execution";
import { buildQuantPlan } from "./quant-engine";
import { computePerformance, type QuantPerfRow, type QuantPerformanceResult } from "./quant-performance";
import {
  buildChainAt,
  recordedBarFor,
  DEFAULT_PREMIUM_REPLAY_CONFIG,
  type QuantPremiumReplayConfig,
  type QuantPremiumSeries,
} from "./quant-premium-replay";
import type { QuantContractSelection } from "./quant-types";

// ── Injectable data source (callers adapt providers; the harness never fetches) ──

export type HistoricalCandleSource = (
  symbol: string,
  interval: string,
  from: string,
  to: string,
) => Promise<Array<{
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}>>;

/**
 * Validates + sorts an injected source's output into canonical candles.
 * Non-finite / undated rows are DROPPED (never repaired, never invented) and
 * counted. The harness itself performs no fetching — the source is injected.
 */
export async function loadCandlesForBacktest(
  source: HistoricalCandleSource,
  symbol: string,
  interval: string,
  from: string,
  to: string,
): Promise<{ candles: Candle[]; dropped: number; sourceError: string | null }> {
  try {
    const raw = (await source(symbol, interval, from, to)) ?? [];
    const candles: Candle[] = [];
    let dropped = 0;
    for (const r of raw) {
      const ts = Date.parse(r?.timestamp ?? "");
      const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
      if (!Number.isFinite(ts) || !finite(r.open) || !finite(r.high) || !finite(r.low) || !finite(r.close) || !(r.close > 0)) {
        dropped++;
        continue;
      }
      candles.push({
        timestamp: r.timestamp,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: finite(r.volume) ? r.volume : 0,
      });
    }
    candles.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    return { candles, dropped, sourceError: null };
  } catch (e: any) {
    return { candles: [], dropped: 0, sourceError: e?.message ?? String(e) };
  }
}

// ── Input / output shapes ────────────────────────────────────────────

export interface QuantBacktestOptions {
  /** First candle index eligible for a decision (warmup). Default 60. */
  startIdx?: number;
  /** Paper capital for risk sizing — null/absent → every candidate is risk-blocked. */
  capital?: number | null;
  /** Forced mode; default = chainProvider ? "CHAIN" : "UNDERLYING_SIM". */
  mode?: "UNDERLYING_SIM" | "CHAIN";
  /** MODELED bid/ask half-spread used when a recorded premium has no book. */
  premiumReplay?: QuantPremiumReplayConfig;
  /** Minimum signal score to accept a strategy signal (default = engine default). */
  minScore?: number;
  /** Minimum reward:risk the plan must reach (default = engine default). */
  minRewardRisk?: number;
}

export type QuantBacktestChainProvider = (idx: number) => CanonicalOptionChain | null;

export interface QuantBacktestInput {
  symbol: string;
  candles: Candle[];
  options?: QuantBacktestOptions;
  chainProvider?: QuantBacktestChainProvider;
  /**
   * RECORDED option-premium series (per contract). When present the replay is
   * a premium replay: the chain at each step is rebuilt from the recorded
   * option bars, contract selection runs on real premiums/OI, and exits are
   * evaluated on the contract's OWN recorded bars — never on underlying
   * prices. A missing recorded bar means "no observation" (no hit claimed).
   */
  premiumSeries?: QuantPremiumSeries[];
}

export interface QuantBacktestDecision {
  idx: number;
  ts: string;
  regime: string;
  regimeConfidence: number | null;
  winner: string | null;
  direction: string | null;
  score: number | null;
  verdict: "TRADE" | "WAIT" | "NO_TRADE";
  blockReason: string | null;
  instrument: "UNDERLYING_SIM" | "CHAIN";
  entry?: number;
  stopLoss?: number;
  tp1?: number | null;
  lots?: number;
}

export interface QuantBacktestRejected {
  idx: number;
  ts: string;
  stage:
    | "insufficient_data"
    | "chain_unavailable"
    | "contract_rejected"
    | "plan_rejected"
    | "risk_blocked"
    | "entry_rejected";
  reason: string;
}

export interface QuantBacktestTrade {
  tradeId: string;
  idx: number; // entry candle index
  entryTs: string;
  exitIdx: number | null;
  exitTs: string | null;
  instrument: "UNDERLYING_SIM" | "CHAIN";
  strategy: string;
  direction: string;
  regime: string;
  tradingsymbol: string | null;
  strike: number | null;
  optionType: "CE" | "PE" | null;
  expiry: string | null;
  lotSize: number | null;
  lots: number;
  quantity: number;
  entryPrice: number;
  stopLoss: number; // initial planned stop
  currentStopLoss: number; // stop at close (trail state)
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  tp4: number | null;
  tpHitLevel: string | null;
  status: string; // CLOSED_* | OPEN_SIM (still open at series end)
  exitPrice: number | null;
  exitReason: string | null;
  trailingHighWater: number | null;
  trailingAtrPremium: number | null;
  /** Σ per-exit (fill − entry)×qty — gross, before costs */
  grossPnl: number;
  estCosts: number;
  netPnl: number;
  /** = grossPnl — computePerformance convention (estCosts separate). */
  realizedPnl: number;
  events: string[];
}

export interface QuantBacktestResult {
  symbol: string;
  totalCandles: number;
  startIdx: number;
  capital: number | null;
  instrument: "UNDERLYING_SIM" | "CHAIN";
  /**
   * Where the option premium came from:
   *   RECORDED — real exchange option prices (per-contract bars) drive
   *              selection, entry and exits.
   *   MODELED  — the premium is the underlying close (proxy) — NOT executable
   *              performance.
   */
  premiumSource: "RECORDED" | "MODELED";
  decisions: QuantBacktestDecision[];
  trades: QuantBacktestTrade[];
  rejected: QuantBacktestRejected[];
  performance: QuantPerformanceResult;
  openAtEnd: number;
  notes: string[];
}

// ── Internals ────────────────────────────────────────────────────────

const STOP_EVENT_TYPES = new Set(["SL_HIT", "GAP_THROUGH_SL", "TRAILING_SL_HIT", "BREAKEVEN_SL_HIT"]);
const MIN_DECISION_CANDLES = 50; // ema50 (regime) + atr14 (plan) warmup

interface OpenSim {
  trade: QuantBacktestTrade;
  exec: QuantExecutionTrade;
  gross: number;
  costs: number;
}

/**
 * The observation the position model sees for one candle. BUY_CE reads the
 * underlying series directly; BUY_PE reads a series mirrored around the entry
 * fill (premium-proxy payoff inversion — documented approximation).
 */
function observationFor(direction: string, fillPrice: number, c: Candle): QuantObservationTick {
  const ts = Date.parse(c.timestamp);
  if (direction === "BUY_PE") {
    return { ltp: 2 * fillPrice - c.close, high: 2 * fillPrice - c.low, low: 2 * fillPrice - c.high, ts };
  }
  return { ltp: c.close, high: c.high, low: c.low, ts };
}

function underlyingSimContract(symbol: string, c: Candle, direction: string): QuantContractSelection {
  return {
    tradingsymbol: `${symbol.toUpperCase()}-UNDERLYING-SIM`,
    strike: null,
    optionType: direction === "BUY_CE" ? "CE" : direction === "BUY_PE" ? "PE" : null,
    expiry: null,
    lotSize: 1,
    tickSize: 0.05,
    premium: c.close,
    bid: c.close,
    ask: c.close,
    spreadPct: 0,
    iv: null,
    delta: null,
    theta: null,
    oi: null,
    selectionReasons: [
      "underlying-sim: premium proxy = underlying close — spreads, lot-size constraints and greeks are not modeled in this mode",
    ],
  };
}

/**
 * The observation a premium replay uses for an OPEN trade: the contract's own
 * RECORDED option bar (close/high/low). Null when the contract has no recorded
 * bar at this timestamp — the caller then records "no observation" instead of
 * substituting an underlying price.
 */
function premiumObservationFor(
  seriesList: QuantPremiumSeries[],
  tradingsymbol: string | null,
  expiry: string | null,
  strike: number | null,
  ts: string,
): QuantObservationTick | null {
  const bar = recordedBarFor(seriesList, tradingsymbol ?? "", expiry, strike, ts);
  if (!bar) return null;
  return { ltp: bar.close, high: bar.high, low: bar.low, ts: Date.parse(ts) };
}

// ── The replay ───────────────────────────────────────────────────────

export function runQuantBacktest(input: QuantBacktestInput): QuantBacktestResult {
  const symbol = input.symbol;
  const candles = input.candles ?? [];
  const startIdx = Math.max(0, Math.min(input.options?.startIdx ?? 60, candles.length));
  const capital = typeof input.options?.capital === "number" && Number.isFinite(input.options.capital) && input.options.capital > 0
    ? input.options.capital
    : null;
  const premiumSeries = input.premiumSeries ?? [];
  const useRecordedPremium = premiumSeries.length > 0;
  const premiumCfg = input.options?.premiumReplay ?? DEFAULT_PREMIUM_REPLAY_CONFIG;
  const instrument: "UNDERLYING_SIM" | "CHAIN" =
    useRecordedPremium || input.options?.mode === "CHAIN" || (input.options?.mode == null && input.chainProvider != null)
      ? "CHAIN"
      : "UNDERLYING_SIM";

  const decisions: QuantBacktestDecision[] = [];
  const rejected: QuantBacktestRejected[] = [];
  const trades: QuantBacktestTrade[] = [];
  const notes: string[] = [];

  let open: OpenSim | null = null;

  const closeOpenTrade = (stopType: QuantLevelEvent["type"] | null, exitIdx: number, exitTs: string) => {
    const t = open!.trade;
    const exec = open!.exec;
    t.status = stopType != null ? statusForStopEvent(stopType) : "CLOSED_TP";
    t.exitIdx = exitIdx;
    t.exitTs = exitTs;
    t.tpHitLevel = exec.tpHitLevel;
    t.currentStopLoss = exec.stopLoss;
    t.trailingHighWater = exec.highestSinceTp1;
    t.grossPnl = Math.round(open!.gross * 100) / 100;
    t.estCosts = Math.round(open!.costs * 100) / 100;
    t.netPnl = Math.round((open!.gross - open!.costs) * 100) / 100;
    t.realizedPnl = t.grossPnl;
    trades.push(t);
    open = null;
  };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // 1. Manage the open position first — one trade at a time, and while a
    //    position is open no new decisions are evaluated.
    if (open != null) {
      const exec = open.exec;
      // Premium replay: the observation is the contract's OWN recorded bar.
      // Underlying-sim: the underlying series is the premium proxy.
      const observation = useRecordedPremium
        ? premiumObservationFor(premiumSeries, open.trade.tradingsymbol, open.trade.expiry, open.trade.strike, c.timestamp)
        : observationFor(open.trade.direction, open.trade.entryPrice, c);
      if (observation == null) {
        rejected.push({
          idx: i,
          ts: c.timestamp,
          stage: "insufficient_data",
          reason: `no recorded option bar for ${open.trade.tradingsymbol ?? "contract"} at this step — no hit claimed`,
        });
        continue;
      }
      const events = evaluateLevels({ trade: exec, observation });

      let lastExit: { price: number; ts: number; type: string } | null = null;
      let stopType: QuantLevelEvent["type"] | null = null;
      for (const ev of events) {
        open.gross += (ev.fillPrice - exec.entryPrice) * ev.quantityExited;
        open.costs += estimateCosts(exec.entryPrice, ev.fillPrice, 1, ev.quantityExited);
        open.trade.events.push(ev.type);
        if (ev.type === "TP1_HIT") {
          exec.tp1Hit = true;
          exec.tpHitLevel = "TP1";
        } else if (ev.type.startsWith("TP")) {
          exec.tpHitLevel = ev.type.replace("_HIT", "");
        }
        exec.remainingQuantity = ev.remainingQuantity;
        lastExit = { price: ev.fillPrice, ts: ev.ts, type: ev.type };
        if (STOP_EVENT_TYPES.has(ev.type)) {
          stopType = ev.type;
          exec.remainingQuantity = 0;
          break; // conservative: the stop ends the trade
        }
      }

      // Breakeven after TP1, then the ATR trail (same policy as the monitor).
      if (exec.tp1Hit && exec.remainingQuantity > 0) {
        open.exec = applyTrail(applyBreakevenAfterTp1(exec), observation);
      }

      if (open.exec.remainingQuantity <= 0 && lastExit != null) {
        open.trade.exitPrice = lastExit.price;
        open.trade.exitReason = lastExit.type;
        closeOpenTrade(stopType, i, c.timestamp);
      }
      continue;
    }

    // 2. Warmup window — not a decision step.
    if (i < startIdx) continue;

    // 3. Data-quality gate — insufficient candles are recorded, never traded.
    if (i + 1 < MIN_DECISION_CANDLES) {
      rejected.push({
        idx: i,
        ts: c.timestamp,
        stage: "insufficient_data",
        reason: `only ${i + 1} candles at this step — need ≥ ${MIN_DECISION_CANDLES} for ema50/atr14 features`,
      });
      continue;
    }

    // 4. Decision pipeline on candles[0..i] ONLY — no look-ahead.
    const window = candles.slice(0, i + 1);
    const features = computeFeatures({ candles: window });
    const regime = classifyRegime(features, { isExpiryDay: false, symbol });
    const signals = evaluateStrategies(features, regime, { isExpiryDay: false, symbol });
    const { winner, conflict } = selectWinner(signals, regime, features, input.options?.minScore);

    if (!winner) {
      decisions.push({
        idx: i,
        ts: c.timestamp,
        regime: regime.regime,
        regimeConfidence: regime.confidence,
        winner: null,
        direction: null,
        score: null,
        verdict: conflict ? "WAIT" : "NO_TRADE",
        blockReason: conflict ?? (signals.flatMap((s) => s.rejectionReasons).slice(0, 3).join("; ") || "no eligible strategy signal"),
        instrument,
      });
      continue;
    }

    // 5. Contract.
    let contract: QuantContractSelection;
    if (useRecordedPremium) {
      // Chain rebuilt from the RECORDED option bars of this very step.
      const chain = buildChainAt(premiumSeries, c.timestamp, c.close, premiumCfg);
      if (!chain) {
        rejected.push({ idx: i, ts: c.timestamp, stage: "chain_unavailable", reason: "no recorded option bar for any contract at this step" });
        continue;
      }
      contract = selectContract({ symbol, direction: winner.direction, chain, features, nowMs: Date.parse(c.timestamp) });
    } else if (instrument === "CHAIN") {
      const chain = input.chainProvider?.(i) ?? null;
      if (!chain) {
        rejected.push({ idx: i, ts: c.timestamp, stage: "chain_unavailable", reason: "chainProvider returned no chain at this step" });
        continue;
      }
      contract = selectContract({ symbol, direction: winner.direction, chain, features, nowMs: Date.parse(c.timestamp) });
    } else {
      contract = underlyingSimContract(symbol, c, winner.direction);
    }
    if (contract.rejected) {
      rejected.push({ idx: i, ts: c.timestamp, stage: "contract_rejected", reason: contract.rejectionReason ?? "contract selection rejected" });
      continue;
    }

    // 6. Plan (same builder as the live engine).
    const plan = buildQuantPlan(contract, features);
    if (plan.entry == null || plan.stopLoss == null || !(plan.entry > 0) || !(plan.stopLoss > 0)) {
      rejected.push({ idx: i, ts: c.timestamp, stage: "plan_rejected", reason: "plan has no usable entry/stop" });
      continue;
    }

    // 7. Risk sizing (single-position book — the one-at-a-time rule is
    //    structural; daily caps/cooldown are not simulated here).
    const risk = assessRisk({
      symbol,
      contract,
      plan: { ...plan, lots: null },
      account: { capital },
      openPositions: [],
      todayRealizedPnl: null,
      todayTradeCount: 0,
      lastLossAt: null,
      nowMs: null,
    });
    if (!risk.passesAll || risk.lots < 1) {
      rejected.push({ idx: i, ts: c.timestamp, stage: "risk_blocked", reason: risk.reasons.join("; ") || "risk assessment blocked" });
      continue;
    }

    // 8. Entry fill at the decision candle's close (+1 tick slippage).
    const fill = simulateEntry(contract, { ...plan, lots: risk.lots }, Date.parse(c.timestamp));
    if (fill.rejected) {
      rejected.push({ idx: i, ts: c.timestamp, stage: "entry_rejected", reason: fill.reason });
      continue;
    }

    const trade: QuantBacktestTrade = {
      tradeId: `${symbol}:BT:${i}`,
      idx: i,
      entryTs: c.timestamp,
      exitIdx: null,
      exitTs: null,
      instrument,
      strategy: winner.strategy,
      direction: winner.direction,
      regime: regime.regime,
      tradingsymbol: contract.tradingsymbol,
      strike: contract.strike,
      optionType: contract.optionType,
      expiry: contract.expiry,
      lotSize: contract.lotSize,
      lots: risk.lots,
      quantity: fill.quantity,
      entryPrice: fill.fillPrice,
      stopLoss: plan.stopLoss,
      currentStopLoss: plan.stopLoss,
      tp1: plan.targets.tp1 ?? null,
      tp2: plan.targets.tp2 ?? null,
      tp3: plan.targets.tp3 ?? null,
      tp4: plan.targets.tp4 ?? null,
      tpHitLevel: null,
      status: "OPEN_SIM",
      exitPrice: null,
      exitReason: null,
      trailingHighWater: null,
      trailingAtrPremium: plan.trailingPolicy?.atrPremium ?? null,
      grossPnl: 0,
      estCosts: 0,
      netPnl: 0,
      realizedPnl: 0,
      events: [],
    };
    decisions.push({
      idx: i,
      ts: c.timestamp,
      regime: regime.regime,
      regimeConfidence: regime.confidence,
      winner: winner.strategy,
      direction: winner.direction,
      score: winner.score,
      verdict: "TRADE",
      blockReason: null,
      instrument,
      entry: fill.fillPrice,
      stopLoss: plan.stopLoss,
      tp1: plan.targets.tp1 ?? null,
      lots: risk.lots,
    });

    const exec: QuantExecutionTrade = {
      tradeId: trade.tradeId,
      direction: (winner.direction as QuantExecutionTrade["direction"]) ?? "BUY",
      entryPrice: fill.fillPrice,
      stopLoss: plan.stopLoss,
      initialStopLoss: plan.stopLoss,
      targets: { tp1: plan.targets.tp1 ?? null, tp2: plan.targets.tp2 ?? null, tp3: plan.targets.tp3 ?? null, tp4: plan.targets.tp4 ?? null },
      quantity: fill.quantity,
      remainingQuantity: fill.quantity,
      tp1Hit: false,
      tpHitLevel: null,
      highestSinceTp1: null,
      breakevenArmed: false,
      atrPremium: plan.trailingPolicy?.atrPremium ?? null,
    };
    open = { trade, exec, gross: 0, costs: 0 };
  }

  // Trades still open at series end — the normal end-of-series path. They
  // stay OPEN_SIM and are excluded from performance.
  const openAtEnd = trades.filter((t) => !t.status.startsWith("CLOSED")).length + (open != null ? 1 : 0);
  if (open != null) {
    open.trade.status = "OPEN_SIM";
    trades.push(open.trade);
    open = null;
  }

  // ── Performance through the SAME computePerformance as the engine ──
  const perfRows: QuantPerfRow[] = trades
    .filter((t) => t.status.startsWith("CLOSED"))
    .map((t) => ({
      status: t.status,
      strategy: t.strategy,
      regime: t.regime,
      mode: "PAPER",
      realizedPnl: t.grossPnl,
      estCosts: t.estCosts,
      entryTime: new Date(Date.parse(t.entryTs)),
      exitTime: t.exitTs != null ? new Date(Date.parse(t.exitTs)) : null,
      stopLoss: t.stopLoss,
      tp1: t.tp1,
      tp2: t.tp2,
      tp3: t.tp3,
      tp4: t.tp4,
      tpHitLevel: t.tpHitLevel,
      lots: t.lots,
      quantity: t.quantity,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
    }));
  const performance = computePerformance(perfRows);

  // ── Honest notes ──────────────────────────────────────────────────
  notes.push(
    "chronological replay: the decision at step i is built from candles[0..i] only — entry fills at that candle's close (+1 tick slippage) and level evaluation begins on the NEXT candle",
  );
  notes.push(
    "isExpiryDay is false for every step (the harness has no expiry calendar) — EXPIRY_MOMENTUM never fires here",
  );
  notes.push(
    "one open trade at a time; while a position is open no new decisions are evaluated; portfolio-level daily loss cap, cooldown and trades-per-day caps are not simulated (risk sizing runs on an empty book)",
  );
  if (useRecordedPremium) {
    notes.push(
      "PREMIUM REPLAY (recorded): contract selection, entry premium and exits use the contracts' OWN recorded option bars (exchange OHLC/volume/OI) — no premium was synthesized",
    );
    notes.push(
      `MODELED: bid/ask around the recorded close = ±${(premiumCfg.spreadModelPct * 100).toFixed(2)}% per side (the historical feed carries no book); entry fills at the modeled ask + 1 tick, target fills at the target level, stop fills at min(ltp, stop)`,
    );
    notes.push(
      "no recorded option bar at a step = no observation: the step records 'insufficient_data' and no hit is claimed (the underlying price is never substituted for a premium)",
    );
  } else if (instrument === "UNDERLYING_SIM") {
    notes.push(
      "underlying-sim mode: option premium dynamics approximated on the underlying; spreads/lot constraints not modeled (chainProvider absent)",
    );
    notes.push(
      "underlying-sim mode: BUY_PE decisions are evaluated on a mirrored series (payoff inversion around the entry fill: mirrored = 2×fill − underlying) — a linear approximation, no premium model",
    );
  } else {
    notes.push(
      "chain mode: the real strike-selector gates run against the injected chain; a missing chain at a step records a rejected candidate (chain_unavailable)",
    );
    notes.push(
      "chain mode: the harness assumes the injected chain quotes track the injected candle series — it does not verify premium/underlying consistency",
    );
  }
  notes.push(
    "costs use the engine's estimateCosts model per exit (brokerage ₹40 round trip, STT 0.1% sell, slippage 0.05%/side); rows carry GROSS P&L in realizedPnl with estCosts separate so computePerformance nets costs exactly once — the DB monitor stores net-of-cost realizedPnl, do not mix the conventions",
  );
  notes.push(
    "level evaluation uses the monitor's conservative policy: SL before TPs, TP1 exits half the remaining quantity, a gap through the stop fills at min(ltp, stop)",
  );
  if (openAtEnd > 0) {
    notes.push(`${openAtEnd} trade(s) still open at series end — recorded with status OPEN_SIM and excluded from performance`);
  }
  if (capital == null) {
    notes.push("no capital configured — every candidate was risk-blocked (capital is never assumed)");
  }

  return {
    symbol,
    totalCandles: candles.length,
    startIdx,
    capital,
    instrument,
    premiumSource: useRecordedPremium ? "RECORDED" : "MODELED",
    decisions,
    trades,
    rejected,
    performance,
    openAtEnd,
    notes,
  };
}
