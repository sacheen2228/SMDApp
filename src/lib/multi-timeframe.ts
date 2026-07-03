// Multi-Timeframe Consensus Engine
// Analyzes 6 timeframes independently, aggregates into a single bias signal.

import type { CandleData, TimeframeResult, ConsensusResult } from '@/types/sdm';
import { analyzeMarketStructure } from './market-structure';

// ─── EMA Helpers ──────────────────────────────────────────────────

function computeEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [];
  // Seed with SMA of first `period` values
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  ema.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    ema.push(prev);
  }
  return ema;
}

// ─── Per-Timeframe Analysis ───────────────────────────────────────

export function analyzeTimeframe(candles: CandleData[]): TimeframeResult {
  const candleCount = candles.length;
  const tf = '';

  if (candleCount === 0) {
    return {
      tf,
      bias: 'NEUTRAL',
      ema9: 0,
      ema21: 0,
      emaSlope: 0,
      structureTrend: 'RANGING',
      volumeConfirm: false,
      candleCount: 0,
    };
  }

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  // EMA calculation — need at least 21 candles for full convergence
  const ema9Values = candleCount >= 9 ? computeEMA(closes, 9) : [];
  const ema21Values = candleCount >= 21 ? computeEMA(closes, 21) : [];

  const ema9 = ema9Values.length > 0 ? ema9Values[ema9Values.length - 1] : closes[closes.length - 1];
  const ema21 = ema21Values.length > 0 ? ema21Values[ema21Values.length - 1] : closes[closes.length - 1];

  // Slope: normalized difference (ema9 - ema21) / ema21
  const emaSlope = ema21 !== 0 ? (ema9 - ema21) / ema21 : 0;

  // Market structure
  const structure = analyzeMarketStructure(candles);

  // Volume confirmation: current volume > session average
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / candleCount;
  const currentVolume = volumes[volumes.length - 1];
  const volumeConfirm = currentVolume > avgVolume;

  // Bias scoring
  const emaBias = ema9 > ema21 ? 1 : ema9 < ema21 ? -1 : 0;
  const structBias = structure.trend === 'UPTREND' ? 1 : structure.trend === 'DOWNTREND' ? -1 : 0;
  const avgScore = (emaBias + structBias) / 2;

  let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  if (avgScore > 0) {
    bias = volumeConfirm || avgScore >= 1 ? 'BULLISH' : 'NEUTRAL';
  } else if (avgScore < 0) {
    bias = volumeConfirm || avgScore <= -1 ? 'BEARISH' : 'NEUTRAL';
  } else {
    bias = 'NEUTRAL';
  }

  return {
    tf,
    bias,
    ema9,
    ema21,
    emaSlope,
    structureTrend: structure.trend,
    volumeConfirm,
    candleCount,
  };
}

// ─── Consensus Aggregation ────────────────────────────────────────

export function computeConsensus(results: TimeframeResult[]): ConsensusResult {
  if (results.length === 0) {
    return {
      timeframes: [],
      consensus: 0,
      overallBias: 'NEUTRAL',
      bullishCount: 0,
      bearishCount: 0,
      neutralCount: 0,
      status: 'DEGRADED',
    };
  }

  let bullishCount = 0;
  let bearishCount = 0;
  let neutralCount = 0;
  let degradedCount = 0;

  for (const r of results) {
    if (r.candleCount < 21) degradedCount++;
    if (r.bias === 'BULLISH') bullishCount++;
    else if (r.bias === 'BEARISH') bearishCount++;
    else neutralCount++;
  }

  const total = results.length;
  const consensus = (bullishCount - bearishCount) / total;

  let overallBias: ConsensusResult['overallBias'];
  if (consensus >= 0.5) overallBias = 'STRONG_BULLISH';
  else if (consensus >= 0.15) overallBias = 'BULLISH';
  else if (consensus > -0.15) overallBias = 'NEUTRAL';
  else if (consensus > -0.5) overallBias = 'BEARISH';
  else overallBias = 'STRONG_BEARISH';

  const status = degradedCount === total ? 'DEGRADED' : 'OK';

  return {
    timeframes: results,
    consensus,
    overallBias,
    bullishCount,
    bearishCount,
    neutralCount,
    status,
  };
}

// ─── Main Entry Point ─────────────────────────────────────────────

export function analyzeMultiTimeframe(
  candlesByTimeframe: Record<string, CandleData[]>
): ConsensusResult {
  const results: TimeframeResult[] = [];

  for (const [tf, candles] of Object.entries(candlesByTimeframe)) {
    if (!candles || candles.length === 0) continue;
    const result = analyzeTimeframe(candles);
    result.tf = tf;
    results.push(result);
  }

  return computeConsensus(results);
}
