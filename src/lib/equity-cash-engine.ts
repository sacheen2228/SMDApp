// Equity Cash Signal Engine - Main algorithm for Indian equity cash markets
// Builds setups, scores signals, generates trade plans

import {
  Candle, MarketData, MarketRegime, SetupType, TradeDirection,
  SignalStrength, SignalScore, TradePlan, EntryPlan, StopLoss, Target,
  LiquidityEvent, MarketStructureEvent, VWAPState, AuctionState, AcceptanceType,
  VolumeProfile, SessionProfile, SwingPoint
} from './auction-types';
import { analyzeMarketStructure, detectSwings } from './market-structure-engine';
import { analyzeLiquidity, detectLiquiditySweeps, identifyLiquidityLevels } from './liquidity-engine';
import { classifyMarketRegime, getRegimeCharacteristics } from './regime-classifier';
import { calculateSessionProfile, classifyAuctionState, detectAcceptance, calculateVolumeProfile } from './auction-engine';
import { calculateSessionVWAP, classifyVWAPState, calculateAllVWAPs } from './vwap-engine';
import { calculateRelativeVolume, analyzeBreakoutVolume, analyzePullbackVolume, analyzeReversalVolume } from './volume-engine';
import { detectGaps, analyzeGap } from './gap-engine';

const TICK_SIZE = 0.05;

export function buildEquityMarketData(
  candles: Candle[],
  prevDayHigh: number,
  prevDayLow: number,
  prevWeekHigh: number,
  prevWeekLow: number
): MarketData {
  // Session profile
  const sessionProfile = calculateSessionProfile(candles, TICK_SIZE);
  sessionProfile.prevDayHigh = prevDayHigh;
  sessionProfile.prevDayLow = prevDayLow;
  sessionProfile.prevWeekHigh = prevWeekHigh;
  sessionProfile.prevWeekLow = prevWeekLow;

  // Composite profile (would need historical - using current for now)
  const compositeProfile = calculateVolumeProfile(candles, TICK_SIZE);

  // Swings & Structure
  const swings = detectSwings(candles);
  const structure = analyzeMarketStructure(candles);

  // VWAP
  const sessionVwap = calculateSessionVWAP(candles);
  const vwapAnchors = calculateAllVWAPs(candles, swings);
  const vwapState = classifyVWAPState(
    candles[candles.length - 1]?.close || 0,
    sessionVwap.vwap,
    candles[candles.length - 2]?.close || 0,
    candles[0]?.open || 0,
    vwapAnchors
  );

  // Relative Volume
  const relativeVol = calculateRelativeVolume(candles, candles.length - 1);

  // Liquidity
  const liquidity = analyzeLiquidity(
    candles, swings,
    prevDayHigh, prevDayLow, prevWeekHigh, prevWeekLow
  );

  // Gaps
  const gaps = detectGaps(candles);

  // Auction state
  const profile = calculateVolumeProfile(candles, TICK_SIZE);
  const { state: auctionState, location } = classifyAuctionState(
    candles[candles.length - 1]?.close || 0,
    profile.vah, profile.val, profile.poc
  );
  const acceptance = detectAcceptance(profile, null, candles[candles.length - 1]?.close || 0);

  // Regime
  const regime = classifyMarketRegime(candles, profile, sessionProfile, structure, relativeVol, sessionVwap.vwap, vwapState);

  return {
    symbol: '', // filled by caller
    candles,
    sessionProfile,
    compositeProfile,
    swings,
    structure: structure.structurePoints,
    vwapAnchors,
    relativeVol,
    volumeAtPrice: [],
    gaps,
    liquidityLevels: liquidity.levels,
    regime,
    auctionState,
    acceptance,
    valueMigration: 'NEUTRAL',
  };
}

export function evaluateEquitySetups(
  data: MarketData
): { longSetups: SetupType[]; shortSetups: SetupType[] } {
  const longSetups: SetupType[] = [];
  const shortSetups: SetupType[] = [];
  const price = data.candles[data.candles.length - 1]?.close || 0;
  const profile = data.sessionProfile;
  const liquidity = data.liquidityLevels;
  const structure = data.structure;
  const vwapAnchors = data.vwapAnchors;

  // Helper: check if level exists
  const hasLevelNear = (target: number, tolerance = 0.002) =>
    liquidity.some(l => Math.abs(l.price - target) / target < tolerance);

  // ---- LONG SETUPS ----

  // VAL Reclaim
  if (price > profile.val && hasLevelNear(profile.val) && data.relativeVol.ratio > 1.2) {
    longSetups.push('VAL_RECLAIM');
  }

  // Previous Low Sweep + Reclaim
  const pdl = liquidity.find(l => l.type === 'PDL' && l.swept);
  if (pdl && price > pdl.price && data.relativeVol.ratio > 1.0) {
    longSetups.push('PREV_LOW_SWEEP_RECLAIM');
  }

  // VWAP Reclaim
  const sessionVwap = vwapAnchors.find(v => v.type === 'SESSION');
  if (sessionVwap && price > sessionVwap.price && hasLevelNear(sessionVwap.price)) {
    longSetups.push('VWAP_RECLAIM');
  }

  // Opening Range Breakout
  if (price > profile.openingRange.high && data.relativeVol.ratio > 1.5) {
    longSetups.push('OPENING_RANGE_BREAKOUT');
  }

  // LVN Breakout
  for (const lvn of profile.lvn) {
    if (price > lvn && hasLevelNear(lvn) && data.relativeVol.ratio > 1.3) {
      longSetups.push('LVN_BREAKOUT');
      break;
    }
  }

  // HVN Rejection + Bullish Structure
  for (const hvn of profile.hvn) {
    if (price < hvn && price > hvn * 0.998 && hasLevelNear(hvn)) {
      longSetups.push('HVN_REJECTION_BULLISH');
      break;
    }
  }

  // Failed Breakdown
  const failedBD = liquidity.some(l => l.type === 'FAILED_BREAKDOWN');
  if (failedBD) longSetups.push('FAILED_BREAKDOWN');

  // Gap Reversal
  const gapReversal = data.gaps.some(g => g.type === 'GAP_REVERSAL' || g.gapAndGo === false);
  if (gapReversal) longSetups.push('GAP_REVERSAL');

  // POC Reclaim
  if (price > profile.poc && hasLevelNear(profile.poc) && price < profile.poc * 1.005) {
    longSetups.push('POC_RECLAIM');
  }

  // ---- SHORT SETUPS ----

  // VAH Rejection
  if (price < profile.vah && hasLevelNear(profile.vah) && data.relativeVol.ratio > 1.2) {
    shortSetups.push('VAH_REJECTION');
  }

  // Previous High Sweep + Rejection
  const pdh = liquidity.find(l => l.type === 'PDH' && l.swept);
  if (pdh && price < pdh.price) {
    shortSetups.push('PREV_HIGH_SWEEP_REJECTION');
  }

  // VWAP Rejection
  if (sessionVwap && price < sessionVwap.price && hasLevelNear(sessionVwap.price)) {
    shortSetups.push('VWAP_REJECTION');
  }

  // Opening Range Breakdown
  if (price < profile.openingRange.low && data.relativeVol.ratio > 1.5) {
    shortSetups.push('OPENING_RANGE_BREAKDOWN');
  }

  // LVN Breakdown
  for (const lvn of profile.lvn) {
    if (price < lvn && hasLevelNear(lvn) && data.relativeVol.ratio > 1.3) {
      shortSetups.push('LVN_BREAKDOWN');
      break;
    }
  }

  // HVN Rejection + Bearish Structure
  for (const hvn of profile.hvn) {
    if (price > hvn && price < hvn * 1.002 && hasLevelNear(hvn)) {
      shortSetups.push('HVN_REJECTION_BEARISH');
      break;
    }
  }

  // Failed Breakout
  const failedBO = liquidity.some(l => l.type === 'FAILED_BREAKOUT');
  if (failedBO) shortSetups.push('FAILED_BREAKOUT');

  // Gap Failure
  const gapFail = data.gaps.some(g => g.gapAndGo === false);
  if (gapFail) shortSetups.push('GAP_FAILURE');

  // POC Rejection
  if (price < profile.poc && hasLevelNear(profile.poc)) {
    shortSetups.push('POC_REJECTION');
  }

  return { longSetups, shortSetups };
}

export function scoreEquitySignal(
  data: MarketData,
  direction: TradeDirection,
  setup: SetupType
): SignalScore {
  const profile = data.sessionProfile;
  const liquidity = data.liquidityLevels;
  const structure = data.structure;
  const vwapState = classifyVWAPState(
    data.candles[data.candles.length - 1]?.close || 0,
    data.sessionProfile.sessionVwap,
    data.candles[data.candles.length - 2]?.close || 0,
    data.candles[0]?.open || 0,
    data.vwapAnchors
  );
  const regimeChars = getRegimeCharacteristics(data.regime);

  // Auction Structure (25)
  let auctionScore = 15; // base
  if (direction === 'LONG' && data.auctionState === 'PRICE_BELOW_VALUE') auctionScore += 10;
  if (direction === 'SHORT' && data.auctionState === 'PRICE_ABOVE_VALUE') auctionScore += 10;
  if (data.acceptance === 'VALUE_MIGRATION_HIGHER' && direction === 'LONG') auctionScore += 10;
  if (data.acceptance === 'VALUE_MIGRATION_LOWER' && direction === 'SHORT') auctionScore += 10;

  // Volume Profile (20)
  let vpScore = 10;
  if (direction === 'LONG' && data.sessionProfile.val > 0) vpScore += 10;
  if (direction === 'SHORT' && data.sessionProfile.vah > 0) vpScore += 10;

  // Liquidity (20)
  let liqScore = 10;
  const relevantLevels = liquidity.filter(l =>
    direction === 'LONG' ? l.type.includes('LOW') || l.type === 'PDL' :
    l.type.includes('HIGH') || l.type === 'PDH'
  );
  const sweptRelevant = relevantLevels.filter(l => l.swept).length;
  liqScore += Math.min(sweptRelevant * 5, 10);

  // Market Structure (15)
  let msScore = 8;
  const bullishStructure = structure.some(s =>
    s.swing.type === 'LOW' && s.swing.price > structure[structure.length - 2]?.swing.price
  );
  const bearishStructure = structure.some(s =>
    s.swing.type === 'HIGH' && s.swing.price < structure[structure.length - 2]?.swing.price
  );
  if ((direction === 'LONG' && bullishStructure) || (direction === 'SHORT' && bearishStructure)) {
    msScore += 7;
  }

  // Volume (10)
  let volScore = 5;
  if (data.relativeVol.ratio > 1.5) volScore += 5;
  else if (data.relativeVol.ratio > 1.2) volScore += 3;

  // VWAP (5)
  let vwapScore = 3;
  if (direction === 'LONG' && vwapState.state === 'VWAP_RECLAIM') vwapScore += 2;
  if (direction === 'SHORT' && vwapState.state === 'VWAP_REJECTION') vwapScore += 2;

  // Market Regime (5)
  let regimeScore = 0;
  if (regimeChars.bias === (direction === 'LONG' ? 'BULLISH' : 'BEARISH')) regimeScore = 5;
  else if (regimeChars.bias === 'NEUTRAL') regimeScore = 2;

  const total = Math.min(100, auctionScore + vpScore + liqScore + msScore + volScore + vwapScore + regimeScore);

  let strength: SignalStrength = 'NO_TRADE';
  if (total >= 90) strength = 'A+';
  else if (total >= 80) strength = 'A';
  else if (total >= 70) strength = 'B';
  else if (total >= 60) strength = 'WATCH';

  return {
    auctionStructure: Math.min(25, auctionScore),
    volumeProfile: Math.min(20, vpScore),
    liquidity: Math.min(20, liqScore),
    marketStructure: Math.min(15, msScore),
    volume: Math.min(10, volScore),
    vwap: Math.min(5, vwapScore),
    marketRegime: Math.min(5, regimeScore),
    total,
    strength,
  };
}

export function generateEquityTradePlan(
  data: MarketData,
  direction: TradeDirection,
  setup: SetupType,
  score: SignalScore
): TradePlan {
  const price = data.candles[data.candles.length - 1]?.close || 0;
  const profile = data.sessionProfile;
  const liquidity = data.liquidityLevels;
  const sessionVwap = data.vwapAnchors.find(v => v.type === 'SESSION')?.price || price;

  // Entry prices
  let aggressive = price;
  let confirmation = price;
  let retest = price;

  if (direction === 'LONG') {
    aggressive = price;
    confirmation = Math.max(price, profile.val);
    retest = Math.min(profile.val, profile.poc);
  } else {
    aggressive = price;
    confirmation = Math.min(price, profile.vah);
    retest = Math.max(profile.vah, profile.poc);
  }

  // Stop Loss - structural
  let slPrice: number;
  let slType: StopLoss['type'] = 'SWING';
  if (direction === 'LONG') {
    const swingLow = data.swings.filter(s => s.type === 'LOW').pop();
    slPrice = swingLow ? swingLow.price * 0.998 : price * 0.98;
    slType = 'SWING';
  } else {
    const swingHigh = data.swings.filter(s => s.type === 'HIGH').pop();
    slPrice = swingHigh ? swingHigh.price * 1.002 : price * 1.02;
    slType = 'SWING';
  }

  // Targets
  const targets: Target[] = [];
  if (direction === 'LONG') {
    targets.push({ price: profile.vah, type: 'VAH', rr: (profile.vah - price) / (price - slPrice) });
    targets.push({ price: profile.poc, type: 'POC', rr: (profile.poc - price) / (price - slPrice) });
    targets.push({ price: profile.vah * 1.01, type: 'LIQUIDITY', rr: (profile.vah * 1.01 - price) / (price - slPrice) });
  } else {
    targets.push({ price: profile.val, type: 'VAL', rr: (price - profile.val) / (slPrice - price) });
    targets.push({ price: profile.poc, type: 'POC', rr: (price - profile.poc) / (slPrice - price) });
    targets.push({ price: profile.val * 0.99, type: 'LIQUIDITY', rr: (price - profile.val * 0.99) / (slPrice - price) });
  }

  const avgR = targets.reduce((s, t) => s + t.rr, 0) / targets.length;
  const maxLoss = direction === 'LONG' ? price - slPrice : slPrice - price;
  const maxProfit = targets[2] ? Math.abs(targets[2].price - price) : Math.abs(targets[0].price - price);
  const breakeven = direction === 'LONG' ? price + maxLoss * 0.5 : price - maxLoss * 0.5;
  const riskReward = maxProfit / maxLoss;

  // Historical expectancy (placeholder - would come from backtest)
  const historicalExpectancy = score.total / 100 * avgR * 0.6 - (1 - score.total / 100) * 1;

  return {
    symbol: data.symbol,
    direction,
    setup,
    entry: { aggressive, confirmation, retest },
    stopLoss: { price: slPrice, type: slType, reason: `Structural ${slType.toLowerCase()}` },
    targets,
    maxLoss,
    maxProfit,
    breakeven,
    riskReward,
    signalScore: score,
    historicalExpectancy,
    finalDecision: score.strength === 'NO_TRADE' || score.total < 60 ? 'NO_TRADE' : direction,
  };
}

export function analyzeEquityCash(
  symbol: string,
  candles: Candle[],
  prevDayHigh: number,
  prevDayLow: number,
  prevWeekHigh: number,
  prevWeekLow: number
): {
  data: MarketData;
  longSetups: SetupType[];
  shortSetups: SetupType[];
  bestLong?: TradePlan;
  bestShort?: TradePlan;
  finalDecision: TradeDirection;
} {
  const data = buildEquityMarketData(candles, prevDayHigh, prevDayLow, prevWeekHigh, prevWeekLow);
  data.symbol = symbol;

  const { longSetups, shortSetups } = evaluateEquitySetups(data);

  // Score each setup and pick best
  let bestLong: TradePlan | undefined;
  let bestShort: TradePlan | undefined;
  let bestLongScore = 0;
  let bestShortScore = 0;

  for (const setup of longSetups) {
    const score = scoreEquitySignal(data, 'LONG', setup);
    if (score.total > bestLongScore) {
      bestLongScore = score.total;
      bestLong = generateEquityTradePlan(data, 'LONG', setup, score);
    }
  }

  for (const setup of shortSetups) {
    const score = scoreEquitySignal(data, 'SHORT', setup);
    if (score.total > bestShortScore) {
      bestShortScore = score.total;
      bestShort = generateEquityTradePlan(data, 'SHORT', setup, score);
    }
  }

  // Final decision
  let finalDecision: TradeDirection = 'NO_TRADE';
  if (bestLong && bestLong.signalScore.total >= 70 && bestLongScore >= bestShortScore) {
    finalDecision = 'LONG';
  } else if (bestShort && bestShort.signalScore.total >= 70 && bestShortScore > bestLongScore) {
    finalDecision = 'SHORT';
  }

  return { data, longSetups, shortSetups, bestLong, bestShort, finalDecision };
}