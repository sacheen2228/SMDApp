// Volume Engine - Relative volume, volume-at-price, volume acceleration, breakout/pullback/reversal volume

import { Candle, RelativeVolume, VolumeAtPrice, VolumeProfile } from './auction-types';

export interface VolumeConfig {
  lookbackPeriod: number; // for average volume
  percentileLookback: number;
  accelerationPeriod: number;
}

const DEFAULT_VOL_CONFIG: VolumeConfig = {
  lookbackPeriod: 20,
  percentileLookback: 252, // ~1 year
  accelerationPeriod: 5,
};

export function calculateRelativeVolume(
  candles: Candle[],
  currentIdx: number,
  config: Partial<VolumeConfig> = {}
): RelativeVolume {
  const cfg = { ...DEFAULT_VOL_CONFIG, ...config };
  const lookback = Math.min(cfg.lookbackPeriod, currentIdx);

  if (lookback < 5) {
    return { current: candles[currentIdx]?.volume || 0, average: 0, ratio: 1, percentile: 50, acceleration: 0 };
  }

  const recentVolumes = candles.slice(currentIdx - lookback, currentIdx).map(c => c.volume);
  const current = candles[currentIdx]?.volume || 0;
  const average = recentVolumes.reduce((s, v) => s + v, 0) / recentVolumes.length;
  const ratio = average > 0 ? current / average : 1;

  // Volume percentile (vs longer lookback)
  const percLookback = Math.min(cfg.percentileLookback, currentIdx);
  const histVolumes = candles.slice(currentIdx - percLookback, currentIdx).map(c => c.volume);
  const sorted = [...histVolumes].sort((a, b) => a - b);
  const percentile = sorted.length > 0
    ? (sorted.filter(v => v <= current).length / sorted.length) * 100
    : 50;

  // Volume acceleration (current vs 5-period average)
  const accelPeriod = Math.min(cfg.accelerationPeriod, currentIdx);
  const accelVolumes = candles.slice(currentIdx - accelPeriod, currentIdx).map(c => c.volume);
  const accelAvg = accelVolumes.reduce((s, v) => s + v, 0) / accelVolumes.length;
  const acceleration = accelAvg > 0 ? current / accelAvg : 1;

  return { current, average, ratio, percentile, acceleration };
}

export function calculateVolumeAtPrice(candles: Candle[], profile: VolumeProfile): VolumeAtPrice[] {
  const vap: VolumeAtPrice[] = [];

  for (const level of profile.levels) {
    // Aggregate buy/sell volume at this price from candles
    let buyVol = 0, sellVol = 0;
    for (const c of candles) {
      if (c.high >= level.price && c.low <= level.price) {
        const tp = (c.high + c.low + c.close) / 3;
        const volAtPrice = c.volume * (1 - Math.abs(tp - level.price) / (c.high - c.low || 1));
        if (c.close >= c.open) {
          buyVol += volAtPrice * 0.6;
          sellVol += volAtPrice * 0.4;
        } else {
          buyVol += volAtPrice * 0.4;
          sellVol += volAtPrice * 0.6;
        }
      }
    }

    let cumulativeDelta = 0;
    // Calculate cumulative delta from bottom up
    const sortedLevels = [...profile.levels].sort((a, b) => a.price - b.price);
    for (const l of sortedLevels) {
      cumulativeDelta += (l.buyVolume || 0) - (l.sellVolume || 0);
      if (l.price === level.price) break;
    }

    vap.push({
      price: level.price,
      volume: level.volume,
      buyVolume: buyVol,
      sellVolume: sellVol,
      delta: buyVol - sellVol,
      cumulativeDelta,
    });
  }

  return vap.sort((a, b) => a.price - b.price);
}

export function analyzeBreakoutVolume(
  candles: Candle[],
  breakoutIdx: number,
  lookback: number = 20
): { isValid: boolean; volumeRatio: number; volumePercentile: number } {
  if (breakoutIdx < lookback) return { isValid: false, volumeRatio: 0, volumePercentile: 0 };

  const breakoutVol = candles[breakoutIdx].volume;
  const avgVol = candles.slice(breakoutIdx - lookback, breakoutIdx)
    .reduce((s, c) => s + c.volume, 0) / lookback;

  const volumeRatio = avgVol > 0 ? breakoutVol / avgVol : 0;

  const histVolumes = candles.slice(breakoutIdx - lookback, breakoutIdx).map(c => c.volume);
  const sorted = [...histVolumes].sort((a, b) => a - b);
  const percentile = sorted.length > 0
    ? (sorted.filter(v => v <= breakoutVol).length / sorted.length) * 100
    : 50;

  // Valid breakout: volume > 1.5x average and > 70th percentile
  const isValid = volumeRatio > 1.5 && percentile > 70;

  return { isValid, volumeRatio, volumePercentile };
}

export function analyzePullbackVolume(
  candles: Candle[],
  pullbackStart: number,
  pullbackEnd: number
): { isValid: boolean; avgVolumeRatio: number; declining: boolean } {
  if (pullbackStart >= pullbackEnd) return { isValid: false, avgVolumeRatio: 0, declining: false };

  const pullbackCandles = candles.slice(pullbackStart, pullbackEnd + 1);
  const prePullback = candles.slice(Math.max(0, pullbackStart - 10), pullbackStart);
  const preAvg = prePullback.reduce((s, c) => s + c.volume, 0) / Math.max(1, prePullback.length);

  const pullbackAvg = pullbackCandles.reduce((s, c) => s + c.volume, 0) / pullbackCandles.length;
  const avgVolumeRatio = preAvg > 0 ? pullbackAvg / preAvg : 1;

  // Check if volume is declining during pullback
  const volumes = pullbackCandles.map(c => c.volume);
  let declining = true;
  for (let i = 1; i < volumes.length; i++) {
    if (volumes[i] > volumes[i - 1] * 1.1) { declining = false; break; }
  }

  // Valid pullback: volume drops to < 70% of pre-pullback average and declining
  const isValid = avgVolumeRatio < 0.7 && declining;

  return { isValid, avgVolumeRatio, declining };
}

export function analyzeReversalVolume(
  candles: Candle[],
  reversalIdx: number,
  lookback: number = 10
): { isValid: boolean; volumeSpike: boolean; climactic: boolean } {
  if (reversalIdx < lookback) return { isValid: false, volumeSpike: false, climactic: false };

  const revVol = candles[reversalIdx].volume;
  const avgVol = candles.slice(reversalIdx - lookback, reversalIdx)
    .reduce((s, c) => s + c.volume, 0) / lookback;

  const volumeSpike = revVol > avgVol * 2;
  const climactic = revVol > avgVol * 3 && candles[reversalIdx].volume > candles[reversalIdx - 1]?.volume * 2;

  // Valid reversal: volume spike + price reversal
  const prevDir = candles[reversalIdx - 1].close > candles[reversalIdx - 1].open ? 1 : -1;
  const currDir = candles[reversalIdx].close > candles[reversalIdx].open ? 1 : -1;
  const directionChange = prevDir !== currDir;

  const isValid = volumeSpike && directionChange;

  return { isValid, volumeSpike, climactic };
}

export function analyzeVolumeProfile(
  candles: Candle[],
  profile: VolumeProfile
): {
  pocVolume: number;
  vahVolume: number;
  valVolume: number;
  hvnVolumes: number[];
  lvnVolumes: number[];
  volumeDistribution: 'NORMAL' | 'SKEWED_HIGH' | 'SKEWED_LOW' | 'BIMODAL';
} {
  const pocLevel = profile.levels.find(l => l.price === profile.poc);
  const vahLevel = profile.levels.find(l => l.price === profile.vah);
  const valLevel = profile.levels.find(l => l.price === profile.val);

  const hvnVolumes = profile.hvn.map(p => profile.levels.find(l => l.price === p)?.volume || 0);
  const lvnVolumes = profile.lvn.map(p => profile.levels.find(l => l.price === p)?.volume || 0);

  // Determine distribution shape
  const volumes = profile.levels.map(l => l.volume).sort((a, b) => b - a);
  const top10 = volumes.slice(0, 10).reduce((s, v) => s + v, 0);
  const total = volumes.reduce((s, v) => s + v, 0);
  const concentration = total > 0 ? top10 / total : 0;

  let distribution: 'NORMAL' | 'SKEWED_HIGH' | 'SKEWED_LOW' | 'BIMODAL' = 'NORMAL';
  if (concentration > 0.6) distribution = 'BIMODAL';

  return {
    pocVolume: pocLevel?.volume || 0,
    vahVolume: vahLevel?.volume || 0,
    valVolume: valLevel?.volume || 0,
    hvnVolumes,
    lvnVolumes,
    volumeDistribution: distribution,
  };
}