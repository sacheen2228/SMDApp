// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED SCORING ENGINE v2.0
// One centralized engine with 5 strategy profiles.
// Used by ALL SMD tabs — no duplicate scoring logic.
//
// Architecture:
//   Market Data → Data Validation → Market Regime → Strategy Detection
//   → Strategy Weight Profile → Hard Gates → Final Score → Opportunity Ranking
//   → Risk Engine → Entry/Exit Engine → Trade Decision
//
// CRITICAL: Score ≠ Probability. Score = quality of setup per the model.
// ═══════════════════════════════════════════════════════════════════════════

export const SCORING_VERSION = "2.0";

// ─── Strategy Profiles ─────────────────────────────────────────────

export type StrategyProfile = "EQUITY_SWING" | "FO" | "OPTIONS" | "CAS" | "HERO_ZERO" | "MCX_COMMODITY";

export interface FactorWeights {
  structure: number;
  mssBos: number;
  supertrend: number;
  oiDelta: number;
  volume: number;
  vwap: number;
  historical: number;
  orderBlock: number;
  fvg: number;
  liquidity: number;
  pcr: number;
  vix: number;
  greeksIv: number;
}

export const STRATEGY_PROFILES: Record<StrategyProfile, FactorWeights> = {
  EQUITY_SWING: {
    structure: 20, mssBos: 14, supertrend: 2, oiDelta: 3, volume: 14,
    vwap: 10, historical: 8, orderBlock: 7, fvg: 5, liquidity: 5,
    pcr: 2, vix: 3, greeksIv: 0,
  },
  FO: {
    structure: 18, mssBos: 12, supertrend: 2, oiDelta: 15, volume: 13,
    vwap: 8, historical: 7, orderBlock: 5, fvg: 4, liquidity: 6,
    pcr: 3, vix: 3, greeksIv: 0,
  },
  OPTIONS: {
    structure: 15, mssBos: 12, supertrend: 1, oiDelta: 14, volume: 14,
    vwap: 7, historical: 6, orderBlock: 5, fvg: 4, liquidity: 10,
    pcr: 4, vix: 5, greeksIv: 3,
  },
  CAS: {
    structure: 10, mssBos: 8, supertrend: 0, oiDelta: 15, volume: 15,
    vwap: 5, historical: 7, orderBlock: 4, fvg: 3, liquidity: 10,
    pcr: 6, vix: 8, greeksIv: 9,
  },
  HERO_ZERO: {
    structure: 15, mssBos: 12, supertrend: 0, oiDelta: 15, volume: 20,
    vwap: 5, historical: 3, orderBlock: 5, fvg: 5, liquidity: 10,
    pcr: 2, vix: 3, greeksIv: 5,
  },
  MCX_COMMODITY: {
    structure: 20, mssBos: 15, supertrend: 5, oiDelta: 15, volume: 15,
    vwap: 10, historical: 0, orderBlock: 0, fvg: 5, liquidity: 8,
    pcr: 0, vix: 0, greeksIv: 0,
  },
};

export function getProfileWeights(profile: StrategyProfile): FactorWeights {
  return { ...STRATEGY_PROFILES[profile] };
}

export function getWeightTotal(weights: FactorWeights): number {
  return Object.values(weights).reduce((s, w) => s + w, 0);
}

// ─── Factor Score Types ────────────────────────────────────────────

export interface FactorScore {
  factor: string;
  score: number;       // 0-100 raw score
  weighted: number;    // score * weight / 100
  weight: number;      // from profile
  available: boolean;  // false if data missing
  reason: string;
}

// ─── Market Data Input ─────────────────────────────────────────────

export interface MarketDataInput {
  // Instrument
  symbol: string;
  strategy: StrategyProfile;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";

  // Price data
  spot: number;
  candles?: Array<{
    time: number; open: number; high: number; low: number; close: number; volume: number;
  }>;
  prevClose?: number;
  dayHigh?: number;
  dayLow?: number;

  // Option data
  optionChain?: Array<{
    strike: number;
    ce?: { ltp: number; oi: number; oiChg: number; volume: number; iv: number; delta: number; theta: number; gamma: number; vega: number; bid?: number; ask?: number; } | null;
    pe?: { ltp: number; oi: number; oiChg: number; volume: number; iv: number; delta: number; theta: number; gamma: number; vega: number; bid?: number; ask?: number; } | null;
  }>;
  pcr?: number;
  maxPain?: number;
  callWall?: number;
  putFloor?: number;

  // Futures data
  futures?: { ltp: number; basis: number; basisPercent: number; oi: number; oiChange: number; volume: number; };

  // Volatility
  vix?: number;
  ivRank?: number;
  ivPercentile?: number;
  atr?: number;
  atrPercent?: number;

  // Volume
  avgVolume?: number;
  currentVolume?: number;
  relativeVolume?: number;
  deliveryPercent?: number;

  // Technical
  rsi?: number;
  ema9?: number;
  ema21?: number;
  ema50?: number;
  ema200?: number;
  adx?: number;
  macd?: number;
  macdSignal?: number;
  bollingerUpper?: number;
  bollingerLower?: number;
  bollingerMid?: number;
  vwap?: number;

  // Market structure
  marketStructure?: "BULLISH" | "BEARISH" | "NEUTRAL";
  swingHigh?: number;
  swingLow?: number;
  support?: number[];
  resistance?: number[];

  // MSS / SuperTrend (from mss-engine.ts and supertrend-engine.ts)
  mssBias?: "BULLISH" | "BEARISH" | "NEUTRAL";
  mssSweepGated?: boolean;
  mssScore?: number;
  supertrendDirection?: "UP" | "DOWN" | "NEUTRAL";
  supertrendAligned?: boolean;
  supertrendScore?: number;

  // Order blocks / FVG
  orderBlocks?: Array<{ price: number; direction: "BULLISH" | "BEARISH"; }>;
  fvgs?: Array<{ price: number; direction: "BULLISH" | "BEARISH"; }>;

  // Liquidity
  liquidityLevels?: Array<{ price: number; type: string; swept: boolean; }>;

  // Institutional
  fiiNet?: number;
  diiNet?: number;

  // News
  newsScore?: number;
  newsHeadlines?: Array<{ title: string; sentiment: number; source: string; timestamp: number; }>;

  // Historical
  historicalWinRate?: number;
  historicalRR?: number;

  // Market context
  regime?: string;
  regimeConfidence?: number;
  breadthScore?: number;
  sessionPhase?: string;
  isMarketOpen?: boolean;
  daysToExpiry?: number;

  // Risk
  capital?: number;
  riskPercent?: number;
  maxPositionSize?: number;
  lotSize?: number;

  // Data quality
  dataSource?: string;
  dataTimestamp?: number;
  dataLatencyMs?: number;

  // Trade parameters (if computing entry/SL/TP)
  entryPrice?: number;
  stopLoss?: number;
  target1?: number;
  target2?: number;
  target3?: number;
}

// ─── Hard Gate Types ───────────────────────────────────────────────

export type GateStatus = "PASS" | "FAIL" | "WARN" | "SKIP";

export interface HardGate {
  name: string;
  status: GateStatus;
  reason: string;
  required: boolean;
}

export interface HardGateResult {
  passed: boolean;
  gates: HardGate[];
  failedGates: string[];
  warningGates: string[];
}

// ─── Trade Decision Types ──────────────────────────────────────────

export type TradeDecisionType = "TRADE" | "WATCH" | "NO_TRADE";

export interface TradeDecision {
  // Identity
  symbol: string;
  strategy: StrategyProfile;
  instrument: string;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "LONG" | "SHORT" | "CALL" | "PUT" | "NO_TRADE";

  // Scoring
  score: number;               // 0-100 composite
  scoreBreakdown: FactorScore[];
  grade: "A+" | "A" | "B" | "WATCH" | "NO_TRADE";

  // Hard gates
  hardGateStatus: HardGateResult;

  // Trade parameters
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  target3?: number;
  riskReward: number;
  maxLoss: number;
  expectedReward: number;

  // Context
  marketRegime: string;
  newsImpact: string;
  liquidityStatus: string;

  // Decision
  decision: TradeDecisionType;
  reasons: string[];
  invalidation: string;

  // Metadata
  scoringVersion: string;
  strategyProfile: StrategyProfile;
  weightsUsed: FactorWeights;
  scoreAtEntry: number;
  hardGatesAtEntry: HardGateResult;
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTOR SCORING FUNCTIONS
// Each returns 0-100. Returns null if data unavailable.
// ═══════════════════════════════════════════════════════════════════════════

function scoreStructure(input: MarketDataInput): FactorScore {
  const w = STRATEGY_PROFILES[input.strategy].structure;
  const ms = input.marketStructure;
  const hasSwings = (input.swingHigh ?? 0) > 0 && (input.swingLow ?? 0) > 0;
  const hasSR = (input.support?.length ?? 0) > 0 || (input.resistance?.length ?? 0) > 0;

  if (!ms && !hasSwings) {
    return { factor: "structure", score: 0, weighted: 0, weight: w, available: false, reason: "No market structure data" };
  }

  let score = 30;
  if (ms === "BULLISH" || ms === "BEARISH") score += 25;
  if (hasSwings) score += 20;
  if (hasSR) score += 15;
  if (input.adx && input.adx > 20) score += 10;

  const aligned = (input.direction === "BULLISH" && ms === "BULLISH") ||
                  (input.direction === "BEARISH" && ms === "BEARISH");
  if (aligned) score += 10;

  score = Math.min(100, Math.max(0, score));
  return {
    factor: "structure", score, weighted: Math.round(score * w / 100), weight: w, available: true,
    reason: `${ms || "NEUTRAL"} structure${aligned ? " — aligned with direction" : ""}`,
  };
}

function scoreMSS(input: MarketDataInput): FactorScore {
  const w = STRATEGY_PROFILES[input.strategy].mssBos;
  const bias = input.mssBias;
  const sweepGated = input.mssSweepGated ?? false;
  const mssScore = input.mssScore ?? 50;

  if (!bias || bias === "NEUTRAL") {
    return { factor: "mssBos", score: 50, weighted: Math.round(50 * w / 100), weight: w, available: false, reason: "MSS neutral or unavailable" };
  }

  const aligned = bias === input.direction;
  let score = 50;
  if (aligned) {
    score = sweepGated ? Math.min(100, mssScore + 20) : Math.min(100, mssScore + 10);
  } else {
    score = sweepGated ? 20 : 35;
  }

  return {
    factor: "mssBos", score, weighted: Math.round(score * w / 100), weight: w, available: true,
    reason: `MSS ${bias}${sweepGated ? " sweep-gated" : ""}${aligned ? " — aligned" : " — counter"}`,
  };
}

function scoreSuperTrend(input: MarketDataInput): FactorScore {
  const w = STRATEGY_PROFILES[input.strategy].supertrend;
  if (w === 0) return { factor: "supertrend", score: 0, weighted: 0, weight: 0, available: true, reason: "SuperTrend disabled for this profile" };

  const dir = input.supertrendDirection;
  const aligned = input.supertrendAligned ?? false;

  if (!dir || dir === "NEUTRAL") {
    return { factor: "supertrend", score: 50, weighted: Math.round(50 * w / 100), weight: w, available: false, reason: "SuperTrend neutral or unavailable" };
  }

  const score = aligned ? 85 : 30;
  return {
    factor: "supertrend", score, weighted: Math.round(score * w / 100), weight: w, available: true,
    reason: `SuperTrend ${dir}${aligned ? " — aligned" : " — counter"}`,
  };
}

function scoreOIDelta(input: MarketDataInput): FactorScore {
  const w = STRATEGY_PROFILES[input.strategy].oiDelta;
  const chain = input.optionChain;
  const pcr = input.pcr;
  const spot = input.spot;

  if (!chain && pcr == null) {
    return { factor: "oiDelta", score: 0, weighted: 0, weight: w, available: false, reason: "No OI/option data" };
  }

  let score = 50;

  // PCR scoring
  if (pcr != null) {
    if (input.direction === "BULLISH") {
      if (pcr > 1.2) score += 20;
      else if (pcr > 1.0) score += 10;
      else if (pcr < 0.8) score -= 15;
    } else if (input.direction === "BEARISH") {
      if (pcr < 0.8) score += 20;
      else if (pcr < 1.0) score += 10;
      else if (pcr > 1.2) score -= 15;
    }
  }

  // OI buildup
  if (chain && spot > 0) {
    const near = chain.filter(s => s.strike && Math.abs(s.strike - spot) / spot < 0.03);
    let buildup = 0;
    for (const s of near) {
      if (input.direction === "BULLISH" && s.ce && s.ce.oiChg > 0) buildup += s.ce.oiChg;
      if (input.direction === "BEARISH" && s.pe && s.pe.oiChg > 0) buildup += s.pe.oiChg;
    }
    if (buildup > 200000) score += 15;
    else if (buildup > 50000) score += 8;
  }

  // Futures OI
  if (input.futures) {
    const basis = input.futures.basis;
    if (input.direction === "BULLISH" && basis > 0) score += 5;
    if (input.direction === "BEARISH" && basis < 0) score += 5;
  }

  score = Math.min(100, Math.max(0, score));
  return {
    factor: "oiDelta", score, weighted: Math.round(score * w / 100), weight: w, available: true,
    reason: `OI ${pcr ? `PCR ${pcr.toFixed(2)}` : "data available"}`,
  };
}

function scoreVolume(input: MarketDataInput): FactorScore {
  const w = STRATEGY_PROFILES[input.strategy].volume;
  const rvol = input.relativeVolume;
  const avgVol = input.avgVolume;
  const curVol = input.currentVolume;

  if (rvol == null && avgVol == null && curVol == null) {
    return { factor: "volume", score: 0, weighted: 0, weight: w, available: false, reason: "No volume data" };
  }

  let score = 50;
  const rv = rvol ?? (avgVol && avgVol > 0 && curVol ? curVol / avgVol : 1);

  if (rv > 3) score = 95;
  else if (rv > 2) score = 85;
  else if (rv > 1.5) score = 75;
  else if (rv > 1.2) score = 65;
  else if (rv > 0.8) score = 50;
  else if (rv > 0.5) score = 35;
  else score = 20;

  // Delivery quality bonus
  if (input.deliveryPercent && input.deliveryPercent > 60) score += 10;
  if (input.deliveryPercent && input.deliveryPercent < 25) score -= 10;

  score = Math.min(100, Math.max(0, score));
  return {
    factor: "volume", score, weighted: Math.round(score * w / 100), weight: w, available: true,
    reason: `RelVol ${rv.toFixed(1)}x${input.deliveryPercent ? ` delivery ${input.deliveryPercent}%` : ""}`,
  };
}

function scoreVWAP(input: MarketDataInput): FactorScore {
  const w = STRATEGY_PROFILES[input.strategy].vwap;
  const spot = input.spot;
  const vwap = input.vwap;

  if (!vwap || vwap <= 0 || spot <= 0) {
    return { factor: "vwap", score: 50, weighted: Math.round(50 * w / 100), weight: w, available: false, reason: "VWAP unavailable" };
  }

  const distPct = Math.abs(spot - vwap) / vwap;
  let score = 50;

  if (input.direction === "BULLISH") {
    if (spot > vwap) {
      score = distPct < 0.005 ? 90 : distPct < 0.01 ? 80 : distPct < 0.02 ? 70 : 60;
    } else {
      score = distPct < 0.005 ? 40 : distPct < 0.01 ? 30 : 20;
    }
  } else if (input.direction === "BEARISH") {
    if (spot < vwap) {
      score = distPct < 0.005 ? 90 : distPct < 0.01 ? 80 : distPct < 0.02 ? 70 : 60;
    } else {
      score = distPct < 0.005 ? 40 : distPct < 0.01 ? 30 : 20;
    }
  } else {
    score = distPct < 0.005 ? 70 : distPct < 0.01 ? 60 : 50;
  }

  return {
    factor: "vwap", score, weighted: Math.round(score * w / 100), weight: w, available: true,
    reason: `Spot ${spot > vwap ? "above" : "below"} VWAP (${(distPct * 100).toFixed(2)}%)`,
  };
}

function scoreHistorical(input: MarketDataInput): FactorScore {
  const w = STRATEGY_PROFILES[input.strategy].historical;
  const wr = input.historicalWinRate;
  const rr = input.historicalRR;

  if (wr == null && rr == null) {
    return { factor: "historical", score: 0, weighted: 0, weight: w, available: false, reason: "No historical data" };
  }

  let score = 50;
  if (wr != null) score = Math.round(wr * 100);
  if (rr != null && rr > 2) score = Math.min(100, score + 15);

  return {
    factor: "historical", score, weighted: Math.round(score * w / 100), weight: w, available: true,
    reason: `WR ${wr ? (wr * 100).toFixed(0) : "?"}%${rr ? ` R:R ${rr.toFixed(1)}` : ""}`,
  };
}

function scoreOrderBlock(input: MarketDataInput): FactorScore {
  const w = STRATEGY_PROFILES[input.strategy].orderBlock;
  const obs = input.orderBlocks;

  if (!obs || obs.length === 0) {
    return { factor: "orderBlock", score: 30, weighted: Math.round(30 * w / 100), weight: w, available: false, reason: "No order blocks detected" };
  }

  const aligned = obs.filter(ob => ob.direction === input.direction).length;
  const score = aligned > 0 ? Math.min(100, 60 + aligned * 15) : 40;

  return {
    factor: "orderBlock", score, weighted: Math.round(score * w / 100), weight: w, available: true,
    reason: `${obs.length} OB(s), ${aligned} aligned`,
  };
}

function scoreFVG(input: MarketDataInput): FactorScore {
  const w = STRATEGY_PROFILES[input.strategy].fvg;
  const fvgs = input.fvgs;

  if (!fvgs || fvgs.length === 0) {
    return { factor: "fvg", score: 30, weighted: Math.round(30 * w / 100), weight: w, available: false, reason: "No FVGs detected" };
  }

  const aligned = fvgs.filter(f => f.direction === input.direction).length;
  const score = aligned > 0 ? Math.min(100, 60 + aligned * 15) : 35;

  return {
    factor: "fvg", score, weighted: Math.round(score * w / 100), weight: w, available: true,
    reason: `${fvgs.length} FVG(s), ${aligned} aligned`,
  };
}

function scoreLiquidity(input: MarketDataInput): FactorScore {
  const w = STRATEGY_PROFILES[input.strategy].liquidity;
  const levels = input.liquidityLevels;
  const avgVol = input.avgVolume;

  let score = 50;

  // Volume-based liquidity
  if (avgVol != null) {
    if (avgVol > 1000000) score += 20;
    else if (avgVol > 500000) score += 10;
    else if (avgVol < 100000) score -= 15;
  }

  // Option liquidity
  if (input.optionChain) {
    const near = input.optionChain.filter(s => s.strike && input.spot > 0 && Math.abs(s.strike - input.spot) / input.spot < 0.03);
    const totalOI = near.reduce((s, st) => {
      if (st.ce) s += st.ce.oi;
      if (st.pe) s += st.pe.oi;
      return s;
    }, 0);
    if (totalOI > 5000000) score += 15;
    else if (totalOI > 1000000) score += 8;
    else if (totalOI < 100000) score -= 10;
  }

  // Spread check
  if (input.optionChain && input.spot > 0) {
    const atm = input.optionChain.reduce((best, s) =>
      Math.abs(s.strike - input.spot) < Math.abs(best.strike - input.spot) ? s : best
    );
    if (atm.ce && atm.ce.bid && atm.ce.ask) {
      const spread = (atm.ce.ask - atm.ce.bid) / atm.ce.ask;
      if (spread > 0.05) score -= 20;
      else if (spread > 0.03) score -= 10;
    }
  }

  score = Math.min(100, Math.max(0, score));
  return {
    factor: "liquidity", score, weighted: Math.round(score * w / 100), weight: w, available: true,
    reason: `Liquidity score ${score}/100`,
  };
}

function scorePCR(input: MarketDataInput): FactorScore {
  const w = STRATEGY_PROFILES[input.strategy].pcr;
  const pcr = input.pcr;

  if (pcr == null) {
    return { factor: "pcr", score: 50, weighted: Math.round(50 * w / 100), weight: w, available: false, reason: "PCR unavailable" };
  }

  let score = 50;
  if (input.direction === "BULLISH") {
    if (pcr > 1.3) score = 90;
    else if (pcr > 1.1) score = 75;
    else if (pcr > 0.9) score = 55;
    else if (pcr > 0.7) score = 35;
    else score = 20;
  } else if (input.direction === "BEARISH") {
    if (pcr < 0.7) score = 90;
    else if (pcr < 0.9) score = 75;
    else if (pcr < 1.1) score = 55;
    else if (pcr < 1.3) score = 35;
    else score = 20;
  }

  return {
    factor: "pcr", score, weighted: Math.round(score * w / 100), weight: w, available: true,
    reason: `PCR ${pcr.toFixed(2)}`,
  };
}

function scoreVIX(input: MarketDataInput): FactorScore {
  const w = STRATEGY_PROFILES[input.strategy].vix;
  const vix = input.vix;

  if (vix == null || vix <= 0) {
    return { factor: "vix", score: 50, weighted: Math.round(50 * w / 100), weight: w, available: false, reason: "VIX unavailable" };
  }

  let score = 50;
  if (vix >= 12 && vix <= 20) score = 90;
  else if (vix >= 10 && vix <= 25) score = 75;
  else if (vix >= 8 && vix <= 30) score = 60;
  else if (vix > 30) score = 30;
  else if (vix < 8) score = 40;

  return {
    factor: "vix", score, weighted: Math.round(score * w / 100), weight: w, available: true,
    reason: `VIX ${vix.toFixed(1)} — ${vix > 30 ? "EXTREME" : vix > 25 ? "HIGH" : vix > 20 ? "ELEVATED" : vix > 12 ? "NORMAL" : "LOW"}`,
  };
}

function scoreGreeksIV(input: MarketDataInput): FactorScore {
  const w = STRATEGY_PROFILES[input.strategy].greeksIv;
  if (w === 0) return { factor: "greeksIv", score: 0, weighted: 0, weight: 0, available: true, reason: "Greeks/IV disabled for this profile" };

  const chain = input.optionChain;
  const spot = input.spot;
  const ivRank = input.ivRank;

  if (!chain || spot <= 0) {
    return { factor: "greeksIv", score: 50, weighted: Math.round(50 * w / 100), weight: w, available: false, reason: "No option data for Greeks" };
  }

  let score = 50;

  // IV Rank scoring
  if (ivRank != null) {
    if (input.strategy === "OPTIONS" || input.strategy === "CAS") {
      // For option buying: low IV = cheap premiums = good
      if (ivRank < 30) score += 20;
      else if (ivRank < 50) score += 10;
      else if (ivRank > 70) score -= 10;
    }
  }

  // Greeks quality at ATM
  const atm = chain.reduce((best, s) =>
    Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best
  );
  if (atm.ce && Math.abs(atm.ce.delta) >= 0.20 && Math.abs(atm.ce.delta) <= 0.60) score += 15;
  if (atm.pe && Math.abs(atm.pe.delta) >= 0.20 && Math.abs(atm.pe.delta) <= 0.60) score += 10;

  score = Math.min(100, Math.max(0, score));
  return {
    factor: "greeksIv", score, weighted: Math.round(score * w / 100), weight: w, available: true,
    reason: `IV Rank ${ivRank ?? "?"}% — Greeks assessed`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTOR DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════

const FACTOR_FUNCTIONS: Record<string, (input: MarketDataInput) => FactorScore> = {
  structure: scoreStructure,
  mssBos: scoreMSS,
  supertrend: scoreSuperTrend,
  oiDelta: scoreOIDelta,
  volume: scoreVolume,
  vwap: scoreVWAP,
  historical: scoreHistorical,
  orderBlock: scoreOrderBlock,
  fvg: scoreFVG,
  liquidity: scoreLiquidity,
  pcr: scorePCR,
  vix: scoreVIX,
  greeksIv: scoreGreeksIV,
};

export function computeAllFactors(input: MarketDataInput): FactorScore[] {
  return Object.entries(FACTOR_FUNCTIONS).map(([key, fn]) => fn(input));
}

// ═══════════════════════════════════════════════════════════════════════════
// HARD GATE ENGINE
// ═══════════════════════════════════════════════════════════════════════════

function runHardGates(input: MarketDataInput): HardGateResult {
  const gates: HardGate[] = [];

  // 1. DATA VALIDATION
  const dataIssues: string[] = [];
  const dataWarnings: string[] = [];
  if (!input.spot || input.spot <= 0) dataIssues.push("spot price missing");
  if (!input.candles || input.candles.length < 5) dataWarnings.push("insufficient candles");
  if (input.dataLatencyMs && input.dataLatencyMs > 30000) dataIssues.push("data stale (>30s)");
  if (input.dataTimestamp) {
    const age = Date.now() - input.dataTimestamp;
    if (age > 300000) dataIssues.push("data timestamp >5min old");
  }
  gates.push({
    name: "DATA_VALIDATION",
    status: dataIssues.length > 0 ? "FAIL" : dataWarnings.length > 0 ? "WARN" : "PASS",
    reason: dataIssues.length > 0 ? dataIssues.join("; ") : dataWarnings.length > 0 ? dataWarnings.join("; ") : "Data valid",
    required: dataIssues.length > 0,
  });

  // 2. LIQUIDITY
  const liqIssues: string[] = [];
  const isMCX = input.strategy === "MCX_COMMODITY";
  const avgVol = input.avgVolume ?? input.currentVolume;
  // MCX has lower volume thresholds than NSE
  const liqThreshold = isMCX ? 500 : 50000;
  if (avgVol != null && avgVol < liqThreshold) liqIssues.push(`avg volume ${avgVol} < ${liqThreshold}`);
  if (input.optionChain && input.spot > 0) {
    const near = input.optionChain.filter(s => Math.abs(s.strike - input.spot) / input.spot < 0.03);
    const totalOI = near.reduce((s, st) => {
      if (st.ce) s += st.ce.oi;
      if (st.pe) s += st.pe.oi;
      return s;
    }, 0);
    if (totalOI < 50000) liqIssues.push(`option OI ${totalOI} < 50K`);
    // Spread check
    const atm = near.reduce((best, s) =>
      Math.abs(s.strike - input.spot) < Math.abs(best.strike - input.spot) ? s : best
    );
    if (atm.ce && atm.ce.bid && atm.ce.ask) {
      const spread = (atm.ce.ask - atm.ce.bid) / atm.ce.ask;
      if (spread > 0.10) liqIssues.push(`spread ${(spread * 100).toFixed(1)}% > 10%`);
    }
  }
  // Strategy-specific liquidity requirements
  if (input.strategy === "HERO_ZERO" || input.strategy === "OPTIONS") {
    if (avgVol != null && avgVol < 100000) liqIssues.push("insufficient liquidity for options strategy");
  }
  gates.push({
    name: "LIQUIDITY",
    status: liqIssues.length > 0 ? "FAIL" : "PASS",
    reason: liqIssues.length > 0 ? liqIssues.join("; ") : "Liquidity sufficient",
    required: !isMCX, // MCX: warn only, don't block
  });

  // 3. MARKET REGIME
  const regimeIssues: string[] = [];
  const vix = input.vix;
  // MCX doesn't have India VIX — skip VIX checks for MCX
  if (!isMCX) {
    if (vix != null && vix > 35) regimeIssues.push(`VIX ${vix.toFixed(1)} — extreme volatility`);
    if (input.strategy === "HERO_ZERO") {
      if (vix != null && vix > 30) regimeIssues.push("Hero-Zero not suitable in extreme VIX");
      if (vix != null && vix < 10) regimeIssues.push("Hero-Zero needs volatility to profit");
    }
  }
  gates.push({
    name: "MARKET_REGIME",
    status: regimeIssues.length > 0 ? "FAIL" : "PASS",
    reason: regimeIssues.length > 0 ? regimeIssues.join("; ") : (isMCX ? "MCX regime check skipped (no VIX)" : "Regime acceptable"),
    required: true,
  });

  // 4. RISK/REWARD
  const rrIssues: string[] = [];
  if (input.entryPrice && input.stopLoss && input.target1) {
    const risk = Math.abs(input.entryPrice - input.stopLoss);
    const reward = Math.abs(input.target1 - input.entryPrice);
    if (risk <= 0) rrIssues.push("stop loss at entry");
    else {
      const rr = reward / risk;
      if (rr < 1.0) rrIssues.push(`R:R ${rr.toFixed(1)} < 1.0`);
    }
  }
  // For MCX: check ATR-based R:R if explicit levels not provided
  if (isMCX && input.atr && input.spot && rrIssues.length === 0) {
    const atrRr = (input.atr * 2.5) / (input.atr * 1.5); // target 2.5x ATR, SL 1.5x ATR
    // This is informational — don't block
  }
  gates.push({
    name: "RISK_REWARD",
    status: rrIssues.length > 0 ? "FAIL" : "PASS",
    reason: rrIssues.length > 0 ? rrIssues.join("; ") : "R:R acceptable",
    required: !isMCX, // MCX: scanner computes its own levels
  });

  // 5. PRICE/OPTION DATA QUALITY
  const qualityIssues: string[] = [];
  if (input.optionChain && input.spot > 0) {
    const strikesWithZeroLTP = input.optionChain.filter(s => {
      if (s.strike === input.spot) return false; // skip ATM
      return (s.ce && s.ce.ltp <= 0) || (s.pe && s.pe.ltp <= 0);
    }).length;
    if (strikesWithZeroLTP > input.optionChain.length * 0.3) {
      qualityIssues.push(`${strikesWithZeroLTP} strikes with zero LTP`);
    }
  }
  // MCX doesn't have India VIX — skip VIX check
  if (!isMCX && input.vix != null && input.vix <= 0) qualityIssues.push("VIX is zero");
  gates.push({
    name: "DATA_QUALITY",
    status: qualityIssues.length > 0 ? "FAIL" : "PASS",
    reason: qualityIssues.length > 0 ? qualityIssues.join("; ") : "Data quality OK",
    required: true,
  });

  // 6. EXPECTED MOVE (for options/CAS)
  if (input.strategy === "OPTIONS" || input.strategy === "CAS") {
    const emIssues: string[] = [];
    if (input.vix && input.spot && input.daysToExpiry && input.entryPrice) {
      const expectedMove = input.spot * (input.vix / 100) * Math.sqrt(Math.max(1, input.daysToExpiry) / 365);
      if (expectedMove < input.entryPrice * 0.5) {
        emIssues.push(`expected move ₹${expectedMove.toFixed(0)} < 50% of premium ₹${input.entryPrice.toFixed(0)}`);
      }
    }
    gates.push({
      name: "EXPECTED_MOVE",
      status: emIssues.length > 0 ? "FAIL" : "PASS",
      reason: emIssues.length > 0 ? emIssues.join("; ") : "Expected move justifies premium",
      required: true,
    });
  }

  const failedGates = gates.filter(g => g.status === "FAIL" && g.required).map(g => g.name);
  const warningGates = gates.filter(g => g.status === "WARN").map(g => g.name);

  return {
    passed: failedGates.length === 0,
    gates,
    failedGates,
    warningGates,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

export function scoreTrade(input: MarketDataInput): TradeDecision {
  const weights = getProfileWeights(input.strategy);

  // 1. Compute all factor scores
  const factors = computeAllFactors(input);

  // 2. Compute weighted composite score (normalize by actual available weight)
  const totalWeight = getWeightTotal(weights);
  const rawScore = factors.reduce((sum, f) => sum + f.weighted, 0);
  // For MCX: normalize by sum of weights that have data (not all factors available)
  const availableWeight = factors.filter(f => f.available).reduce((sum, f) => sum + f.weight, 0);
  const isMCXProfile = input.strategy === "MCX_COMMODITY";
  const effectiveWeight = isMCXProfile ? Math.max(availableWeight, totalWeight * 0.5) : totalWeight;
  const score = effectiveWeight > 0 ? Math.round((rawScore / effectiveWeight) * 100) : 0;
  const normalizedScore = Math.min(100, Math.max(0, score));

  // 3. Run hard gates
  const hardGates = runHardGates(input);

  // 4. Determine grade
  let grade: TradeDecision["grade"];
  if (normalizedScore >= 90) grade = "A+";
  else if (normalizedScore >= 80) grade = "A";
  else if (normalizedScore >= 70) grade = "WATCH";
  else if (normalizedScore >= 60) grade = "NO_TRADE";
  else grade = "NO_TRADE";

  // 5. Final decision — hard gates override score
  let decision: TradeDecisionType;
  const reasons: string[] = [];

  if (!hardGates.passed) {
    decision = "NO_TRADE";
    reasons.push(`Hard gate failure: ${hardGates.failedGates.join(", ")}`);
  } else if (grade === "NO_TRADE") {
    decision = "NO_TRADE";
    reasons.push(`Score ${normalizedScore}/100 below minimum threshold`);
  } else if (grade === "WATCH") {
    decision = "WATCH";
    reasons.push(`Score ${normalizedScore}/100 — watching for confirmation`);
  } else {
    decision = "TRADE";
    reasons.push(`Score ${normalizedScore}/100 — ${grade} grade`);
  }

  // Add factor reasons
  for (const f of factors) {
    if (f.available && f.score >= 70) reasons.push(`✓ ${f.factor}: ${f.reason}`);
  }

  // 6. Compute entry/SL/TP if not provided
  let entry = input.entryPrice ?? 0;
  let stopLoss = input.stopLoss ?? 0;
  let target1 = input.target1 ?? 0;
  let target2 = input.target2 ?? 0;
  let target3 = input.target3;
  let riskReward = 0;
  let maxLoss = 0;
  let expectedReward = 0;

  if (entry > 0 && stopLoss > 0 && target1 > 0) {
    const risk = Math.abs(entry - stopLoss);
    const reward = Math.abs(target1 - entry);
    riskReward = risk > 0 ? reward / risk : 0;
    const lotSize = input.lotSize ?? 1;
    const qty = input.maxPositionSize ?? 1;
    maxLoss = risk * qty;
    expectedReward = reward * qty;
  }

  // 7. Build trade decision
  const now = Date.now();
  const decision2: TradeDecision = {
    symbol: input.symbol,
    strategy: input.strategy,
    instrument: `${input.symbol} ${input.strategy}`,
    direction: decision === "TRADE" ? (input.direction === "BULLISH" ? "LONG" : input.direction === "BEARISH" ? "SHORT" : "NO_TRADE") : "NO_TRADE",

    score: normalizedScore,
    scoreBreakdown: factors,
    grade,

    hardGateStatus: hardGates,

    entry: Math.round(entry * 100) / 100,
    stopLoss: Math.round(stopLoss * 100) / 100,
    target1: Math.round(target1 * 100) / 100,
    target2: Math.round(target2 * 100) / 100,
    target3: target3 != null ? Math.round(target3 * 100) / 100 : undefined,
    riskReward: Math.round(riskReward * 10) / 10,
    maxLoss: Math.round(maxLoss),
    expectedReward: Math.round(expectedReward),

    marketRegime: input.regime ?? "UNKNOWN",
    newsImpact: input.newsScore != null ? (input.newsScore > 20 ? "POSITIVE" : input.newsScore < -20 ? "NEGATIVE" : "NEUTRAL") : "NO NEWS",
    liquidityStatus: hardGates.gates.find(g => g.name === "LIQUIDITY")?.status ?? "UNKNOWN",

    decision,
    reasons,
    invalidation: `Structure break${input.swingLow ? ` below ${input.swingLow}` : ""}`,

    scoringVersion: SCORING_VERSION,
    strategyProfile: input.strategy,
    weightsUsed: weights,
    scoreAtEntry: normalizedScore,
    hardGatesAtEntry: hardGates,
    timestamp: now,
  };

  return decision2;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONVENIENCE: Score multiple candidates and rank
// ═══════════════════════════════════════════════════════════════════════════

export function scoreAndRank(
  candidates: MarketDataInput[],
  maxResults: number = 10
): TradeDecision[] {
  const scored = candidates.map(c => scoreTrade(c));
  return scored
    .filter(d => d.decision !== "NO_TRADE" || d.grade === "WATCH")
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCORE DISPLAY HELPER — clarifies Score ≠ Probability
// ═══════════════════════════════════════════════════════════════════════════

export function formatScoreDisplay(score: number, grade: string): string {
  return `${score}/100 — ${grade} (setup quality, not probability)`;
}

export function getScoreInterpretation(score: number): string {
  if (score >= 90) return "Excellent setup quality — strong confluence of factors";
  if (score >= 80) return "High-quality setup — most factors aligned";
  if (score >= 70) return "Good setup — watch for confirmation";
  if (score >= 60) return "Marginal setup — insufficient confluence";
  return "Poor setup — avoid";
}
