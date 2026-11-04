// Market Mechanism Detection — Phase C ADD of Unified Intraday Intelligence Engine
//
// Detects market mechanism states from observed facts + existing indicator
// and SMC evidence. Research-only: produces a mechanism classification and
// confidence score that feeds the BUY CE / BUY PE / WAIT coordinator.
//
// Does NOT create a trading engine. Does NOT modify production strategies,
// execution, risk management or Telegram. Reuses existing DTR, SMC, indicator
// and option-chain modules — no duplicated calculations.
//
// States:
//   1. trend_expansion      — directional expansion (trending)
//   2. balance_consolidation — range-bound / balance
//   3. breakout_acceptance   — breakout with acceptance (above/below value)
//   4. liquidity_sweep       — stop hunt / liquidity sweep (needs rejection)
//   5. absorption_auction    — failed auction / absorption (needs volume)
//   6. trend_exhaustion      — trend losing momentum
//   7. reversal_transition   — structural transition / reversal
//   8. high_volatility       — news-driven / high-vol movement
//
// Observed facts (measured) vs inferred mechanisms (interpreted) are kept
// separate. No institutional buying/selling is claimed from OI alone. No
// liquidity sweep is claimed without subsequent rejection/confirmation.
// No absorption is claimed without volume+price evidence.

import type { Candle } from "@/types/engine";
import type { IndicatorBundle } from "./indicators";
import type { SmcRead } from "./smc";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type MarketMechanism =
  | "trend_expansion"
  | "balance_consolidation"
  | "breakout_acceptance"
  | "liquidity_sweep"
  | "absorption_auction"
  | "trend_exhaustion"
  | "reversal_transition"
  | "high_volatility";

export type ControlSide = "bullish" | "bearish" | "neutral";

export type ConfirmationStatus = "CONFIRMED" | "PARTIAL" | "UNCONFIRMED" | "WAIT";

export interface MechanismRead {
  mechanism: MarketMechanism;
  regime: string;
  control: ControlSide;
  confidence: number; // 0-100, not a probability
  confirmationStatus: ConfirmationStatus;
  observedFacts: string[]; // directly measured
  inferredMechanisms: string[]; // interpreted from facts
  conflictingEvidence: string[];
  keyLevels: {
    support: number[];
    resistance: number[];
    invalidation: number | null;
  };
  dtrUtilization: number | null;
  remainingRange: number | null;
  timestamp: string;
  freshness: "LIVE" | "FRESH" | "DELAYED" | "STALE" | "UNAVAILABLE";
  sufficientData: boolean;
  reason: string | null;
  /** Recommended coordinator action: BUY_CE | BUY_PE | WAIT */
  coordinatorAction: "BUY_CE" | "BUY_PE" | "WAIT";
}

export interface MechanismContext {
  optionChain?: {
    pcr: number | null;
    callOiChange: number | null;
    putOiChange: number | null;
    iv: number | null;
    ivPctChange: number | null;
  };
  indiaVix?: number | null;
  sectorBreadth?: { advancing: number; declining: number; unchanged: number } | null;
  lastCandleTs?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function freshnessFromAge(ageMs: number | null): MechanismRead["freshness"] {
  if (ageMs == null) return "UNAVAILABLE";
  if (ageMs <= 30_000) return "LIVE";
  if (ageMs <= 300_000) return "FRESH";
  if (ageMs <= 900_000) return "DELAYED";
  return "STALE";
}

function insufficient(reason: string): MechanismRead {
  return {
    mechanism: "balance_consolidation",
    regime: "UNKNOWN",
    control: "neutral",
    confidence: 0,
    confirmationStatus: "WAIT",
    observedFacts: [],
    inferredMechanisms: [],
    conflictingEvidence: [],
    keyLevels: { support: [], resistance: [], invalidation: null },
    dtrUtilization: null,
    remainingRange: null,
    timestamp: new Date().toISOString(),
    freshness: "UNAVAILABLE",
    sufficientData: false,
    reason,
    coordinatorAction: "WAIT",
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Main mechanism detection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Detect the current market mechanism from indicators + SMC + context.
 *
 * @param symbol — trading symbol
 * @param indicatorBundle — Unified Engine indicator bundle (Phase B)
 * @param smcRead — SMC research read (Phase C)
 * @param context — optional context (option chain, India VIX, sector breadth, last candle ts)
 */
export function detectMarketMechanism(
  symbol: string,
  indicatorBundle: IndicatorBundle,
  smcRead: SmcRead,
  context: MechanismContext = {},
): MechanismRead {
  const { optionChain, indiaVix, sectorBreadth, lastCandleTs } = context;
  const ts = lastCandleTs ?? indicatorBundle.lastCandleTs ?? null;
  const freshness = freshnessFromAge(ts ? Date.now() - ts : null);

  const insufficientData = (reason: string): MechanismRead => ({
    ...insufficient(reason),
    freshness,
    timestamp: new Date().toISOString(),
  });

  const lastPrice =
    indicatorBundle.vwap.value?.vwap ?? 0; // fallback

  // ── Gather observed facts (measured, not inferred) ──
  const observedFacts: string[] = [];
  const inferredMechanisms: string[] = [];
  const conflictingEvidence: string[] = [];

  // DTR facts
  const dtrVal = indicatorBundle.dtr.value;
  const dtrUtil = dtrVal?.dtrUtilization ?? null;
  const remainingRange = dtrVal?.remainingRangePct ?? null;
  if (indicatorBundle.dtr.sufficientData && dtrVal) {
    observedFacts.push(
      `DTR ₹${dtrVal.dtr?.toFixed(2) ?? "?"} | utilization ${(dtrUtil ?? 0).toFixed(0)}% | remaining range ${(remainingRange ?? 0).toFixed(0)}%`,
    );
  } else {
    observedFacts.push("DTR: insufficient data");
  }

  // ATR/volatility facts
  const atrVal = indicatorBundle.atr.value;
  if (indicatorBundle.atr.sufficientData && atrVal) {
    observedFacts.push(
      `ATR(14) ₹${atrVal.atr.toFixed(2)} (${atrVal.atrPct.toFixed(1)}% of price, regime: ${atrVal.regime})`,
    );
  }

  // VWAP facts
  const vwapVal = indicatorBundle.vwap.value;
  if (indicatorBundle.vwap.sufficientData && vwapVal) {
    observedFacts.push(
      `Price ${vwapVal.deviationPct > 0 ? "above" : "below"} VWAP by ${Math.abs(vwapVal.deviationPct).toFixed(1)}%`,
    );
  }

  // ADX trend strength (fact)
  const adxVal = indicatorBundle.adx.value;
  if (indicatorBundle.adx.sufficientData && adxVal) {
    observedFacts.push(
      `ADX(14) ${adxVal.adx.toFixed(0)} — ${adxVal.trend}`,
    );
  }

  // RVOL (fact)
  const rvolVal = indicatorBundle.rvol.value;
  if (indicatorBundle.rvol.sufficientData && rvolVal) {
    observedFacts.push(`RVOL ${rvolVal.ratio.toFixed(1)}x`);
  }

  // Market structure facts
  if (smcRead.sufficientData) {
    observedFacts.push(
      `SMC structure: ${smcRead.structure} (confidence ${smcRead.confidence}%)`,
    );
    const msVal = indicatorBundle.marketStructure.value;
    if (msVal) {
      observedFacts.push(`Market structure trend: ${msVal.currentTrend}`);
      if (msVal.bosEvents.length) {
        observedFacts.push(`BOS events: ${msVal.bosEvents.join(", ")}`);
      }
      if (msVal.chochEvents.length) {
        observedFacts.push(`CHOCH events: ${msVal.chochEvents.join(", ")}`);
      }
    }
  }

  // Option chain facts (observed only — never institutional inference)
  if (optionChain) {
    if (optionChain.pcr != null) {
      observedFacts.push(`PCR ${optionChain.pcr.toFixed(2)}`);
    }
    if (optionChain.callOiChange != null || optionChain.putOiChange != null) {
      observedFacts.push(
        `OI change: CE ${optionChain.callOiChange ?? 0} | PE ${optionChain.putOiChange ?? 0}`,
      );
    }
    if (optionChain.iv != null) {
      observedFacts.push(`IV ${optionChain.iv.toFixed(1)}%`);
    }
  }

  // India VIX (fact)
  if (indiaVix != null) {
    observedFacts.push(`India VIX ${indiaVix.toFixed(1)}`);
  }

  // Sector breadth (fact)
  if (sectorBreadth) {
    const total = sectorBreadth.advancing + sectorBreadth.declining + sectorBreadth.unchanged;
    const pctAdv = total > 0 ? (sectorBreadth.advancing / total) * 100 : 50;
    observedFacts.push(`Sector breadth: ${pctAdv.toFixed(0)}% advancing`);
  }

  // ── Mechanism detection (inference from observed facts) ──
  let mechanism: MarketMechanism = "balance_consolidation";
  let control: ControlSide = "neutral";
  let confidence = 30;
  let confirmationStatus: ConfirmationStatus = "UNCONFIRMED";
  const supportLevels: number[] = [];
  const resistanceLevels: number[] = [];
  let invalidation: number | null = null;
  let coordinatorAction: "BUY_CE" | "BUY_PE" | "WAIT" = "WAIT";

  // Rule 1: High volatility (takes priority when VIX elevated or ATR extreme)
  const vixHigh = (indiaVix ?? 0) > 22;
  const atrExtreme = atrVal?.regime === "extreme";
  if (vixHigh || atrExtreme) {
    inferredMechanisms.push("High-volatility regime detected (elevated VIX or extreme ATR)");
    mechanism = "high_volatility";
    control = "neutral";
    confidence = 70;
    confirmationStatus = "CONFIRMED";
    coordinatorAction = "WAIT";
  }

  // Rule 2: Liquidity sweep (needs confirmed sweep + rejection — NOT just a sweep)
  if (
    smcRead.sufficientData &&
    smcRead.zones.some((z) => z.type === "liquidity_sweep" && z.active && z.strength > 70)
  ) {
    const sweep = smcRead.zones.find((z) => z.type === "liquidity_sweep" && z.active && z.strength > 70)!;
    inferredMechanisms.push(
      `Liquidity sweep at ₹${sweep.price.toFixed(2)} with rejection (${sweep.side})`,
    );
    mechanism = "liquidity_sweep";
    control = sweep.side === "resistance" ? "bullish" : "bearish";
    confidence = smcRead.confidence;
    confirmationStatus = "CONFIRMED";
    invalidation = sweep.price;
    coordinatorAction = control === "bullish" ? "BUY_CE" : "BUY_PE";
  }

  // Rule 3: Reversal / structural transition (CHOCH + BOS flip)
  if (smcRead.sufficientData && smcRead.events.some((e) => e.type === "CHOCH")) {
    const choch = smcRead.events.find((e) => e.type === "CHOCH")!;
    inferredMechanisms.push(`CHOCH detected — structural transition toward ${choch.direction}`);
    mechanism = "reversal_transition";
    control = choch.direction === "bullish" ? "bullish" : "bearish";
    confidence = Math.max(confidence, 65);
    confirmationStatus = "PARTIAL";
    coordinatorAction = control === "bullish" ? "BUY_CE" : "BUY_PE";
  }

  // Rule 4: Breakout / acceptance (BOS + above/below VWAP + RVOL)
  if (
    smcRead.sufficientData &&
    smcRead.events.some((e) => e.type === "BOS") &&
    rvolVal &&
    rvolVal.ratio > 1.5
  ) {
    const bos = smcRead.events.find((e) => e.type === "BOS")!;
    const vwapBullish = vwapVal ? lastPrice > vwapVal.vwap : false;
    const vwapBearish = vwapVal ? lastPrice < vwapVal.vwap : false;
    const bullishBreakout = bos.direction === "bullish" && vwapBullish;
    const bearishBreakout = bos.direction === "bearish" && vwapBearish;
    if (bullishBreakout || bearishBreakout) {
      inferredMechanisms.push(
        `Breakout with acceptance: BOS ${bos.direction} + RVOL ${rvolVal.ratio.toFixed(1)}x + VWAP confirmation`,
      );
      mechanism = "breakout_acceptance";
      control = bos.direction === "bullish" ? "bullish" : "bearish";
      confidence = Math.max(confidence, 75);
      confirmationStatus = "CONFIRMED";
      coordinatorAction = control === "bullish" ? "BUY_CE" : "BUY_PE";
    }
  }

  // Rule 5: Trend expansion (ADX strong + EMA alignment + directional SMC)
  if (
    adxVal &&
    adxVal.adx > 25 &&
    smcRead.structure !== "NEUTRAL"
  ) {
    const adxBullish = adxVal.trend === "strong_trend" && smcRead.structure === "BULLISH";
    const adxBearish = adxVal.trend === "strong_trend" && smcRead.structure === "BEARISH";
    if (adxBullish || adxBearish) {
      inferredMechanisms.push(
        `Trend expansion: ADX ${adxVal.adx.toFixed(0)} + SMC ${smcRead.structure}`,
      );
      if (mechanism === "balance_consolidation" || mechanism === "high_volatility") {
        mechanism = "trend_expansion";
        control = smcRead.structure === "BULLISH" ? "bullish" : "bearish";
        confidence = Math.max(confidence, 60);
        confirmationStatus = "CONFIRMED";
        coordinatorAction = control === "bullish" ? "BUY_CE" : "BUY_PE";
      }
    }
  }

  // Rule 6: Trend exhaustion (ADX high but RVOL declining + price at extreme)
  if (
    adxVal &&
    adxVal.adx > 35 &&
    rvolVal &&
    rvolVal.ratio < 0.8 &&
    dtrUtil != null &&
    dtrUtil > 0.8
  ) {
    inferredMechanisms.push(
      `Trend exhaustion: high ADX ${adxVal.adx.toFixed(0)} + declining RVOL + price at DTR extreme`,
    );
    mechanism = "trend_exhaustion";
    control = "neutral";
    confidence = 60;
    confirmationStatus = "PARTIAL";
    coordinatorAction = "WAIT";
  }

  // Rule 7: Absorption / failed auction (high volume but price stuck at value area)
  if (
    rvolVal &&
    rvolVal.ratio > 2.0 &&
    Math.abs((vwapVal?.deviationPct ?? 0)) < 0.5 &&
    smcRead.structure === "NEUTRAL"
  ) {
    inferredMechanisms.push(
      `Absorption: high RVOL ${rvolVal.ratio.toFixed(1)}x but price near VWAP, structure neutral`,
    );
    const hasRejection = smcRead.zones.some((z) => z.active && z.strength > 70);
    if (hasRejection) {
      mechanism = "absorption_auction";
      control = "neutral";
      confidence = 55;
      confirmationStatus = "PARTIAL";
      coordinatorAction = "WAIT";
    } else {
      conflictingEvidence.push(
        "High volume but no price rejection — absorption not confirmed",
      );
    }
  }

  // Rule 8: Balance / consolidation (default when nothing else fits)
  if (mechanism === "balance_consolidation") {
    inferredMechanisms.push("No clear mechanism — balance/consolidation");
    confidence = 40;
    confirmationStatus = "UNCONFIRMED";
    coordinatorAction = "WAIT";
  }

  // ── Conflicting evidence detection ──
  if (smcRead.conflictingEvidence.length > 0) {
    conflictingEvidence.push(...smcRead.conflictingEvidence);
  }
  if (vixHigh && control === "bullish") {
    conflictingEvidence.push("High VIX but bullish structure — trend may fail");
  }
  if (optionChain?.pcr != null) {
    if (optionChain.pcr > 1.5 && control === "bullish") {
      conflictingEvidence.push(`PCR ${optionChain.pcr.toFixed(2)} (put-heavy) conflicts with bullish control`);
    }
    if (optionChain.pcr < 0.6 && control === "bearish") {
      conflictingEvidence.push(`PCR ${optionChain.pcr.toFixed(2)} (call-heavy) conflicts with bearish control`);
    }
  }

  // If conflicts exist, downgrade to WAIT
  if (conflictingEvidence.length > 0) {
    confirmationStatus = "WAIT";
    coordinatorAction = "WAIT";
    confidence = Math.min(confidence, 50);
  }

  // ── Key levels ──
  if (smcRead.sufficientData && smcRead.invalidationLevel != null) {
    invalidation = smcRead.invalidationLevel;
  }
  for (const z of smcRead.zones) {
    if (z.side === "support" && z.active) supportLevels.push(z.price);
    if (z.side === "resistance" && z.active) resistanceLevels.push(z.price);
  }

  const result: MechanismRead = {
    mechanism,
    regime: mechanism.replace(/_/g, " ").toUpperCase(),
    control,
    confidence: Math.min(100, Math.max(0, confidence)),
    confirmationStatus,
    observedFacts,
    inferredMechanisms,
    conflictingEvidence,
    keyLevels: {
      support: supportLevels,
      resistance: resistanceLevels,
      invalidation,
    },
    dtrUtilization: dtrUtil,
    remainingRange: remainingRange,
    timestamp: new Date().toISOString(),
    freshness,
    sufficientData: smcRead.sufficientData && indicatorBundle.dtr.sufficientData,
    reason: smcRead.reason ?? null,
    coordinatorAction,
  };

  return result;
}
