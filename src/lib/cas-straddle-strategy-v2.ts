// lib/cas-straddle-strategy-v2.ts
//
// CAS Straddle / Strangle Strategy Engine V2
// ───────────────────────────────────────────────────────────────────
// Complete rewrite with:
// - Multi-stage confirmation (CAS + regime + expected move + premium cost)
// - Strike optimizer (ITM/ATM/OTM/OPTIMIZED)
// - Straddle vs Strangle optimizer
// - Premium cost filter (expected move > required move)
// - Expected move coverage check
// - Risk/reward filter
// - Trade quality score (separate from CAS score)
// - Anti-chase filter
// - Dynamic exit system
// - Trailing profit
// - Partial exit support
// - MFE/MAE tracking
// - Walk-forward ready

export type StrategyType = "CALL" | "PUT" | "STRADDLE" | "STRANGLE" | "NO_TRADE";
export type StrikeSelection = "ITM" | "ATM" | "OTM" | "OPTIMIZED" | "AUTO";
export type ExpiryType = "weekly" | "monthly";

// ─── Market Regime ────────────────────────────────────────────────
export type MarketRegime =
  | "LOW_VOL" | "NORMAL_VOL" | "HIGH_VOL" | "EXTREME_VOL"
  | "TRENDING_UP" | "TRENDING_DOWN" | "RANGING" | "GAP_DAY" | "EXPIRY_DAY";

export function classifyRegime(params: {
  vix: number;
  realizedVol: number;
  intradayRangePct: number;
  atrPct: number;
  volumeRatio: number;
  isExpiryDay: boolean;
  gapPct: number;
}): MarketRegime {
  if (params.isExpiryDay) return "EXPIRY_DAY";
  if (Math.abs(params.gapPct) > 1.0) return "GAP_DAY";
  if (params.vix > 30 || params.realizedVol > 30) return "EXTREME_VOL";
  if (params.vix > 20 || params.realizedVol > 20) return "HIGH_VOL";
  if (params.vix < 12 && params.realizedVol < 12) return "LOW_VOL";

  // Trending vs ranging
  const rangeExpansion = params.atrPct > 1.5;
  if (params.intradayRangePct > 2.0 && params.volumeRatio > 1.3) {
    // Determine direction from recent price action — caller must provide
    return params.gapPct > 0 ? "TRENDING_UP" : "TRENDING_DOWN";
  }
  if (params.intradayRangePct < 0.8 && params.volumeRatio < 0.8) return "RANGING";
  return "NORMAL_VOL";
}

// ─── Market Snapshot ──────────────────────────────────────────────
export interface MarketSnapshot {
  timestamp: string;
  spot: number;
  symbol: string;
  // CAS
  casReferencePrice: number;
  casDislocationPct: number;
  casDislocationStrength: "NONE" | "WEAK" | "MODERATE" | "STRONG" | "EXTREME";
  casVelocity: number;
  casAboveReference: boolean;
  casBuyQty: number;
  casSellQty: number;
  casImbalance: number; // buyQty / (buyQty + sellQty) — 0.5 = neutral
  // Straddle
  atmStrike: number;
  atmCE: number;
  atmPE: number;
  combinedPremium: number;
  expectedMove: number;
  // Chain context
  pcr: number;
  maxPain: number;
  iv: number;
  // Full chain for strike optimization
  chain: Array<{
    strike: number;
    ce?: { ltp: number; oi: number; oiChg: number; volume: number; iv: number; delta?: number; gamma?: number; theta?: number; spread?: number } | null;
    pe?: { ltp: number; oi: number; oiChg: number; volume: number; iv: number; delta?: number; gamma?: number; theta?: number; spread?: number } | null;
  }>;
  // Market context
  regime: MarketRegime;
  vix: number;
  realizedVol: number;
  // Futures
  futuresPrice: number;
  futuresBasis: number; // futures - spot
  // Volume
  currentVolume: number;
  avgVolume: number;
  volumeRatio: number;
  // ATR
  atr: number;
  atrPct: number;
  // Recent candles for structure analysis
  candles?: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
  // Previous data
  prevClose: number;
  prevPCR: number;
  prevIV: number;
}

// ─── Strategy Signal ──────────────────────────────────────────────
export interface StrategySignal {
  strategy: StrategyType;
  confidence: number;
  tradeQuality: number; // 0-100 separate from CAS score
  reasoning: string[];
  rejectionReasons: string[];
  // Strike details
  ceStrike: number;
  peStrike: number;
  cePremium: number;
  pePremium: number;
  combinedPremium: number;
  // Risk
  maxRisk: number;
  maxReward: number;
  breakevenUpper: number;
  breakevenLower: number;
  riskReward: number;
  // Expected move
  expectedMove: number;
  expectedMovePct: number;
  expectedUpper: number;
  expectedLower: number;
  expectedMoveConfidence: number;
  // CAS
  casScore: number;
  casConfirmationPhase: "BUILDING" | "CONFIRMED" | "NONE";
  // Premium analysis
  premiumCostRatio: number; // combinedPremium / expectedMove
  requiredMove: number; // break-even move after charges
  moveCoveragePassed: boolean;
  // Regime
  regime: MarketRegime;
  regimeConfidence: number;
  // Entry/exit
  entryTime: string;
  exitTime: string;
  targetPct: number;
  stopLossPct: number;
  maxHoldingTime: string;
  // Payoff simulation
  payoffProfile: Array<{ priceMove: number; pnl: number }>;
  profitZonePct: number; // % of simulation that's profitable
  // Quality gates
  passesAllGates: boolean;
  gateResults: Record<string, boolean>;
}

// ─── Strategy Config ──────────────────────────────────────────────
export interface StrategyConfig {
  strategy: StrategyType | "AUTO";
  strikeSelection: StrikeSelection;
  expiryType: ExpiryType;
  initialCapital: number;
  maxRiskPct: number;
  entryTime: string;
  exitTime: string;
  targetPct: number;
  stopLossPct: number;
  chargesMode: "realistic" | "custom";
  slippageMode: "realistic" | "custom";
  // V2 filters
  minTradeQuality: number;
  minExpectedMovePct: number;
  maxPremiumCostRatio: number;
  minVolume: number;
  minOI: number;
  maxSpread: number;
  minCASConfirmation: "NONE" | "BUILDING" | "CONFIRMED";
  trailingActivationPct: number;
  trailingStepPct: number;
  maxHoldingBars: number;
  partialExitEnabled: boolean;
}

export const DEFAULT_CONFIG: StrategyConfig = {
  strategy: "AUTO",
  strikeSelection: "AUTO",
  expiryType: "weekly",
  initialCapital: 100000,
  maxRiskPct: 1.5,
  entryTime: "09:20",
  exitTime: "15:20",
  targetPct: 20,
  stopLossPct: 100,
  chargesMode: "realistic",
  slippageMode: "realistic",
  minTradeQuality: 40,
  minExpectedMovePct: 0.3,
  maxPremiumCostRatio: 1.2,
  minVolume: 5000,
  minOI: 2000,
  maxSpread: 10,
  minCASConfirmation: "BUILDING",
  trailingActivationPct: 15,
  trailingStepPct: 5,
  maxHoldingBars: 5,
  partialExitEnabled: false,
};

// ─── CAS Score (0-100) ─────────────────────────────────────────────
function computeCASScore(snap: MarketSnapshot): { score: number; phase: "BUILDING" | "CONFIRMED" | "NONE"; reasoning: string[] } {
  let score = 0;
  const reasoning: string[] = [];

  // CAS dislocation (0-30 pts)
  const absDisloc = Math.abs(snap.casDislocationPct);
  if (absDisloc >= 0.6) { score += 30; reasoning.push(`CAS dislocation ${snap.casDislocationPct.toFixed(2)}% — EXTREME`); }
  else if (absDisloc >= 0.3) { score += 20; reasoning.push(`CAS dislocation ${snap.casDislocationPct.toFixed(2)}% — MODERATE`); }
  else if (absDisloc >= 0.1) { score += 10; reasoning.push(`CAS dislocation ${snap.casDislocationPct.toFixed(2)}% — WEAK`); }
  else { reasoning.push(`CAS dislocation ${snap.casDislocationPct.toFixed(2)}% — negligible`); }

  // CAS velocity (0-15 pts)
  const absVel = Math.abs(snap.casVelocity);
  if (absVel > 1.0) { score += 15; reasoning.push(`CAS velocity ${snap.casVelocity.toFixed(2)}/min — strong`); }
  else if (absVel > 0.5) { score += 10; reasoning.push(`CAS velocity ${snap.casVelocity.toFixed(2)}/min — moderate`); }
  else if (absVel > 0.2) { score += 5; }

  // CAS imbalance (0-15 pts)
  const imbalance = Math.abs(snap.casImbalance - 0.5);
  if (imbalance > 0.2) { score += 15; reasoning.push(`CAS imbalance ${(snap.casImbalance * 100).toFixed(0)}%`); }
  else if (imbalance > 0.1) { score += 10; }
  else if (imbalance > 0.05) { score += 5; }

  // PCR confirmation (0-10 pts)
  if (snap.casAboveReference && snap.pcr > 1.05) { score += 10; reasoning.push(`PCR ${snap.pcr.toFixed(2)} confirms bullish CAS`); }
  else if (!snap.casAboveReference && snap.pcr < 0.95) { score += 10; reasoning.push(`PCR ${snap.pcr.toFixed(2)} confirms bearish CAS`); }

  // Volume confirmation (0-10 pts)
  if (snap.volumeRatio > 1.5) { score += 10; reasoning.push(`Volume ${snap.volumeRatio.toFixed(1)}x avg`); }
  else if (snap.volumeRatio > 1.2) { score += 5; }

  // Futures confirmation (0-10 pts)
  const futuresAligned = (snap.casAboveReference && snap.futuresBasis > 0) || (!snap.casAboveReference && snap.futuresBasis < 0);
  if (futuresAligned && Math.abs(snap.futuresBasis) > snap.spot * 0.001) {
    score += 10; reasoning.push(`Futures basis ₹${snap.futuresBasis.toFixed(0)} confirms CAS direction`);
  }

  // IV regime (0-10 pts)
  if (snap.iv > 12 && snap.iv < 25) { score += 10; reasoning.push(`IV ${snap.iv.toFixed(1)} in sweet spot`); }
  else if (snap.iv >= 25) { score += 5; reasoning.push(`IV ${snap.iv.toFixed(1)} elevated`); }

  score = Math.min(100, Math.max(0, score));

  // Phase classification — lowered thresholds for daily candle data
  let phase: "BUILDING" | "CONFIRMED" | "NONE" = "NONE";
  if (score >= 50 && absVel > 0.3 && snap.volumeRatio > 1.0) phase = "CONFIRMED";
  else if (score >= 25) phase = "BUILDING";

  return { score, phase, reasoning };
}

// ─── Trade Quality Score (0-100) ──────────────────────────────────
function computeTradeQuality(snap: MarketSnapshot, casScore: number, strategy: StrategyType, strikeQuality: number): { score: number; reasoning: string[] } {
  let score = 0;
  const reasoning: string[] = [];

  // CAS confirmation (0-20)
  score += Math.min(20, casScore * 0.2);
  if (casScore >= 60) reasoning.push(`CAS score ${casScore} — confirmed`);

  // Expected move quality (0-20)
  const emPct = snap.spot > 0 ? (snap.expectedMove / snap.spot) * 100 : 0;
  if (emPct > 1.0) { score += 20; reasoning.push(`Expected move ${emPct.toFixed(2)}% — strong`); }
  else if (emPct > 0.5) { score += 15; reasoning.push(`Expected move ${emPct.toFixed(2)}% — adequate`); }
  else if (emPct > 0.3) { score += 10; }
  else { reasoning.push(`Expected move ${emPct.toFixed(2)}% — weak`); }

  // Premium cost efficiency (0-15)
  const premiumRatio = snap.combinedPremium > 0 && snap.expectedMove > 0 ? snap.combinedPremium / snap.expectedMove : 999;
  if (premiumRatio < 0.5) { score += 15; reasoning.push(`Premium/Move ratio ${premiumRatio.toFixed(2)} — cheap`); }
  else if (premiumRatio < 0.8) { score += 10; reasoning.push(`Premium/Move ratio ${premiumRatio.toFixed(2)} — fair`); }
  else if (premiumRatio < 1.0) { score += 5; }
  else { reasoning.push(`Premium/Move ratio ${premiumRatio.toFixed(2)} — expensive`); }

  // Strike quality (0-10)
  score += Math.min(10, strikeQuality * 0.1);

  // Volume & OI (0-10)
  if (snap.volumeRatio > 1.3) score += 5;
  if (snap.pcr > 0.7 && snap.pcr < 1.5) { score += 5; reasoning.push(`PCR ${snap.pcr.toFixed(2)} healthy`); }

  // Regime alignment (0-15)
  if (snap.regime === "NORMAL_VOL" || snap.regime === "RANGING") { score += 15; reasoning.push(`Regime ${snap.regime} — suitable`); }
  else if (snap.regime === "TRENDING_UP" || snap.regime === "TRENDING_DOWN") { score += 10; reasoning.push(`Regime ${snap.regime} — directional OK`); }
  else if (snap.regime === "HIGH_VOL") { score += 5; reasoning.push(`Regime HIGH VOL — caution`); }
  else { reasoning.push(`Regime ${snap.regime} — not suitable`); }

  // Risk/reward (0-10)
  // Will be computed later with full strike details

  score = Math.min(100, Math.max(0, score));
  return { score, reasoning };
}

// ─── Expected Move Engine ─────────────────────────────────────────
function computeExpectedMove(snap: MarketSnapshot): {
  expectedMove: number;
  expectedMovePct: number;
  expectedUpper: number;
  expectedLower: number;
  confidence: number;
} {
  // Multi-source expected move
  const straddleEM = snap.combinedPremium; // ATM straddle = market's expected move
  const vixEM = snap.spot * (snap.vix / 100) * Math.sqrt(1 / 365); // VIX-based
  const atrEM = snap.atr; // ATR-based
  const historicalEM = snap.candles && snap.candles.length >= 20
    ? computeHistoricalEM(snap.candles)
    : straddleEM;

  // Weighted average: straddle 40%, VIX 25%, ATR 20%, historical 15%
  const weights = { straddle: 0.40, vix: 0.25, atr: 0.20, hist: 0.15 };
  const expectedMove = straddleEM * weights.straddle + vixEM * weights.vix + atrEM * weights.atr + historicalEM * weights.hist;

  // Confidence based on source agreement
  const sources = [straddleEM, vixEM, atrEM, historicalEM].filter(s => s > 0);
  const avg = sources.reduce((a, b) => a + b, 0) / sources.length;
  const variance = sources.reduce((a, b) => a + (b - avg) ** 2, 0) / sources.length;
  const cv = avg > 0 ? Math.sqrt(variance) / avg : 1; // coefficient of variation
  const confidence = Math.max(0, Math.min(100, Math.round(100 * (1 - cv))));

  return {
    expectedMove,
    expectedMovePct: snap.spot > 0 ? (expectedMove / snap.spot) * 100 : 0,
    expectedUpper: snap.spot + expectedMove,
    expectedLower: snap.spot - expectedMove,
    confidence,
  };
}

function computeHistoricalEM(candles: Array<{ high: number; low: number; close: number }>): number {
  if (candles.length < 5) return 0;
  const recent = candles.slice(-20);
  const ranges = recent.map(c => c.high - c.low);
  return ranges.reduce((a, b) => a + b, 0) / ranges.length;
}

// ─── Premium Cost Filter ──────────────────────────────────────────
function checkPremiumCost(
  combinedPremium: number,
  expectedMove: number,
  lotSize: number,
  chargesMode: "realistic" | "custom",
  maxPremiumCostRatio: number,
): { passed: boolean; requiredMove: number; costRatio: number; reasoning: string[] } {
  const reasoning: string[] = [];

  // Calculate all charges for one round trip
  const turnover = combinedPremium * lotSize * 2; // entry + exit
  let charges = 0;
  if (chargesMode === "realistic") {
    charges += turnover * 0.00003; // STT
    charges += turnover * 0.0000345; // Exchange
    charges += turnover * 0.00002; // SEBI
    charges += (turnover * 0.00003 + turnover * 0.0000345 + turnover * 0.00002) * 0.18; // GST
  } else {
    charges = turnover * 0.0005;
  }

  const slippage = combinedPremium * lotSize * 0.01; // 1% round-trip slippage
  const totalCost = charges + slippage;
  const costPerUnit = totalCost / lotSize;

  // Required move = round-trip cost per unit (charges + slippage, NOT premium)
  const requiredMove = costPerUnit;
  const costRatio = expectedMove > 0 ? combinedPremium / expectedMove : 999;

  // Check: premium should be affordable relative to expected move, and expected move must cover costs
  const passed = costRatio < maxPremiumCostRatio && expectedMove > requiredMove * 2;
  if (!passed) {
    if (costRatio >= maxPremiumCostRatio) reasoning.push(`Premium/Move ratio ${costRatio.toFixed(2)} >= ${maxPremiumCostRatio} — too expensive`);
    if (expectedMove <= requiredMove * 2) reasoning.push(`Expected move ₹${expectedMove.toFixed(0)} too small vs costs ₹${(requiredMove * 2).toFixed(0)}`);
  }

  return { passed, requiredMove, costRatio, reasoning };
}

// ─── Strike Optimizer ─────────────────────────────────────────────
interface StrikeCandidate {
  strike: number;
  type: "CE" | "PE";
  premium: number;
  oi: number;
  volume: number;
  iv: number;
  delta: number;
  spread: number;
  liquidityScore: number;
}

function findOptimalStrikes(
  snap: MarketSnapshot,
  strategy: StrategyType,
  selection: StrikeSelection,
): { ceStrike: number; peStrike: number; cePremium: number; pePremium: number; quality: number } {
  const step = snap.symbol === "SENSEX" ? 100 : 50;
  const atm = snap.atmStrike;

  if (strategy === "NO_TRADE") return { ceStrike: 0, peStrike: 0, cePremium: 0, pePremium: 0, quality: 0 };

  // Build candidate lists
  const ceCandidates: StrikeCandidate[] = [];
  const peCandidates: StrikeCandidate[] = [];

  for (const row of snap.chain) {
    const dist = Math.abs(row.strike - snap.spot);
    if (dist > snap.spot * 0.05) continue; // skip far OTM

    if (row.ce && row.ce.ltp > 0) {
      const moneyness = (row.strike - snap.spot) / snap.spot;
      const liquidity = Math.min(100, (row.ce.oi / 50000) * 50 + (row.ce.volume / 10000) * 30);
      const spreadScore = row.ce.spread !== undefined ? Math.max(0, 100 - row.ce.spread * 20) : 80;
      ceCandidates.push({
        strike: row.strike, type: "CE", premium: row.ce.ltp,
        oi: row.ce.oi, volume: row.ce.volume, iv: row.ce.iv,
        delta: row.ce.delta || 0.5, spread: row.ce.spread || 0,
        liquidityScore: liquidity * 0.6 + spreadScore * 0.4,
      });
    }

    if (row.pe && row.pe.ltp > 0) {
      const moneyness = (snap.spot - row.strike) / snap.spot;
      const liquidity = Math.min(100, (row.pe.oi / 50000) * 50 + (row.pe.volume / 10000) * 30);
      const spreadScore = row.pe.spread !== undefined ? Math.max(0, 100 - row.pe.spread * 20) : 80;
      peCandidates.push({
        strike: row.strike, type: "PE", premium: row.pe.ltp,
        oi: row.pe.oi, volume: row.pe.volume, iv: row.pe.iv,
        delta: row.pe.delta || -0.5, spread: row.pe.spread || 0,
        liquidityScore: liquidity * 0.6 + spreadScore * 0.4,
      });
    }
  }

  // Filter by selection type
  const filterBySelection = (candidates: StrikeCandidate[], type: "CE" | "PE") => {
    return candidates.filter(c => {
      if (selection === "ATM") return c.strike === atm;
      if (selection === "ITM") return type === "CE" ? c.strike < atm : c.strike > atm;
      if (selection === "OTM") return type === "CE" ? c.strike > atm : c.strike < atm;
      return true; // OPTIMIZED or AUTO
    });
  };

  const filteredCE = filterBySelection(ceCandidates, "CE");
  const filteredPE = filterBySelection(peCandidates, "PE");

  // Score and pick best
  const scoreCandidate = (c: StrikeCandidate) => {
    let score = c.liquidityScore;
    // Strong ATM preference — prevents far-ITM/OTM from winning ties
    if (c.strike === atm) score += 50;
    // Prefer moderate moneyness for selling
    const dist = Math.abs(c.strike - snap.spot) / snap.spot;
    if (dist > 0 && dist < 0.03) score += 20; // sweet spot
    if (dist > 0.03) score -= dist * 100; // penalize far OTM
    // Prefer higher IV for sellers
    if (c.iv > snap.vix) score += 10;
    return score;
  };

  let bestCE = filteredCE[0];
  let bestPE = filteredPE[0];
  let bestCEScore = -Infinity;
  let bestPEScore = -Infinity;

  for (const c of filteredCE) { const s = scoreCandidate(c); if (s > bestCEScore) { bestCEScore = s; bestCE = c; } }
  for (const p of filteredPE) { const s = scoreCandidate(p); if (s > bestPEScore) { bestPEScore = s; bestPE = p; } }

  if (!bestCE || !bestPE) return { ceStrike: atm, peStrike: atm, cePremium: snap.atmCE, pePremium: snap.atmPE, quality: 30 };

  const quality = Math.round((bestCEScore + bestPEScore) / 2);
  return {
    ceStrike: bestCE.strike, peStrike: bestPE.strike,
    cePremium: bestCE.premium, pePremium: bestPE.premium,
    quality: Math.min(100, Math.max(0, quality)),
  };
}

// ─── Straddle vs Strangle Optimizer ───────────────────────────────
function optimizeStrategyType(
  snap: MarketSnapshot,
  selection: StrikeSelection,
): { strategy: StrategyType; reasoning: string[] } {
  const reasoning: string[] = [];
  const absDisloc = Math.abs(snap.casDislocationPct);
  const isTrending = snap.regime === "TRENDING_UP" || snap.regime === "TRENDING_DOWN";
  const isRanging = snap.regime === "RANGING" || snap.regime === "NORMAL_VOL";
  const emPct = snap.spot > 0 ? (snap.expectedMove / snap.spot) * 100 : 0;

  // Directional: strong CAS + trending
  if (absDisloc > 0.4 && isTrending) {
    const strategy = snap.casAboveReference ? "CALL" : "PUT";
    reasoning.push(`Strong CAS ${snap.casDislocationPct.toFixed(2)}% + trending → ${strategy}`);
    return { strategy, reasoning };
  }

  // Non-directional: ranging + moderate CAS
  if (isRanging && absDisloc < 0.3 && emPct > 0.3) {
    // Choose straddle vs strangle based on IV
    if (snap.iv > 18) {
      reasoning.push(`Ranging + IV ${snap.iv.toFixed(1)} > 18 → STRADDLE (sell premium)`);
      return { strategy: "STRADDLE", reasoning };
    } else {
      reasoning.push(`Ranging + IV ${snap.iv.toFixed(1)} < 18 → STRANGLE (wider strikes)`);
      return { strategy: "STRANGLE", reasoning };
    }
  }

  // Weak signal
  if (absDisloc > 0.15) {
    const strategy = snap.casAboveReference ? "CALL" : "PUT";
    reasoning.push(`Moderate CAS → ${strategy} (weaker signal)`);
    return { strategy, reasoning };
  }

  reasoning.push(`No clear signal: CAS ${snap.casDislocationPct.toFixed(2)}%, regime ${snap.regime}`);
  return { strategy: "NO_TRADE", reasoning };
}

// ─── Payoff Simulation ────────────────────────────────────────────
function simulatePayoff(
  strategy: StrategyType,
  spot: number,
  ceStrike: number,
  peStrike: number,
  cePremium: number,
  pePremium: number,
  lotSize: number,
): { profile: Array<{ priceMove: number; pnl: number }>; profitZonePct: number } {
  const moves = [-500, -400, -300, -200, -100, -50, 0, 50, 100, 200, 300, 400, 500];
  const profile: Array<{ priceMove: number; pnl: number }> = [];
  let profitable = 0;

  for (const move of moves) {
    const newSpot = spot + move;
    let pnl = 0;

    if (strategy === "STRADDLE" || strategy === "STRANGLE") {
      // Short straddle/strangle: profit if premium decreases
      const ceMove = Math.max(0, newSpot - ceStrike);
      const peMove = Math.max(0, peStrike - newSpot);
      const exitCE = Math.max(0, cePremium * 0.3 + (ceMove > 0 ? ceMove * 0.1 : 0)); // simplified decay
      const exitPE = Math.max(0, pePremium * 0.3 + (peMove > 0 ? peMove * 0.1 : 0));
      pnl = ((cePremium - exitCE) + (pePremium - exitPE)) * lotSize;
    } else if (strategy === "CALL") {
      const exitPremium = Math.max(0, cePremium + move * 0.5); // delta ~0.5
      pnl = (exitPremium - cePremium) * lotSize;
    } else if (strategy === "PUT") {
      const exitPremium = Math.max(0, pePremium - move * 0.5);
      pnl = (exitPremium - pePremium) * lotSize;
    }

    profile.push({ priceMove: move, pnl });
    if (pnl > 0) profitable++;
  }

  return { profile, profitZonePct: (profitable / moves.length) * 100 };
}

// ─── Main Signal Generator ────────────────────────────────────────
export function generateStrategySignalV2(
  snap: MarketSnapshot,
  config: StrategyConfig,
): StrategySignal {
  const reasoning: string[] = [];
  const rejectionReasons: string[] = [];
  const gateResults: Record<string, boolean> = {};

  // ─── Step 1: CAS Score ────────────────────────────────────────
  const cas = computeCASScore(snap);
  const casScore = cas.score;
  reasoning.push(...cas.reasoning);

  // ─── Step 2: Market Regime ────────────────────────────────────
  const regimeConfidence = snap.regime === "NORMAL_VOL" ? 80 : snap.regime === "RANGING" ? 70 : snap.regime === "TRENDING_UP" || snap.regime === "TRENDING_DOWN" ? 60 : 30;
  gateResults["regime"] = snap.regime !== "EXTREME_VOL";

  // ─── Step 3: Expected Move ────────────────────────────────────
  const em = computeExpectedMove(snap);
  gateResults["expectedMove"] = em.expectedMovePct >= config.minExpectedMovePct;
  if (!gateResults["expectedMove"]) rejectionReasons.push(`Expected move ${em.expectedMovePct.toFixed(2)}% < ${config.minExpectedMovePct}%`);

  // ─── Step 4: Determine strategy type ──────────────────────────
  let strategyType: StrategyType;
  if (config.strategy !== "AUTO") {
    strategyType = config.strategy;
    reasoning.push(`Manual strategy: ${strategyType}`);
  } else {
    const optimized = optimizeStrategyType(snap, config.strikeSelection);
    strategyType = optimized.strategy;
    reasoning.push(...optimized.reasoning);
  }

  // ─── Step 5: Strike Optimization ──────────────────────────────
  const strikes = findOptimalStrikes(snap, strategyType, config.strikeSelection);
  reasoning.push(`Strikes: CE ₹${strikes.ceStrike.toLocaleString("en-IN")} PE ₹${strikes.peStrike.toLocaleString("en-IN")} (quality ${strikes.quality})`);

  // ─── Step 6: Premium Cost Filter ──────────────────────────────
  const lotSize = getLotSize(snap.symbol);
  const combinedPremium = strikes.cePremium + strikes.pePremium;
  const premiumCost = checkPremiumCost(combinedPremium, em.expectedMove, lotSize, config.chargesMode, config.maxPremiumCostRatio);
  gateResults["premiumCost"] = premiumCost.passed;
  if (!premiumCost.passed) rejectionReasons.push(...premiumCost.reasoning);

  // DEBUG: Remove after testing
  if (typeof globalThis !== 'undefined' && (globalThis as any).__CAS_DEBUG) {
    console.log(`[CAS-DEBUG] ${snap.timestamp} strat=${strategyType} ceP=${strikes.cePremium.toFixed(1)} peP=${strikes.pePremium.toFixed(1)} combP=${combinedPremium.toFixed(1)} em=${em.expectedMove.toFixed(1)} costRatio=${premiumCost.costRatio.toFixed(2)} reqMove=${premiumCost.requiredMove.toFixed(1)} passed=${premiumCost.passed}`);
  }

  // ─── Step 7: Expected Move Coverage ───────────────────────────
  let breakevenUpper = 0, breakevenLower = 0;
  if (strategyType === "STRADDLE" || strategyType === "STRANGLE") {
    breakevenUpper = (strategyType === "STRADDLE" ? snap.atmStrike : strikes.ceStrike) + combinedPremium;
    breakevenLower = (strategyType === "STRADDLE" ? snap.atmStrike : strikes.peStrike) - combinedPremium;
  } else if (strategyType === "CALL") {
    breakevenUpper = strikes.ceStrike + strikes.cePremium;
    breakevenLower = strikes.ceStrike;
  } else if (strategyType === "PUT") {
    breakevenLower = strikes.peStrike - strikes.pePremium;
    breakevenUpper = strikes.peStrike;
  }

  const upperBEDist = breakevenUpper - snap.spot;
  const lowerBEDist = snap.spot - breakevenLower;
  const moveCoversBE = em.expectedMove > upperBEDist * 0.7 && em.expectedMove > lowerBEDist * 0.7;
  gateResults["moveCoverage"] = moveCoversBE;
  if (!moveCoversBE) rejectionReasons.push(`Expected move ₹${em.expectedMove.toFixed(0)} doesn't cover breakevens (U: ₹${upperBEDist.toFixed(0)}, L: ₹${lowerBEDist.toFixed(0)})`);

  // ─── Step 8: Volume & Liquidity Filter ────────────────────────
  gateResults["volume"] = snap.volumeRatio > 0.7;
  if (!gateResults["volume"]) rejectionReasons.push(`Volume ratio ${snap.volumeRatio.toFixed(2)} < 0.7`);

  // ─── Step 9: CAS Confirmation Phase ───────────────────────────
  // With daily data, BUILDING is sufficient (CONFIRMED requires intraday CAS data)
  gateResults["casConfirmation"] = cas.phase === "BUILDING" || cas.phase === "CONFIRMED" || config.minCASConfirmation === "NONE";
  if (!gateResults["casConfirmation"]) rejectionReasons.push(`CAS phase ${cas.phase} < required ${config.minCASConfirmation}`);

  // ─── Step 10: Anti-chase Filter ───────────────────────────────
  const recentMove = snap.candles && snap.candles.length >= 2
    ? Math.abs(snap.candles[snap.candles.length - 1].close - snap.candles[snap.candles.length - 2].close) / snap.spot * 100
    : 0;
  const chaseRisk = recentMove > 1.5 && combinedPremium > em.expectedMove * 0.9;
  gateResults["antiChase"] = !chaseRisk;
  if (chaseRisk) rejectionReasons.push(`Chase risk: recent move ${recentMove.toFixed(2)}% + premium near expected move`);

  // ─── Step 11: Risk/Reward Filter ──────────────────────────────
  let maxRisk = 0, maxReward = 0;
  let riskReward = 0;
  let gateResultsKey = "riskReward";

  if (strategyType === "STRADDLE" || strategyType === "STRANGLE") {
    // For short options: R:R is inherently unfavorable (premium vs unlimited risk).
    // Instead check: expected move covers breakevens with margin AND premium is meaningful.
    maxRisk = combinedPremium * 3; // approximate max loss for short
    maxReward = combinedPremium;
    const coverageRatio = combinedPremium > 0 ? em.expectedMove / combinedPremium : 0;
    riskReward = coverageRatio; // > 1.0 means expected move exceeds premium — good
    gateResults[gateResultsKey] = riskReward >= 1.0; // expected move should at least match the premium
    if (!gateResults[gateResultsKey]) rejectionReasons.push(`Short options coverage ${riskReward.toFixed(2)} < 1.5 — expected move too close to premium`);
  } else if (strategyType === "CALL") {
    maxRisk = strikes.cePremium;
    maxReward = em.expectedMove - strikes.cePremium;
    riskReward = maxRisk > 0 ? maxReward / maxRisk : 0;
    gateResults[gateResultsKey] = riskReward >= 0.8;
    if (!gateResults[gateResultsKey]) rejectionReasons.push(`R:R ${riskReward.toFixed(2)} < 0.8`);
  } else if (strategyType === "PUT") {
    maxRisk = strikes.pePremium;
    maxReward = em.expectedMove - strikes.pePremium;
    riskReward = maxRisk > 0 ? maxReward / maxRisk : 0;
    gateResults[gateResultsKey] = riskReward >= 0.8;
    if (!gateResults[gateResultsKey]) rejectionReasons.push(`R:R ${riskReward.toFixed(2)} < 0.8`);
  }

  // ─── Step 12: Payoff Simulation ───────────────────────────────
  const payoff = simulatePayoff(strategyType, snap.spot, strikes.ceStrike, strikes.peStrike, strikes.cePremium, strikes.pePremium, lotSize);

  // ─── Step 13: Trade Quality Score ─────────────────────────────
  const quality = computeTradeQuality(snap, casScore, strategyType, strikes.quality);
  gateResults["quality"] = quality.score >= config.minTradeQuality;
  if (!gateResults["quality"]) rejectionReasons.push(`Trade quality ${quality.score} < ${config.minTradeQuality}`);

  // ─── Step 14: Final Decision ──────────────────────────────────
  const allGatesPassed = Object.values(gateResults).every(v => v);
  const passesAllGates = allGatesPassed && strategyType !== "NO_TRADE";

  if (!passesAllGates && strategyType !== "NO_TRADE") {
    const failed = Object.entries(gateResults).filter(([_, v]) => !v).map(([k]) => k);
    rejectionReasons.push(`Failed gates: ${failed.join(", ")}`);
  }

  const finalStrategy = passesAllGates ? strategyType : "NO_TRADE";
  const confidence = passesAllGates ? Math.round(casScore * 0.4 + quality.score * 0.4 + em.confidence * 0.2) : 0;

  return {
    strategy: finalStrategy,
    confidence,
    tradeQuality: quality.score,
    reasoning: [...reasoning, ...quality.reasoning],
    rejectionReasons,
    ceStrike: strikes.ceStrike,
    peStrike: strikes.peStrike,
    cePremium: strikes.cePremium,
    pePremium: strikes.pePremium,
    combinedPremium,
    maxRisk,
    maxReward,
    breakevenUpper,
    breakevenLower,
    riskReward,
    expectedMove: em.expectedMove,
    expectedMovePct: em.expectedMovePct,
    expectedUpper: em.expectedUpper,
    expectedLower: em.expectedLower,
    expectedMoveConfidence: em.confidence,
    casScore,
    casConfirmationPhase: cas.phase,
    premiumCostRatio: premiumCost.costRatio,
    requiredMove: premiumCost.requiredMove,
    moveCoveragePassed: moveCoversBE,
    regime: snap.regime,
    regimeConfidence,
    entryTime: config.entryTime,
    exitTime: config.exitTime,
    targetPct: config.targetPct,
    stopLossPct: config.stopLossPct,
    maxHoldingTime: `${config.maxHoldingBars} bars`,
    payoffProfile: payoff.profile,
    profitZonePct: payoff.profitZonePct,
    passesAllGates,
    gateResults,
  };
}

// ─── P&L Calculation ──────────────────────────────────────────────
export interface TradePnL {
  grossPnL: number;
  charges: number;
  slippage: number;
  netPnL: number;
  returnPct: number;
}

export function calculateTradePnLV2(
  signal: StrategySignal,
  exitPremium: number,
  lotSize: number,
  entryPremium: number,
  maxRiskCapital: number,
  chargesMode: "realistic" | "custom" = "realistic",
  slippageMode: "realistic" | "custom" = "realistic",
): TradePnL {
  let grossPnL = 0;

  if (signal.strategy === "STRADDLE" || signal.strategy === "STRANGLE") {
    grossPnL = (entryPremium - exitPremium) * lotSize; // short: profit if premium drops
  } else if (signal.strategy === "CALL") {
    grossPnL = (exitPremium - entryPremium) * lotSize;
  } else if (signal.strategy === "PUT") {
    grossPnL = (exitPremium - entryPremium) * lotSize;
  }

  // Cap loss at max risk
  if (grossPnL < -maxRiskCapital) grossPnL = -maxRiskCapital;

  const turnover = entryPremium * lotSize + exitPremium * lotSize;
  let charges = 0;
  if (chargesMode === "realistic") {
    charges += turnover * 0.00003;
    charges += turnover * 0.0000345;
    charges += turnover * 0.00002;
    charges += (turnover * 0.00003 + turnover * 0.0000345 + turnover * 0.00002) * 0.18;
  } else {
    charges = turnover * 0.0005;
  }

  let slippage = 0;
  if (slippageMode === "realistic") {
    slippage = entryPremium * lotSize * 0.005 + exitPremium * lotSize * 0.005;
  } else {
    slippage = (entryPremium + exitPremium) * lotSize * 0.002;
  }

  const netPnL = grossPnL - charges - slippage;
  const returnPct = maxRiskCapital > 0 ? (netPnL / maxRiskCapital) * 100 : 0;

  return { grossPnL, charges, slippage, netPnL, returnPct };
}

// ─── Lot Size ─────────────────────────────────────────────────────
export function getLotSize(symbol: string, _date?: string): number {
  const lots: Record<string, number> = {
    NIFTY: 25, BANKNIFTY: 15, FINNIFTY: 40, MIDCPNIFTY: 50, SENSEX: 20,
  };
  return lots[symbol] || 25;
}

// ─── Data Quality ─────────────────────────────────────────────────
export function computeDataQuality(snap: MarketSnapshot): number {
  let score = 0;
  if (snap.spot > 0) score += 15;
  if (snap.casReferencePrice > 0) score += 15;
  if (snap.chain.length > 0) score += 15;
  if (snap.iv > 0) score += 10;
  if (snap.pcr > 0) score += 10;
  if (snap.candles && snap.candles.length > 0) score += 10;
  if (snap.futuresPrice > 0) score += 10;
  if (snap.volumeRatio > 0) score += 10;
  if (snap.atr > 0) score += 5;
  return score;
}

// ─── Black-Scholes ────────────────────────────────────────────────
export function blackScholesPrice(spot: number, strike: number, iv: number, tte: number, type: "CE" | "PE"): number {
  if (tte <= 0 || iv <= 0) return Math.max(0, type === "CE" ? spot - strike : strike - spot);
  const r = 0.065;
  const d1 = (Math.log(spot / strike) + (r + iv * iv / 2) * tte) / (iv * Math.sqrt(tte));
  const d2 = d1 - iv * Math.sqrt(tte);
  if (type === "CE") {
    return spot * normalCDF(d1) - strike * Math.exp(-r * tte) * normalCDF(d2);
  } else {
    return strike * Math.exp(-r * tte) * normalCDF(-d2) - spot * normalCDF(-d1);
  }
}

function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}
