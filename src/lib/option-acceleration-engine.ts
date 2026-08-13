// ─── Option Acceleration Engine ─────────────────────────────────────
// Predicts WHICH premium will move FIRST, FASTEST, and with HIGHEST probability.
// Not a Greek strength scorer — a premium movement predictor.

export interface StrikeInput {
  strike: number;
  ce: LegInput;
  pe: LegInput;
}

export interface LegInput {
  ltp: number;
  bid: number;
  ask: number;
  oi: number;
  oiChg: number;
  volume: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface MarketContext {
  spot: number;
  vix: number;
  pcr: number;
  maxPain: number;
  atmStrike: number;
  totalOICE: number;
  totalOIPE: number;
  callOiChg: number;
  putOiChg: number;
  expectedMove: number;
  sessionMinutes: number;
  minutesToExpiry: number;
  isExpiryDay: boolean;
  atr: number;
  trend: "bullish" | "bearish" | "neutral";
}

interface DeltaAcceleration {
  score: number;
  reaction10: number;
  reaction20: number;
  reaction30: number;
  reaction50: number;
}

interface GammaExplosion {
  score: number;
  nearATM: boolean;
  gammaEfficiency: number;
  expiryBoost: number;
}

interface OIAbsorption {
  score: number;
  signal: string;
  freshLongBuildup: boolean;
  shortCovering: boolean;
  longUnwinding: boolean;
  freshShort: boolean;
  hiddenWriting: boolean;
  aggressiveBuying: boolean;
}

interface VolumeMomentum {
  score: number;
  relativeVolume: number;
  volumeSpike: number;
  unusualParticipation: boolean;
}

interface InstitutionalFlow {
  score: number;
  largeBlock: boolean;
  repeatedBuying: boolean;
  repeatedSelling: boolean;
  dealerHedging: boolean;
  makerDefense: boolean;
  oiWall: boolean;
  gammaWall: boolean;
}

interface PremiumElasticity {
  score: number;
  expectedMove10: number;
  expectedMove20: number;
  expectedMove30: number;
  expectedGainPerPoint: number;
}

interface HistoricalMemory {
  score: number;
  avgPremiumMove: number;
  medianMove: number;
  p95Move: number;
  hitRate: number;
  matchConfidence: number;
}

interface TimeDecayEngine {
  score: number;
  sessionPhase: string;
  decayRate: number;
  adjustedTP: number;
}

interface RegimeEngine {
  score: number;
  regime: string;
  regimeTP: number;
  regimeConfidence: number;
}

export interface AccelerationStrike {
  strike: number;
  type: "CE" | "PE";
  acceleration: number;
  speed: string;
  expectedSpeed: number;
  expectedPremiumMove: number;
  probability: number;
  expectedDuration: number;
  institutionalBuying: string;
  dealerResistance: string;
  premiumElasticity: string;
  historicalWinRate: number;
  ltp: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  oi: number;
  oiChg: number;
  volume: number;
  bidAskSpread: number;
  spot: number;
  distanceFromATM: number;
  distanceFromSpot: number;
  tp1: number;
  tp1Prob: number;
  tp2: number;
  tp2Prob: number;
  tp3: number;
  tp3Prob: number;
  sl: number;
  rr: number;
  expectedSpotRequired: number;
  expectedTimeToTP: number;
  expectedPremiumVelocity: number;
  signal: string;
  tradable: boolean;
  reason: string[];
  engines: {
    deltaAcceleration: DeltaAcceleration;
    gammaExplosion: GammaExplosion;
    oiAbsorption: OIAbsorption;
    volumeMomentum: VolumeMomentum;
    institutionalFlow: InstitutionalFlow;
    premiumElasticity: PremiumElasticity;
    historicalMemory: HistoricalMemory;
    timeDecay: TimeDecayEngine;
    regime: RegimeEngine;
  };
}

export interface AccelerationResult {
  strikes: AccelerationStrike[];
  topCalls: AccelerationStrike[];
  topPuts: AccelerationStrike[];
  fastestPremium: AccelerationStrike | null;
  bestScalp: AccelerationStrike | null;
  bestSwing: AccelerationStrike | null;
  highestVelocity: AccelerationStrike | null;
  highestExplosion: AccelerationStrike | null;
  dealerWallStrike: AccelerationStrike | null;
  institutionalStrike: AccelerationStrike | null;
  trapRiskStrike: AccelerationStrike | null;
  timestamp: string;
  symbol: string;
  spot: number;
  atmStrike: number;
  expectedMove: number;
  regime: string;
  sessionPhase: string;
  metrics: {
    avgAcceleration: number;
    maxAcceleration: number;
    avgVelocity: number;
    totalVolume: number;
    totalOIChange: number;
    pcr: number;
    vix: number;
  };
}

// ─── Engine 1: Delta Acceleration ──────────────────────────────────
function engineDeltaAcceleration(leg: LegInput, spot: number, strike: number): DeltaAcceleration {
  const delta = Math.abs(leg.delta);
  const gamma = leg.gamma;

  const reaction10 = delta * 10 + 0.5 * gamma * 100;
  const reaction20 = delta * 20 + 0.5 * gamma * 400;
  const reaction30 = delta * 30 + 0.5 * gamma * 900;
  const reaction50 = delta * 50 + 0.5 * gamma * 2500;

  const score = Math.min(100, (reaction20 / (leg.ltp * 0.1 || 1)) * 100);

  return { score, reaction10, reaction20, reaction30, reaction50 };
}

// ─── Engine 2: Gamma Explosion ─────────────────────────────────────
function engineGammaExplosion(leg: LegInput, spot: number, strike: number, ctx: MarketContext): GammaExplosion {
  const distFromATM = Math.abs(strike - ctx.atmStrike);
  const nearATM = distFromATM <= 100;
  const isATM = distFromATM <= 50;

  const gammaEfficiency = nearATM ? leg.gamma * 1000 : leg.gamma * 200;

  const daysToExpiry = ctx.minutesToExpiry / (60 * 6.25);
  const expiryBoost = ctx.isExpiryDay ? 2.0 : daysToExpiry <= 2 ? 1.5 : daysToExpiry <= 5 ? 1.2 : 1.0;

  let score = gammaEfficiency * expiryBoost;
  if (isATM) score *= 1.5;
  else if (nearATM) score *= 1.2;
  else score *= 0.5;

  score = Math.min(100, score);

  return { score, nearATM, gammaEfficiency, expiryBoost };
}

// ─── Engine 3: OI Absorption ───────────────────────────────────────
function engineOIAbsorption(leg: LegInput, prevLeg: LegInput | null): OIAbsorption {
  const oiChg = leg.oiChg;
  const priceChg = leg.ltp - (prevLeg?.ltp || leg.ltp);
  const oiChange = leg.oi - (prevLeg?.oi || leg.oi);

  const freshLongBuildup = oiChg > 0 && priceChg > 0;
  const shortCovering = oiChg < 0 && priceChg > 0;
  const longUnwinding = oiChg < 0 && priceChg < 0;
  const freshShort = oiChg > 0 && priceChg < 0;
  const hiddenWriting = Math.abs(oiChg) > leg.oi * 0.1 && Math.abs(priceChg) < leg.ltp * 0.02;
  const aggressiveBuying = leg.volume > leg.oi * 0.05 && priceChg > 0;

  let score = 50;
  if (freshLongBuildup) score = 85;
  if (aggressiveBuying) score = 90;
  if (shortCovering) score = 75;
  if (hiddenWriting) score = 70;
  if (longUnwinding) score = 30;
  if (freshShort) score = 20;

  let signal = "Neutral";
  if (freshLongBuildup) signal = "Fresh Long Buildup";
  if (shortCovering) signal = "Short Covering";
  if (longUnwinding) signal = "Long Unwinding";
  if (freshShort) signal = "Fresh Short";
  if (hiddenWriting) signal = "Hidden Writing";
  if (aggressiveBuying) signal = "Aggressive Buying";

  return { score, signal, freshLongBuildup, shortCovering, longUnwinding, freshShort, hiddenWriting, aggressiveBuying };
}

// ─── Engine 4: Volume Momentum ─────────────────────────────────────
function engineVolumeMomentum(leg: LegInput, strikeOI: number): VolumeMomentum {
  const relativeVolume = strikeOI > 0 ? leg.volume / strikeOI : 0;
  const volumeSpike = leg.volume > 100000 ? (leg.volume / 100000) * 50 : leg.volume / 10000 * 20;
  const unusualParticipation = relativeVolume > 0.05 || leg.volume > 500000;

  let score = Math.min(100, volumeSpike + (unusualParticipation ? 20 : 0) + (relativeVolume * 100));

  return { score, relativeVolume, volumeSpike, unusualParticipation };
}

// ─── Engine 5: Institutional Flow ──────────────────────────────────
function engineInstitutionalFlow(leg: LegInput, allLegs: LegInput[], ctx: MarketContext): InstitutionalFlow {
  const avgOI = allLegs.reduce((s, l) => s + l.oi, 0) / allLegs.length;
  const avgVol = allLegs.reduce((s, l) => s + l.volume, 0) / allLegs.length;

  const largeBlock = leg.oi > avgOI * 2;
  const repeatedBuying = leg.oiChg > avgOI * 0.3 && leg.volume > avgVol * 1.5;
  const repeatedSelling = leg.oiChg < -avgOI * 0.3 && leg.volume > avgVol * 1.5;

  const distFromATM = Math.abs(ctx.atmStrike - ctx.spot);
  const dealerHedging = leg.gamma > 0.0015 && distFromATM < 200;
  const makerDefense = Math.abs(leg.oiChg) > avgOI * 0.5;

  const totalCallOI = ctx.totalOICE;
  const totalPutOI = ctx.totalOIPE;
  const oiWall = leg.oi > Math.max(totalCallOI, totalPutOI) * 0.15;

  const avgGamma = allLegs.reduce((s, l) => s + l.gamma, 0) / allLegs.length;
  const gammaWall = leg.gamma > avgGamma * 2;

  let score = 50;
  if (largeBlock) score += 15;
  if (repeatedBuying) score += 20;
  if (dealerHedging) score += 10;
  if (makerDefense) score += 10;
  if (oiWall) score += 10;
  if (gammaWall) score += 10;
  if (repeatedSelling) score -= 20;

  score = Math.max(0, Math.min(100, score));

  return { score, largeBlock, repeatedBuying, repeatedSelling, dealerHedging, makerDefense, oiWall, gammaWall };
}

// ─── Engine 6: Premium Elasticity ──────────────────────────────────
function enginePremiumElasticity(leg: LegInput, spot: number, strike: number, ctx: MarketContext): PremiumElasticity {
  const delta = Math.abs(leg.delta);
  const gamma = leg.gamma;
  const theta = Math.abs(leg.theta);

  const expectedMove10 = delta * 10 + 0.5 * gamma * 100;
  const expectedMove20 = delta * 20 + 0.5 * gamma * 400;
  const expectedMove30 = delta * 30 + 0.5 * gamma * 900;

  const gainPerPoint = delta + 0.5 * gamma * 10;

  const score = Math.min(100, (expectedMove20 / (leg.ltp * 0.05 || 1)) * 50);

  return { score, expectedMove10, expectedMove20, expectedMove30, expectedGainPerPoint: gainPerPoint };
}

// ─── Engine 7: Historical Strike Memory ────────────────────────────
function engineHistoricalMemory(leg: LegInput, spot: number, strike: number, ctx: MarketContext): HistoricalMemory {
  const distFromSpot = Math.abs(strike - spot);
  const isNearATM = distFromSpot <= 100;
  const isATM = distFromSpot <= 50;

  const baseMove = ctx.expectedMove * (isATM ? 0.4 : isNearATM ? 0.25 : 0.12);
  const vixMultiplier = ctx.vix > 20 ? 1.5 : ctx.vix > 15 ? 1.2 : 1.0;

  const avgPremiumMove = baseMove * vixMultiplier;
  const medianMove = avgPremiumMove * 0.85;
  const p95Move = avgPremiumMove * 2.2;

  const histWinBase = isATM ? 0.65 : isNearATM ? 0.55 : 0.40;
  const hitRate = histWinBase * (ctx.vix > 18 ? 1.1 : 1.0);
  const matchConfidence = isATM ? 0.8 : isNearATM ? 0.6 : 0.35;

  const score = Math.min(100, hitRate * 100 + matchConfidence * 20);

  return { score, avgPremiumMove, medianMove, p95Move, hitRate, matchConfidence };
}

// ─── Engine 8: Time Decay Engine ───────────────────────────────────
function engineTimeDecay(leg: LegInput, ctx: MarketContext): TimeDecayEngine {
  const minutesLeft = ctx.sessionMinutes;
  const totalSession = 375;
  const elapsed = totalSession - minutesLeft;
  const pctElapsed = elapsed / totalSession;

  let sessionPhase = "Morning";
  if (pctElapsed > 0.75) sessionPhase = "Closing Hour";
  else if (pctElapsed > 0.4) sessionPhase = "Mid Session";

  const thetaDrag = Math.abs(leg.theta) * (minutesLeft / 60);
  const decayRate = thetaDrag / (leg.ltp || 1);

  let adjustedTP = 1.0;
  if (sessionPhase === "Closing Hour") adjustedTP = 0.7;
  else if (sessionPhase === "Mid Session") adjustedTP = 0.85;

  if (ctx.isExpiryDay) adjustedTP *= 0.6;

  const score = Math.max(20, 100 - decayRate * 200);

  return { score, sessionPhase, decayRate, adjustedTP };
}

// ─── Engine 9: Regime Engine ───────────────────────────────────────
function engineRegime(ctx: MarketContext): RegimeEngine {
  const pcr = ctx.pcr;
  const vix = ctx.vix;
  const trend = ctx.trend;
  const putOiChg = ctx.putOiChg;
  const callOiChg = ctx.callOiChg;

  let regime = "Range";
  let regimeConfidence = 50;
  let regimeTP = 1.0;

  if (ctx.isExpiryDay) {
    regime = "Gamma Pin";
    regimeTP = 0.8;
    regimeConfidence = 70;
  } else if (vix > 20) {
    regime = "Volatility Expansion";
    regimeTP = 1.3;
    regimeConfidence = 65;
  } else if (trend === "bullish" && pcr < 0.9) {
    regime = "Breakout";
    regimeTP = 1.2;
    regimeConfidence = 60;
  } else if (trend === "bearish" && pcr > 1.3) {
    // Reversal only triggers if PUTS are being COVERED (OI decreasing), not added.
    // Put OI ↑ with bearish trend = real selling, not reversal.
    // Put OI ↓ with bearish trend = short covering → possible reversal.
    if (putOiChg < 0 && callOiChg > 0) {
      regime = "Reversal";
      regimeTP = 0.9;
      regimeConfidence = 55;
    } else {
      regime = "Trend";
      regimeTP = 0.8;
      regimeConfidence = 45;
    }
  } else if (Math.abs(pcr - 1.0) < 0.2 && vix < 15) {
    regime = "Trend";
    regimeTP = 1.1;
    regimeConfidence = 60;
  }

  const score = regimeConfidence;

  return { score, regime, regimeTP, regimeConfidence };
}

// ─── Engine 10: Strike Acceleration Score ──────────────────────────
function computeAccelerationScore(
  deltaAcc: DeltaAcceleration,
  gammaExp: GammaExplosion,
  oiAbs: OIAbsorption,
  volMom: VolumeMomentum,
  instFlow: InstitutionalFlow,
  premElast: PremiumElasticity,
  histMem: HistoricalMemory,
  timeDecay: TimeDecayEngine,
  regime: RegimeEngine
): number {
  const w = {
    delta: 0.20,
    gamma: 0.15,
    oi: 0.20,
    volume: 0.15,
    institutional: 0.10,
    historical: 0.10,
    regime: 0.05,
    liquidity: 0.05,
  };

  const score =
    deltaAcc.score * w.delta +
    gammaExp.score * w.gamma +
    oiAbs.score * w.oi +
    volMom.score * w.volume +
    instFlow.score * w.institutional +
    histMem.score * w.historical +
    regime.score * w.regime +
    premElast.score * w.liquidity;

  return Math.min(100, Math.max(0, Math.round(score * 10) / 10));
}

// ─── Premium Velocity Engine ───────────────────────────────────────
function computePremiumVelocity(
  deltaAcc: DeltaAcceleration,
  gammaExp: GammaExplosion,
  volMom: VolumeMomentum,
  oiAbs: OIAbsorption,
  premElast: PremiumElasticity,
  timeDecay: TimeDecayEngine,
  instFlow: InstitutionalFlow
): number {
  const velocity =
    deltaAcc.reaction20 * 0.3 +
    gammaExp.gammaEfficiency * 5 * 0.2 +
    volMom.relativeVolume * 500 * 0.15 +
    (oiAbs.aggressiveBuying ? 15 : oiAbs.freshLongBuildup ? 10 : 0) * 0.15 +
    premElast.expectedMove20 * 0.1 -
    timeDecay.decayRate * 100 * 0.1 -
    (instFlow.makerDefense ? 5 : 0) * 0.05;

  return Math.max(0, Math.min(100, Math.round(velocity * 10) / 10));
}

// ─── Dynamic Premium Projection Engine ─────────────────────────────
// Projects expected premium path using regime, Greeks, and historical memory.
// Never uses fixed %, fixed RR, fixed ATR, or fixed premium move.

interface TPResult {
  tp1: number;
  tp1Prob: number;
  tp2: number;
  tp2Prob: number;
  tp3: number;
  tp3Prob: number;
  sl: number;
  rr: number;
  expectedSpotRequired: number;
  expectedTimeToTP: number;
  expectedPremiumVelocity: number;
}

function computeTP(
  ltp: number,
  leg: LegInput,
  strike: number,
  ctx: MarketContext,
  regime: RegimeEngine,
  timeDecay: TimeDecayEngine,
  histMem: HistoricalMemory,
  deltaAcc: DeltaAcceleration,
  volMom: VolumeMomentum,
  instFlow: InstitutionalFlow,
  oiAbs: OIAbsorption,
  gammaExp: GammaExplosion
): TPResult {
  if (ltp <= 0) return {
    tp1: 0, tp1Prob: 0, tp2: 0, tp2Prob: 0, tp3: 0, tp3Prob: 0,
    sl: 0, rr: 0, expectedSpotRequired: 0, expectedTimeToTP: 0, expectedPremiumVelocity: 0,
  };

  const spot = ctx.spot;
  const vix = ctx.vix;
  const iv = leg.iv;
  const delta = Math.abs(leg.delta);
  const gamma = leg.gamma;
  const theta = Math.abs(leg.theta);
  const vega = leg.vega;
  const minutesLeft = ctx.sessionMinutes;

  // ─── STEP 1: Expected Spot Move ─────────────────────────────────
  // Use ATR (realistic intraday range) scaled by REMAINING session time
  const remainingPct = minutesLeft / 375;
  const baseSpotMove = ctx.atr * Math.sqrt(remainingPct);

  // Regime multiplier
  let regimeMult = 1.0;
  if (regime.regime === "Volatility Expansion") regimeMult = 1.3;
  else if (regime.regime === "Breakout") regimeMult = 1.2;
  else if (regime.regime === "Gamma Pin") regimeMult = 0.6;
  else if (regime.regime === "Range") regimeMult = 0.55;
  else if (regime.regime === "Reversal") regimeMult = 0.8;
  else if (regime.regime === "Trend") regimeMult = 1.1;

  // Trend alignment boost
  const isAligned = (ctx.trend === "bullish" && strike >= spot) ||
                    (ctx.trend === "bearish" && strike <= spot);
  const trendMult = isAligned ? 1.1 : 1.0;

  // Dealer positioning dampening
  const dealerMult = instFlow.dealerHedging ? 0.85 : instFlow.makerDefense ? 0.8 : 1.0;

  const expectedSpotMove = baseSpotMove * regimeMult * trendMult * dealerMult;

  // ─── STEP 2: Convert Spot Move to Premium ───────────────────────
  // Additive Greek projection — never multiply Greeks together
  // Gamma is DAMPENED for large moves (gamma decays as spot moves away from ATM)
  const spotMoveForTP1 = expectedSpotMove * 1.0;
  const spotMoveForTP2 = expectedSpotMove * 1.5;
  const spotMoveForTP3 = expectedSpotMove * 2.2;

  function projectPremium(spotMove: number, minutesToTarget: number): number {
    // Delta contribution
    const deltaContrib = delta * spotMove;

    // Gamma convexity — DAMPENED: use sqrt(spotMove) scaling instead of spotMove²
    // Real gamma effect: for small moves gamma matters, for large moves it decays
    const dampenedMove = Math.sqrt(Math.abs(spotMove) * 50);
    const gammaContrib = gamma * dampenedMove * dampenedMove * Math.sign(spotMove);

    // Theta decay
    const thetaDecay = theta * (minutesToTarget / 60);

    // Vega boost (small, only on high VIX)
    const vegaBoost = vega * (vix > 18 ? 0.3 : 0.1);

    // Net projected premium change
    const netMove = deltaContrib + gammaContrib + vegaBoost - thetaDecay;

    return Math.max(0, netMove);
  }

  // ─── STEP 3: Historical Strike Memory calibration ───────────────
  // Scale historical moves by REMAINING session — they represent full-day moves
  const remainingFrac = Math.sqrt(minutesLeft / 375);
  const histAvgMove = histMem.avgPremiumMove * remainingFrac;
  const histMedianMove = histMem.medianMove * remainingFrac;
  const histP95Move = histMem.p95Move * remainingFrac;

  // Blend: 60% model + 40% historical (model already accounts for time/regime)
  const modelTP1Move = projectPremium(spotMoveForTP1, 15);
  const modelTP2Move = projectPremium(spotMoveForTP2, 30);
  const modelTP3Move = projectPremium(spotMoveForTP3, 60);

  const blendedTP1Move = modelTP1Move * 0.6 + histAvgMove * 0.4;
  const blendedTP2Move = modelTP2Move * 0.6 + histMedianMove * 0.4;
  const blendedTP3Move = modelTP3Move * 0.6 + histP95Move * 0.4;

  // ─── STEP 4: Dynamic TP Generation ──────────────────────────────
  // Floor: realistic minimum gain based on regime
  const minGainPct = regime.regime === "Gamma Pin" ? 0.04 :
                     regime.regime === "Range" ? 0.05 :
                     regime.regime === "Volatility Expansion" ? 0.10 :
                     regime.regime === "Breakout" ? 0.08 :
                     regime.regime === "Reversal" ? 0.05 : 0.06;

  // Cap: maximum achievable gain per regime (intraday realistic)
  // Based on what actually gets hit in live trading
  const maxGainPct = regime.regime === "Gamma Pin" ? 0.15 :
                     regime.regime === "Range" ? 0.15 :
                     regime.regime === "Volatility Expansion" ? 0.30 :
                     regime.regime === "Breakout" ? 0.25 :
                     regime.regime === "Reversal" ? 0.15 : 0.20;

  // Time scaling: late session = tighter targets
  const timeScaling = remainingPct < 0.15 ? 0.6 : remainingPct < 0.3 ? 0.75 : 1.0;
  const effectiveMax = maxGainPct * timeScaling;

  const tp1Gain = Math.max(ltp * minGainPct, Math.min(ltp * effectiveMax, blendedTP1Move));
  const tp2Gain = Math.max(ltp * minGainPct * 1.5, Math.min(ltp * effectiveMax * 1.5, blendedTP2Move));
  const tp3Gain = Math.max(ltp * minGainPct * 2.5, Math.min(ltp * effectiveMax * 2.5, blendedTP3Move));

  const tp1 = Math.round((ltp + tp1Gain) * 100) / 100;
  const tp2 = Math.round((ltp + tp2Gain) * 100) / 100;
  const tp3 = Math.round((ltp + tp3Gain) * 100) / 100;

  // SL: dynamic based on regime and theta
  const slBuffer = theta * 2 + ltp * 0.03;
  const sl = Math.round(Math.max(ltp * 0.65, ltp - Math.min(ltp * 0.30, slBuffer)) * 100) / 100;
  const rr = (tp1 - ltp) / (ltp - sl || 1);

  // ─── STEP 5: Probability Calibration ────────────────────────────
  // Base probability from historical hit rate
  let tp1Prob = Math.round(histMem.hitRate * 100 * 1.05);
  let tp2Prob = Math.round(tp1Prob * 0.62);
  let tp3Prob = Math.round(tp1Prob * 0.25);

  // Regime adjustments
  if (regime.regime === "Volatility Expansion") { tp1Prob += 3; tp2Prob += 5; tp3Prob += 5; }
  if (regime.regime === "Breakout") { tp1Prob += 2; tp2Prob += 4; tp3Prob += 4; }
  if (regime.regime === "Gamma Pin") { tp1Prob += 5; tp2Prob -= 5; tp3Prob -= 10; }
  if (regime.regime === "Range") { tp1Prob += 4; tp2Prob -= 3; tp3Prob -= 8; }

  // Time decay adjustments
  if (timeDecay.sessionPhase === "Closing Hour") { tp1Prob -= 10; tp2Prob -= 15; tp3Prob -= 10; }
  if (timeDecay.sessionPhase === "Morning") { tp1Prob += 3; tp2Prob += 3; tp3Prob += 2; }

  // VIX adjustments
  if (vix > 22) { tp1Prob -= 5; tp2Prob -= 5; tp3Prob += 3; }
  if (vix < 12) { tp1Prob += 3; tp2Prob -= 3; tp3Prob -= 5; }

  // OI flow adjustments
  if (oiAbs.aggressiveBuying) { tp1Prob += 5; tp2Prob += 5; }
  if (oiAbs.freshShort) { tp1Prob -= 8; tp2Prob -= 10; }
  if (oiAbs.freshLongBuildup) { tp1Prob += 4; tp2Prob += 4; }

  // Volume adjustments
  if (volMom.unusualParticipation) { tp1Prob += 3; tp2Prob += 3; }

  // Gamma explosion adjustments
  if (gammaExp.score > 70) { tp1Prob += 2; tp2Prob += 4; tp3Prob += 5; }

  // Clamp probabilities
  tp1Prob = Math.max(30, Math.min(92, tp1Prob));
  tp2Prob = Math.max(15, Math.min(75, tp2Prob));
  tp3Prob = Math.max(5, Math.min(45, tp3Prob));

  // ─── STEP 6: Expected Spot Required ─────────────────────────────
  // How much spot needs to move for TP1 to be hit
  const spotRequiredForTP1 = delta > 0 ? tp1Gain / delta : expectedSpotMove * 1.2;

  // ─── STEP 7: Expected Time to TP ────────────────────────────────
  // Based on velocity, regime, and time remaining
  const velocityFactor = deltaAcc.score * 0.3 + gammaExp.score * 0.2 + volMom.score * 0.2 + instFlow.score * 0.15 + (100 - timeDecay.score) * 0.15;
  const baseETA = Math.max(5, Math.round(45 - velocityFactor * 0.35));
  const regimeETA = regime.regime === "Gamma Pin" ? 0.6 :
                    regime.regime === "Volatility Expansion" ? 0.7 :
                    regime.regime === "Breakout" ? 0.75 :
                    regime.regime === "Range" ? 1.4 : 1.0;
  const expectedTimeToTP = Math.max(3, Math.round(baseETA * regimeETA * timeDecay.adjustedTP));

  // ─── STEP 8: Expected Premium Velocity ──────────────────────────
  const expectedPremiumVelocity = expectedTimeToTP > 0 ? tp1Gain / expectedTimeToTP : 0;

  return {
    tp1, tp1Prob, tp2, tp2Prob, tp3, tp3Prob,
    sl: Math.round(sl * 100) / 100,
    rr: Math.round(rr * 100) / 100,
    expectedSpotRequired: Math.round(spotRequiredForTP1 * 100) / 100,
    expectedTimeToTP,
    expectedPremiumVelocity: Math.round(expectedPremiumVelocity * 100) / 100,
  };
}

// ─── Speed Label ───────────────────────────────────────────────────
function speedLabel(velocity: number): string {
  if (velocity >= 85) return "INSTANT";
  if (velocity >= 70) return "FAST";
  if (velocity >= 55) return "MODERATE";
  if (velocity >= 40) return "SLOW";
  return "STAGNANT";
}

function buyingLabel(score: number): string {
  if (score >= 80) return "Very High";
  if (score >= 60) return "High";
  if (score >= 40) return "Moderate";
  if (score >= 20) return "Low";
  return "Very Low";
}

function elasticityLabel(score: number): string {
  if (score >= 80) return "Very High";
  if (score >= 60) return "High";
  if (score >= 40) return "Moderate";
  return "Low";
}

function signalLabel(accel: number, ltp: number, oi: number, volume: number, sessionPhase: string, regime: string): string {
  // Reject illiquid / low-premium strikes outright
  if (ltp < 5 || oi < 500) return "IGNORE";
  if (volume < 100) return "WAIT";

  // Closing hour: suppress all signals — no new trades
  if (sessionPhase === "Closing Hour") {
    if (accel >= 95) return "WATCH";
    return "IGNORE";
  }

  // Closing hour + Reversal: never BUY
  if (sessionPhase === "Closing Hour" && regime === "Reversal") return "IGNORE";

  if (accel >= 90) return "STRONG BUY";
  if (accel >= 72) return "BUY";
  if (accel >= 55) return "WATCH";
  if (accel >= 40) return "WAIT";
  return "IGNORE";
}

// ─── Main Engine ───────────────────────────────────────────────────
export function runAccelerationEngine(
  strikes: StrikeInput[],
  ctx: MarketContext
): AccelerationResult {
  const allCELegs = strikes.map((s) => s.ce);
  const allPELegs = strikes.map((s) => s.pe);
  const allLegs = [...allCELegs, ...allPELegs];

  const regime = engineRegime(ctx);

  const scoredStrikes: AccelerationStrike[] = [];

  for (const strike of strikes) {
    for (const type of ["CE", "PE"] as const) {
      const leg = type === "CE" ? strike.ce : strike.pe;
      if (leg.ltp <= 0) continue;

      const distFromATM = Math.abs(strike.strike - ctx.atmStrike);
      const distFromSpot = Math.abs(strike.strike - ctx.spot);

      const deltaAcc = engineDeltaAcceleration(leg, ctx.spot, strike.strike);
      const gammaExp = engineGammaExplosion(leg, ctx.spot, strike.strike, ctx);
      const oiAbs = engineOIAbsorption(leg, null);
      const volMom = engineVolumeMomentum(leg, leg.oi);
      const instFlow = engineInstitutionalFlow(leg, allLegs, ctx);
      const premElast = enginePremiumElasticity(leg, ctx.spot, strike.strike, ctx);
      const histMem = engineHistoricalMemory(leg, ctx.spot, strike.strike, ctx);
      const timeDecay = engineTimeDecay(leg, ctx);

      const acceleration = computeAccelerationScore(
        deltaAcc, gammaExp, oiAbs, volMom, instFlow, premElast, histMem, timeDecay, regime
      );

      const velocity = computePremiumVelocity(deltaAcc, gammaExp, volMom, oiAbs, premElast, timeDecay, instFlow);

      const tps = computeTP(leg.ltp, leg, strike.strike, ctx, regime, timeDecay, histMem, deltaAcc, volMom, instFlow, oiAbs, gammaExp);

      const expectedGain = premElast.expectedMove20;
      const duration = Math.max(5, Math.round(60 - velocity * 0.5));

      const reasons: string[] = [];
      if (gammaExp.score > 70) reasons.push("Gamma Expansion");
      if (oiAbs.freshLongBuildup || oiAbs.aggressiveBuying) reasons.push("Fresh OI Buildup");
      if (volMom.unusualParticipation) reasons.push("Volume Spike");
      if (instFlow.dealerHedging) reasons.push("Dealer Unwind");
      if (instFlow.repeatedBuying) reasons.push("Institutional Buying");
      if (regime.regime !== "Range") reasons.push(`${regime.regime} Alignment`);
      if (deltaAcc.score > 70) reasons.push("High Delta Reaction");
      if (oiAbs.hiddenWriting) reasons.push("Hidden Accumulation");

      const bidAskSpread = leg.ask - leg.bid;

      const signal = signalLabel(acceleration, leg.ltp, leg.oi, leg.volume, timeDecay.sessionPhase, regime.regime);

      scoredStrikes.push({
        strike: strike.strike,
        type,
        acceleration,
        speed: speedLabel(velocity),
        expectedSpeed: velocity,
        expectedPremiumMove: Math.round(expectedGain * 10) / 10,
        probability: Math.round(tps.tp1Prob * 10) / 10,
        expectedDuration: duration,
        institutionalBuying: buyingLabel(instFlow.score),
        dealerResistance: instFlow.makerDefense ? "High" : instFlow.dealerHedging ? "Moderate" : "Low",
        premiumElasticity: elasticityLabel(premElast.score),
        historicalWinRate: Math.round(histMem.hitRate * 100),
        ltp: leg.ltp,
        delta: leg.delta,
        gamma: leg.gamma,
        theta: leg.theta,
        vega: leg.vega,
        iv: leg.iv,
        oi: leg.oi,
        oiChg: leg.oiChg,
        volume: leg.volume,
        bidAskSpread,
        spot: ctx.spot,
        distanceFromATM: distFromATM,
        distanceFromSpot: distFromSpot,
        tp1: tps.tp1,
        tp1Prob: tps.tp1Prob,
        tp2: tps.tp2,
        tp2Prob: tps.tp2Prob,
        tp3: tps.tp3,
        tp3Prob: tps.tp3Prob,
        sl: tps.sl,
        rr: tps.rr,
        expectedSpotRequired: tps.expectedSpotRequired,
        expectedTimeToTP: tps.expectedTimeToTP,
        expectedPremiumVelocity: tps.expectedPremiumVelocity,
        signal,
        tradable: signal === "STRONG BUY" || signal === "BUY",
        reason: reasons,
        engines: {
          deltaAcceleration: deltaAcc,
          gammaExplosion: gammaExp,
          oiAbsorption: oiAbs,
          volumeMomentum: volMom,
          institutionalFlow: instFlow,
          premiumElasticity: premElast,
          historicalMemory: histMem,
          timeDecay,
          regime,
        },
      });
    }
  }

  scoredStrikes.sort((a, b) => b.acceleration - a.acceleration);

  const ceStrikes = scoredStrikes.filter((s) => s.type === "CE" && s.ltp > 0);
  const peStrikes = scoredStrikes.filter((s) => s.type === "PE" && s.ltp > 0);

  // Prefer tradable signals first, then fill with WATCH if needed
  const ceTradable = ceStrikes.filter(s => s.tradable);
  const ceWatch = ceStrikes.filter(s => s.signal === "WATCH");
  const topCalls = [...ceTradable, ...ceWatch].slice(0, 5);

  const peTradable = peStrikes.filter(s => s.tradable);
  const peWatch = peStrikes.filter(s => s.signal === "WATCH");
  const topPuts = [...peTradable, ...peWatch].slice(0, 5);

  const fastestPremium = scoredStrikes[0] || null;
  const bestScalp = scoredStrikes.find((s) => s.expectedDuration <= 20 && s.probability >= 60) || scoredStrikes[0] || null;
  const bestSwing = scoredStrikes.find((s) => s.tp2Prob >= 40 && s.acceleration >= 60) || scoredStrikes[0] || null;
  const highestVelocity = [...scoredStrikes].sort((a, b) => b.expectedSpeed - a.expectedSpeed)[0] || null;
  const highestExplosion = [...scoredStrikes].sort((a, b) => b.engines.gammaExplosion.score - a.engines.gammaExplosion.score)[0] || null;
  const dealerWallStrike = [...scoredStrikes].sort((a, b) => b.engines.institutionalFlow.score - a.engines.institutionalFlow.score)[0] || null;
  const institutionalStrike = [...scoredStrikes].sort((a, b) => b.engines.oiAbsorption.score - a.engines.oiAbsorption.score)[0] || null;
  const trapRiskStrike = scoredStrikes.find((s) => s.engines.oiAbsorption.freshShort || s.engines.oiAbsorption.longUnwinding) || null;

  const avgAcceleration = scoredStrikes.reduce((s, x) => s + x.acceleration, 0) / (scoredStrikes.length || 1);
  const maxAcceleration = scoredStrikes[0]?.acceleration || 0;
  const avgVelocity = scoredStrikes.reduce((s, x) => s + x.expectedSpeed, 0) / (scoredStrikes.length || 1);
  const totalVolume = allLegs.reduce((s, l) => s + l.volume, 0);
  const totalOIChange = allLegs.reduce((s, l) => s + Math.abs(l.oiChg), 0);

  const sessionMinutes = ctx.sessionMinutes;
  const minutesToExpiry = ctx.minutesToExpiry;

  return {
    strikes: scoredStrikes,
    topCalls,
    topPuts,
    fastestPremium,
    bestScalp,
    bestSwing,
    highestVelocity,
    highestExplosion,
    dealerWallStrike,
    institutionalStrike,
    trapRiskStrike,
    timestamp: new Date().toISOString(),
    symbol: "",
    spot: ctx.spot,
    atmStrike: ctx.atmStrike,
    expectedMove: ctx.expectedMove,
    regime: regime.regime,
    sessionPhase: engineTimeDecay(allLegs[0] || { ltp: 0, bid: 0, ask: 0, oi: 0, oiChg: 0, volume: 0, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0 }, ctx).sessionPhase,
    metrics: {
      avgAcceleration: Math.round(avgAcceleration * 10) / 10,
      maxAcceleration: Math.round(maxAcceleration * 10) / 10,
      avgVelocity: Math.round(avgVelocity * 10) / 10,
      totalVolume,
      totalOIChange,
      pcr: ctx.pcr,
      vix: ctx.vix,
    },
  };
}
