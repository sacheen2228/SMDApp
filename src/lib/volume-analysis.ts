// Volume & Order Flow Analysis Module
// Analyzes volume patterns, order flow proxies, and volume-based levels from OHLCV candle data
// All derived metrics are labeled as estimated since we don't have true tick data

import {
  CandleData,
  VolumeProfileLevel,
  AbsorptionLevel,
  ExhaustionSignal,
  VolumeAnalysis,
} from '@/types/sdm';

// ─── Volume Profile ─────────────────────────────────────────────

export function computeVolumeProfile(candles: CandleData[], priceBins = 50): VolumeProfileLevel[] {
  if (candles.length === 0) return [];

  const sessionHigh = Math.max(...candles.map(c => c.high));
  const sessionLow = Math.min(...candles.map(c => c.low));
  const sessionRange = sessionHigh - sessionLow;

  if (sessionRange <= 0) {
    // All candles at same price
    const totalVol = candles.reduce((sum, c) => sum + c.volume, 0);
    return [{ price: sessionHigh, volume: totalVol, buyVolume: totalVol * 0.5, sellVolume: totalVol * 0.5 }];
  }

  const binSize = sessionRange / priceBins;
  const bins: VolumeProfileLevel[] = [];

  for (let i = 0; i < priceBins; i++) {
    const binLow = sessionLow + i * binSize;
    const binHigh = binLow + binSize;
    const binMid = (binLow + binHigh) / 2;

    let totalVolume = 0;
    let buyVolume = 0;
    let sellVolume = 0;

    for (const candle of candles) {
      // Check if candle overlaps this bin
      if (candle.high >= binLow && candle.low <= binHigh) {
        // Proportion of candle overlapping the bin (simple fraction estimate)
        const overlapLow = Math.max(candle.low, binLow);
        const overlapHigh = Math.min(candle.high, binHigh);
        const overlapFraction = (overlapHigh - overlapLow) / candleRange(candle);

        const volEstimate = candle.volume * overlapFraction;
        totalVolume += volEstimate;

        // Simple tick rule: close > open = buy dominated
        if (candle.close > candle.open) {
          buyVolume += volEstimate * 0.6;
          sellVolume += volEstimate * 0.4;
        } else if (candle.close < candle.open) {
          buyVolume += volEstimate * 0.4;
          sellVolume += volEstimate * 0.6;
        } else {
          buyVolume += volEstimate * 0.5;
          sellVolume += volEstimate * 0.5;
        }
      }
    }

    if (totalVolume > 0) {
      bins.push({ price: binMid, volume: totalVolume, buyVolume, sellVolume });
    }
  }

  return bins;
}

function candleRange(c: CandleData): number {
  const range = c.high - c.low;
  return range > 0 ? range : 0.0001; // avoid division by zero
}

// ─── Point of Control ───────────────────────────────────────────

export function findPOC(profile: VolumeProfileLevel[]): number {
  if (profile.length === 0) return 0;

  let maxVol = 0;
  let poc = profile[0].price;

  for (const level of profile) {
    if (level.volume > maxVol) {
      maxVol = level.volume;
      poc = level.price;
    }
  }

  return poc;
}

// ─── Value Area ─────────────────────────────────────────────────

export function findValueArea(profile: VolumeProfileLevel[]): { vah: number; val: number } {
  if (profile.length === 0) return { vah: 0, val: 0 };

  const totalVolume = profile.reduce((sum, l) => sum + l.volume, 0);
  if (totalVolume <= 0) return { vah: 0, val: 0 };

  const targetVolume = totalVolume * 0.7;

  // Find POC index
  let pocIdx = 0;
  let maxVol = 0;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i].volume > maxVol) {
      maxVol = profile[i].volume;
      pocIdx = i;
    }
  }

  let accumulated = profile[pocIdx].volume;
  let valIdx = pocIdx;
  let vahIdx = pocIdx;

  // Expand alternately up and down until we capture 70% of volume
  let expandUp = true;
  while (accumulated < targetVolume && (valIdx > 0 || vahIdx < profile.length - 1)) {
    if (expandUp && vahIdx < profile.length - 1) {
      vahIdx++;
      accumulated += profile[vahIdx].volume;
    } else if (!expandUp && valIdx > 0) {
      valIdx--;
      accumulated += profile[valIdx].volume;
    }
    expandUp = !expandUp;
  }

  return { vah: profile[vahIdx].price, val: profile[valIdx].price };
}

// ─── Cumulative Delta ───────────────────────────────────────────

export function computeCumulativeDelta(candles: CandleData[]): number {
  let cumulative = 0;

  for (const candle of candles) {
    if (candle.close > candle.open) {
      // Uptick — buy initiated volume (estimated 60%)
      cumulative += candle.volume * 0.6;
      cumulative -= candle.volume * 0.4;
    } else if (candle.close < candle.open) {
      // Downtick — sell initiated volume (estimated 60%)
      cumulative += candle.volume * 0.4;
      cumulative -= candle.volume * 0.6;
    }
    // If open == close, no net contribution
  }

  return cumulative;
}

// ─── Absorption Detection ───────────────────────────────────────

export function detectAbsorption(candles: CandleData[], lookback = 5): AbsorptionLevel[] {
  if (candles.length < lookback) return [];

  const absorptions: AbsorptionLevel[] = [];

  for (let i = lookback - 1; i < candles.length; i++) {
    const window = candles.slice(i - lookback + 1, i + 1);
    const windowHigh = Math.max(...window.map(c => c.high));
    const windowLow = Math.min(...window.map(c => c.low));
    const midpoint = (windowHigh + windowLow) / 2;
    const priceRange = windowHigh - windowLow;
    const rangePercent = midpoint > 0 ? (priceRange / midpoint) * 100 : 0;

    const totalVolume = window.reduce((sum, c) => sum + c.volume, 0);

    // Absorption: high volume but price range < 0.1% of midpoint
    if (rangePercent < 0.1 && totalVolume > 0) {
      const lastCandle = window[window.length - 1];
      // Determine side based on whether price held up (BUY absorption) or was pushed down (SELL absorption)
      const side: 'BUY' | 'SELL' = lastCandle.close >= lastCandle.open ? 'BUY' : 'SELL';

      // Deduplicate: don't add if we already have a level very close by
      const nearExisting = absorptions.some(
        a => Math.abs(a.price - midpoint) < priceRange * 0.5
      );

      if (!nearExisting) {
        absorptions.push({
          price: midpoint,
          side,
          volume: totalVolume,
          priceRange,
        });
      }
    }
  }

  return absorptions;
}

// ─── Exhaustion Detection ───────────────────────────────────────

export function detectExhaustion(candles: CandleData[], lookback = 20): ExhaustionSignal[] {
  if (candles.length < lookback + 1) return [];

  const signals: ExhaustionSignal[] = [];

  for (let i = lookback; i < candles.length; i++) {
    const historicalSlice = candles.slice(i - lookback, i);
    const avgVolume = historicalSlice.reduce((sum, c) => sum + c.volume, 0) / historicalSlice.length;
    const currentCandle = candles[i];

    // Volume spike: > 2x average
    if (currentCandle.volume > avgVolume * 2 && avgVolume > 0) {
      // Check for reversal in next candle (if available)
      if (i + 1 < candles.length) {
        const nextCandle = candles[i + 1];

        // Buy exhaustion: green candle followed by red candle (reversal down)
        if (currentCandle.close > currentCandle.open && nextCandle.close < nextCandle.open) {
          signals.push({
            price: currentCandle.close,
            time: currentCandle.time,
            type: 'BUY_EXHAUSTION',
            volume: currentCandle.volume,
          });
        }

        // Sell exhaustion: red candle followed by green candle (reversal up)
        if (currentCandle.close < currentCandle.open && nextCandle.close > nextCandle.open) {
          signals.push({
            price: currentCandle.close,
            time: currentCandle.time,
            type: 'SELL_EXHAUSTION',
            volume: currentCandle.volume,
          });
        }
      }
    }
  }

  return signals;
}

// ─── Main Entry Point ───────────────────────────────────────────

export function analyzeVolume(candles: CandleData[]): VolumeAnalysis {
  if (candles.length < 20) {
    return {
      poc: 0,
      vah: 0,
      val: 0,
      cumulativeDelta: 0,
      volumeProfile: [],
      absorptionLevels: [],
      exhaustionSignals: [],
      totalVolume: 0,
      avgVolume: 0,
      status: 'DEGRADED',
    };
  }

  const totalVolume = candles.reduce((sum, c) => sum + c.volume, 0);
  const avgVolume = totalVolume / candles.length;

  const volumeProfile = computeVolumeProfile(candles);
  const poc = findPOC(volumeProfile);
  const { vah, val } = findValueArea(volumeProfile);
  const cumulativeDelta = computeCumulativeDelta(candles);
  const absorptionLevels = detectAbsorption(candles);
  const exhaustionSignals = detectExhaustion(candles);

  return {
    poc,
    vah,
    val,
    cumulativeDelta,
    volumeProfile,
    absorptionLevels,
    exhaustionSignals,
    totalVolume,
    avgVolume,
    status: 'OK',
  };
}
