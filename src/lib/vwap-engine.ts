// VWAP Engine - Session, Anchored, Weekly VWAP with reclaim/rejection detection

import { Candle, VwapAnchor, VWAPState } from './auction-types';

export interface VwapConfig {
  anchorPoints: string[]; // 'SESSION', 'WEEKLY', 'MONTHLY', 'SWING_HIGH', 'SWING_LOW'
  deviationBands: number[]; // 1, 2, 3 sigma
}

const DEFAULT_VWAP_CONFIG: VwapConfig = {
  anchorPoints: ['SESSION', 'WEEKLY', 'SWING_HIGH', 'SWING_LOW'],
  deviationBands: [1, 2, 3],
};

export function calculateSessionVWAP(candles: Candle[]): { vwap: number; upperBands: number[]; lowerBands: number[] } {
  let cumPV = 0, cumV = 0;
  const typicalPrices: number[] = [];

  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumV += c.volume;
    typicalPrices.push(tp);
  }

  const vwap = cumV > 0 ? cumPV / cumV : candles[candles.length - 1]?.close || 0;

  // Calculate standard deviation bands
  if (typicalPrices.length === 0) return { vwap, upperBands: [], lowerBands: [] };

  const mean = vwap;
  const variance = typicalPrices.reduce((s, tp) => s + Math.pow(tp - mean, 2), 0) / typicalPrices.length;
  const stdDev = Math.sqrt(variance);

  const upperBands = [1, 2, 3].map(m => vwap + m * stdDev);
  const lowerBands = [1, 2, 3].map(m => vwap - m * stdDev);

  return { vwap, upperBands, lowerBands };
}

export function calculateAnchoredVWAP(
  candles: Candle[],
  anchorTime: number,
  anchorType: VwapAnchor['type']
): VwapAnchor | null {
  const anchorIdx = candles.findIndex(c => c.time >= anchorTime);
  if (anchorIdx === -1) return null;

  const anchoredCandles = candles.slice(anchorIdx);
  const { vwap, upperBands, lowerBands } = calculateSessionVWAP(anchoredCandles);

  return {
    price: vwap,
    time: anchorTime,
    type: anchorType,
    anchorTime,
  };
}

export function calculateWeeklyVWAP(weeklyCandles: Candle[]): VwapAnchor {
  const { vwap } = calculateSessionVWAP(weeklyCandles);
  return {
    price: vwap,
    time: weeklyCandles[0]?.time || Date.now(),
    type: 'WEEKLY',
    anchorTime: weeklyCandles[0]?.time || Date.now(),
  };
}

export function calculateAllVWAPs(
  candles: Candle[],
  swings: { time: number; price: number; type: 'HIGH' | 'LOW' }[]
): VwapAnchor[] {
  const anchors: VwapAnchor[] = [];

  // Session VWAP
  const sessionVwap = calculateSessionVWAP(candles);
  anchors.push({
    price: sessionVwap.vwap,
    time: candles[0]?.time || Date.now(),
    type: 'SESSION',
    anchorTime: candles[0]?.time || Date.now(),
  });

  // Weekly VWAP (if we have enough data)
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const now = candles[candles.length - 1]?.time || Date.now();
  const weekStart = now - weekMs;
  const weeklyCandles = candles.filter(c => c.time >= weekStart);
  if (weeklyCandles.length > 20) {
    anchors.push(calculateWeeklyVWAP(weeklyCandles));
  }

  // Swing High/Low Anchored VWAPs
  const recentSwings = swings.slice(-10);
  for (const swing of recentSwings) {
    const avwap = calculateAnchoredVWAP(candles, swing.time, swing.type === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW');
    if (avwap) anchors.push(avwap);
  }

  return anchors;
}

export function classifyVWAPState(
  currentPrice: number,
  sessionVwap: number,
  prevClose: number,
  sessionOpen: number,
  vwapAnchors: VwapAnchor[]
): { state: VWAPState; distance: number; reclaim: boolean; rejection: boolean } {
  const distance = ((currentPrice - sessionVwap) / sessionVwap) * 100;

  // Check reclaim: was below, now above with conviction
  // (would need historical state tracking - simplified here)
  const reclaim = currentPrice > sessionVwap && prevClose < sessionVwap && currentPrice > sessionOpen;
  const rejection = currentPrice < sessionVwap && prevClose > sessionVwap && currentPrice < sessionOpen;

  let state: VWAPState = 'ABOVE_VWAP';
  if (currentPrice < sessionVwap) state = 'BELOW_VWAP';
  if (reclaim) state = 'VWAP_RECLAIM';
  else if (rejection) state = 'VWAP_REJECTION';

  return { state, distance, reclaim, rejection };
}

export function calculateVWAPDeviationBands(candles: Candle[], multipliers: number[] = [1, 2, 3]): {
  vwap: number;
  upper: number[];
  lower: number[];
} {
  const { vwap, upperBands, lowerBands } = calculateSessionVWAP(candles);
  return { vwap, upper: upperBands, lower: lowerBands };
}