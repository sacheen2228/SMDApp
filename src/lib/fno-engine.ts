// F&O Engine - Indian Index/Stock Futures & Options
// Auction + Volume Profile + Futures OI + Option Chain + IV + Greeks

import {
  Candle, OptionChainSnapshot, OptionChainStrike, OptionMetrics,
  FuturesData, MarketRegime, SetupType, TradeDirection, SignalStrength,
  SignalScore, TradePlan, EntryPlan, StopLoss, Target,
  IVState, FuturesOIState, VolumeProfile, SessionProfile
} from './auction-types';
import { analyzeMarketStructure, detectSwings } from './market-structure-engine';
import { analyzeLiquidity, identifyLiquidityLevels } from './liquidity-engine';
import { classifyMarketRegime, getRegimeCharacteristics } from './regime-classifier';
import { calculateSessionProfile, classifyAuctionState, detectAcceptance, calculateVolumeProfile } from './auction-engine';
import { calculateSessionVWAP, classifyVWAPState, calculateAllVWAPs } from './vwap-engine';
import { calculateRelativeVolume } from './volume-engine';
import { detectGaps } from './gap-engine';

const TICK_SIZE = 0.05;

export interface FnoMarketData {
  symbol: string;
  spot: number;
  candles: Candle[];
  sessionProfile: SessionProfile;
  compositeProfile: VolumeProfile;
  swings: { time: number; price: number; type: 'HIGH' | 'LOW' }[];
  structure: ReturnType<typeof analyzeMarketStructure>;
  vwapAnchors: ReturnType<typeof calculateAllVWAPs>;
  relativeVol: ReturnType<typeof calculateRelativeVolume>;
  liquidityLevels: ReturnType<typeof identifyLiquidityLevels>;
  gaps: ReturnType<typeof detectGaps>;
  futures: FuturesData | null;
  optionChain: OptionChainSnapshot | null;
  regime: MarketRegime;
  auctionState: AuctionState;
  acceptance: AcceptanceType;
  ivState: IVState;
}

export function buildFnoMarketData(
  symbol: string,
  spot: number,
  candles: Candle[],
  futures: FuturesData | null,
  optionChain: OptionChainSnapshot | null,
  prevDayHigh: number,
  prevDayLow: number,
  prevWeekHigh: number,
  prevWeekLow: number
): FnoMarketData {
  const sessionProfile = calculateSessionProfile(candles, TICK_SIZE);
  sessionProfile.prevDayHigh = prevDayHigh;
  sessionProfile.prevDayLow = prevDayLow;
  sessionProfile.prevWeekHigh = prevWeekHigh;
  sessionProfile.prevWeekLow = prevWeekLow;

  const compositeProfile = calculateVolumeProfile(candles, TICK_SIZE);
  const swings = detectSwings(candles);
  const structure = analyzeMarketStructure(candles);
  const sessionVwap = calculateSessionVWAP(candles);
  const vwapAnchors = calculateAllVWAPs(candles, swings);
  const relativeVol = calculateRelativeVolume(candles, candles.length - 1);
  const liquidity = analyzeLiquidity(candles, swings, prevDayHigh, prevDayLow, prevWeekHigh, prevWeekLow);
  const gaps = detectGaps(candles);
  const profile = calculateVolumeProfile(candles, TICK_SIZE);
  const { state: auctionState } = classifyAuctionState(spot, profile.vah, profile.val, profile.poc);
  const acceptance = detectAcceptance(profile, null, spot);

  const regime = classifyMarketRegime(candles, profile, sessionProfile, structure, relativeVol, sessionVwap.vwap,
    classifyVWAPState(spot, sessionVwap.vwap, candles[candles.length - 2]?.close || 0, candles[0]?.open || 0, vwapAnchors)
  );

  // IV State
  const ivState = calculateIVState(optionChain);

  return {
    symbol,
    spot,
    candles,
    sessionProfile,
    compositeProfile,
    swings,
    structure,
    vwapAnchors,
    relativeVol,
    liquidityLevels: liquidity.levels,
    gaps,
    futures,
    optionChain,
    regime,
    auctionState,
    acceptance,
    ivState,
  };
}

function calculateIVState(oc: OptionChainSnapshot | null): IVState {
  if (!oc || oc.atmIV <= 0) return 'NORMAL_IV';

  if (oc.ivPercentile > 80) return 'EXTREME_IV';
  if (oc.ivPercentile > 60) return 'HIGH_IV';
  if (oc.ivPercentile < 20) return 'LOW_IV';
  return 'NORMAL_IV';
}

export function evaluateFnoSetups(data: FnoMarketData): { longSetups: SetupType[]; shortSetups: SetupType[] } {
  const longSetups: SetupType[] = [];
  const shortSetups: SetupType[] = [];
  const profile = data.sessionProfile;
  const spot = data.spot;
  const futures = data.futures;
  const oc = data.optionChain;

  // ---- LONG SETUPS ----

  // VAL Reclaim
  if (spot > data.sessionProfile.val && data.relativeVol.ratio > 1.2) {
    longSetups.push('VAL_RECLAIM_FO');
  }

  // VAH Rejection
  if (spot < data.sessionProfile.vah && data.relativeVol.ratio > 1.2) {
    shortSetups.push('VAH_REJECTION_FO');
  }

  // POC Reclaim
  if (spot > data.sessionProfile.poc && spot < data.sessionProfile.poc * 1.005) {
    longSetups.push('POC_RECLAIM_FO');
  }

  // LVN Breakout
  for (const lvn of data.sessionProfile.lvn) {
    if (spot > lvn && data.relativeVol.ratio > 1.3) {
      longSetups.push('LVN_BREAKOUT_FO');
      break;
    }
  }

  // HVN Rejection
  for (const hvn of data.sessionProfile.hvn) {
    if (spot < hvn && spot > hvn * 0.998) {
      longSetups.push('HVN_REJECTION_FO');
      break;
    }
    if (spot > hvn && spot < hvn * 1.002) {
      shortSetups.push('HVN_REJECTION_FO');
      break;
    }
  }

  // Opening Range Breakout
  if (spot > data.sessionProfile.openingRange.high && data.relativeVol.ratio > 1.5) {
    longSetups.push('OPENING_RANGE_BREAKOUT_FO');
  }
  if (spot < data.sessionProfile.openingRange.low && data.relativeVol.ratio > 1.5) {
    shortSetups.push('OPENING_RANGE_FAILURE_FO');
  }

  // Liquidity Sweep
  const sweepLow = data.liquidityLevels.some(l => l.swept && l.type.includes('LOW'));
  const sweepHigh = data.liquidityLevels.some(l => l.swept && l.type.includes('HIGH'));
  if (sweepLow) longSetups.push('LIQUIDITY_SWEEP_FO');
  if (sweepHigh) shortSetups.push('LIQUIDITY_SWEEP_FO');

  // Failed Breakout
  const failedBO = data.liquidityLevels.some(l => l.type === 'FAILED_BREAKOUT');
  if (failedBO) shortSetups.push('FAILED_BREAKOUT_FO');

  // CVD/Delta Confirmation
  if (oc && oc.pcr < 0.7 && data.structure.currentTrend === 'UP') {
    longSetups.push('CVD_DELTA_CONFIRMATION');
  }
  if (oc && oc.pcr > 1.3 && data.structure.currentTrend === 'DOWN') {
    shortSetups.push('CVD_DELTA_CONFIRMATION');
  }

  // Futures OI Confirmation
  if (futures) {
    if (futures.oiState === 'LONG_BUILDUP' && data.structure.currentTrend === 'UP') {
      longSetups.push('FUTURES_OI_CONFIRMATION');
    }
    if (futures.oiState === 'SHORT_BUILDUP' && data.structure.currentTrend === 'DOWN') {
      shortSetups.push('FUTURES_OI_CONFIRMATION');
    }
  }

  // Option Chain Confirmation
  if (oc) {
    // Call OI building at strikes above spot = resistance
    // Put OI building at strikes below spot = support
    const atmStrike = oc.atmStrike;
    const callOIAbove = Array.from(oc.callOiMap.entries())
      .filter(([k]) => k > atmStrike)
      .reduce((s, [, v]) => s + v, 0);
    const putOIBelow = Array.from(oc.putOiMap.entries())
      .filter(([k]) => k < atmStrike)
      .reduce((s, [, v]) => s + v, 0);

    if (putOIBelow > callOIAbove * 1.2) longSetups.push('OPTION_CHAIN_CONFIRMATION');
    if (callOIAbove > putOIBelow * 1.2) shortSetups.push('OPTION_CHAIN_CONFIRMATION');
  }

  return { longSetups, shortSetups };
}

export function scoreFnoSignal(
  data: FnoMarketData,
  direction: TradeDirection,
  setup: SetupType
): SignalScore {
  const profile = data.sessionProfile;
  const liquidity = data.liquidityLevels;
  const structure = data.structure;
  const futures = data.futures;
  const oc = data.optionChain;

  const vwapState = classifyVWAPState(
    data.spot,
    data.sessionProfile.sessionVwap,
    data.candles[data.candles.length - 2]?.close || 0,
    data.candles[0]?.open || 0,
    data.vwapAnchors
  );

  const regimeChars = getRegimeCharacteristics(data.regime);

  // Underlying Auction (20)
  let auctionScore = 12;
  if (direction === 'LONG' && data.auctionState === 'PRICE_BELOW_VALUE') auctionScore += 8;
  if (direction === 'SHORT' && data.auctionState === 'PRICE_ABOVE_VALUE') auctionScore += 8;

  // Volume Profile (15)
  let vpScore = 8;
  if (direction === 'LONG' && profile.val > 0) vpScore += 7;

  // Liquidity (15)
  let liqScore = 8;
  const sweptLow = liquidity.filter(l => l.swept && l.type.includes('LOW')).length;
  const sweptHigh = liquidity.filter(l => l.swept && l.type.includes('HIGH')).length;
  if (direction === 'LONG' && sweptLow > 0) liqScore += 7;
  if (direction === 'SHORT' && sweptHigh > 0) liqScore += 7;

  // Market Structure (15)
  let msScore = 8;
  if ((direction === 'LONG' && structure.currentTrend === 'UP') ||
      (direction === 'SHORT' && structure.currentTrend === 'DOWN')) {
    msScore += 7;
  }

  // Futures OI (10)
  let oiScore = 5;
  if (futures) {
    if (direction === 'LONG' && (futures.oiState === 'LONG_BUILDUP' || futures.oiState === 'SHORT_COVERING')) oiScore += 5;
    if (direction === 'SHORT' && (futures.oiState === 'SHORT_BUILDUP' || futures.oiState === 'LONG_UNWINDING')) oiScore += 5;
  }

  // Option Chain (10)
  let ocScore = 5;
  if (oc) {
    if (direction === 'LONG' && oc.pcr < 0.8) ocScore += 5;
    if (direction === 'SHORT' && oc.pcr > 1.2) ocScore += 5;
  }

  // IV/Greeks (10)
  let ivScore = 5;
  if (data.ivState === 'LOW_IV' && direction === 'LONG') ivScore += 5;
  if (data.ivState === 'HIGH_IV' && direction === 'SHORT') ivScore += 5;
  if (data.ivState === 'EXTREME_IV') ivScore = 2; // penalize

  // VWAP (5)
  let vwapScore = 3;
  if (direction === 'LONG' && vwapState.state === 'VWAP_RECLAIM') vwapScore += 2;
  if (direction === 'SHORT' && vwapState.state === 'VWAP_REJECTION') vwapScore += 2;

  const total = Math.min(100, auctionScore + vpScore + liqScore + msScore + oiScore + ocScore + ivScore + vwapScore);

  let strength: SignalStrength = 'NO_TRADE';
  if (total >= 90) strength = 'A+';
  else if (total >= 80) strength = 'A';
  else if (total >= 70) strength = 'B';
  else if (total >= 60) strength = 'WATCH';

  return {
    auctionStructure: Math.min(20, auctionScore),
    volumeProfile: Math.min(15, vpScore),
    liquidity: Math.min(15, liqScore),
    marketStructure: Math.min(15, msScore),
    futuresOI: Math.min(10, oiScore),
    optionChain: Math.min(10, ocScore),
    ivGreeks: Math.min(10, ivScore),
    vwap: Math.min(5, vwapScore),
    total,
    strength,
  };
}

export function selectOptionStrategy(
  data: FnoMarketData,
  direction: TradeDirection,
  score: SignalScore
): {
  strategy: 'BUY_CE' | 'BUY_PE' | 'CALL_SPREAD' | 'PUT_SPREAD' | 'OTHER_DEFINED_RISK' | 'NO_TRADE';
  reasoning: string;
  strike: number;
  expiry: string;
} {
  const oc = data.optionChain;
  if (!oc || score.total < 70) {
    return { strategy: 'NO_TRADE', reasoning: 'No option chain or score too low', strike: 0, expiry: '' };
  }

  const spot = data.spot;
  const atmStrike = oc.atmStrike;
  const daysToExpiry = calculateDaysToExpiry(oc.expiry);

  // Prefer defined risk (spreads) over naked
  // Unless very high conviction (A+) and low IV
  const highConviction = score.strength === 'A+';
  const lowIV = data.ivState === 'LOW_IV' || data.ivState === 'NORMAL_IV';

  if (direction === 'LONG') {
    if (highConviction && lowIV && daysToExpiry > 7) {
      return { strategy: 'BUY_CE', reasoning: 'High conviction, low IV, long expiry - directional', strike: atmStrike, expiry: oc.expiry };
    }
    // Default: Call Spread
    const longStrike = atmStrike;
    const shortStrike = atmStrike + getStrikeStep(spot) * 2;
    return { strategy: 'CALL_SPREAD', reasoning: 'Defined risk bullish', strike: longStrike, expiry: oc.expiry };
  } else {
    if (highConviction && lowIV && daysToExpiry > 7) {
      return { strategy: 'BUY_PE', reasoning: 'High conviction, low IV, long expiry - directional', strike: atmStrike, expiry: oc.expiry };
    }
    const longStrike = atmStrike;
    const shortStrike = atmStrike - getStrikeStep(spot) * 2;
    return { strategy: 'PUT_SPREAD', reasoning: 'Defined risk bearish', strike: longStrike, expiry: oc.expiry };
  }
}

function getStrikeStep(spot: number): number {
  if (spot > 40000) return 100; // SENSEX/BANKNIFTY
  if (spot > 20000) return 50;  // NIFTY
  return 50;
}

function calculateDaysToExpiry(expiryStr: string): number {
  const expiry = new Date(expiryStr);
  const now = new Date();
  return Math.max(0, Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
}

export function generateFnoTradePlan(
  data: FnoMarketData,
  direction: TradeDirection,
  setup: SetupType,
  score: SignalScore
): TradePlan {
  const spot = data.spot;
  const profile = data.sessionProfile;
  const oc = data.optionChain;
  const strategy = selectOptionStrategy(data, direction, score);

  const strategyInfo = selectOptionStrategy(data, direction, score);
  const entryPrice = spot;
  const slPrice = direction === 'LONG'
    ? spot * 0.99
    : spot * 1.01;

  // Targets based on profile levels
  const targets: Target[] = [];
  if (direction === 'LONG') {
    targets.push({ price: profile.vah, type: 'VAH', rr: (profile.vah - spot) / (spot - slPrice) });
    targets.push({ price: profile.poc, type: 'POC', rr: (profile.poc - spot) / (spot - slPrice) });
    targets.push({ price: profile.vah * 1.01, type: 'LIQUIDITY', rr: (profile.vah * 1.01 - spot) / (spot - slPrice) });
  } else {
    targets.push({ price: profile.val, type: 'VAL', rr: (spot - profile.val) / (slPrice - spot) });
    targets.push({ price: profile.poc, type: 'POC', rr: (spot - profile.poc) / (slPrice - spot) });
    targets.push({ price: profile.val * 0.99, type: 'LIQUIDITY', rr: (spot - profile.val * 0.99) / (slPrice - spot) });
  }

  const maxLoss = direction === 'LONG' ? entryPrice - slPrice : slPrice - entryPrice;
  const maxProfit = targets[2] ? Math.abs(targets[2].price - entryPrice) : Math.abs(targets[0].price - entryPrice);
  const riskReward = maxProfit / maxLoss;
  const breakeven = direction === 'LONG' ? entryPrice + maxLoss * 0.5 : entryPrice - maxLoss * 0.5;

  // Historical expectancy
  const avgR = targets.reduce((s, t) => s + t.rr, 0) / targets.length;
  const historicalExpectancy = score.total / 100 * avgR * 0.6 - (1 - score.total / 100) * 1;

  return {
    symbol: data.symbol,
    direction,
    setup,
    entry: { aggressive: entryPrice, confirmation: entryPrice, retest: entryPrice },
    stopLoss: { price: slPrice, type: 'SWING', reason: 'Structural invalidation' },
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

export function analyzeFno(
  symbol: string,
  spot: number,
  candles: Candle[],
  futures: FuturesData | null,
  optionChain: OptionChainSnapshot | null,
  prevDayHigh: number,
  prevDayLow: number,
  prevWeekHigh: number,
  prevWeekLow: number
): {
  data: FnoMarketData;
  longSetups: SetupType[];
  shortSetups: SetupType[];
  bestLong?: TradePlan;
  bestShort?: TradePlan;
  preferredStrategy: ReturnType<typeof selectOptionStrategy>;
  finalDecision: TradeDirection;
} {
  const data = buildFnoMarketData(symbol, spot, candles, futures, optionChain,
    prevDayHigh, prevDayLow, prevWeekHigh, prevWeekLow);

  const { longSetups, shortSetups } = evaluateFnoSetups(data);

  let bestLong: TradePlan | undefined;
  let bestShort: TradePlan | undefined;
  let bestLongScore = 0;
  let bestShortScore = 0;

  for (const setup of longSetups) {
    const score = scoreFnoSignal(data, 'LONG', setup);
    if (score.total > bestLongScore) {
      bestLongScore = score.total;
      bestLong = generateFnoTradePlan(data, 'LONG', setup, score);
    }
  }

  for (const setup of shortSetups) {
    const score = scoreFnoSignal(data, 'SHORT', setup);
    if (score.total > bestShortScore) {
      bestShortScore = score.total;
      bestShort = generateFnoTradePlan(data, 'SHORT', setup, score);
    }
  }

  const preferredStrategy = selectOptionStrategy(data, 'LONG', { total: bestLongScore } as SignalScore);

  let finalDecision: TradeDirection = 'NO_TRADE';
  if (bestLong && bestLong.signalScore.total >= 70 && bestLongScore >= bestShortScore) {
    finalDecision = 'LONG';
  } else if (bestShort && bestShort.signalScore.total >= 70 && bestShortScore > bestLongScore) {
    finalDecision = 'SHORT';
  }

  return { data, longSetups, shortSetups, bestLong, bestShort, preferredStrategy, finalDecision };
}