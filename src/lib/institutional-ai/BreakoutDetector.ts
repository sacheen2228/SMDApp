// ─── BreakoutDetector — Support/Resistance + Breakout Detection ────
// Detects support and resistance from candle history.
// Confirms breakouts using candle CLOSE only (never wick).

import type { Candle, BreakoutResult, PriceLevel } from "./types";
import { BREAKOUT_CONFIG } from "./config";

/**
 * Detect support/resistance levels from candle history and confirm
 * whether a breakout has occurred. Only candle closes count — wicks
 * are ignored for breakout confirmation.
 */
export function detectBreakout(candles: Candle[], spotPrice: number): BreakoutResult {
  if (candles.length < BREAKOUT_CONFIG.lookbackPeriod) {
    return emptyResult();
  }

  const lookback = candles.slice(-BREAKOUT_CONFIG.lookbackPeriod);
  const { supports, resistances } = findPriceLevels(lookback);

  const nearestSupport = findNearest(supports, spotPrice, "BELOW");
  const nearestResistance = findNearest(resistances, spotPrice, "ABOVE");

  const latestCandle = lookback[lookback.length - 1];
  const prevCandle = lookback[lookback.length - 2];

  // Check for breakout confirmation via CLOSE
  const bullishBreak = latestCandle.close > nearestResistance &&
    prevCandle.close <= nearestResistance;
  const bearishBreak = latestCandle.close < nearestSupport &&
    prevCandle.close >= nearestSupport;

  const direction = bullishBreak ? "BULLISH" : bearishBreak ? "BEARISH" : "NONE";
  const detected = direction !== "NONE";

  // Score based on strength of breakout
  let score = 0;
  if (detected) {
    const breakDistance = direction === "BULLISH"
      ? (latestCandle.close - nearestResistance) / nearestResistance
      : (nearestSupport - latestCandle.close) / nearestSupport;
    score = Math.min(20, Math.round(10 + breakDistance * 500));

    // Bonus for volume confirmation
    const avgVol = lookback.reduce((s, c) => s + c.volume, 0) / lookback.length;
    if (latestCandle.volume > avgVol * 1.5) score = Math.min(20, score + 3);
  }

  const supportLevels: PriceLevel[] = supports.map((p) => ({
    price: p,
    strength: countTouches(lookback, p, "support"),
    touches: countTouches(lookback, p, "support"),
    isBreakout: bearishBreak && Math.abs(p - nearestSupport) < 1,
    direction: "BELOW",
  }));

  const resistanceLevels: PriceLevel[] = resistances.map((p) => ({
    price: p,
    strength: countTouches(lookback, p, "resistance"),
    touches: countTouches(lookback, p, "resistance"),
    isBreakout: bullishBreak && Math.abs(p - nearestResistance) < 1,
    direction: "ABOVE",
  }));

  return {
    detected,
    direction,
    breakoutPrice: detected ? latestCandle.close : 0,
    supportLevels,
    resistanceLevels,
    nearestSupport,
    nearestResistance,
    candleConfirmation: detected,
    score,
  };
}

/** Find support levels (swing lows) */
function findPriceLevels(candles: Candle[]): { supports: number[]; resistances: number[] } {
  const supports: number[] = [];
  const resistances: number[] = [];
  const tolerance = BREAKOUT_CONFIG.levelTolerancePercent / 100;

  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    // Swing low: low is lower than neighbors
    if (c.low < candles[i - 1].low && c.low < candles[i - 2].low &&
      c.low < candles[i + 1].low && c.low < candles[i + 2].low) {
      if (!isNearExisting(supports, c.low, tolerance)) {
        supports.push(c.low);
      }
    }
    // Swing high: high is higher than neighbors
    if (c.high > candles[i - 1].high && c.high > candles[i - 2].high &&
      c.high > candles[i + 1].high && c.high > candles[i + 2].high) {
      if (!isNearExisting(resistances, c.high, tolerance)) {
        resistances.push(c.high);
      }
    }
  }

  return { supports, resistances };
}

function isNearExisting(levels: number[], price: number, tolerance: number): boolean {
  return levels.some((l) => Math.abs(l - price) / price < tolerance);
}

function findNearest(levels: number[], spot: number, direction: "ABOVE" | "BELOW"): number {
  if (levels.length === 0) return spot;
  const filtered = direction === "ABOVE"
    ? levels.filter((l) => l > spot)
    : levels.filter((l) => l < spot);
  if (filtered.length === 0) return spot;
  return filtered.reduce((closest, l) =>
    Math.abs(l - spot) < Math.abs(closest - spot) ? l : closest
  );
}

function countTouches(candles: Candle[], level: number, type: "support" | "resistance"): number {
  const tolerance = BREAKOUT_CONFIG.levelTolerancePercent / 100;
  return candles.filter((c) => {
    if (type === "support") {
      return Math.abs(c.low - level) / level < tolerance;
    }
    return Math.abs(c.high - level) / level < tolerance;
  }).length;
}

function emptyResult(): BreakoutResult {
  return {
    detected: false,
    direction: "NONE",
    breakoutPrice: 0,
    supportLevels: [],
    resistanceLevels: [],
    nearestSupport: 0,
    nearestResistance: 0,
    candleConfirmation: false,
    score: 0,
  };
}
