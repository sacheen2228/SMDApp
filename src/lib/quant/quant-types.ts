// quant-types.ts — shared interfaces for UNIVERSAL_QUANT_V1.
//
// ISOLATION: quant-namespace types only; no existing engine's types are
// extended or imported here. Also home of qid() — the ONLY place in the
// quant namespace where Math.random is permitted (id generation).

import type { QuantStrategy, Regime } from "./quant-config";

/**
 * Cuid-like id for quant rows/events. Deterministic columns (eventIds,
 * idempotency keys) are built by callers; qid() is for primary keys only.
 */
export function qid(): string {
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Provenance stamp carried by every quant data read. */
export interface QuantObservation {
  source: string;
  symbol: string;
  exchange: string;
  providerTimestamp: string | null; // provider's own publish time (ISO)
  collectedAt: string; // IST-aware ISO — when the quant layer read it
  ageMs: number | null; // null when the provider gave no timestamp
  quality: "FRESH" | "STALE" | "UNAVAILABLE";
  contractId: string; // what was requested, e.g. "NIFTY:2026-10-27:chain"
}

/** Computed market features. Every numeric field is null when not computable — NEVER invented. */
export interface QuantFeatures {
  close: number | null;
  vwap: number | null;
  vwapDevPct: number | null;
  ema9: number | null;
  ema20: number | null;
  ema50: number | null;
  atr14: number | null;
  realizedVol: number | null; // annualized % (stdev of per-candle returns × √252 × 100)
  sessionHigh: number | null;
  sessionLow: number | null;
  prevDayHigh: number | null;
  prevDayLow: number | null;
  prevDayClose: number | null;
  openRangeHigh: number | null; // first 15 minutes of the supplied series
  openRangeLow: number | null;
  rangeCompression: number | null; // last-10-candle range ÷ atr14
  volumeExpansion: number | null; // last candle volume ÷ avg of prior candles
  trendScore: number | null; // signed % — EMA alignment slope (see quant-features.ts)
  gapPct: number | null; // first open vs prevDayClose
  expectedMovePct: number | null; // vix/√252 when vix present
  vix: number | null;
  candleCount: number;
  lastCandleTs: string | null;
}

export interface QuantRegimeResult {
  regime: Regime;
  confidence: number | null; // null when UNCERTAIN / not measurable
  measurements: Record<string, number | null>;
  reasons: string[];
}

export interface QuantStrategySignal {
  strategy: QuantStrategy;
  direction: "BUY_CE" | "BUY_PE" | "BUY" | "SELL";
  eligible: boolean;
  score: number | null; // 0-100, deterministic weighted sum (null when ineligible)
  evidence: string[];
  rejectionReasons: string[];
}

export interface QuantContractSelection {
  tradingsymbol: string | null;
  strike: number | null;
  optionType: "CE" | "PE" | null;
  expiry: string | null;
  lotSize: number | null;
  tickSize: number | null;
  premium: number | null;
  bid: number | null;
  ask: number | null;
  spreadPct: number | null;
  iv: number | null;
  delta: number | null;
  theta: number | null;
  oi: number | null;
  selectionReasons: string[];
  rejected?: boolean;
  rejectionReason?: string;
}

export interface QuantRiskAssessment {
  capital: number | null;
  riskBudget: number | null; // allowed rupee risk = capital × perTradeRiskPct/100
  riskAmount: number | null; // actual planned rupee risk = riskPerLot × lots
  lots: number; // 0 when not tradable
  quantity: number;
  maxLoss: number | null; // riskAmount + estCosts (costs priced at the stop)
  estCosts: number | null;
  affordable: boolean;
  passesAll: boolean;
  reasons: string[];
}

export interface QuantPlan {
  entry: number | null;
  stopLoss: number | null;
  targets: { tp1?: number | null; tp2?: number | null; tp3?: number | null; tp4?: number | null };
  trailingPolicy: {
    kind: "BREAKEVEN_TP1_THEN_ATR_TRAIL";
    atrPremium: number | null;
    multiple: number; // trail distance in ATR multiples (1 = 1×atrPremium)
  } | null;
  rewardRisk: number | null;
  dataQualityScore: number | null;
  lots?: number | null; // set by the risk manager; simulateEntry refuses 0/absent
}

export interface QuantDecision {
  decisionId: string;
  ts: string; // IST-aware ISO
  symbol: string;
  exchange: string;
  regime: Regime;
  signals: QuantStrategySignal[];
  winner: QuantStrategySignal | null;
  contract: QuantContractSelection | null;
  plan: QuantPlan | null;
  risk: QuantRiskAssessment | null;
  verdict: "TRADE" | "WAIT" | "NO_TRADE";
  blockReason?: string;
  /** DEEP-RESEARCH GATE result — chain structure vs the chosen direction. */
  chainConfirmation?: { confirmed: boolean; evidence: string };
  provenance: QuantObservation[];
}
