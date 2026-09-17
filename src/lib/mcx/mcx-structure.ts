// MCX Structure Engine — Swing structure, S/R, BOS/CHOCH, VWAP
// Market structure determines entry invalidation and directional bias.
// Never uses structure alone to trigger a trade.

import type { MCXCommodity } from './types';

export type StructureBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'COMPRESSION';
export type StructureEvent = 'BOS_BULLISH' | 'BOS_BEARISH' | 'CHOCH_BULLISH' | 'CHOCH_BEARISH' | 'NONE';

export interface MCXStructureResult {
  bias: StructureBias;
  event: StructureEvent;
  swingHighs: number[];
  swingLows: number[];
  supportLevels: number[];
  resistanceLevels: number[];
  pdh: number;  // previous day high
  pdl: number;  // previous day low
  pwh: number;  // previous week high
  pwl: number;  // previous week low
  dayHigh: number;
  dayLow: number;
  vwap: number;
  vwapPosition: 'ABOVE' | 'BELOW' | 'AT';
  currentHigh: number;
  currentLow: number;
  range: number;
  compressionRatio: number; // ATR / range — high = compression
  evidence: string[];
}

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Detect swing points with configurable lookback ──
function detectSwingPoints(candles: Candle[], lookback = 3): { highs: number[]; lows: number[] } {
  const highIdx: number[] = [];
  const lowIdx: number[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high < candles[i - j].high || candles[i].high < candles[i + j].high) isHigh = false;
      if (candles[i].low > candles[i - j].low || candles[i].low > candles[i + j].low) isLow = false;
    }
    if (isHigh) highIdx.push(i);
    if (isLow) lowIdx.push(i);
  }

  return { highs: highIdx, lows: lowIdx };
}

// ── Detect BOS (Break of Structure) ──
function detectBOS(candles: Candle[], swingHighs: number[], swingLows: number[]): StructureEvent {
  if (candles.length < 3) return 'NONE';
  const last = candles[candles.length - 1];

  // Bullish BOS: price breaks above last swing high
  if (swingHighs.length > 0) {
    const lastSwingHigh = candles[swingHighs[swingHighs.length - 1]].high;
    if (last.close > lastSwingHigh && candles[candles.length - 2].close <= lastSwingHigh) {
      return 'BOS_BULLISH';
    }
  }

  // Bearish BOS: price breaks below last swing low
  if (swingLows.length > 0) {
    const lastSwingLow = candles[swingLows[swingLows.length - 1]].low;
    if (last.close < lastSwingLow && candles[candles.length - 2].close >= lastSwingLow) {
      return 'BOS_BEARISH';
    }
  }

  return 'NONE';
}

// ── Detect CHOCH (Change of Character) ──
function detectCHOCH(candles: Candle[], swingHighs: number[], swingLows: number[]): StructureEvent {
  if (swingHighs.length < 2 || swingLows.length < 2) return 'NONE';
  const last = candles[candles.length - 1];

  // Bullish CHOCH: was making LH/LL, now breaks above previous lower high
  const recentHighs = swingHighs.slice(-3).map(i => candles[i].high);
  const recentLows = swingLows.slice(-3).map(i => candles[i].low);

  const wasBearish = recentHighs.length >= 2 && recentHighs[recentHighs.length - 1] < recentHighs[recentHighs.length - 2];
  if (wasBearish && last.close > recentHighs[recentHighs.length - 1]) {
    return 'CHOCH_BULLISH';
  }

  const wasBullish = recentLows.length >= 2 && recentLows[recentLows.length - 1] > recentLows[recentLows.length - 2];
  if (wasBullish && last.close < recentLows[recentLows.length - 1]) {
    return 'CHOCH_BEARISH';
  }

  return 'NONE';
}

// ── Calculate VWAP from candles ──
function calculateVWAP(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  let cumVolPrice = 0;
  let cumVol = 0;
  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumVolPrice += typicalPrice * c.volume;
    cumVol += c.volume;
  }
  return cumVol > 0 ? cumVolPrice / cumVol : candles[candles.length - 1].close;
}

// ── Calculate POC (Point of Control) from candles ──
function calculatePOC(candles: Candle[], bins = 20): number {
  if (candles.length < 5) return candles[candles.length - 1]?.close || 0;
  const lows = candles.map(c => c.low);
  const highs = candles.map(c => c.high);
  const minPrice = Math.min(...lows);
  const maxPrice = Math.max(...highs);
  const range = maxPrice - minPrice;
  if (range <= 0) return (minPrice + maxPrice) / 2;

  const binSize = range / bins;
  const volumeProfile = new Array(bins).fill(0);
  const binPrices: number[] = [];
  for (let i = 0; i < bins; i++) {
    binPrices.push(minPrice + binSize * (i + 0.5));
  }

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const binIdx = Math.min(bins - 1, Math.max(0, Math.floor((typicalPrice - minPrice) / binSize)));
    volumeProfile[binIdx] += c.volume;
  }

  let maxVolIdx = 0;
  for (let i = 1; i < volumeProfile.length; i++) {
    if (volumeProfile[i] > volumeProfile[maxVolIdx]) maxVolIdx = i;
  }
  return binPrices[maxVolIdx];
}

// ── Main structure analysis ──
export function analyzeMCXStructure(
  _symbol: MCXCommodity,
  candles: Candle[],
  currentPrice: number
): MCXStructureResult {
  if (candles.length < 10) {
    return {
      bias: 'NEUTRAL', event: 'NONE',
      swingHighs: [], swingLows: [],
      supportLevels: [], resistanceLevels: [],
      pdh: 0, pdl: 0, pwh: 0, pwl: 0,
      dayHigh: 0, dayLow: 0,
      vwap: 0, vwapPosition: 'AT',
      currentHigh: 0, currentLow: 0, range: 0,
      compressionRatio: 0,
      evidence: ['Insufficient data for structure analysis'],
    };
  }

  const swings = detectSwingPoints(candles, 3);
  const swingHighValues = swings.highs.map(i => candles[i].high);
  const swingLowValues = swings.lows.map(i => candles[i].low);

  // BOS and CHOCH
  const bosEvent = detectBOS(candles, swings.highs, swings.lows);
  const chochEvent = detectCHOCH(candles, swings.highs, swings.lows);
  const event = bosEvent !== 'NONE' ? bosEvent : chochEvent;

  // Support and resistance from swing points
  const supportLevels = [...new Set(swingLowValues)].sort((a, b) => b - a).slice(0, 5);
  const resistanceLevels = [...new Set(swingHighValues)].sort((a, b) => a - b).slice(0, 5);

  // Previous day/week levels
  const dayMs = 24 * 60 * 60 * 1000;
  const now = candles[candles.length - 1].time * 1000;
  const todayStart = now - (now % dayMs);
  const dayCandles = candles.filter(c => c.time * 1000 >= todayStart);
  const prevDayCandles = candles.filter(c => c.time * 1000 >= todayStart - dayMs && c.time * 1000 < todayStart);

  const pdh = prevDayCandles.length > 0 ? Math.max(...prevDayCandles.map(c => c.high)) : 0;
  const pdl = prevDayCandles.length > 0 ? Math.min(...prevDayCandles.map(c => c.low)) : 0;

  // Week levels (approximate: last 5 trading days)
  const weekMs = 5 * dayMs;
  const weekCandles = candles.filter(c => c.time * 1000 >= now - weekMs);
  const pwh = weekCandles.length > 0 ? Math.max(...weekCandles.map(c => c.high)) : 0;
  const pwl = weekCandles.length > 0 ? Math.min(...weekCandles.map(c => c.low)) : 0;

  // Current day levels
  const dayHigh = dayCandles.length > 0 ? Math.max(...dayCandles.map(c => c.high)) : currentPrice;
  const dayLow = dayCandles.length > 0 ? Math.min(...dayCandles.map(c => c.low)) : currentPrice;

  // VWAP
  const vwap = calculateVWAP(dayCandles.length > 0 ? dayCandles : candles.slice(-20));
  const vwapPosition = currentPrice > vwap * 1.001 ? 'ABOVE' : currentPrice < vwap * 0.999 ? 'BELOW' : 'AT';

  // POC
  const poc = calculatePOC(candles.slice(-30));

  // Compression ratio
  const recentRange = Math.max(...candles.slice(-10).map(c => c.high)) - Math.min(...candles.slice(-10).map(c => c.low));
  const atr14 = (() => {
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return trs.length >= 14 ? trs.slice(-14).reduce((s, v) => s + v, 0) / 14 : trs.reduce((s, v) => s + v, 0) / Math.max(1, trs.length);
  })();
  const compressionRatio = recentRange > 0 ? atr14 / recentRange : 1;

  // Determine bias
  const evidence: string[] = [];
  let bias: StructureBias = 'NEUTRAL';

  const recentHighs = swingHighValues.slice(-3);
  const recentLows = swingLowValues.slice(-3);
  const hhCount = recentHighs.length >= 2 && recentHighs[recentHighs.length - 1] > recentHighs[recentHighs.length - 2] ? 1 : 0;
  const hlCount = recentLows.length >= 2 && recentLows[recentLows.length - 1] > recentLows[recentLows.length - 2] ? 1 : 0;
  const lhCount = recentHighs.length >= 2 && recentHighs[recentHighs.length - 1] < recentHighs[recentHighs.length - 2] ? 1 : 0;
  const llCount = recentLows.length >= 2 && recentLows[recentLows.length - 1] < recentLows[recentLows.length - 2] ? 1 : 0;

  if (compressionRatio > 0.8) {
    bias = 'COMPRESSION';
    evidence.push(`Price compressing (ratio: ${compressionRatio.toFixed(2)})`);
  } else if (hhCount && hlCount) {
    bias = 'BULLISH';
    evidence.push('Higher Highs + Higher Lows');
  } else if (lhCount && llCount) {
    bias = 'BEARISH';
    evidence.push('Lower Highs + Lower Lows');
  } else if (currentPrice > poc) {
    bias = 'BULLISH';
    evidence.push(`Above POC (${poc.toFixed(1)})`);
  } else if (currentPrice < poc) {
    bias = 'BEARISH';
    evidence.push(`Below POC (${poc.toFixed(1)})`);
  }

  if (event !== 'NONE') evidence.push(`Structure event: ${event}`);
  evidence.push(`VWAP: ${vwapPosition} (${vwap.toFixed(1)})`);
  evidence.push(`Day range: ${dayLow.toFixed(1)} - ${dayHigh.toFixed(1)}`);

  return {
    bias,
    event,
    swingHighs: swingHighValues,
    swingLows: swingLowValues,
    supportLevels,
    resistanceLevels,
    pdh, pdl, pwh, pwl,
    dayHigh, dayLow,
    vwap,
    vwapPosition,
    currentHigh: dayHigh,
    currentLow: dayLow,
    range: dayHigh - dayLow,
    compressionRatio,
    evidence,
  };
}
