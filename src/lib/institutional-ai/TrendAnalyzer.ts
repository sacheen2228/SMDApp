// ─── TrendAnalyzer — EMA/RSI/ADX Trend Detection ──────────────────
// Calculates trend direction and strength from candle data.

import type { Candle } from "./types";
import { TREND_CONFIG } from "./config";

export interface TrendResult {
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  strength: number;
  ema9: number;
  ema21: number;
  rsi: number;
  adx: number;
  score: number;
}

/**
 * Calculate trend from candle data using EMA crossover, RSI, and ADX.
 * Score 0-100 representing trend strength and alignment.
 */
export function analyzeTrend(candles: Candle[]): TrendResult {
  if (candles.length < TREND_CONFIG.slowEMA + 5) {
    return { direction: "NEUTRAL", strength: 0, ema9: 0, ema21: 0, rsi: 50, adx: 0, score: 0 };
  }

  const closes = candles.map((c) => c.close);
  const ema9 = ema(closes, TREND_CONFIG.fastEMA);
  const ema21 = ema(closes, TREND_CONFIG.slowEMA);
  const rsiVal = rsi(closes, 14);
  const adxVal = adx(candles, 14);

  let direction: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  let score = 0;

  // EMA crossover
  if (ema9 > ema21) {
    direction = "BULLISH";
    score += 30;
  } else if (ema9 < ema21) {
    direction = "BEARISH";
    score += 30;
  }

  // RSI
  if (direction === "BULLISH" && rsiVal > 50 && rsiVal < TREND_CONFIG.rsiOverbought) {
    score += 25;
  } else if (direction === "BEARISH" && rsiVal < 50 && rsiVal > TREND_CONFIG.rsiOversold) {
    score += 25;
  }

  // ADX
  if (adxVal > TREND_CONFIG.adxThreshold) {
    score += 25;
  } else {
    score += Math.round((adxVal / TREND_CONFIG.adxThreshold) * 25);
  }

  // Price position relative to EMAs
  const lastClose = closes[closes.length - 1];
  if (direction === "BULLISH" && lastClose > ema9) score += 10;
  if (direction === "BEARISH" && lastClose < ema9) score += 10;

  // Consecutive candle direction
  const last3 = candles.slice(-3);
  const bullishCandles = last3.filter((c) => c.close > c.open).length;
  const bearishCandles = last3.filter((c) => c.close < c.open).length;
  if (direction === "BULLISH" && bullishCandles >= 2) score += 10;
  if (direction === "BEARISH" && bearishCandles >= 2) score += 10;

  return {
    direction,
    strength: Math.abs(ema9 - ema21) / ema21 * 100,
    ema9,
    ema21,
    rsi: rsiVal,
    adx: adxVal,
    score: Math.min(100, score),
  };
}

function ema(data: number[], period: number): number {
  const k = 2 / (period + 1);
  let emaVal = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < data.length; i++) {
    emaVal = data[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

function rsi(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function adx(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 0;
  let plusDM = 0;
  let minusDM = 0;
  let tr = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const upMove = c.high - prev.high;
    const downMove = prev.low - c.low;
    plusDM += upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM += downMove > upMove && downMove > 0 ? downMove : 0;
    tr += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  }

  if (tr === 0) return 0;
  const plusDI = (plusDM / tr) * 100;
  const minusDI = (minusDM / tr) * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  return dx;
}
