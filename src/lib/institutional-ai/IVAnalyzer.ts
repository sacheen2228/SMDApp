// ─── IVAnalyzer — Implied Volatility Analysis ─────────────────────
// Detects IV expansion, crush, and skew for sentiment signals.

import type { OptionData, IVResult } from "./types";
import { IV_CONFIG } from "./config";

/**
 * Analyze implied volatility across the option chain.
 * IV expansion = increasing uncertainty (bearish for longs).
 * IV crush = decreasing uncertainty (bullish for longs).
 * Put-IV > Call-IV = fear skew (bearish).
 */
export function analyzeIV(chain: OptionData[]): IVResult {
  let totalCallIV = 0;
  let totalPutIV = 0;
  let callCount = 0;
  let putCount = 0;

  for (const strike of chain) {
    if (strike.callIV > 0) { totalCallIV += strike.callIV; callCount++; }
    if (strike.putIV > 0) { totalPutIV += strike.putIV; putCount++; }
  }

  const averageCallIV = callCount > 0 ? totalCallIV / callCount : 0;
  const averagePutIV = putCount > 0 ? totalPutIV / putCount : 0;
  const ivSkew = averagePutIV - averageCallIV;

  // IV expansion/crush detection (compare near-ATM vs far strikes)
  const nearATM = chain.filter((s, _, arr) => {
    const avgStrike = arr.reduce((sum, x) => sum + x.strike, 0) / arr.length;
    return Math.abs(s.strike - avgStrike) / avgStrike < 0.03;
  });
  const farStrikes = chain.filter((s, _, arr) => {
    const avgStrike = arr.reduce((sum, x) => sum + x.strike, 0) / arr.length;
    return Math.abs(s.strike - avgStrike) / avgStrike >= 0.03;
  });

  const nearAvgIV = nearATM.length > 0
    ? nearATM.reduce((s, x) => s + (x.callIV + x.putIV) / 2, 0) / nearATM.length
    : 0;
  const farAvgIV = farStrikes.length > 0
    ? farStrikes.reduce((s, x) => s + (x.callIV + x.putIV) / 2, 0) / farStrikes.length
    : 0;

  const ivExpansion = nearAvgIV > farAvgIV * (1 + IV_CONFIG.expansionThresholdPercent / 100);
  const ivCrush = nearAvgIV < farAvgIV * (1 - IV_CONFIG.crushThresholdPercent / 100);

  // Score
  let score = 0;
  if (ivCrush) score += 30; // Good for option buyers
  if (ivExpansion) score -= 10; // Bad for option buyers
  if (Math.abs(ivSkew) > IV_CONFIG.skewThreshold) {
    score += ivSkew > 0 ? -10 : 10; // Put skew = bearish, call skew = bullish
  }
  score = Math.max(0, Math.min(100, score + 50));

  const details = [
    `Call IV: ${averageCallIV.toFixed(1)}% | Put IV: ${averagePutIV.toFixed(1)}%`,
    ivExpansion ? "IV expanding — rising uncertainty" : null,
    ivCrush ? "IV crushing — declining uncertainty" : null,
    Math.abs(ivSkew) > IV_CONFIG.skewThreshold
      ? `IV skew: ${ivSkew > 0 ? "Put" : "Call"} heavy (${ivSkew.toFixed(1)}%)`
      : null,
  ].filter(Boolean).join(" · ");

  return {
    averageCallIV,
    averagePutIV,
    ivExpansion,
    ivCrush,
    ivSkew,
    score,
    details,
  };
}
