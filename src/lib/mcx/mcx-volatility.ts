// MCX Volatility Engine — ATR, IV, expected move, volatility regime
// Volatility determines realistic movement, not trade direction.
// High IV ≠ BUY. Low IV ≠ BUY.

import type { MCXCommodity } from './types';

export type VolatilityRegime = 'LOW_VOL' | 'NORMAL_VOL' | 'EXPANDING_VOL' | 'HIGH_VOL' | 'EXTREME_VOL';
export type IVClassification = 'LOW' | 'NORMAL' | 'ELEVATED' | 'HIGH' | 'EXTREME';

export interface MCXVolatilityResult {
  atr: number;
  atrPercent: number;
  atrRegime: 'COMPRESSED' | 'NORMAL' | 'EXPANDING';
  volatilityRegime: VolatilityRegime;
  ivClassification: IVClassification;
  iv: number;
  expectedMove: number; // absolute price units
  expectedMovePercent: number;
  ivPercentile: number; // 0-100, where we are vs range
  ivExpansion: boolean;
  ivCrush: boolean;
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

// ── ATR calculation ──
function computeATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) {
    const trs = candles.slice(1).map((c, i) => {
      const pc = candles[i].close;
      return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    });
    return trs.length > 0 ? trs.reduce((s, v) => s + v, 0) / trs.length : 0;
  }
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// ── Main volatility analysis ──
export function analyzeMCXVolatility(
  _symbol: MCXCommodity,
  candles: Candle[],
  currentPrice: number,
  iv?: number, // from option chain (decimal, e.g., 0.25 for 25%)
  prevIV?: number
): MCXVolatilityResult {
  if (candles.length < 15 || currentPrice <= 0) {
    return {
      atr: 0, atrPercent: 0, atrRegime: 'NORMAL',
      volatilityRegime: 'NORMAL_VOL', ivClassification: 'NORMAL',
      iv: 0, expectedMove: 0, expectedMovePercent: 0,
      ivPercentile: 50, ivExpansion: false, ivCrush: false,
      evidence: ['Insufficient data for volatility analysis'],
    };
  }

  const evidence: string[] = [];

  // ATR
  const atr = computeATR(candles, 14);
  const atrPercent = (atr / currentPrice) * 100;

  // ATR regime (compare current ATR to 20-bar average ATR)
  const atrHistory: number[] = [];
  for (let i = 20; i <= candles.length; i++) {
    atrHistory.push(computeATR(candles.slice(0, i), 14));
  }
  const avgATR = atrHistory.length > 0 ? atrHistory.reduce((s, v) => s + v, 0) / atrHistory.length : atr;
  let atrRegime: 'COMPRESSED' | 'NORMAL' | 'EXPANDING' = 'NORMAL';
  if (avgATR > 0) {
    const atrRatio = atr / avgATR;
    if (atrRatio > 1.3) atrRegime = 'EXPANDING';
    else if (atrRatio < 0.7) atrRegime = 'COMPRESSED';
  }

  // Volatility regime from ATR percent
  let volatilityRegime: VolatilityRegime = 'NORMAL_VOL';
  if (atrPercent < 0.5) volatilityRegime = 'LOW_VOL';
  else if (atrPercent < 1.5) volatilityRegime = 'NORMAL_VOL';
  else if (atrPercent < 3.0) volatilityRegime = 'EXPANDING_VOL';
  else if (atrPercent < 5.0) volatilityRegime = 'HIGH_VOL';
  else volatilityRegime = 'EXTREME_VOL';

  // IV classification
  const ivDecimal = iv || 0;
  const ivPercent = ivDecimal * 100;
  let ivClassification: IVClassification = 'NORMAL';
  if (ivPercent > 0 && ivPercent < 15) ivClassification = 'LOW';
  else if (ivPercent >= 15 && ivPercent < 25) ivClassification = 'NORMAL';
  else if (ivPercent >= 25 && ivPercent < 40) ivClassification = 'ELEVATED';
  else if (ivPercent >= 40 && ivPercent < 60) ivClassification = 'HIGH';
  else if (ivPercent >= 60) ivClassification = 'EXTREME';

  // Expected move: ATR as proxy, or IV-based
  const expectedMove = ivDecimal > 0
    ? currentPrice * ivDecimal * Math.sqrt(1 / 365) // daily expected move from IV
    : atr; // fallback to ATR
  const expectedMovePercent = currentPrice > 0 ? (expectedMove / currentPrice) * 100 : 0;

  // IV percentile (simplified — compare to historical ATR implied vol)
  const ivPercentile = ivPercent > 0
    ? Math.min(100, Math.max(0, ivPercent * 2.5)) // rough mapping
    : 50;

  // IV expansion/crush
  const ivExpansion = prevIV !== undefined && iv !== undefined && iv > prevIV * 1.1;
  const ivCrush = prevIV !== undefined && iv !== undefined && iv < prevIV * 0.9;

  // Evidence
  evidence.push(`ATR: ${atr.toFixed(1)} (${atrPercent.toFixed(1)}%) — ${atrRegime}`);
  evidence.push(`Volatility: ${volatilityRegime}`);
  if (ivDecimal > 0) {
    evidence.push(`IV: ${(ivDecimal * 100).toFixed(1)}% — ${ivClassification}`);
    if (ivExpansion) evidence.push('IV expanding — options getting expensive');
    if (ivCrush) evidence.push('IV crushing — options getting cheaper');
  }
  evidence.push(`Expected move: ${expectedMove.toFixed(1)} (${expectedMovePercent.toFixed(2)}%)`);

  return {
    atr,
    atrPercent,
    atrRegime,
    volatilityRegime,
    ivClassification,
    iv: ivDecimal,
    expectedMove,
    expectedMovePercent,
    ivPercentile,
    ivExpansion,
    ivCrush,
    evidence,
  };
}
