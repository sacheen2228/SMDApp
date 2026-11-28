// F&O Quantitative Seller Intelligence Engine — Daily Derivatives integration.
//
// Classifies per-strike OI+premium behaviour (LONG/SHORT buildup, SHORT
// COVERING, LONG UNWINDING), scores writer pressure vs covering, computes
// DEX/GEX exposure (GEX reuses gex-engine), builds seller invalidation zones
// and aggregates a BUY_CE / BUY_PE / WAIT candidate with market confirmation.
//
// Data honesty:
//   • previousOI = oi − exchange ΔOI (never a second snapshot)
//   • premium/IV baselines come from a day-first ring — the first fetch of the
//     day is labelled NO_PREMIUM_BASELINE and reports 0 change, never invented
//   • volume ratio is relvol vs the chain median (caller supplies averageVolume)
//   • legs with no greeks are skipped and counted, never analysed on delta 0
//
// DEX/GEX UNITS:
//   DEX (Delta Exposure) = OI × lotSize × delta × spotPrice   (₹ rupees)
//     - OI: number of open contracts (exchange-published)
//     - lotSize: exchange lot size (NIFTY=65, SENSEX=20 per symbol-config)
//     - delta: Black-Scholes delta from exchange IV (provider or BS-computed)
//     - spotPrice: underlying spot price (₹)
//     - CE delta is positive, PE delta is negative → DEX is signed
//
//   GEX (Gamma Exposure) = gamma × OI × spotPrice² × 0.01   (see gex-engine.ts)
//     - gamma: per 1-point index move per contract (from exchange IV or BS)
//     - spotPrice²: converts gamma to rupee exposure per contract
//     - ×0.01: converts from "per 100 index points" to "per 1 index point"
//
// DEX/GEX values are computed from exchange-published OI and BS-derived greeks.
// They have NOT been independently reconciled against exchange-published
// DEX/GEX figures. Treat as indicative only.
import { calculateGEX } from "@/lib/gex-engine";
import { istDayKey } from "@/lib/risk-management";
import {
  getLatestPriorObservation,
  getSessionFirstObservation,
  pruneOldObservations,
  recordOiObservation,
} from "@/lib/oi-baseline-store";
import type { SDMOptionStrike, GEXResult } from "@/types/sdm";

// ── Types ────────────────────────────────────────────────────────────

export type OptionType = "CE" | "PE";
export type MarketDirection = "BULLISH" | "BEARISH" | "NEUTRAL";
export type PositionClassification =
  | "LONG_BUILDUP"
  | "SHORT_BUILDUP"
  | "SHORT_COVERING"
  | "LONG_UNWINDING"
  | "MIXED";

/**
 * OI baseline classification. It describes WHICH session the OI baseline was
 * observed in — never invented, never UTC-shifted.
 *
 *   INTRADAY    — we own a same-session observation of this contract's OI.
 *                 baselineTimestamp = epoch ms of that observation.
 *   OVERNIGHT   — our newest owned observation belongs to an earlier session;
 *                 the OI change spans the overnight gap. baselineTimestamp =
 *                 epoch ms of that earlier observation.
 *   UNVERIFIED  — no owned observation; the baseline is reconstructed from the
 *                 exchange ΔOI (oi − ΔOI) whose reference session the provider
 *                 does not publish. baselineTimestamp = null.
 *   UNAVAILABLE — no ΔOI at all and no owned observation.
 */
export type OIBaselineType = "INTRADAY" | "OVERNIGHT" | "UNVERIFIED" | "UNAVAILABLE";

export type OIBaselineSource =
  | "exchange-delta"
  | "same-session-snapshot"
  | "prior-session-snapshot"
  | "none";

/** An OI baseline this process OBSERVED (never reconstructed). */
export interface OwnedOIBaseline {
  /** OI observed at `observedAt`. */
  oi: number;
  /** Epoch ms of the observation. */
  observedAt: number;
  /** IST trading-session key (YYYY-MM-DD) of the observation. */
  session: string;
}

export interface OIBaselineVerdict {
  type: OIBaselineType;
  source: OIBaselineSource;
  /** Epoch ms of the baseline observation — null when reconstructed. */
  baselineTimestamp: number | null;
  /** IST trading date of the baseline observation — null when unknown. */
  baselineSession: string | null;
  /** IST trading date of the current observation. */
  currentSession: string;
  /** True only when the baseline is from the same session — the only one that
   *  may drive intraday writer-pressure / covering inference. */
  valid: boolean;
  reason: string;
}

/** Classify the OI baseline provenance. */
export function classifyOIBaseline(input: {
  previousOI: number;
  owned: OwnedOIBaseline | null;
  currentTimestamp: number;
}): OIBaselineVerdict {
  const currentSession = istDayKey(input.currentTimestamp);
  const previousOk = Number.isFinite(input.previousOI) && input.previousOI > 0;

  const owned = input.owned;
  if (owned && Number.isFinite(owned.oi) && owned.oi > 0 && Number.isFinite(owned.observedAt)) {
    if (owned.session === currentSession) {
      return {
        type: "INTRADAY",
        source: "same-session-snapshot",
        baselineTimestamp: owned.observedAt,
        baselineSession: owned.session,
        currentSession,
        valid: true,
        reason: `OI baseline observed in this session (${owned.session}) at ${new Date(owned.observedAt).toISOString()}`,
      };
    }
    return {
      type: "OVERNIGHT",
      source: "prior-session-snapshot",
      baselineTimestamp: owned.observedAt,
      baselineSession: owned.session,
      currentSession,
      valid: false,
      reason: `OI baseline observed in an earlier session (${owned.session}); the change spans the overnight gap`,
    };
  }

  if (!previousOk) {
    return {
      type: "UNAVAILABLE",
      source: "none",
      baselineTimestamp: null,
      baselineSession: null,
      currentSession,
      valid: false,
      reason: "no OI baseline — the provider published no ΔOI and no observation is owned",
    };
  }

  return {
    type: "UNVERIFIED",
    source: "exchange-delta",
    baselineTimestamp: null,
    baselineSession: null,
    currentSession,
    valid: false,
    reason: "OI baseline reconstructed from the exchange ΔOI — its reference session is not published",
  };
}

export interface OptionSnapshot {
  symbol: string;
  expiry: string;
  strike: number;
  type: OptionType;
  underlyingPrice: number;
  premium: number;
  previousPremium: number;
  oi: number;
  previousOI: number;
  volume: number;
  averageVolume: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  previousIV: number;
  lotSize: number;
  timestamp: number;
  /**
   * An OI baseline this process OBSERVED (never a reconstruction).
   * null → only the exchange ΔOI reconstruction (oi − ΔOI) is available.
   */
  oiBaseline?: OwnedOIBaseline | null;
}

export interface MarketConfirmation {
  underlyingChangePct: number;
  vwap: number | null;
  currentPrice: number;
  breakoutConfirmed: boolean;
  retestConfirmed: boolean;
  previousResistance?: number;
  previousSupport?: number;
}

export interface EngineConfig {
  minScore: number;
  minVolumeRatio: number;
  maxDataAgeMs: number;
  oiChangeThreshold: number;
  minCoveringScore: number;
  minPressureScore: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  minScore: 40,
  minVolumeRatio: 1.5,
  maxDataAgeMs: 15_000,
  oiChangeThreshold: 2,
  minCoveringScore: 40,
  minPressureScore: 60,
};

export interface GreekImpact {
  deltaImpact: number;
  gammaImpact: number;
  thetaImpact: number;
  vegaImpact: number;
  estimatedPremiumChange: number;
}

export interface Exposure {
  deltaExposure: number;
  gammaExposure: number;
}

export interface SellerAnalysis {
  symbol: string;
  expiry: string;
  strike: number;
  type: OptionType;
  classification: PositionClassification;
  oiChangePct: number;
  /** null when no valid previous premium baseline exists (day-first observation) */
  premiumChangePct: number | null;
  /** null when no valid previous IV baseline exists (day-first observation) */
  ivChangePct: number | null;
  volumeRatio: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  writerPressureScore: number;
  coveringScore: number;
  greekImpact: GreekImpact;
  exposure: Exposure;
  potentialWriterPressure: boolean;
  potentialShortCovering: boolean;
  direction: MarketDirection;
  dataFresh: boolean;
  warnings: string[];
  timestamp: number;
  /** OI change baseline classification: INTRADAY / OVERNIGHT / UNVERIFIED / UNAVAILABLE */
  oiChangeType: "INTRADAY" | "OVERNIGHT" | "UNVERIFIED" | "UNAVAILABLE";
  /** When the baseline observation was taken (epoch ms) */
  baselineTimestamp: number | null;
  /** When the current observation was taken (epoch ms) */
  comparisonTimestamp: number | null;
  /** Source of the baseline: "exchange-delta" / "same-session-snapshot" / "prior-session-snapshot" / "none" */
  baselineSource: OIBaselineSource;
  /** Whether the baseline is valid for writer-pressure analysis (same-session only). */
  baselineValid: boolean;
  /** IST trading-session key (YYYY-MM-DD) of the current observation. */
  currentSession: string;
  /** OI change vs our own same-session baseline (null when we own none). */
  intradayOiChangeAbsolute: number | null;
  /** OI change vs our own same-session baseline (null when we own none). */
  intradayOiChangePct: number | null;
}

export type SellerZoneStatus =
  | "DEFENDED_CANDIDATE"
  | "PRESSURE_BUILDING"
  | "POTENTIAL_COVERING"
  | "INVALIDATED"
  | "UNCONFIRMED";

export interface SellerZone {
  strike: number;
  type: OptionType;
  status: SellerZoneStatus;
  zoneLow: number;
  zoneHigh: number;
  pressureScore: number;
  classification: PositionClassification;
  direction: MarketDirection;
}

export interface TradeCandidate {
  signal: "BUY_CE" | "BUY_PE" | "WAIT";
  direction: MarketDirection;
  score: number;
  confidence: number;
  reasons: string[];
  warnings: string[];
  entryConfirmed: boolean;
  requiresRetest: boolean;
}

// ── Core maths ───────────────────────────────────────────────────────

export function classifyPosition(
  oiChangePct: number,
  premiumChangePct: number,
  threshold = DEFAULT_CONFIG.oiChangeThreshold
): PositionClassification {
  if (oiChangePct > threshold && premiumChangePct > 0) return "LONG_BUILDUP";
  if (oiChangePct > threshold && premiumChangePct < 0) return "SHORT_BUILDUP";
  if (oiChangePct < -threshold && premiumChangePct > 0) return "SHORT_COVERING";
  if (oiChangePct < -threshold && premiumChangePct < 0) return "LONG_UNWINDING";
  return "MIXED";
}

export function calculateGreekImpact(
  snap: OptionSnapshot,
  spotMove: number,
  timeDecayDays = 0,
  volChange = 0
): GreekImpact {
  const deltaImpact = snap.delta * spotMove;
  const gammaImpact = 0.5 * snap.gamma * spotMove * spotMove;
  const thetaImpact = snap.theta * timeDecayDays;
  const vegaImpact = snap.vega * volChange;
  return {
    deltaImpact,
    gammaImpact,
    thetaImpact,
    vegaImpact,
    estimatedPremiumChange: deltaImpact + gammaImpact + thetaImpact + vegaImpact,
  };
}

export function calculateExposure(snap: OptionSnapshot): Exposure {
  const contracts = snap.oi * snap.lotSize;
  return {
    deltaExposure: contracts * snap.delta * snap.underlyingPrice,
    gammaExposure: contracts * snap.gamma,
  };
}

function magnitudeScore(
  oiChangePct: number,
  premiumChangePct: number | null,
  volumeRatio: number,
  oiAligned: boolean
): number {
  const oi = Math.min(Math.abs(oiChangePct) / 20, 1) * 40;
  const prem = premiumChangePct != null ? Math.min(Math.abs(premiumChangePct) / 5, 1) * 30 : 0;
  const vol = Math.min(Math.abs(volumeRatio) / 3, 1) * 20;
  const base = oiAligned ? 10 : 0;
  return Math.round(oi + prem + vol + base);
}

function flowDirection(classification: PositionClassification, type: OptionType): MarketDirection {
  const longDir: MarketDirection = type === "CE" ? "BULLISH" : "BEARISH";
  const shortDir: MarketDirection = type === "CE" ? "BEARISH" : "BULLISH";
  switch (classification) {
    case "LONG_BUILDUP":
      return longDir;
    case "LONG_UNWINDING":
      return shortDir;
    case "SHORT_BUILDUP":
      return shortDir;
    case "SHORT_COVERING":
      return longDir;
    default:
      return "NEUTRAL";
  }
}

export function analyzeOption(
  current: OptionSnapshot,
  config: EngineConfig = DEFAULT_CONFIG
): SellerAnalysis {
  const warnings: string[] = [];
  const age = Date.now() - current.timestamp;
  const dataFresh = Number.isFinite(age) && age <= config.maxDataAgeMs;
  if (!dataFresh) warnings.push("STALE_OR_INVALID_TIMESTAMP");

  const baselineOk = Number.isFinite(current.previousOI) && current.previousOI > 0;
  if (!baselineOk) warnings.push("INVALID_OR_MISSING_BASELINE");

  const valid =
    dataFresh &&
    baselineOk &&
    Number.isFinite(current.delta) &&
    Number.isFinite(current.gamma) &&
    Number.isFinite(current.theta);

  // OI baseline provenance. An owned same-session observation (INTRADAY) is
  // the only basis we may act on for intraday writer-pressure inference. An
  // exchange-ΔOI reconstruction (UNVERIFIED) tells us nothing about which
  // session the baseline belongs to — never UTC-shifted, never guessed.
  const verdict = classifyOIBaseline({
    previousOI: current.previousOI,
    owned: current.oiBaseline ?? null,
    currentTimestamp: current.timestamp,
  });

  const oiChangeType: OIBaselineType = verdict.type;
  const baselineTimestamp: number | null = verdict.baselineTimestamp;
  const baselineSession: string | null = verdict.baselineSession;
  const baselineSource: OIBaselineSource = verdict.source;
  const baselineValid: boolean = verdict.valid;

  if (oiChangeType === "UNVERIFIED") warnings.push("OI_BASELINE_SESSION_UNVERIFIED");
  else if (oiChangeType === "OVERNIGHT") warnings.push("OI_BASELINE_OVERNIGHT");

  // Headline OI change vs the exchange ΔOI baseline (session-to-date vs previous close).
  const oiChangeAbsolute = current.oi - current.previousOI;
  const oiChangePct = baselineOk
    ? ((current.oi - current.previousOI) / current.previousOI) * 100
    : 0;

  // Intraday OI change vs our own owned baseline (session-first observation),
  // or vs our newest prior-session observation (OVERNIGHT). Null when we own
  // no observation at all.
  const owned = current.oiBaseline ?? null;
  const intradayOiChangeAbsolute =
    owned && Number.isFinite(owned.oi) && owned.oi > 0 ? current.oi - owned.oi : null;
  const intradayOiChangePct =
    owned && Number.isFinite(owned.oi) && owned.oi > 0
      ? ((current.oi - owned.oi) / owned.oi) * 100
      : null;

  // Classification basis: our own owned baseline when present (intraday
  // when same-session, overnight when earlier), else the exchange ΔOI.
  const classifiedOiChangePct = intradayOiChangePct ?? oiChangePct;
  const premiumChangePct = current.previousPremium > 0
    ? ((current.premium - current.previousPremium) / current.previousPremium) * 100
    : null;
  const ivChangePct = current.previousIV > 0
    ? ((current.iv - current.previousIV) / current.previousIV) * 100
    : null;
  const volumeRatio = current.averageVolume > 0 ? current.volume / current.averageVolume : 0;

  const classification = classifyPosition(classifiedOiChangePct, premiumChangePct, config.oiChangeThreshold);

  let writerPressureScore = 0;
  let coveringScore = 0;
  if (valid && baselineValid) {
    const raw = magnitudeScore(classifiedOiChangePct, premiumChangePct, volumeRatio, classifiedOiChangePct > 0);
    if (classification === "SHORT_BUILDUP") writerPressureScore = raw;
    if (classification === "SHORT_COVERING") coveringScore = raw;
  }

  const potentialWriterPressure = valid && baselineValid && classification === "SHORT_BUILDUP";
  const potentialShortCovering = valid && baselineValid && classification === "SHORT_COVERING";

  return {
    symbol: current.symbol,
    expiry: current.expiry,
    strike: current.strike,
    type: current.type,
    classification,
    oiChangePct,
    premiumChangePct,
    ivChangePct,
    volumeRatio,
    delta: current.delta,
    gamma: current.gamma,
    theta: current.theta,
    vega: current.vega,
    writerPressureScore,
    coveringScore,
    greekImpact: calculateGreekImpact(current, 0, 0, ivChangePct / 100),
    exposure: calculateExposure(current),
    potentialWriterPressure,
    potentialShortCovering,
    direction: flowDirection(classification, current.type),
    dataFresh,
    warnings,
    timestamp: current.timestamp,
    oiChangeType,
    baselineTimestamp,
    comparisonTimestamp: current.timestamp,
    baselineSession,
    baselineSource,
    baselineValid,
    intradayOiChangeAbsolute,
    intradayOiChangePct,
  };
}

export function calculateSellerZone(
  snapshot: OptionSnapshot,
  analysis: SellerAnalysis,
  config: EngineConfig = DEFAULT_CONFIG
): SellerZone {
  const buffer = Math.max(snapshot.premium, 1);
  const zoneLow = snapshot.type === "CE" ? snapshot.strike : snapshot.strike - buffer;
  const zoneHigh = snapshot.type === "CE" ? snapshot.strike + buffer : snapshot.strike;
  const pressureScore = Math.max(analysis.writerPressureScore, analysis.coveringScore);

  let status: SellerZoneStatus;
  if (!analysis.dataFresh || analysis.warnings.includes("INVALID_OR_MISSING_BASELINE")) {
    status = "INVALIDATED";
  } else if (analysis.coveringScore >= config.minCoveringScore) {
    status = "POTENTIAL_COVERING";
  } else if (analysis.writerPressureScore >= config.minPressureScore) {
    status = "PRESSURE_BUILDING";
  } else if (analysis.classification === "LONG_BUILDUP") {
    status = "DEFENDED_CANDIDATE";
  } else {
    status = "UNCONFIRMED";
  }

  return {
    strike: snapshot.strike,
    type: snapshot.type,
    status,
    zoneLow,
    zoneHigh,
    pressureScore,
    classification: analysis.classification,
    direction: analysis.direction,
  };
}

export function generateTradeCandidate(
  ceAnalyses: SellerAnalysis[],
  peAnalyses: SellerAnalysis[],
  market: MarketConfirmation,
  config: EngineConfig = DEFAULT_CONFIG
): TradeCandidate {
  const warnings: string[] = [];

  const bestCe = ceAnalyses
    .filter(a => a.dataFresh && a.potentialShortCovering && a.volumeRatio >= config.minVolumeRatio)
    .sort((a, b) => b.coveringScore - a.coveringScore)[0];
  const bestPe = peAnalyses
    .filter(a => a.dataFresh && a.potentialShortCovering && a.volumeRatio >= config.minVolumeRatio)
    .sort((a, b) => b.coveringScore - a.coveringScore)[0];

  const aboveVwap = market.vwap != null && market.currentPrice > market.vwap;
  const belowVwap = market.vwap != null && market.currentPrice < market.vwap;
  const rising = market.underlyingChangePct > 0;
  const falling = market.underlyingChangePct < 0;

  const ceOk = !!bestCe && bestCe.coveringScore >= config.minScore && aboveVwap && market.breakoutConfirmed;
  const peOk = !!bestPe && bestPe.coveringScore >= config.minScore && belowVwap && market.breakoutConfirmed;

  const mkScore = (base: number, vwapOk: boolean, changeOk: boolean): number =>
    Math.max(
      0,
      Math.min(
        100,
        Math.round(
          base +
            (vwapOk ? 15 : 0) +
            (market.breakoutConfirmed ? 15 : 0) +
            (changeOk ? 10 : 0) +
            (market.retestConfirmed ? 10 : 0)
        )
      )
    );

  let signal: TradeCandidate["signal"] = "WAIT";
  let direction: MarketDirection = "NEUTRAL";
  let score = 0;
  const reasons: string[] = [];

  if (ceOk && peOk) {
    const ceScore = mkScore(bestCe!.coveringScore, aboveVwap, rising);
    const peScore = mkScore(bestPe!.coveringScore, belowVwap, falling);
    if (ceScore === peScore) {
      warnings.push("CONFLICTING_SIGNALS");
    } else if (ceScore > peScore) {
      signal = "BUY_CE";
      score = ceScore;
    } else {
      signal = "BUY_PE";
      score = peScore;
    }
  } else if (ceOk) {
    signal = "BUY_CE";
    score = mkScore(bestCe!.coveringScore, aboveVwap, rising);
  } else if (peOk) {
    signal = "BUY_PE";
    score = mkScore(bestPe!.coveringScore, belowVwap, falling);
  }

  if (signal === "BUY_CE") {
    direction = "BULLISH";
    reasons.push("CE_SHORT_COVERING_SIGNATURE");
    if (aboveVwap) reasons.push("ABOVE_VWAP");
    if (market.breakoutConfirmed) reasons.push("UNDERLYING_BREAKOUT");
    if (rising) reasons.push("UNDERLYING_RISING");
    if (market.retestConfirmed) reasons.push("RETEST_CONFIRMED");
  } else if (signal === "BUY_PE") {
    direction = "BEARISH";
    reasons.push("PE_SHORT_COVERING_SIGNATURE");
    if (belowVwap) reasons.push("BELOW_VWAP");
    if (market.breakoutConfirmed) reasons.push("UNDERLYING_BREAKOUT");
    if (falling) reasons.push("UNDERLYING_FALLING");
    if (market.retestConfirmed) reasons.push("RETEST_CONFIRMED");
  }

  const active = signal !== "WAIT";
  const requiresRetest = active && !market.retestConfirmed;
  const entryConfirmed = active && market.retestConfirmed;
  if (requiresRetest) warnings.push("AWAITING_RETEST");
  if (active && !market.breakoutConfirmed) warnings.push("NO_BREAKOUT_CONFIRMATION");

  return {
    signal,
    direction,
    score,
    confidence: score,
    reasons,
    warnings,
    entryConfirmed,
    requiresRetest,
  };
}

// ── Day-first premium/IV baseline ring + owned OI observations ───────────
//
// The day-first ring holds the FIRST observation of each IST trading day per
// contract — premium/IV baselines (never invented, day-first = 0 change) and
// the session-first OI baseline (INTRADAY). A second ring, lastOiObservation,
// holds the NEWEST OI observation per contract so a prior-session observation
// can be reported honestly as OVERNIGHT instead of being silently dropped.
const baselineRing = new Map<
  string,
  { premium: number; iv: number; oi: number; observedAt: number; session: string }
>();

function ringKey(symbol: string, expiry: string, strike: number, type: OptionType, day: string): string {
  return `${symbol}|${expiry}|${day}|${strike}|${type}`;
}

function contractKey(symbol: string, expiry: string, strike: number, type: OptionType): string {
  return `${symbol}|${expiry}|${strike}|${type}`;
}

/** Newest OI observation per contract — survives IST date rollover. */
const lastOiObservation = new Map<string, { oi: number; observedAt: number; session: string }>();

let _pruneCounter = 0;

export function __resetSellerIntelRing(): void {
  baselineRing.clear();
  lastOiObservation.clear();
  _pruneCounter = 0;
}

// ── DD-tab orchestrator ──────────────────────────────────────────────

export interface SellerIntelLeg {
  ltp?: number | null;
  oi?: number | null;
  oiChange?: number | null;
  oiChg?: number | null;
  volume?: number | null;
  iv?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
}

export interface SellerIntelInput {
  symbol: string;
  expiry: string;
  spot: number;
  lotSize: number;
  strikes: { strike: number; ce?: SellerIntelLeg | null; pe?: SellerIntelLeg | null }[];
  vwap: number | null;
  dayOpen: number;
  latestSignals: { type: string; side?: string; time?: number | string }[];
  nowMs?: number;
}

export interface SellerBoardRow {
  strike: number;
  type: OptionType;
  oi: number;
  oiChangeAbsolute: number;
  oiChangePct: number;
  oiChangeType: "INTRADAY" | "OVERNIGHT" | "UNVERIFIED" | "UNAVAILABLE";
  baselineTimestamp: number | null;
  baselineSession: string | null;
  baselineSource: OIBaselineSource;
  baselineValid: boolean;
  /** null when no valid previous premium baseline exists */
  premiumChangePct: number | null;
  /** OI change vs our own owned baseline (null when we own none). */
  intradayOiChangeAbsolute: number | null;
  /** OI change vs our own owned baseline (null when we own none). */
  intradayOiChangePct: number | null;
  classification: PositionClassification;
  score: number;
  volumeRatio: number;
  delta: number;
}

export interface SellerIntelExposure {
  callDex: number;
  putDex: number;
  netDex: number;
  totalGex: number;
  gammaFlip: number;
  dealerRegime: GEXResult["dealerRegime"] | "UNKNOWN";
  dealerBias: GEXResult["dealerBias"] | "UNKNOWN";
  gammaWalls: GEXResult["gammaWalls"];
}

export interface SellerIntelReport {
  symbol: string;
  asOf: string;
  lotSize: number;
  verdict: TradeCandidate;
  market: MarketConfirmation;
  zones: SellerZone[];
  topWriting: SellerBoardRow[];
  topCovering: SellerBoardRow[];
  exposure: SellerIntelExposure;
  dataNotes: string[];
}

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function legAnalysable(leg: SellerIntelLeg): boolean {
  return (
    num(leg.ltp) > 0 &&
    num(leg.oi) > 0 &&
    Number.isFinite(leg.delta as number) &&
    (leg.delta as number) !== null &&
    Number.isFinite(leg.gamma as number) &&
    (leg.gamma as number) !== null &&
    Number.isFinite(leg.theta as number) &&
    (leg.theta as number) !== null
  );
}

export function buildSellerIntel(input: SellerIntelInput): SellerIntelReport {
  const nowMs = input.nowMs ?? Date.now();
  const day = istDayKey(nowMs);
  const dataNotes: string[] = [];
  let missingBaseline = 0;
  let skippedNoGreeks = 0;

  // Chain median volume → honest relvol baseline (no fake history).
  const volumes: number[] = [];
  for (const s of input.strikes) {
    for (const leg of [s.ce, s.pe]) {
      if (leg && num(leg.volume) > 0 && legAnalysable(leg)) volumes.push(num(leg.volume));
    }
  }
  volumes.sort((a, b) => a - b);
  const medianVol = volumes.length
    ? volumes.length % 2
      ? volumes[(volumes.length - 1) / 2]
      : (volumes[volumes.length / 2 - 1] + volumes[volumes.length / 2]) / 2
    : 0;

  const ceAnalyses: SellerAnalysis[] = [];
  const peAnalyses: SellerAnalysis[] = [];
  const snapshots: OptionSnapshot[] = [];

  for (const s of input.strikes) {
    for (const [type, leg] of [
      ["CE", s.ce],
      ["PE", s.pe],
    ] as const) {
      if (!leg) continue;
      if (!legAnalysable(leg)) {
        if (leg && num(leg.ltp) > 0 && num(leg.oi) > 0) skippedNoGreeks++;
        continue;
      }

      const oi = num(leg.oi);
      const oiChange = leg.oiChange ?? leg.oiChg ?? null;
      if (oiChange == null || !Number.isFinite(oiChange)) {
        dataNotes.push(`${s.strike} ${type} skipped — missing ΔOI (cannot baseline)`);
        continue;
      }
      const previousOI = oi - oiChange;

      const premium = num(leg.ltp);
      const iv = num(leg.iv);
      const key = ringKey(input.symbol, input.expiry, s.strike, type, day);
      const contract = contractKey(input.symbol, input.expiry, s.strike, type);
      const base = baselineRing.get(key);

      // Owned OI baseline: same-session observation (INTRADAY) wins; else the
      // newest observation we own from an earlier session (OVERNIGHT). Only
      // when we own nothing do we fall back to the exchange-ΔOI reconstruction.
      // The durable store backs up the in-memory Maps across restarts: when the
      // ring is empty (new process or first observation of the day) we consult
      // durable storage before declaring the baseline unavailable.
      let ownedBaseline: OwnedOIBaseline | null = null;
      if (base) {
        ownedBaseline = { oi: base.oi, observedAt: base.observedAt, session: base.session };
      } else {
        // Same-session observation from a previous process instance today.
        const sessionFirst = getSessionFirstObservation(
          input.symbol,
          input.expiry,
          s.strike,
          type,
          day
        );
        if (sessionFirst && Number.isFinite(sessionFirst.oi) && sessionFirst.oi > 0) {
          ownedBaseline = {
            oi: sessionFirst.oi,
            observedAt: sessionFirst.observedAt,
            session: sessionFirst.session,
          };
        } else {
          const prior = lastOiObservation.get(contract);
          if (prior && Number.isFinite(prior.oi) && prior.oi > 0 && prior.session < day) {
            ownedBaseline = { oi: prior.oi, observedAt: prior.observedAt, session: prior.session };
          } else {
            const latestPrior = getLatestPriorObservation(
              input.symbol,
              input.expiry,
              s.strike,
              type,
              day
            );
            if (latestPrior && Number.isFinite(latestPrior.oi) && latestPrior.oi > 0) {
              ownedBaseline = {
                oi: latestPrior.oi,
                observedAt: latestPrior.observedAt,
                session: latestPrior.session,
              };
            }
          }
        }
        baselineRing.set(key, { premium, iv, oi, observedAt: nowMs, session: day });
        missingBaseline++;
      }
      lastOiObservation.set(contract, {
        oi,
        observedAt: nowMs,
        session: day,
      });

      // Persist the observation durably so it survives a restart. Best-effort:
      // a storage failure never fabricates a baseline — the caller simply has
      // no owned baseline for this contract until a new observation lands.
      recordOiObservation({
        symbol: input.symbol,
        expiry: input.expiry,
        strike: s.strike,
        type,
        oi,
        observedAt: nowMs,
        session: day,
        source: "seller-intelligence",
        provenance: "observed",
        quality: "OK",
        createdAt: nowMs,
      });

      _pruneCounter += 1;
      if (_pruneCounter % 50 === 0) pruneOldObservations();

      const previousPremium = base ? base.premium : premium;
      const previousIV = base ? base.iv : iv;

      const snap: OptionSnapshot = {
        symbol: input.symbol,
        expiry: input.expiry,
        strike: s.strike,
        type,
        underlyingPrice: input.spot,
        premium,
        previousPremium,
        oi,
        previousOI,
        volume: num(leg.volume),
        averageVolume: medianVol,
        delta: num(leg.delta),
        gamma: num(leg.gamma),
        theta: num(leg.theta),
        vega: num(leg.vega),
        iv,
        previousIV,
        lotSize: input.lotSize,
        timestamp: nowMs,
        oiBaseline: ownedBaseline,
      };
      snapshots.push(snap);
      const analysis = analyzeOption(snap);
      if (type === "CE") ceAnalyses.push(analysis);
      else peAnalyses.push(analysis);
    }
  }

  if (missingBaseline > 0) {
    dataNotes.push(
      `NO_PREMIUM_BASELINE — day-first observation for ${missingBaseline} leg(s); premium/IV change reads 0 until the next fetch`
    );
  }
  if (skippedNoGreeks > 0) {
    dataNotes.push(`${skippedNoGreeks} leg(s) skipped — no greeks (never analysed on delta 0)`);
  }

  const byStrikeType = new Map<string, { snap: OptionSnapshot; analysis: SellerAnalysis }>();
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const analysis = snap.type === "CE" ? ceAnalyses : peAnalyses;
    const a = analysis.find(x => x.strike === snap.strike);
    if (a) byStrikeType.set(`${snap.strike}|${snap.type}`, { snap, analysis: a });
  }

  // Boards: fresh OI being written / pulled — ranked by the matching score.
  const topWriting: SellerBoardRow[] = [];
  const topCovering: SellerBoardRow[] = [];
  for (const { snap, analysis } of byStrikeType.values()) {
    const oiChangeAbsolute = snap.oi - snap.previousOI;
    const row: SellerBoardRow = {
      strike: snap.strike,
      type: snap.type,
      oi: snap.oi,
      oiChangeAbsolute,
      oiChangePct: analysis.oiChangePct,
      oiChangeType: analysis.oiChangeType,
      baselineTimestamp: analysis.baselineTimestamp,
      baselineSession: analysis.baselineSession,
      baselineSource: analysis.baselineSource,
      baselineValid: analysis.baselineValid,
      intradayOiChangeAbsolute: analysis.intradayOiChangeAbsolute,
      intradayOiChangePct: analysis.intradayOiChangePct,
      premiumChangePct: analysis.premiumChangePct,
      classification: analysis.classification,
      score:
        analysis.writerPressureScore > 0 || analysis.coveringScore > 0
          ? Math.max(analysis.writerPressureScore, analysis.coveringScore)
          : magnitudeScore(
              analysis.oiChangePct,
              analysis.premiumChangePct,
              analysis.volumeRatio,
              analysis.oiChangePct > 0
            ),
      volumeRatio: analysis.volumeRatio,
      delta: analysis.delta,
    };
    if (analysis.oiChangePct >= DEFAULT_CONFIG.oiChangeThreshold) topWriting.push(row);
    if (analysis.oiChangePct <= -DEFAULT_CONFIG.oiChangeThreshold) topCovering.push(row);
  }
  topWriting.sort((a, b) => b.score - a.score || b.oiChangePct - a.oiChangePct);
  topCovering.sort((a, b) => b.score - a.score || a.oiChangePct - b.oiChangePct);

  const zones: SellerZone[] = [];
  for (const { snap, analysis } of byStrikeType.values()) {
    zones.push(calculateSellerZone(snap, analysis));
  }
  // Pressure first; on ties (flat tape / first fetch) prefer near-ATM so the
  // board doesn't open with deep-ITM strikes 5000 points away.
  zones.sort(
    (a, b) =>
      b.pressureScore - a.pressureScore ||
      Math.abs(a.strike - input.spot) - Math.abs(b.strike - input.spot)
  );

  // Market confirmation — caller supplies VWAP/day-open; signals must already
  // be scoped to the current session by the caller.
  const market: MarketConfirmation = {
    underlyingChangePct:
      input.dayOpen > 0 ? ((input.spot - input.dayOpen) / input.dayOpen) * 100 : 0,
    vwap: input.vwap,
    currentPrice: input.spot,
    breakoutConfirmed: input.latestSignals.some(s => s.type === "BREAKOUT"),
    retestConfirmed: input.latestSignals.some(s => s.type === "RETEST"),
  };

  const verdict = generateTradeCandidate(ceAnalyses, peAnalyses, market);

  // DEX (signed rupee delta) + GEX via the shared gex-engine.
  let callDex = 0;
  let putDex = 0;
  for (const snap of snapshots) {
    const e = calculateExposure(snap);
    if (snap.type === "CE") callDex += e.deltaExposure;
    else putDex += e.deltaExposure;
  }

  const gexStrikes: SDMOptionStrike[] = [];
  for (const s of input.strikes) {
    const ce = s.ce;
    const pe = s.pe;
    if (!ce || !pe) continue;
    if (
      !Number.isFinite(ce.gamma as number) ||
      !Number.isFinite(pe.gamma as number) ||
      num(ce.oi) <= 0 ||
      num(pe.oi) <= 0
    ) {
      continue;
    }
    gexStrikes.push({
      strike: s.strike,
      ce: {
        ltp: num(ce.ltp),
        oi: num(ce.oi),
        oiChg: num(ce.oiChange ?? ce.oiChg),
        volume: num(ce.volume),
        iv: num(ce.iv),
        delta: num(ce.delta),
        theta: num(ce.theta),
        gamma: num(ce.gamma),
        vega: num(ce.vega),
      },
      pe: {
        ltp: num(pe.ltp),
        oi: num(pe.oi),
        oiChg: num(pe.oiChange ?? pe.oiChg),
        volume: num(pe.volume),
        iv: num(pe.iv),
        delta: num(pe.delta),
        theta: num(pe.theta),
        gamma: num(pe.gamma),
        vega: num(pe.vega),
      },
    } as SDMOptionStrike);
  }

  let gex: GEXResult | null = null;
  if (gexStrikes.length > 0 && input.spot > 0) {
    try {
      gex = calculateGEX(gexStrikes, input.spot);
    } catch {
      gex = null;
      dataNotes.push("GEX computation failed — exposure gamma fields reported as 0");
    }
  }

  const exposure: SellerIntelExposure = {
    callDex,
    putDex,
    netDex: callDex + putDex,
    totalGex: gex?.totalGEX ?? 0,
    gammaFlip: gex?.gammaFlip ?? 0,
    dealerRegime: gex?.dealerRegime ?? "UNKNOWN",
    dealerBias: gex?.dealerBias ?? "UNKNOWN",
    gammaWalls: gex?.gammaWalls ?? [],
  };

  return {
    symbol: input.symbol,
    asOf: new Date(nowMs).toISOString(),
    lotSize: input.lotSize,
    verdict,
    market,
    zones: zones.slice(0, 12),
    topWriting: topWriting.slice(0, 6),
    topCovering: topCovering.slice(0, 6),
    exposure,
    dataNotes,
  };
}
