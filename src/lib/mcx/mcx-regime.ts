// MCX Regime Engine — Multi-timeframe regime detection
// Classifies MCX commodity market regime from candle data
// No ML, no fabrication. Deterministic analysis only.

import type { MCXCommodity } from './types';

export type MCXRegime =
  | 'STRONG_BULLISH' | 'BULLISH' | 'WEAK_BULLISH'
  | 'RANGE'
  | 'WEAK_BEARISH' | 'BEARISH' | 'STRONG_BEARISH'
  | 'BREAKOUT' | 'BREAKDOWN'
  | 'REVERSAL'
  | 'HIGH_VOLATILITY'
  | 'EVENT_RISK'
  | 'NO_TRADE';

export interface MCXRegimeResult {
  regime: MCXRegime;
  confidence: number; // 0-100
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  evidence: string[];
  emaAlignment: string;
  trendStrength: number; // -100 to +100
  atrRegime: 'COMPRESSED' | 'NORMAL' | 'EXPANDING';
}

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── EMA calculation ──
function ema(prices: number[], period: number): number[] {
  if (prices.length < period) return prices.map(() => prices[prices.length - 1] || 0);
  const k = 2 / (period + 1);
  const result: number[] = [];
  let val = prices.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = 0; i < period; i++) result.push(val);
  for (let i = period; i < prices.length; i++) {
    val = prices[i] * k + val * (1 - k);
    result.push(val);
  }
  return result;
}

// ── ATR calculation ──
function computeATR(candles: Candle[], period = 14): number[] {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atr: number[] = [];
  for (let i = 0; i < trs.length; i++) {
    if (i < period - 1) {
      atr.push(trs.slice(0, i + 1).reduce((s, v) => s + v, 0) / (i + 1));
    } else {
      atr.push((atr[atr.length - 1] * (period - 1) + trs[i]) / period);
    }
  }
  return atr;
}

// ── Detect swing points ──
function detectSwings(candles: Candle[], lookback = 5): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}

// ── Classify trend from EMA alignment ──
function classifyEMAAlignment(emaValues: Record<string, number>): string {
  const { ema9, ema21, ema50 } = emaValues;
  if (ema9 > ema21 && ema21 > ema50) return 'BULLISH_ALIGNED';
  if (ema9 < ema21 && ema21 < ema50) return 'BEARISH_ALIGNED';
  if (ema9 > ema21 && ema21 < ema50) return 'MIXED_RECOVERY';
  if (ema9 < ema21 && ema21 > ema50) return 'MIXED_WEAKENING';
  return 'NEUTRAL';
}

// ── Main regime analysis ──
export function analyzeMCXRegime(
  symbol: MCXCommodity,
  candles: Candle[],
  currentPrice: number
): MCXRegimeResult {
  if (candles.length < 20) {
    return {
      regime: 'NO_TRADE',
      confidence: 0,
      direction: 'NEUTRAL',
      evidence: ['Insufficient candle data'],
      emaAlignment: 'UNKNOWN',
      trendStrength: 0,
      atrRegime: 'NORMAL',
    };
  }

  const closes = candles.map(c => c.close);
  const ema9Arr = ema(closes, 9);
  const ema21Arr = ema(closes, 21);
  const ema50Arr = ema(closes, Math.min(50, closes.length));
  const atrArr = computeATR(candles, 14);

  const lastEma9 = ema9Arr[ema9Arr.length - 1];
  const lastEma21 = ema21Arr[ema21Arr.length - 1];
  const lastEma50 = ema50Arr[ema50Arr.length - 1];
  const lastATR = atrArr[atrArr.length - 1] || 0;
  const prevATR = atrArr.length > 5 ? atrArr[atrArr.length - 5] : lastATR;

  const emaAlignment = classifyEMAAlignment({ ema9: lastEma9, ema21: lastEma21, ema50: lastEma50 });

  // ATR regime
  const atrChange = prevATR > 0 ? (lastATR - prevATR) / prevATR : 0;
  let atrRegime: 'COMPRESSED' | 'NORMAL' | 'EXPANDING' = 'NORMAL';
  if (atrChange > 0.2) atrRegime = 'EXPANDING';
  else if (atrChange < -0.15) atrRegime = 'COMPRESSED';

  // Price vs EMAs
  const aboveEMA9 = currentPrice > lastEma9;
  const aboveEMA21 = currentPrice > lastEma21;
  const aboveEMA50 = currentPrice > lastEma50;

  // Trend strength: -100 (strong bear) to +100 (strong bull)
  let trendStrength = 0;
  if (aboveEMA9) trendStrength += 25;
  else trendStrength -= 25;
  if (aboveEMA21) trendStrength += 25;
  else trendStrength -= 25;
  if (aboveEMA50) trendStrength += 25;
  else trendStrength -= 25;
  if (emaAlignment === 'BULLISH_ALIGNED') trendStrength += 25;
  else if (emaAlignment === 'BEARISH_ALIGNED') trendStrength -= 25;

  // Swing structure
  const swings = detectSwings(candles, 3);
  const recentHighs = swings.highs.slice(-3).map(i => candles[i].high);
  const recentLows = swings.lows.slice(-3).map(i => candles[i].low);

  let hhCount = 0, lhCount = 0, hlCount = 0, llCount = 0;
  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i] > recentHighs[i - 1]) hhCount++;
    else lhCount++;
  }
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i] > recentLows[i - 1]) hlCount++;
    else llCount++;
  }

  // Volume analysis
  const recentVolumes = candles.slice(-10).map(c => c.volume);
  const avgVol = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / Math.min(20, candles.length);
  const lastVol = recentVolumes[recentVolumes.length - 1] || 0;
  const relVol = avgVol > 0 ? lastVol / avgVol : 1;
  const volumeExpansion = relVol > 1.5;

  // Price change
  const prevClose = candles[candles.length - 2]?.close || currentPrice;
  const dailyChange = prevClose > 0 ? ((currentPrice - prevClose) / prevClose) * 100 : 0;

  // Determine regime
  const evidence: string[] = [];
  let regime: MCXRegime = 'RANGE';
  let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  let confidence = 50;

  // Check for HIGH_VOLATILITY
  const atrPercent = currentPrice > 0 ? (lastATR / currentPrice) * 100 : 0;
  if (atrPercent > 4) {
    regime = 'HIGH_VOLATILITY';
    evidence.push(`ATR ${atrPercent.toFixed(1)}% — extreme volatility`);
    confidence = 40;
    direction = 'NEUTRAL';
  }
  // Check for BREAKOUT/BREAKDOWN
  else if (volumeExpansion && trendStrength > 50 && hhCount >= 2) {
    regime = 'BREAKOUT';
    evidence.push(`Volume expansion (${relVol.toFixed(1)}x), HH structure, bullish alignment`);
    direction = 'LONG';
    confidence = 75;
  } else if (volumeExpansion && trendStrength < -50 && llCount >= 2) {
    regime = 'BREAKDOWN';
    evidence.push(`Volume expansion (${relVol.toFixed(1)}x), LL structure, bearish alignment`);
    direction = 'SHORT';
    confidence = 75;
  }
  // Strong trends
  else if (trendStrength >= 75) {
    regime = 'STRONG_BULLISH';
    evidence.push(`Full bullish alignment, HH+HL structure`);
    direction = 'LONG';
    confidence = 80;
  } else if (trendStrength <= -75) {
    regime = 'STRONG_BEARISH';
    evidence.push(`Full bearish alignment, LH+LL structure`);
    direction = 'SHORT';
    confidence = 80;
  } else if (trendStrength >= 50) {
    regime = 'BULLISH';
    evidence.push(`Above majority EMAs, positive structure`);
    direction = 'LONG';
    confidence = 65;
  } else if (trendStrength <= -50) {
    regime = 'BEARISH';
    evidence.push(`Below majority EMAs, negative structure`);
    direction = 'SHORT';
    confidence = 65;
  } else if (trendStrength > 0) {
    regime = 'WEAK_BULLISH';
    evidence.push(`Slight bullish bias but not confirmed`);
    direction = 'LONG';
    confidence = 45;
  } else if (trendStrength < 0) {
    regime = 'WEAK_BEARISH';
    evidence.push(`Slight bearish bias but not confirmed`);
    direction = 'SHORT';
    confidence = 45;
  } else {
    regime = 'RANGE';
    evidence.push(`No clear direction, mixed signals`);
    direction = 'NEUTRAL';
    confidence = 30;
  }

  // Check for REVERSAL
  if (regime !== 'HIGH_VOLATILITY' && regime !== 'BREAKOUT' && regime !== 'BREAKDOWN') {
    if (trendStrength > 30 && lhCount >= 2 && !aboveEMA9) {
      regime = 'REVERSAL';
      evidence.push(`Was bullish but losing momentum, LH forming`);
      direction = 'SHORT';
      confidence = 55;
    } else if (trendStrength < -30 && hlCount >= 2 && aboveEMA9) {
      regime = 'REVERSAL';
      evidence.push(`Was bearish but recovering, HL forming`);
      direction = 'LONG';
      confidence = 55;
    }
  }

  // Add additional evidence
  evidence.push(`EMA alignment: ${emaAlignment}`);
  evidence.push(`Trend strength: ${trendStrength}`);
  evidence.push(`ATR regime: ${atrRegime}`);
  if (volumeExpansion) evidence.push(`Volume: ${relVol.toFixed(1)}x avg`);

  return {
    regime,
    confidence,
    direction,
    evidence,
    emaAlignment,
    trendStrength,
    atrRegime,
  };
}
