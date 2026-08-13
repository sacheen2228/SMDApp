// Stage 4 — "Rocket Move" Detection
// Explosive momentum breakout detection. Separate path from the steady
// swing scanner: these are 8-19% single-session movers that fail Stage 1's
// RSI<65 filter by definition. Detected via volume/price anomalies, then
// classified into Ignition / Continuation / Exhaustion / Distribution with
// a mandatory chase-risk guardrail so we never suggest chasing a move that's
// already extended.

import { Candle, calculateEMA, calculateRSI } from "@/lib/ml-engine";

export type RocketStage = "IGNITION" | "CONTINUATION" | "EXHAUSTION" | "DISTRIBUTION";
export type ChaseRisk = "LOW" | "MEDIUM" | "HIGH";
export type RecommendedAction = "ENTRY OK" | "WAIT FOR PULLBACK" | "AVOID" | "TRIM/EXIT";

export interface RocketDetection {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  rvol: number;               // today's volume vs 20-day avg
  dayChgPct: number;          // single-session % move
  gapPct: number;             // open vs prev close
  gapHeld: boolean;           // gap beyond 1x ATR that held through session
  breakoutLevel: number;      // prior consolidation/swing-high level broken
  breakoutConformed: boolean; // above multi-week range/swing high on volume
  dayRangeMultiple: number;   // today's range / own 30-day avg daily range
  catalyst: string;           // "Y: reason" or "N — unexplained"
  stage: RocketStage;
  distFromEma20Atr: number;   // |price - ema20| in ATR multiples
  rsi: number;
  chaseRisk: ChaseRisk;
  recommendedAction: RecommendedAction;
  pullbackLevel: number | null; // if WAIT FOR PULLBACK — level to watch
}

function avgDailyRange(candles: Candle[], lookback = 30): number {
  const slice = candles.slice(-lookback);
  if (!slice.length) return 0;
  return slice.reduce((s, c) => s + (c.high - c.low), 0) / slice.length;
}

function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ));
  }
  const n = Math.min(period, trs.length);
  return trs.slice(-n).reduce((s, v) => s + v, 0) / n;
}

function averageVolume(candles: Candle[], lookback = 20): number {
  const vols = candles.slice(-lookback, -1).map(c => c.volume).filter(v => v > 0);
  if (!vols.length) return 0;
  return vols.reduce((a, b) => a + b, 0) / vols.length;
}

export function detectRocket(candles: Candle[], symbol: string, name: string, sector: string): RocketDetection | null {
  if (candles.length < 40) return null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const price = last.close;
  const closes = candles.map(c => c.close);

  const avgVol = averageVolume(candles, 20);
  const rvol = avgVol > 0 ? last.volume / avgVol : 1;
  const dayChgPct = prev.close > 0 ? ((price - prev.close) / prev.close) * 100 : 0;
  const gapPct = prev.close > 0 ? ((last.open - prev.close) / prev.close) * 100 : 0;
  const atr = calcATR(candles, 14);
  const adr = avgDailyRange(candles, 30);
  const dayRange = last.high - last.low;
  const dayRangeMultiple = adr > 0 ? dayRange / adr : 0;

  // Threshold: explosive move needs RVOL > 3x OR a big day move.
  if (rvol < 3 && dayChgPct < 4) return null;

  const ema20 = calculateEMA(closes, 20).at(-1) ?? price;
  const rsi = calculateRSI(candles, 14);
  const distFromEma20Atr = atr > 0 ? (price - ema20) / atr : 0;

  // Gap held? Gap beyond 1x ATR at open, and close not back through the gap.
  const gapHeld = gapPct > 0 && Math.abs(gapPct) / (atr / price) > 1.0 && last.close >= last.open;

  // Breakout: above the highest high of the prior 30 sessions (excl today).
  const priorHigh = Math.max(...candles.slice(-31, -1).map(c => c.high));
  const breakoutLevel = priorHigh;
  const breakoutConformed = price > priorHigh && rvol >= 1.5;

  // Stage classification
  let stage: RocketStage;
  let chaseRisk: ChaseRisk = "MEDIUM";
  if (rsi > 78 || distFromEma20Atr > 2.5) {
    stage = "EXHAUSTION";
  } else if (rvol >= 5 && dayChgPct >= 3 && dayRangeMultiple >= 2) {
    // Big fresh volume spike — likely first or second day of the move
    stage = "IGNITION";
  } else if (dayChgPct >= 2 && rvol >= 1.5) {
    stage = "CONTINUATION";
  } else {
    // High volume without price progress, or long upper wicks
    const upperWick = last.high - Math.max(last.close, last.open);
    if (rvol >= 3 && (dayChgPct < 2 || upperWick > atr)) {
      stage = "DISTRIBUTION";
    } else {
      stage = "CONTINUATION";
    }
  }

  // Chase-risk guardrail — distance from EMA in ATR terms + gap status
  const distAbs = Math.abs(distFromEma20Atr);
  if (distAbs > 2.5 || rsi > 75) chaseRisk = "HIGH";
  else if (distAbs > 1.8 || (gapHeld && distAbs > 1.2)) chaseRisk = "MEDIUM";
  else chaseRisk = "LOW";

  // Recommended action
  let recommendedAction: RecommendedAction = "ENTRY OK";
  let pullbackLevel: number | null = null;
  if (stage === "EXHAUSTION") {
    recommendedAction = "AVOID";
    pullbackLevel = ema20;
  } else if (stage === "DISTRIBUTION") {
    recommendedAction = "TRIM/EXIT";
    pullbackLevel = Math.max(ema20, prev.close);
  } else if (chaseRisk === "HIGH") {
    recommendedAction = "WAIT FOR PULLBACK";
    pullbackLevel = ema20;
  }

  // Catalyst placeholder — filled by caller (async news check).
  const catalyst = "N — unexplained spike, higher risk";

  return {
    symbol,
    name,
    sector,
    price,
    rvol,
    dayChgPct,
    gapPct,
    gapHeld,
    breakoutLevel,
    breakoutConformed,
    dayRangeMultiple,
    catalyst,
    stage,
    distFromEma20Atr,
    rsi,
    chaseRisk,
    recommendedAction,
    pullbackLevel,
  };
}