// quant-engine.ts — the UNIVERSAL_QUANT_V1 orchestrator.
//
// ISOLATION: paper/shadow only — no broker orders, no direct Telegram sends
// (every alert goes through enqueueQuantAlert → the persistent outbox; the
// drain lives in quant-alert-queue.ts). Every stage is guarded: a provider
// failure produces a NO_TRADE/WAIT decision (or a {skipped} summary), never a
// throw. All DB writes happen BEFORE alert enqueues so a crash can lose an
// alert (recovered by dedupe on the next cycle) but never a trade/decision row.
//
// Cycle flow:
//   0. disabled → { skipped }             1. market closed → { skipped }
//   2. gather chain/candles/spot/vix (injectable deps, quant-data defaults)
//      → data-quality gate (chain missing/stale AND candles missing →
//      NO_TRADE "data unavailable" + QUANT_DATA_FAILURE)
//   3. computeFeatures → classifyRegime → evaluateStrategies → selectWinner
//   4. no winner → WAIT (conflict) / NO_TRADE → decision log (+ QUANT_NO_TRADE)
//   5. winner → selectContract → rejected → NO_TRADE (rejectionReason)
//   6. buildQuantPlan (ATR-premium stop ≥ noise floor, TP1..TP4 = 1.5/2.5/3.5/4.5R)
//   7. assessRisk (live DB risk state) → blocked → NO_TRADE + QUANT_RISK_BLOCK
//   8. TRADE: SHADOW → decision log + candidate alert; PAPER → simulateEntry
//      → QuantPaperTrade row → QUANT_PAPER_ENTRY + QUANT_TRADE_CANDIDATE

import { db } from "@/lib/db";
import { isTradingDay, getTradingSession } from "@/lib/expiry-liquidity/market-session-config";
import { isExpiryDay } from "@/lib/expiry-calculator";
import {
  getQuantOptionChain,
  getQuantCandles,
  getQuantSpot,
  getQuantVix,
  istDayKey,
  istIso,
} from "./quant-data";
import { QUANT_FLAGS } from "./quant-config";
import { qid, type QuantObservation, type QuantDecision, type QuantPlan, type QuantContractSelection, type QuantFeatures } from "./quant-types";
import { computeFeatures } from "./quant-features";
import { classifyRegime } from "./quant-market-regime";
import { evaluateStrategies } from "./quant-strategy-selector";
import { selectWinner } from "./quant-signal-engine";
import { selectContract } from "./quant-strike-selector";
import { assessRisk } from "./quant-risk-manager";
import { simulateEntry } from "./quant-paper-execution";
import { roundToTick } from "@/lib/symbol-config";
import { enqueueQuantAlert, flushOutbox } from "./quant-alert-queue";
import { isAggregated } from "./quant-alert-policy";
import { getQuantPerformanceFromDb } from "./quant-performance";
import { tickMonitor } from "./quant-position-monitor";
import {
  quantEnabled,
  effectiveMode,
  effectivePaperCapital,
  effectiveSymbols,
  effectiveTuning,
} from "./quant-runtime-config";
import { analyze as readerAnalyze, layerForDirection, type NormChain } from "@/lib/option-chain-reader";
import type { CanonicalOptionChain } from "@/lib/data-layer/chains/option-chain";
import type { Candle } from "@/lib/market/canonical";

const ENGINE_VERSION = "UNIVERSAL_QUANT_V1";
const CANDLE_INTERVAL = "5m";

// ── Injectable deps (tests replace; production uses quant-data wrappers) ──

export interface QuantDeps {
  getChain: (symbol: string) => Promise<{ chain: CanonicalOptionChain | null; observation: QuantObservation }>;
  getCandles: (symbol: string) => Promise<{ candles: Candle[]; observation: QuantObservation }>;
  getSpot: (symbol: string) => Promise<{ spot: number | null; observation: QuantObservation }>;
  getVix: () => Promise<{ value: number | null; change: number | null; observation: QuantObservation }>;
  isExpiryDayFn: (symbol: string) => boolean;
  /** true when nowMs falls on a trading day inside the OPEN/REGULAR session. */
  sessionFn: (nowMs: number) => boolean;
}

function isTradableSession(nowMs?: number): boolean {
  const d = nowMs != null ? new Date(nowMs) : new Date();
  return isTradingDay(d) && (getTradingSession(d) === "OPEN" || getTradingSession(d) === "REGULAR");
}

function defaultDeps(): QuantDeps {
  return {
    getChain: (symbol) => getQuantOptionChain(symbol),
    getCandles: (symbol) => getQuantCandles(symbol, CANDLE_INTERVAL),
    getSpot: (symbol) => getQuantSpot(symbol),
    getVix: () => getQuantVix(),
    isExpiryDayFn: (symbol) => isExpiryDay(symbol),
    sessionFn: (nowMs) => isTradableSession(nowMs),
  };
}

let testDeps: Partial<QuantDeps> | null = null;
/**
 * Sticks true once a cycle ran with per-call `opts.deps`. Production callers
 * never pass deps (only `runQuantCycle({nowMs, symbol})` from tickQuant), so
 * this can never arm in production — it exists because the test suites pass
 * fixtures per-call instead of via __setQuantEngineDepsForTests, and their
 * rows must still be qtest-stamped (otherwise cleanup either misses them or,
 * with a shared prefix, deletes the live engine's rows).
 */
let idScopeTest = false;

export function __setQuantEngineDepsForTests(deps: Partial<QuantDeps> | null): void {
  testDeps = deps;
}

/**
 * Test cycles (testDeps set) stamp every generated id with `qtest_`, and system
 * alert keys with `qtest_sys`, so the suite can find and remove ITS rows.
 * Production ids stay `q_…`: tests and the live engine share one SQLite DB, and
 * the old shared-prefix (`q_`) / shared-day-key cleanup deleted the LIVE
 * engine's paper trades, events, decisions and outbox rows on every `bun test`.
 */
let testIdSeq = 0;
function scopedQid(): string {
  if (!testDeps && !idScopeTest) return qid();
  // No Math.random here — the isolation test forbids it outside qid()
  // (quant-types.ts). A monotonic counter is enough: ids only need to be
  // distinct within one test process.
  return `qtest_${Date.now().toString(36)}_${(++testIdSeq).toString(36)}`;
}

function resolveDeps(): QuantDeps {
  return { ...defaultDeps(), ...(testDeps ?? {}) };
}

// ── Plan builder ─────────────────────────────────────────────────────
//
// Premium-space plan from the option ATR proxy:
//   atrProxy  = max(features.atr14 ?? 0, entry × 0.04)   (never a sub-noise stop)
//   stopLoss  = roundToTick(max(entry − 1.2×atrProxy, entry × 0.80)),
//               floored at 8 ticks below entry
//   riskPoints = entry − stopLoss
//   TP1..TP4  = entry + {1.5, 2.5, 3.5, 4.5} × riskPoints (roundToTick; only
//               kept while rewardRisk ≥ QUANT_FLAGS.minRewardRisk)
//   rewardRisk = (tp1 − entry) / riskPoints
//   trailing: breakeven after TP1, then trail = highWater − 1.0×atrProxy.

/**
 * DEEP-RESEARCH GATE — does the live option-chain structure contradict the
 * chosen direction? Uses the vetted deterministic chain reader (OI walls,
 * writing/buying activity, PCR bias). "against" ⇒ NOT confirmed; an
 * unavailable chain also fails (never alert on an unverified structure).
 */
export function confirmWithChain(
  direction: string | null | undefined,
  chain: CanonicalOptionChain | null,
): { confirmed: boolean; evidence: string } {
  try {
    // Direction first — a non-option signal never needs chain confirmation.
    const dir = direction === "BUY_CE" ? "call" : direction === "BUY_PE" ? "put" : null;
    if (!dir) return { confirmed: true, evidence: "non-option direction — chain confirmation n/a" };
    if (!chain || !Number.isFinite(chain.spot as unknown as number) || !chain.strikes?.length) {
      return { confirmed: false, evidence: "chain unavailable for confirmation" };
    }

    const rows = chain.strikes
      .filter((s) => s && s.strike != null)
      .slice(0, 80)
      .map((s) => ({
        strike: s.strike,
        ce: {
          oi: s.ce?.oi ?? null, oiChange: s.ce?.oiChange ?? null, ltp: s.ce?.ltp ?? null,
          volume: s.ce?.volume ?? null, iv: s.ce?.iv ?? null, delta: s.ce?.delta ?? null,
        },
        pe: {
          oi: s.pe?.oi ?? null, oiChange: s.pe?.oiChange ?? null, ltp: s.pe?.ltp ?? null,
          volume: s.pe?.volume ?? null, iv: s.pe?.iv ?? null, delta: s.pe?.delta ?? null,
        },
      }));
    const norm: NormChain = {
      symbol: chain.underlying,
      spot: chain.spot as number,
      rows,
      derivedChange: false,
    };
    const analysis = readerAnalyze(norm, undefined);
    const layer = layerForDirection(analysis, dir);
    return { confirmed: layer.state !== "against", evidence: `${layer.state} — ${layer.evidence}` };
  } catch (e: any) {
    return { confirmed: false, evidence: `chain confirmation error: ${String(e?.message ?? e).slice(0, 120)}` };
  }
}

export function buildQuantPlan(
  contract: QuantContractSelection,
  features: QuantFeatures,
  minRewardRisk: number = QUANT_FLAGS.minRewardRisk,
): QuantPlan {
  const entry = contract.premium;
  const tick = contract.tickSize && contract.tickSize > 0 ? contract.tickSize : 0.05;
  if (!Number.isFinite(entry) || entry == null || entry <= 0) {
    return {
      entry: null, stopLoss: null, targets: {}, trailingPolicy: null,
      rewardRisk: null, dataQualityScore: null,
    };
  }
  const atrProxy = Math.max(features.atr14 ?? 0, entry * 0.04);
  const rawStop = Math.max(entry - 1.2 * atrProxy, entry * 0.8);
  const stopDistance = Math.max(entry - rawStop, 8 * tick);
  const stopLoss = roundToTick(entry - stopDistance, tick);
  // entry/stopLoss both sit on the tick grid — re-snap their difference so
  // float noise (150 − 133.2 → 16.80000000000001) cannot shrink an exact-2R
  // TP1 below the R:R floor.
  const riskPoints = Math.round((entry - stopLoss) / tick) * tick;
  const targets: QuantPlan["targets"] = {};
  let tp1: number | null = null;
  if (riskPoints > 0) {
    // Reward ladder (user rule): 1:2 / 1:3 / 1:5. The first target defines
    // the trade's R:R — it is never silently dropped. When the floor is above
    // the ladder's first rung the plan carries NO targets at all, so the
    // caller blocks the trade instead of running it without a TP1.
    const tpFor = (multiple: number) => roundToTick(entry + multiple * riskPoints, tick);
    const tp1Price = tpFor(2);
    const tp1R = (tp1Price - entry) / riskPoints;
    // One tick of rounding tolerance on the R comparison (the price is
    // snapped to the tick grid, the ratio is not).
    const rrTolerance = tick / riskPoints;
    if (tp1R >= minRewardRisk - rrTolerance - 1e-9) {
      targets.tp1 = tp1Price;
      targets.tp2 = tpFor(3);
      targets.tp3 = tpFor(5);
      tp1 = tp1Price;
    }
  }
  return {
    entry,
    stopLoss,
    targets,
    trailingPolicy: {
      kind: "BREAKEVEN_TP1_THEN_ATR_TRAIL",
      atrPremium: atrProxy,
      multiple: 1.0,
    },
    rewardRisk: tp1 != null && riskPoints > 0 ? Math.round(((tp1 - entry) / riskPoints) * 1000) / 1000 : null,
    dataQualityScore: null, // set on the trade row from the observation set
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

interface CycleSummary {
  skipped?: string;
  verdict?: "TRADE" | "WAIT" | "NO_TRADE" | "SKIPPED";
  decisionId?: string;
  tradeId?: string;
  alertsQueued?: number;
  blockReason?: string;
  symbol?: string;
  mode?: "SHADOW" | "PAPER";
}

function finiteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 0..1 across the observation set: FRESH=1, STALE=0.5, UNAVAILABLE=0. */
function dataQualityScore(observations: QuantObservation[]): number {
  if (observations.length === 0) return 0;
  const sum = observations.reduce((a, o) => a + (o.quality === "FRESH" ? 1 : o.quality === "STALE" ? 0.5 : 0), 0);
  return Math.round((sum / observations.length) * 100) / 100;
}

function istDayStartMs(nowMs: number): number {
  return Date.parse(`${istDayKey(nowMs)}T00:00:00+05:30`);
}

async function persistDecisionLog(
  decision: QuantDecision,
  winnerStrategy: string | null,
): Promise<void> {
  try {
    await db.quantDecisionLog.create({
      data: {
        id: qid(),
        decisionId: decision.decisionId,
        ts: new Date(Date.parse(decision.ts)),
        symbol: decision.symbol,
        verdict: decision.verdict,
        regime: decision.regime ?? null,
        winnerStrategy,
        blockReason: decision.blockReason ?? null,
        payload: JSON.stringify(decision),
      },
    });
  } catch {
    // never throw — the decision is also carried in the cycle summary
  }
}

async function safeEnqueue(
  input: Parameters<typeof enqueueQuantAlert>[0],
): Promise<number> {
  try {
    // System alerts carry tradeId null → an "NA:" key byte-identical to the
    // live engine's. Stamp test cycles so cleanup/assertions are OUR rows only.
    const stamped =
      (testDeps || idScopeTest) && input.tradeId == null
        ? { ...input, tradeId: "qtest_sys" }
        : input;
    const r = await enqueueQuantAlert(stamped);
    return r.queued ? 1 : 0;
  } catch {
    return 0;
  }
}

async function engineErrorAlert(message: string, nowMs: number): Promise<void> {
  await safeEnqueue({
    type: "QUANT_ENGINE_ERROR",
    tradeId: null,
    occurrence: 0, // daily dedupe — one engine-error alert per IST day
    nowMs,
    payload: { message: message.slice(0, 300), mode: effectiveMode(), eventTime: nowMs },
  });
}

// ── The cycle ────────────────────────────────────────────────────────

export async function runQuantCycle(opts?: {
  nowMs?: number;
  deps?: Partial<QuantDeps>;
  symbol?: string;
}): Promise<CycleSummary> {
  const nowMs = opts?.nowMs ?? Date.now();
  const deps = resolveDeps();
  if (opts?.deps) {
    Object.assign(deps, opts.deps);
    idScopeTest = true; // per-call deps are a test-only seam → stamp ids/keys
  }
  // High-accuracy tuning (runtime file overrides; defaults = baseline flags).
  const tuning = effectiveTuning();

  // 0. Arm switch — nothing written, nothing sent.
  if (!quantEnabled()) return { skipped: "disabled", verdict: "SKIPPED" };

  // 1. Session gate.
  if (!deps.sessionFn(nowMs)) return { skipped: "market-closed" };

  const symbol = opts?.symbol ?? effectiveSymbols()[0];
  const mode = effectiveMode();
  const decisionId = scopedQid();

  try {
    // 2. Gather (all wrappers non-throwing) + data-quality gate.
    const [{ chain, observation: chainObs }, { candles, observation: candlesObs }, spotRes, vixRes] =
      await Promise.all([
        deps.getChain(symbol),
        deps.getCandles(symbol),
        deps.getSpot(symbol),
        deps.getVix(),
      ]);
    const spotObs = spotRes.observation;
    const vixObs = vixRes.observation;
    const provenance: QuantObservation[] = [chainObs, candlesObs, spotObs, vixObs];

    const chainUsable = chain != null && chainObs.quality === "FRESH";
    const candlesUsable = candles.length > 0;
    const decision: QuantDecision = {
      decisionId,
      ts: istIso(nowMs),
      symbol,
      exchange: chainObs.exchange ?? "UNKNOWN",
      regime: "UNCERTAIN",
      signals: [],
      winner: null,
      contract: null,
      plan: null,
      risk: null,
      verdict: "NO_TRADE",
      provenance,
    };

    if (!chainUsable && !candlesUsable) {
      decision.blockReason = "data unavailable";
      await persistDecisionLog(decision, null);
      const queued = await safeEnqueue({
        type: "QUANT_DATA_FAILURE",
        tradeId: null,
        occurrence: 0, // daily dedupe
        nowMs,
        payload: {
          source: "chain+candles",
          detail: `chain ${chainObs.quality.toLowerCase()} and candles ${candlesObs.quality.toLowerCase()} — cycle skipped`,
          symbol,
          exchange: decision.exchange,
          eventTime: nowMs,
        },
      });
      return { verdict: "NO_TRADE", decisionId, blockReason: decision.blockReason, alertsQueued: queued, symbol, mode };
    }

    // 2b. Candle gate — every feature the strategies use is derived from the
    // candle series. Missing, degraded (close-only) or stale candles are NOT
    // substituted: the cycle reports DATA_UNAVAILABLE and takes no decision.
    if (!candlesUsable || candlesObs.quality !== "FRESH") {
      decision.blockReason = `candles unavailable (DATA_UNAVAILABLE) — ${candlesObs.quality.toLowerCase()} from ${candlesObs.source}`;
      await persistDecisionLog(decision, null);
      const queued = await safeEnqueue({
        type: "QUANT_DATA_FAILURE",
        tradeId: null,
        occurrence: 0, // daily dedupe
        nowMs,
        payload: {
          source: `candles:${candlesObs.source}`,
          detail: `${decision.blockReason} — cycle skipped, no decision taken`,
          symbol,
          exchange: decision.exchange,
          eventTime: nowMs,
        },
      });
      return { verdict: "NO_TRADE", decisionId, blockReason: decision.blockReason, alertsQueued: queued, symbol, mode };
    }

    // 3. Features → regime → strategies → winner.
    const spot = finiteNum(spotRes.spot) ? spotRes.spot : chain && finiteNum(chain.spot) ? chain.spot : null;
    const vix = finiteNum(vixRes.value) ? vixRes.value : null;
    const features = computeFeatures({ candles, spot, vix, nowMs });
    const isExpiry = deps.isExpiryDayFn(symbol) === true;
    const regime = classifyRegime(features, { isExpiryDay: isExpiry, symbol });
    decision.regime = regime.regime;
    decision.signals = evaluateStrategies(features, regime, { isExpiryDay: isExpiry, symbol });
    const { winner, conflict } = selectWinner(decision.signals, regime, features, tuning.minScore);

    // 4. No winner — WAIT on a direction conflict, else NO_TRADE.
    if (!winner) {
      decision.verdict = conflict ? "WAIT" : "NO_TRADE";
      decision.blockReason = conflict
        ? conflict
        : decision.signals
            .flatMap((s) => s.rejectionReasons)
            .slice(0, 3)
            .join("; ") || "no eligible strategy signal";
      await persistDecisionLog(decision, null);
      let queued = 0;
      if (isAggregated("QUANT_NO_TRADE")) {
        queued = await safeEnqueue({
          type: "QUANT_NO_TRADE",
          tradeId: null, // occurrence omitted → daily dedupe aggregates
          nowMs,
          payload: {
            mode,
            symbol,
            exchange: decision.exchange,
            regime: regime.regime,
            reasons: decision.blockReason.split("; ").slice(0, 3),
            eventTime: nowMs,
            decisionId,
          },
        });
      }
      return { verdict: decision.verdict, decisionId, blockReason: decision.blockReason, alertsQueued: queued, symbol, mode };
    }

    // 5. Contract selection.
    const contract = selectContract({ symbol, direction: winner.direction, chain, features, nowMs });
    if (contract.rejected) {
      decision.verdict = "NO_TRADE";
      decision.blockReason = contract.rejectionReason ?? "contract selection rejected";
      await persistDecisionLog(decision, null);
      const queued = isAggregated("QUANT_NO_TRADE")
        ? await safeEnqueue({
            type: "QUANT_NO_TRADE",
            tradeId: null,
            nowMs,
            payload: {
              mode, symbol, exchange: decision.exchange, regime: regime.regime,
              reasons: [decision.blockReason], eventTime: nowMs, decisionId,
            },
          })
        : 0;
      return { verdict: "NO_TRADE", decisionId, blockReason: decision.blockReason, alertsQueued: queued, symbol, mode };
    }
    decision.contract = contract;

    // 5b. DEEP-RESEARCH GATE — chain structure must not contradict the direction.
    const chainConfirm = confirmWithChain(winner.direction, chain);
    decision.chainConfirmation = { confirmed: chainConfirm.confirmed, evidence: chainConfirm.evidence };
    if (tuning.requireChainConfirm && !chainConfirm.confirmed) {
      decision.verdict = "WAIT";
      decision.blockReason = `chain confirmation: ${chainConfirm.evidence}`;
      await persistDecisionLog(decision, null);
      const queued = isAggregated("QUANT_NO_TRADE")
        ? await safeEnqueue({
            type: "QUANT_NO_TRADE",
            tradeId: null,
            nowMs,
            payload: {
              mode, symbol, exchange: decision.exchange, regime: regime.regime,
              reasons: [decision.blockReason], eventTime: nowMs, decisionId,
            },
          })
        : 0;
      return { verdict: "WAIT", decisionId, blockReason: decision.blockReason, alertsQueued: queued, symbol, mode };
    }

    // 6. Plan (premium-space stop/targets; trailing policy documented).
    const plan = buildQuantPlan(contract, features, tuning.minRewardRisk);
    decision.plan = plan;

    // 6b. R:R FLOOR — a plan without a full reward ladder (TP1 1:2, TP2 1:3,
    // TP3 1:5) is never traded: the first target defines the trade's R:R.
    if (plan.entry == null || plan.stopLoss == null || plan.rewardRisk == null || plan.targets.tp1 == null) {
      decision.verdict = "NO_TRADE";
      decision.blockReason = `plan R:R below floor ${tuning.minRewardRisk} — no reward ladder`;
      await persistDecisionLog(decision, null);
      const queued = await safeEnqueue({
        type: "QUANT_RISK_BLOCK",
        tradeId: null,
        nowMs,
        payload: {
          mode, symbol, exchange: decision.exchange, strategy: winner.strategy,
          direction: winner.direction, regime: regime.regime,
          reasons: [decision.blockReason], eventTime: nowMs,
        },
      });
      return { verdict: "NO_TRADE", decisionId, blockReason: decision.blockReason, alertsQueued: queued, symbol, mode };
    }

    // 7. Risk — live DB risk state.
    const [openPositions, closedToday, tradesToday, lastLoss] = await Promise.all([
      db.quantPaperTrade.findMany({
        where: { status: { in: ["OPEN", "PARTIALLY_CLOSED"] }, engineVersion: ENGINE_VERSION },
        select: { symbol: true, direction: true },
      }),
      db.quantPaperTrade.findMany({
        where: {
          engineVersion: ENGINE_VERSION,
          status: { startsWith: "CLOSED" },
          exitTime: { gte: new Date(istDayStartMs(nowMs)) },
        },
        select: { realizedPnl: true },
      }),
      db.quantPaperTrade.count({
        where: { engineVersion: ENGINE_VERSION, entryTime: { gte: new Date(istDayStartMs(nowMs)) } },
      }),
      db.quantPaperTrade.findFirst({
        where: { engineVersion: ENGINE_VERSION, status: { startsWith: "CLOSED" }, realizedPnl: { lt: 0 } },
        orderBy: { exitTime: "desc" },
        select: { exitTime: true },
      }),
    ]);
    const todayRealizedPnl = closedToday.reduce((a, r) => a + (finiteNum(r.realizedPnl) ? r.realizedPnl! : 0), 0);
    const risk = assessRisk({
      symbol,
      contract,
      plan: { ...plan, lots: null },
      account: { capital: effectivePaperCapital() },
      openPositions,
      todayRealizedPnl: closedToday.length > 0 ? todayRealizedPnl : null,
      todayTradeCount: tradesToday,
      lastLossAt: lastLoss?.exitTime ? lastLoss.exitTime.getTime() : null,
      nowMs,
      overrides: { maxTradesPerDay: tuning.maxTradesPerDay, maxConcurrentPositions: tuning.maxConcurrentPositions },
    });
    decision.risk = risk;

    if (!risk.passesAll) {
      decision.verdict = "NO_TRADE";
      decision.blockReason = risk.reasons.join("; ") || "risk assessment blocked";
      await persistDecisionLog(decision, null);
      const queued = await safeEnqueue({
        type: "QUANT_RISK_BLOCK",
        tradeId: null,
        nowMs,
        payload: {
          mode, symbol, exchange: decision.exchange, strategy: winner.strategy,
          direction: winner.direction, regime: regime.regime,
          reasons: risk.reasons, eventTime: nowMs,
        },
      });
      return { verdict: "NO_TRADE", decisionId, blockReason: decision.blockReason, alertsQueued: queued, symbol, mode };
    }

    // 8. TRADE verdict — SHADOW logs only; PAPER simulates the fill.
    decision.verdict = "TRADE";

    const candidatePayload = {
      tradeId: null as string | null,
      decisionId,
      mode,
      symbol,
      exchange: decision.exchange,
      strategy: winner.strategy,
      direction: winner.direction,
      regime: regime.regime,
      tradingsymbol: contract.tradingsymbol,
      strike: contract.strike,
      optionType: contract.optionType,
      expiry: contract.expiry,
      lotSize: contract.lotSize,
      lots: risk.lots,
      quantity: risk.quantity,
      entry: plan.entry,
      stopLoss: plan.stopLoss,
      targets: plan.targets,
      riskAmount: risk.riskAmount,
      rewardRisk: plan.rewardRisk,
      estCosts: risk.estCosts,
      eventTime: nowMs,
    };

    if (mode === "SHADOW") {
      await persistDecisionLog(decision, winner.strategy);
      const queued = await safeEnqueue({
        type: "QUANT_TRADE_CANDIDATE",
        tradeId: null, // daily dedupe — one shadow candidate notice per IST day
        nowMs,
        payload: candidatePayload,
      });
      return { verdict: "TRADE", decisionId, alertsQueued: queued, symbol, mode };
    }

    const fill = simulateEntry(contract, { ...plan, lots: risk.lots }, nowMs);
    if (fill.rejected) {
      decision.verdict = "NO_TRADE";
      decision.blockReason = fill.reason;
      await persistDecisionLog(decision, null);
      const queued = isAggregated("QUANT_NO_TRADE")
        ? await safeEnqueue({
            type: "QUANT_NO_TRADE",
            tradeId: null,
            nowMs,
            payload: {
              mode, symbol, exchange: decision.exchange, regime: regime.regime,
              reasons: [fill.reason], eventTime: nowMs, decisionId,
            },
          })
        : 0;
      return { verdict: "NO_TRADE", decisionId, blockReason: fill.reason, alertsQueued: queued, symbol, mode };
    }

    await persistDecisionLog(decision, winner.strategy);
    const tradeId = scopedQid();
    await db.quantPaperTrade.create({
      data: {
        id: qid(),
        tradeId,
        engineVersion: ENGINE_VERSION,
        mode: "PAPER",
        strategy: winner.strategy,
        regime: regime.regime,
        symbol,
        exchange: decision.exchange,
        direction: winner.direction,
        tradingsymbol: contract.tradingsymbol,
        strike: contract.strike,
        optionType: contract.optionType,
        expiry: contract.expiry,
        lotSize: contract.lotSize ?? null,
        lots: risk.lots,
        quantity: fill.quantity,
        entryPrice: fill.fillPrice,
        entryTime: new Date(nowMs),
        stopLoss: plan.stopLoss,
        currentStopLoss: plan.stopLoss,
        tp1: plan.targets.tp1 ?? null,
        tp2: plan.targets.tp2 ?? null,
        tp3: plan.targets.tp3 ?? null,
        tp4: plan.targets.tp4 ?? null,
        // atrProxy from buildQuantPlan (max(atr14, entry×4%)) — the monitor's
        // ATR trail reads this; null → trailing is a documented no-op.
        trailingAtrPremium: plan.trailingPolicy?.atrPremium ?? null,
        status: "OPEN",
        riskAmount: risk.riskAmount,
        maxLossPlanned: risk.maxLoss,
        confidence: winner.score != null ? winner.score / 100 : null,
        dataQuality: dataQualityScore(provenance),
        decisionId,
        provenance: JSON.stringify(provenance),
      },
    });

    let alertsQueued = 0;
    alertsQueued += await safeEnqueue({
      type: "QUANT_PAPER_ENTRY",
      tradeId,
      nowMs,
      payload: {
        tradeId, decisionId, mode: "PAPER", symbol, exchange: decision.exchange,
        strategy: winner.strategy, direction: winner.direction, regime: regime.regime,
        tradingsymbol: contract.tradingsymbol, strike: contract.strike,
        optionType: contract.optionType, expiry: contract.expiry,
        lotSize: contract.lotSize, lots: risk.lots, quantity: fill.quantity,
        fillPrice: fill.fillPrice, stopLoss: plan.stopLoss, targets: plan.targets,
        dataSource: chainObs.source, dataHealth: chainObs.quality, eventTime: nowMs,
      },
    });
    alertsQueued += await safeEnqueue({
      type: "QUANT_TRADE_CANDIDATE",
      tradeId,
      nowMs,
      payload: { ...candidatePayload, tradeId },
    });

    return { verdict: "TRADE", decisionId, tradeId, alertsQueued, symbol, mode };
  } catch (e: any) {
    // A cycle must never throw — record the failure as a decision + alert.
    const message = e?.message ?? String(e);
    try {
      await db.quantDecisionLog.create({
        data: {
          id: qid(),
          decisionId,
          ts: new Date(nowMs),
          symbol,
          verdict: "NO_TRADE",
          regime: null,
          winnerStrategy: null,
          blockReason: `engine error: ${message.slice(0, 200)}`,
          payload: JSON.stringify({ decisionId, ts: istIso(nowMs), symbol, verdict: "NO_TRADE", error: message }),
        },
      });
    } catch {
      // ignore
    }
    await engineErrorAlert(`runQuantCycle failed: ${message}`, nowMs);
    return { verdict: "NO_TRADE", decisionId, blockReason: `engine error: ${message}`, symbol, mode };
  }
}

// ── The tick (cycle + position monitor + daily summary + outbox drain) ──

/**
 * QUANT_DAILY_SUMMARY — enqueued once per IST day, on the first tick at/after
 * 15:30 IST. Idempotency key (tradeId null → "NA:…:<IST-day>") makes repeat
 * ticks dedupe. MUST run BEFORE flushOutbox so the same tick delivers it.
 */
export async function maybeEnqueueDailySummary(
  nowMs: number
): Promise<{ queued: boolean; deduped?: boolean; suppressed?: boolean; reason?: string }> {
  const iso = istIso(nowMs); // "YYYY-MM-DDTHH:mm:ss.mmm+05:30"
  const minutes = Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
  if (minutes < 15 * 60 + 30) return { queued: false, reason: "before-1530-ist" };

  const performance = await getQuantPerformanceFromDb();
  const openPositions = await db.quantPaperTrade.count({
    where: { status: { in: ["OPEN", "PARTIALLY_CLOSED", "PENDING_ENTRY"] } },
  });

  return enqueueQuantAlert({
    type: "QUANT_DAILY_SUMMARY",
    payload: {
      performance,
      openPositions,
      note: "Paper results only — net of modeled costs.",
    },
    // Test cycles stamp the NA key so the suite's row is distinguishable
    // from the live 15:30 summary (both land on the same IST day).
    tradeId: testDeps || idScopeTest ? "qtest_sys" : null,
    nowMs,
  });
}

export async function tickQuant(opts?: { nowMs?: number }): Promise<{
  cycle: any;
  monitor: any;
  outbox: any;
  errors: string[];
}> {
  const nowMs = opts?.nowMs ?? Date.now();
  const errors: string[] = [];
  let cycle: any = null;
  let monitor: any = null;
  let outbox: any = null;

  try {
    // Iterate the configured universe — one cycle per symbol per tick.
    const symbols = effectiveSymbols();
    const summaries: any[] = [];
    for (const sym of symbols) {
      try {
        summaries.push(await runQuantCycle({ nowMs, symbol: sym }));
      } catch (e: any) {
        const message = e?.message ?? String(e);
        errors.push(`runQuantCycle(${sym}): ${message}`);
        await engineErrorAlert(`runQuantCycle(${sym}): ${message}`, nowMs);
      }
    }
    cycle = summaries.length === 1 ? summaries[0] : { verdict: "MULTI", cycles: summaries };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    errors.push(`runQuantCycle: ${message}`);
    await engineErrorAlert(`runQuantCycle: ${message}`, nowMs);
  }
  try {
    monitor = await tickMonitor(nowMs);
  } catch (e: any) {
    const message = e?.message ?? String(e);
    errors.push(`tickMonitor: ${message}`);
    await engineErrorAlert(`tickMonitor: ${message}`, nowMs);
  }
  try {
    await maybeEnqueueDailySummary(nowMs);
  } catch (e: any) {
    const message = e?.message ?? String(e);
    errors.push(`dailySummary: ${message}`);
  }
  try {
    outbox = await flushOutbox(nowMs, { includeTestRows: testDeps != null || idScopeTest });
  } catch (e: any) {
    const message = e?.message ?? String(e);
    errors.push(`flushOutbox: ${message}`);
    await engineErrorAlert(`flushOutbox: ${message}`, nowMs);
  }

  return { cycle, monitor, outbox, errors };
}
