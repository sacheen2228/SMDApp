// MTF Indicator Engine
// Computes all indicators across all timeframes.
// Reuses: ml-engine (RSI/EMA/BB/VWAP/ADX), supertrend-engine (SuperTrend),
//         market-structure (S/R), candlestick-breakout (Pivots)
//
// This engine is PURE COMPUTATION — it does NOT fetch data.

import type { CandleData } from '@/types/sdm';
import { computeSuperTrend, type SuperTrendCandle } from './supertrend-engine';
import { calculateRSI, calculateEMA, calculateBollingerBands, calculateVWAP, calculateADX } from './ml-engine';
import { detectSwingPoints, analyzeMarketStructure } from './market-structure';
import type { IndicatorParams } from './mtf-config';

// ─── Types ─────────────────────────────────────────────────────────

export interface TimeframeIndicators {
  timeframe: string;
  candleCount: number;
  lastPrice: number;
  lastTime: number;
  supertrend: {
    direction: "UP" | "DOWN";
    value: number;
    trendAge: number;
    distancePercent: number;  // |close - ST| / ST * 100
  } | null;
  rsi: number;
  ema: { fast: number; slow: number; cross: "BULLISH_CROSS" | "BEARISH_CROSS" | "NONE"; slope: number };
  bollinger: {
    upper: number;
    middle: number;
    lower: number;
    bandwidth: number;
    position: number;  // 0 = at lower, 1 = at upper, 0.5 = middle
  };
  adx: number;
  atr: number;
  vwap: { value: number; distancePercent: number; above: boolean };
  pivots: {
    r2: number; r1: number; pivot: number; s1: number; s2: number;
    nearest: string;  // R1/R2/S1/S2/P
    distancePercent: number;
  } | null;
  volume: {
    current: number;
    average: number;
    ratio: number;
    aboveAverage: boolean;
  };
  structure: {
    trend: "UPTREND" | "DOWNTREND" | "RANGING";
    lastEvent: string | null;
    eventDirection: "BULLISH" | "BEARISH" | null;
  };
}

export interface MTFIndicatorResult {
  timeframes: Record<string, TimeframeIndicators>;
  dataAvailability: Record<string, { available: boolean; candles: number; reason?: string }>;
}

// ─── Helpers ───────────────────────────────────────────────────────

function toSuperTrendCandle(c: CandleData): SuperTrendCandle {
  return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
}

// ─── Per-Timeframe Indicator Computation ───────────────────────────

export function computeIndicatorsForTimeframe(
  candles: CandleData[],
  timeframe: string,
  params: IndicatorParams,
  minCandles: number = 20,
): TimeframeIndicators {
  const defaultReturn: TimeframeIndicators = {
    timeframe,
    candleCount: candles.length,
    lastPrice: 0,
    lastTime: 0,
    supertrend: null,
    rsi: 50,
    ema: { fast: 0, slow: 0, cross: "NONE", slope: 0 },
    bollinger: { upper: 0, middle: 0, lower: 0, bandwidth: 0, position: 0.5 },
    adx: 20,
    atr: 0,
    vwap: { value: 0, distancePercent: 0, above: false },
    pivots: null,
    volume: { current: 0, average: 0, ratio: 1, aboveAverage: false },
    structure: { trend: "RANGING", lastEvent: null, eventDirection: null },
  };

  if (candles.length < 2) return defaultReturn;

  const closes = candles.map(c => c.close);
  const lastCandle = candles[candles.length - 1];

  // SuperTrend
  let supertrend = defaultReturn.supertrend;
  if (candles.length >= params.supertrend.period + 2) {
    const stCandles = candles.map(toSuperTrendCandle);
    const st = computeSuperTrend(stCandles, params.supertrend);
    const dist = Math.abs(lastCandle.close - st.currentValue) / st.currentValue * 100;
    supertrend = {
      direction: st.currentDirection,
      value: st.currentValue,
      trendAge: st.trendAge,
      distancePercent: Math.round(dist * 100) / 100,
    };
  }

  // RSI
  const rsi = calculateRSI(candles, params.rsi.period);

  // EMA
  const emaFastVals = calculateEMA(closes, params.ema.fast);
  const emaSlowVals = calculateEMA(closes, params.ema.slow);
  const emaFast = emaFastVals.length > 0 ? emaFastVals[emaFastVals.length - 1] : lastCandle.close;
  const emaSlow = emaSlowVals.length > 0 ? emaSlowVals[emaSlowVals.length - 1] : lastCandle.close;
  let cross: "BULLISH_CROSS" | "BEARISH_CROSS" | "NONE" = "NONE";
  if (emaFastVals.length >= 2 && emaSlowVals.length >= 2) {
    const prevFast = emaFastVals[emaFastVals.length - 2];
    const prevSlow = emaSlowVals[emaSlowVals.length - 2];
    if (prevFast <= prevSlow && emaFast > emaSlow) cross = "BULLISH_CROSS";
    else if (prevFast >= prevSlow && emaFast < emaSlow) cross = "BEARISH_CROSS";
  }
  const slope = emaSlow !== 0 ? (emaFast - emaSlow) / emaSlow * 100 : 0;

  // Bollinger Bands
  const bb = calculateBollingerBands(closes, params.bollinger.period, params.bollinger.multiplier);
  const bbPosition = bb.upper !== bb.lower
    ? Math.min(1, Math.max(0, (lastCandle.close - bb.lower) / (bb.upper - bb.lower)))
    : 0.5;

  // ADX
  const adx = calculateADX(candles, params.adx.period);

  // ATR (reuse SuperTrend's ATR)
  const stCandles = candles.map(toSuperTrendCandle);
  const atrResult = computeSuperTrend(stCandles, { period: params.atr.period, multiplier: 1 });
  const atr = atrResult.bars.length > 0 ? atrResult.bars[atrResult.bars.length - 1].value : 0;

  // VWAP
  const vwapValue = calculateVWAP(candles);
  const vwapDist = vwapValue !== 0 ? (lastCandle.close - vwapValue) / vwapValue * 100 : 0;

  // Pivots (Camarilla-style from last candle's OHLC)
  let pivots = defaultReturn.pivots;
  if (candles.length >= params.pivots.lookback) {
    const recent = candles.slice(-params.pivots.lookback);
    const prev = recent[recent.length - 2] || recent[recent.length - 1];
    const pivot = (prev.high + prev.low + prev.close) / 3;
    const r1 = 2 * pivot - prev.low;
    const r2 = pivot + (prev.high - prev.low);
    const s1 = 2 * pivot - prev.high;
    const s2 = pivot - (prev.high - prev.low);
    const levels = [
      { name: "R2", value: r2 },
      { name: "R1", value: r1 },
      { name: "P", value: pivot },
      { name: "S1", value: s1 },
      { name: "S2", value: s2 },
    ];
    let nearest = levels[0];
    let minDist = Math.abs(lastCandle.close - nearest.value);
    for (const lv of levels) {
      const d = Math.abs(lastCandle.close - lv.value);
      if (d < minDist) { minDist = d; nearest = lv; }
    }
    pivots = {
      r2, r1, pivot, s1, s2,
      nearest: nearest.name,
      distancePercent: lastCandle.close !== 0
        ? Math.round(minDist / lastCandle.close * 100 * 100) / 100
        : 0,
    };
  }

  // Volume
  const volumes = candles.map(c => c.volume);
  const currentVol = volumes[volumes.length - 1];
  const avgVol = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
  const volRatio = avgVol > 0 ? currentVol / avgVol : 1;

  // Market structure
  const structure = analyzeMarketStructure(candles);
  const lastEvent = structure.structureEvent;

  return {
    timeframe,
    candleCount: candles.length,
    lastPrice: lastCandle.close,
    lastTime: lastCandle.time,
    supertrend,
    rsi: Math.round(rsi * 10) / 10,
    ema: {
      fast: Math.round(emaFast * 100) / 100,
      slow: Math.round(emaSlow * 100) / 100,
      cross,
      slope: Math.round(slope * 100) / 100,
    },
    bollinger: {
      upper: Math.round(bb.upper * 100) / 100,
      middle: Math.round(bb.middle * 100) / 100,
      lower: Math.round(bb.lower * 100) / 100,
      bandwidth: Math.round(bb.bandwidth * 100) / 100,
      position: Math.round(bbPosition * 100) / 100,
    },
    adx: Math.round(adx * 10) / 10,
    atr: Math.round(atr * 100) / 100,
    vwap: {
      value: Math.round(vwapValue * 100) / 100,
      distancePercent: Math.round(vwapDist * 100) / 100,
      above: lastCandle.close > vwapValue,
    },
    pivots,
    volume: {
      current: currentVol,
      average: Math.round(avgVol),
      ratio: Math.round(volRatio * 100) / 100,
      aboveAverage: currentVol > avgVol,
    },
    structure: {
      trend: structure.trend,
      lastEvent: lastEvent?.type || null,
      eventDirection: lastEvent?.direction || null,
    },
  };
}

// ─── Multi-TF Computation ──────────────────────────────────────────

export function computeMTFIndicators(
  candlesByTimeframe: Record<string, CandleData[]>,
  params: IndicatorParams,
  minCandles: number = 20,
): MTFIndicatorResult {
  const timeframes: Record<string, TimeframeIndicators> = {};
  const dataAvailability: MTFIndicatorResult['dataAvailability'] = {};

  for (const [tf, candles] of Object.entries(candlesByTimeframe)) {
    const available = candles && candles.length >= minCandles;
    dataAvailability[tf] = {
      available,
      candles: candles?.length || 0,
      reason: !candles || candles.length === 0
        ? "no_data"
        : candles.length < minCandles
          ? `insufficient_candles_${candles.length}/${minCandles}`
          : undefined,
    };
    if (available) {
      timeframes[tf] = computeIndicatorsForTimeframe(candles, tf, params, minCandles);
    }
  }

  return { timeframes, dataAvailability };
}
