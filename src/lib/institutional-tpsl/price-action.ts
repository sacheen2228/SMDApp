// ═══════════════════════════════════════════════════════════════════
// MODULE 7 — PRICE ACTION ENGINE
// Operates on REAL underlying candles: trend, momentum, compression/
// expansion, pullback, rejection (wick), exhaustion, multi-timeframe.
// ═══════════════════════════════════════════════════════════════════

import { Candle } from './types';
import { findSwings, Swing } from './structure-analyzer';

export type Trend = 'BULLISH' | 'BEARISH' | 'SIDEWAYS';

export interface PriceActionReport {
  trend: Trend;
  trendStrength: number;        // 0..100
  momentum: number;             // -100..100 (slope of closes)
  compression: boolean;         // range contracting (coil)
  expansion: boolean;           // range expanding (breakout)
  pullback: boolean;            // retraced into a discount/premium zone
  rejection: boolean;           // last candle rejected a level (wick)
  exhaustion: boolean;          // extended move + weakening
  mtfAlignment: boolean;        // short-term agrees with medium-term
  score: number;                // 0..100
}

export interface PriceActionInput {
  candles: Candle[];
  spot: number;
  atr?: number;
}

export function analyzePriceAction(input: PriceActionInput): PriceActionReport {
  const { candles, spot, atr } = input;
  if (candles.length < 5) {
    return {
      trend: 'SIDEWAYS', trendStrength: 0, momentum: 0,
      compression: false, expansion: false, pullback: false,
      rejection: false, exhaustion: false, mtfAlignment: false, score: 0,
    };
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const swAll = findSwings(candles, 2, 2);
  const half = candles.slice(Math.floor(candles.length / 2));
  const swHalf = findSwings(half, 2, 2);

  const trend = deriveTrend(swAll.highs, swAll.lows);
  const medTrend = deriveTrend(swHalf.highs, swHalf.lows);
  const mtfAlignment =
    trend === medTrend || trend === 'SIDEWAYS' || medTrend === 'SIDEWAYS';
  const trendStrength = trendStrengthScore(swAll.highs, swAll.lows, closes);

  // Momentum: normalized slope of last 5 closes
  const n = Math.min(5, closes.length - 1);
  const slope = (closes[closes.length - 1] - closes[closes.length - 1 - n]) / (n || 1);
  const momentum = clamp((slope / (atr || spot * 0.005)) * 50, -100, 100);

  // Compression / expansion: recent range vs prior range
  const recent = candles.slice(-5);
  const prior = candles.slice(-15, -5);
  const rRange =
    Math.max(...recent.map((c) => c.high)) - Math.min(...recent.map((c) => c.low));
  const pRange =
    prior.length
      ? Math.max(...prior.map((c) => c.high)) - Math.min(...prior.map((c) => c.low))
      : rRange;
  const compression = pRange > 0 && rRange < 0.6 * pRange;
  const expansion = pRange > 0 && rRange > 1.4 * pRange;

  // Pullback: retraced against trend into prior swing zone
  const last = candles[candles.length - 1];
  const pullback =
    (trend === 'BULLISH' && last.close < closes[closes.length - 2] && last.close > Math.min(...lows.slice(-5))) ||
    (trend === 'BEARISH' && last.close > closes[closes.length - 2] && last.close < Math.max(...highs.slice(-5)));

  // Rejection: long wick opposite body direction
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;
  const rejection =
    (upperWick > body * 1.5 && upperWick > (atr || 0) * 0.4) ||
    (lowerWick > body * 1.5 && lowerWick > (atr || 0) * 0.4);

  // Exhaustion: strong trend + momentum rolling over
  const m1 = slope;
  const m2 = n >= 2 ? (closes[closes.length - 1 - n] - closes[closes.length - 1 - 2 * n]) / (n || 1) : m1;
  const exhaustion = trend !== 'SIDEWAYS' && Math.abs(m1) < Math.abs(m2) * 0.6 && Math.abs(m1) > 0;

  let score = 50;
  score += (trend === 'SIDEWAYS' ? 0 : trendStrength * 0.25);
  if (mtfAlignment) score += 10;
  if (compression) score += 5;
  if (expansion) score -= 5;
  if (rejection) score += 8;
  if (exhaustion) score -= 12;
  score = clamp(score, 0, 100);

  return {
    trend, trendStrength, momentum,
    compression, expansion, pullback, rejection, exhaustion, mtfAlignment, score,
  };
}

function deriveTrend(highs: Swing[], lows: Swing[]): Trend {
  if (highs.length < 2 || lows.length < 2) return 'SIDEWAYS';
  const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
  const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
  const ll = lows[lows.length - 1].price < lows[lows.length - 2].price;
  if (hh && hl) return 'BULLISH';
  if (lh && ll) return 'BEARISH';
  return 'SIDEWAYS';
}

function trendStrengthScore(highs: Swing[], lows: Swing[], closes: number[]): number {
  const ups = highs.filter((h, i) => i > 0 && h.price > highs[i - 1].price).length +
    lows.filter((l, i) => i > 0 && l.price > lows[i - 1].price).length;
  const downs = highs.filter((h, i) => i > 0 && h.price < highs[i - 1].price).length +
    lows.filter((l, i) => i > 0 && l.price < lows[i - 1].price).length;
  const total = ups + downs;
  const bias = total === 0 ? 0 : Math.abs(ups - downs) / total;
  const ctx = Math.min(1, closes.length / 30);
  return clamp(bias * 70 + ctx * 30, 0, 100);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
