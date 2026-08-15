// Index Comparison Engine - Compares all 5 primary indices side by side
// Generates the comparison table with regime, auction, POC, VAH, VAL, etc.

import { IndexSymbol, INDEX_UNIVERSE, IndexMeta } from './index-universe';
import { Candle, MarketRegime, AuctionState, VolumeProfile, SessionProfile, MarketStructureEvent, LiquidityEvent, VWAPState } from './auction-types';
import { calculateSessionProfile, classifyAuctionState, detectAcceptance, calculateVolumeProfile } from './auction-engine';
import { analyzeMarketStructure, detectSwings } from './market-structure-engine';
import { analyzeLiquidity, identifyLiquidityLevels } from './liquidity-engine';
import { calculateSessionVWAP, classifyVWAPState, calculateAllVWAPs } from './vwap-engine';
import { calculateRelativeVolume } from './volume-engine';
import { classifyMarketRegime, getRegimeCharacteristics } from './regime-classifier';
import { getHistoricalCandles } from './historical-data';

const TICK_SIZES: Record<IndexSymbol, number> = {
  NIFTY: 0.05,
  SENSEX: 0.05,
  BANKNIFTY: 0.05,
  FINNIFTY: 0.05,
  MIDCPNIFTY: 0.05,
};

export interface IndexComparisonData {
  symbol: IndexSymbol;
  name: string;
  price: number;
  change: number;
  changePct: number;
  regime: MarketRegime;
  regimeBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  auctionState: AuctionState;
  poc: number;
  vah: number;
  val: number;
  volume: number;
  relativeVolume: number;
  liquidity: string;
  structure: string;
  vwapState: VWAPState;
  vwapDistance: number;
  signalStrength: number; // 0-100
  signalLabel: 'A+' | 'A' | 'B' | 'WATCH' | 'NO_TRADE';
  historicalExpectancy: number;
  timestamp: number;
}

export interface IndexRelativeStrength {
  base: IndexSymbol;
  target: IndexSymbol;
  ratio: number; // target/base
  change: number; // % change in ratio
  status: 'LEADER' | 'IMPROVING' | 'WEAKENING' | 'LAGGARD';
  interpretation: string;
}

export interface MarketOpportunityRanking {
  rank: number;
  symbol: IndexSymbol;
  name: string;
  signalStrength: number;
  signalLabel: string;
  regime: MarketRegime;
  bestInstrument: 'FUTURES' | 'OPTIONS' | 'EQUITY';
  instrumentReason: string;
  liquidity: number;
  rr: number;
  expectedMove: number;
  capitalEfficiency: number;
  historicalExpectancy: number;
  totalScore: number;
}

export async function analyzeAllIndices(
  interval: string = '5m',
  limit: number = 300
): Promise<{
  comparison: IndexComparisonData[];
  relativeStrength: IndexRelativeStrength[];
  ranking: MarketOpportunityRanking[];
  timestamp: number;
}> {
  const comparison: IndexComparisonData[] = [];
  const indexCandles = new Map<IndexSymbol, Candle[]>();

  // Fetch candles for all indices in parallel
  const candlePromises = INDEX_UNIVERSE.map(async (symbol) => {
    const candles = await getHistoricalCandles(symbol, interval, limit);
    return { symbol, candles };
  });

  const results = await Promise.all(candlePromises);
  for (const { symbol, candles } of results) {
    if (candles.length >= 50) {
      indexCandles.set(symbol, candles);
    }
  }

  // Analyze each index
  for (const symbol of INDEX_UNIVERSE) {
    const candles = indexCandles.get(symbol);
    if (!candles || candles.length < 50) continue;

    const analysis = await analyzeIndex(symbol, candles, interval);
    comparison.push(analysis);
  }

  // Calculate relative strength (base = NIFTY)
  const relativeStrength = calculateRelativeStrength(comparison, indexCandles);

  // Generate market opportunity ranking
  const ranking = generateMarketRanking(comparison, indexCandles);

  return {
    comparison: comparison.sort((a, b) => b.signalStrength - a.signalStrength),
    relativeStrength,
    ranking,
    timestamp: Date.now(),
  };
}

async function analyzeIndex(
  symbol: IndexSymbol,
  candles: Candle[],
  interval: string
): Promise<IndexComparisonData> {
  const tickSize = TICK_SIZES[symbol];

  // Session profile
  const sessionProfile = await calculateSessionProfile(candles, tickSize);
  const profile = calculateVolumeProfile(candles, tickSize);

  // Structure
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
    0, 0, 0, 0 // prev levels - would be filled from daily data
  );

  // Regime
  const regime = classifyMarketRegime(candles, profile, sessionProfile, structure, relativeVol, sessionVwap.vwap, vwapState);
  const regimeChars = getRegimeCharacteristics(regime);

  // Auction state
  const currentPrice = candles[candles.length - 1]?.close || 0;
  const { state: auctionState } = classifyAuctionState(currentPrice, profile.vah, profile.val, profile.poc);

  // Signal scoring (simplified version of equity-cash scoring)
  const signalResult = scoreIndexSignal(
    symbol, candles, profile, sessionProfile, structure, relativeVol, vwapState, regime, regimeChars, auctionState
  );

  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const change = lastCandle?.close - prevCandle?.close || 0;
  const changePct = prevCandle?.close ? (change / prevCandle.close) * 100 : 0;

  return {
    symbol,
    name: INDEX_META[symbol].name,
    price: currentPrice,
    change,
    changePct,
    regime,
    regimeBias: regimeChars.bias,
    auctionState,
    poc: profile.poc,
    vah: profile.vah,
    val: profile.val,
    volume: lastCandle?.volume || 0,
    relativeVolume: relativeVol.ratio,
    liquidity: formatLiquidity(liquidity.keyLevels),
    structure: formatStructure(structure),
    vwapState: vwapState.state,
    vwapDistance: vwapState.distance,
    signalStrength: signalResult.score,
    signalLabel: signalResult.label,
    historicalExpectancy: signalResult.expectancy,
    timestamp: Date.now(),
  };
}

function scoreIndexSignal(
  symbol: IndexSymbol,
  candles: Candle[],
  profile: VolumeProfile,
  sessionProfile: SessionProfile,
  structure: ReturnType<typeof analyzeMarketStructure>,
  relativeVol: ReturnType<typeof calculateRelativeVolume>,
  vwapState: ReturnType<typeof classifyVWAPState>,
  regime: MarketRegime,
  regimeChars: ReturnType<typeof getRegimeCharacteristics>,
  auctionState: AuctionState
): { score: number; label: 'A+' | 'A' | 'B' | 'WATCH' | 'NO_TRADE'; expectancy: number } {
  const currentPrice = candles[candles.length - 1]?.close || 0;

  // Auction Structure (25)
  let auctionScore = 15;
  if (auctionState === 'PRICE_BELOW_VALUE') auctionScore += 10;
  else if (auctionState === 'PRICE_ABOVE_VALUE') auctionScore += 5;

  // Volume Profile (20)
  let vpScore = 10;
  if (currentPrice > profile.val && currentPrice < profile.vah) vpScore += 10;

  // Liquidity (20)
  let liqScore = 10;

  // Market Structure (15)
  let msScore = 8;
  if (structure.currentTrend === 'UP') msScore += 7;
  else if (structure.currentTrend === 'DOWN') msScore += 7;

  // Volume (10)
  let volScore = 5;
  if (relativeVol.ratio > 1.5) volScore += 5;
  else if (relativeVol.ratio > 1.2) volScore += 3;

  // VWAP (5)
  let vwapScore = 3;
  if (vwapState.state === 'VWAP_RECLAIM') vwapScore += 2;

  // Market Regime (5)
  let regimeScore = 0;
  if (regimeChars.tradeable) regimeScore = 5;

  const total = Math.min(100, auctionScore + vpScore + liqScore + msScore + volScore + vwapScore + regimeScore);

  let label: 'A+' | 'A' | 'B' | 'WATCH' | 'NO_TRADE' = 'NO_TRADE';
  if (total >= 90) label = 'A+';
  else if (total >= 80) label = 'A';
  else if (total >= 70) label = 'B';
  else if (total >= 60) label = 'WATCH';

  const expectancy = total / 100 * 1.5 * 0.6 - (1 - total / 100) * 1;

  return { score: total, label, expectancy };
}

function calculateRelativeStrength(
  comparison: IndexComparisonData[],
  indexCandles: Map<IndexSymbol, Candle[]>
): IndexRelativeStrength[] {
  const results: IndexRelativeStrength[] = [];
  const baseSymbol: IndexSymbol = 'NIFTY';
  const baseCandles = indexCandles.get(baseSymbol);
  if (!baseCandles || baseCandles.length < 2) return results;

  const basePrice = baseCandles[baseCandles.length - 1].close;
  const basePrevPrice = baseCandles[baseCandles.length - 2].close;
  const baseChange = (basePrice - basePrevPrice) / basePrevPrice;

  for (const targetSymbol of INDEX_UNIVERSE.filter(s => s !== baseSymbol)) {
    const targetCandles = indexCandles.get(targetSymbol);
    if (!targetCandles || targetCandles.length < 2) continue;

    const targetPrice = targetCandles[targetCandles.length - 1].close;
    const targetPrevPrice = targetCandles[targetCandles.length - 2].close;
    const targetChange = (targetPrice - targetPrevPrice) / targetPrevPrice;

    const ratio = targetChange / (baseChange || 0.0001);
    const changeInRatio = targetChange - baseChange;

    let status: IndexRelativeStrength['status'] = 'LAGGARD';
    if (targetChange > baseChange + 0.005) status = 'LEADER';
    else if (targetChange > baseChange) status = 'IMPROVING';
    else if (targetChange < baseChange - 0.005) status = 'LAGGARD';
    else status = 'WEAKENING';

    let interpretation = '';
    if (status === 'LEADER') interpretation = `${targetSymbol} outperforming ${baseSymbol} significantly`;
    else if (status === 'IMPROVING') interpretation = `${targetSymbol} gaining relative strength vs ${baseSymbol}`;
    else if (status === 'WEAKENING') interpretation = `${targetSymbol} losing relative strength vs ${baseSymbol}`;
    else interpretation = `${targetSymbol} lagging ${baseSymbol}`;

    results.push({
      base: baseSymbol,
      target: targetSymbol as IndexSymbol,
      ratio,
      change: changeInRatio * 100,
      status,
      interpretation,
    });
  }

  return results;
}

function generateMarketRanking(
  comparison: IndexComparisonData[],
  indexCandles: Map<IndexSymbol, Candle[]>
): MarketOpportunityRanking[] {
  const rankings: MarketOpportunityRanking[] = [];

  for (const comp of comparison) {
    const candles = indexCandles.get(comp.symbol);
    if (!candles) continue;

    // Determine best instrument
    const regimeChars = getRegimeCharacteristics(comp.regime);
    let bestInstrument: 'FUTURES' | 'OPTIONS' | 'EQUITY' = 'FUTURES';
    let instrumentReason = 'Index futures offer leverage and liquidity';

    if (comp.regime === 'LOW_VOLATILITY' || comp.regime === 'RANGING') {
      bestInstrument = 'OPTIONS';
      instrumentReason = 'Options sell premium in low vol/ranging';
    } else if (comp.regime === 'HIGH_VOLATILITY') {
      bestInstrument = 'EQUITY';
      instrumentReason = 'Equity reduces gamma/vega risk in high vol';
    }

    // Liquidity score (simplified)
    const liquidity = 80; // would come from actual liquidity analysis

    // R:R
    const rr = 2.5; // simplified

    // Expected move
    const expectedMove = Math.abs(comp.changePct) * 2;

    // Capital efficiency
    const capitalEfficiency = comp.signalStrength / 100;

    // Historical expectancy
    const historicalExpectancy = comp.historicalExpectancy;

    // Total composite score
    const totalScore = (
      comp.signalStrength * 0.4 +
      liquidity * 0.15 +
      rr * 20 * 0.15 +
      capitalEfficiency * 100 * 0.15 +
      historicalExpectancy * 100 * 0.15
    );

    rankings.push({
      rank: 0, // will be set after sort
      symbol: comp.symbol,
      name: comp.name,
      signalStrength: comp.signalStrength,
      signalLabel: comp.signalLabel,
      regime: comp.regime,
      bestInstrument,
      instrumentReason,
      liquidity,
      rr,
      expectedMove,
      capitalEfficiency,
      historicalExpectancy,
      totalScore,
    });
  }

  // Sort by total score and assign ranks
  rankings.sort((a, b) => b.totalScore - a.totalScore);
  rankings.forEach((r, i) => { r.rank = i + 1; });

  return rankings;
}

function formatLiquidity(levels: any[]): string {
  const swept = levels.filter(l => l.swept).length;
  const total = levels.length;
  return `${swept}/${total} swept`;
}

function formatStructure(structure: ReturnType<typeof analyzeMarketStructure>): string {
  const parts = [];
  if (structure.currentTrend !== 'SIDEWAYS') parts.push(structure.currentTrend);
  if (structure.bosEvents.length) parts.push(`BOS:${structure.bosEvents.length}`);
  if (structure.chochEvents.length) parts.push(`CHOCH:${structure.chochEvents.length}`);
  return parts.join(' ') || 'NEUTRAL';
}

// Re-export INDEX_META for external use
import { INDEX_META } from './index-universe';