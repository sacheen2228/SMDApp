// Pre-Market Data Science Lab — shared types.
// Research-only. Never used to authorize trades.

export type SourceId =
  | "NSE_CM_PREOPEN"
  | "NSE_FNO_PREOPEN"
  | "MOAPI_OPTION_CHAIN"
  | "INDIA_VIX"
  | "FII_DII"
  | "CANDLES"
  | "BHAVCOPY";

export type DataQuality = "OK" | "DEGRADED" | "MISSING" | "STALE";

export type BiasLabel = "BULLISH" | "BEARISH" | "NEUTRAL" | "MIXED" | "WAIT";

export interface Provenance {
  source: SourceId;
  url?: string;
  fetchedAt: string; // ISO
  publishedAt?: string; // exchange timestamp when present
  schemaVersion: number;
}

export interface QualityReport {
  overall: DataQuality;
  perSource: Record<string, { quality: DataQuality; reason?: string; ageMs?: number }>;
  score: number; // 0-100 data-quality score (NOT a trade score)
}

// ── Normalized CM pre-open row ───────────────────────────────────────
export interface CmPreopenRow {
  symbol: string;
  series?: string;
  purpose?: string;
  previousClose: number | null;
  iep: number | null;
  finalPrice: number | null;
  change: number | null;
  pChange: number | null;
  finalQuantity: number | null;
  totalTurnover: number | null;
  totalBuyQuantity: number | null;
  totalSellQuantity: number | null;
  atoBuyQty: number | null;
  atoSellQty: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  bestBidQty: number | null;
  bestAskQty: number | null;
  marketCap?: number | string | null;
  yearHigh?: number | null;
  yearLow?: number | null;
}

// ── Normalized F&O pre-open futures row ──────────────────────────────
export interface FuturesPreopenRow {
  instrumentType: "FUTIDX" | "FUTSTK";
  symbol: string;
  identifier: string;
  expiryDate: string; // "23-Nov-2026"
  previousClose: number | null;
  iep: number | null;
  finalPrice: number | null;
  change: number | null;
  pChange: number | null;
  finalQuantity: number | null; // contracts
  totalTurnover: number | null; // ₹
  totalBuyQuantity: number | null;
  totalSellQuantity: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  bestBidQty: number | null;
  bestAskQty: number | null;
}

export interface PreopenFetchResult<T> {
  ok: boolean;
  rows: T[];
  timestamp: string | null;
  marketStatus?: string | null;
  error?: string;
  quality: DataQuality;
}

// ── Daily study unit (one trading day × instrument) ──────────────────
export interface PreopenStudyDay {
  tradeDate: string; // YYYY-MM-DD
  symbol: string; // NIFTY | BANKNIFTY | ...
  provenance: Provenance;
  quality: QualityReport;
  cm: {
    previousClose: number | null;
    iep: number | null;
    finalPrice: number | null;
    pChange: number | null;
    finalQuantity: number | null;
    totalTurnover: number | null;
    imbalanceQty: number | null;
    bestBid: number | null;
    bestAsk: number | null;
    totalBuyQuantity?: number | null;
    totalSellQuantity?: number | null;
  } | null;
  futures: {
    instrumentType: "FUTIDX" | "FUTSTK";
    expiryDate: string;
    previousClose: number | null;
    iep: number | null;
    finalPrice: number | null;
    pChange: number | null;
    finalQuantity: number | null;
    totalTurnover: number | null;
    imbalanceQty: number | null;
    basis: number | null;
    basisPct: number | null;
    totalBuyQuantity?: number | null;
    totalSellQuantity?: number | null;
  } | null;
  open: {
    spotOpen: number | null;
    futuresOpen: number | null;
    dayHigh: number | null;
    dayLow: number | null;
    dayClose: number | null;
    volume: number | null;
  } | null;
  vix: number | null;
  fiiNet: number | null;
  diiNet: number | null;
}

// ── Feature row (Phase 4) ────────────────────────────────────────────
export interface FeatureRow {
  tradeDate: string;
  symbol: string;
  asOf: string; // feature cutoff ISO — never after outcomes
  features: Record<string, number | null>;
  source: SourceId[];
  calcVersion: string;
}

// ── Model I/O ────────────────────────────────────────────────────────
export type OutcomeLabel = 0 | 1;

export interface LabeledSample {
  tradeDate: string;
  symbol: string;
  features: Record<string, number | null>;
  target: string; // e.g. "gap_continuation"
  label: OutcomeLabel;
}

export interface ModelMetrics {
  n: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  rocAuc: number | null;
  brier: number | null;
  accuracy: number | null;
  confusion: { tp: number; fp: number; tn: number; fn: number };
}

// ── Combined score (Phase 7) ─────────────────────────────────────────
export interface FeatureContribution {
  key: string;
  label: string;
  raw: number | null;
  normalized: number; // -1..1
  weight: number;
  weighted: number;
  source: SourceId;
  quality: DataQuality;
}

export interface CombinedQuantScore {
  score: number; // 0-100 experimental research score
  bias: BiasLabel;
  contributions: FeatureContribution[];
  sourceScores: {
    cm: number | null;
    fno: number | null;
    options: number | null;
    volatility: number | null;
    breadth: number | null;
    flow: number | null;
  };
  quality: QualityReport;
  disclaimer: string;
  calculatedAt: string;
}

export const SCORE_DISCLAIMER =
  "Experimental research score only. Not a probability of profit. Not trade authorization. " +
  "Existing SDM gates, risk checks and BUY CE/PE-only rules remain in force.";

// ── Phase 11 — Quantitative Shadow Validation ────────────────────────
// Validation-only. Never authorizes, sizes, or executes a trade.

export type ShadowModelId = "logistic" | "forest" | "gbt" | "ridge" | "lab_score" | "sdm" | "combined";

export interface ShadowPrediction {
  model: ShadowModelId;
  featureSet?: string;
  pUp: number | null; // probability of up / bullish direction (0-1)
  predLabel?: 0 | 1 | null;
  asOf: string;
  notes?: string;
}

export interface ShadowOutcomes {
  open: number | null;
  close5m: number | null;
  close15m: number | null;
  close30m: number | null;
  eodClose: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  /** Direction labels vs open (1 = up from open). null when print missing. */
  label5m: 0 | 1 | null;
  label15m: 0 | 1 | null;
  label30m: 0 | 1 | null;
  labelEod: 0 | 1 | null;
  gapContEod: 0 | 1 | null;
  gapRevEod: 0 | 1 | null;
  notes: string[];
}

export interface SdmShadowSnapshot {
  signal: "BUY_CALL" | "BUY_PUT" | "WAIT" | "NO_DATA";
  confidence: number | null;
  asOf: string;
  source: string;
  notes?: string;
}

export interface ResearchInputs {
  asOf: string;
  vix: { value: number | null; change?: number | null; quality: DataQuality; source: string } | null;
  fiiDii: {
    fiiNet: number | null; diiNet: number | null; date: string | null;
    available: boolean; quality: DataQuality;
  } | null;
  options: {
    symbol: string; pcr: number | null; ceOi: number | null; peOi: number | null;
    atmIv?: number | null; quality: DataQuality; source: string; asOf: string;
  } | null;
  breadth: {
    adv: number; dec: number; unchanged: number; quality: DataQuality;
  } | null;
  missing: string[];
}

export type OutcomeStatus =
  | "PENDING_OUTCOME"
  | "OUTCOME_RECORDED"
  | "OUTCOME_UNAVAILABLE";

export interface ShadowSession {
  id?: string;
  tradeDate: string;
  symbol: string;
  featureAsOf: string;
  labScore: number | null;
  labBias: BiasLabel | null;
  predictions: ShadowPrediction[];
  sdm: SdmShadowSnapshot | null;
  outcomes: ShadowOutcomes | null;
  research: ResearchInputs | null;
  quality: QualityReport | null;
  optionSimValidated: boolean | null; // null = not attempted, false = NOT_VALIDATED
  notes: string[];
  createdAt?: string;
  /** Phase 12 outcome lifecycle. */
  outcomeStatus?: OutcomeStatus;
  outcomeAttempts?: number;
  outcomeAttachedAt?: string | null;
  recordedAt?: string | null;
  researchAsOf?: string | null;
}

export interface WilsonInterval {
  n: number;
  successes: number;
  rate: number | null;
  lower: number | null;
  upper: number | null;
  /** True when n < 30 — do not claim statistical significance. */
  insufficient: boolean;
}

export interface OptionSimResult {
  tradeDate: string;
  symbol: string;
  side: "CE" | "PE";
  strike: number | null;
  expiry: string | null;
  entry: number | null;
  stopLoss: number | null;
  target: number | null;
  outcome: "WIN" | "LOSS" | "FLAT" | "NOT_VALIDATED" | "NO_DATA";
  pnlR: number | null;
  mae: number | null; // adverse premium move % from entry
  mfe: number | null;
  charges: number | null; // ₹ absolute estimate or null
  slippagePts: number | null;
  validated: boolean;
  reason?: string;
  asOf: string;
  /** Phase 12: contract lot used for charge/rupee estimates (null = unknown). */
  lotSize?: number | null;
  /** Phase 12: rupee P&L estimate when lot known (points × lot, minus charges). */
  pnlInr?: number | null;
}

export const SHADOW_MIN_N = 30;
export const SHADOW_DISCLAIMER =
  "Shadow validation only. Research metrics are not trade authorization, not expected returns, " +
  "and not a claim of profitability. Production SDM/veto/risk paths are unchanged.";

/** Phase 12 — max outcome attach attempts before OUTCOME_UNAVAILABLE. */
export const MAX_OUTCOME_ATTEMPTS = 8;
