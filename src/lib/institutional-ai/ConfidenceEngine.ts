// ─── ConfidenceEngine — Weighted AI Confidence Scoring ─────────────
// Combines all analysis modules into a single 0-100 confidence score.

import type { AnalysisContext, ConfidenceScores } from "./types";
import { CONFIDENCE_WEIGHTS, MIN_CONFIDENCE } from "./config";

/**
 * Calculate total confidence from all analysis components.
 * Each component is scored 0-100, then weighted per CONFIDENCE_WEIGHTS.
 */
export function calculateConfidence(ctx: AnalysisContext): ConfidenceScores {
  // Breakout score (0-20)
  const breakoutScore = Math.round(
    (ctx.breakout.score / 100) * CONFIDENCE_WEIGHTS.breakout
  );

  // Trend score (0-15)
  const trendScore = Math.round(
    (ctx.trendScore / 100) * CONFIDENCE_WEIGHTS.trend
  );

  // Liquidity = max OI score (0-15)
  const liquidityScore = Math.round(
    (ctx.maxOI.score / 100) * CONFIDENCE_WEIGHTS.liquidity
  );

  // Volume score (0-10)
  const volumeScore = Math.round(
    (ctx.volume.score / 100) * CONFIDENCE_WEIGHTS.volume
  );

  // Call writing (bearish signal, 0-10)
  const callWritingScore = Math.round(
    (ctx.optionAnalysis.callWritingScore / 100) * CONFIDENCE_WEIGHTS.callWriting
  );

  // Put writing (bullish signal, 0-10)
  const putWritingScore = Math.round(
    (ctx.optionAnalysis.putWritingScore / 100) * CONFIDENCE_WEIGHTS.putWriting
  );

  // PCR (0-5)
  const pcrScore = Math.round(
    (ctx.pcr.score / 100) * CONFIDENCE_WEIGHTS.pcr
  );

  // IV (0-5)
  const ivScore = Math.round(
    (ctx.iv.score / 100) * CONFIDENCE_WEIGHTS.iv
  );

  // OI Shift (0-5)
  const oiShiftScore = Math.round(
    (ctx.oiShift.score / 100) * CONFIDENCE_WEIGHTS.oiShift
  );

  // Max OI (0-5)
  const maxOIScore = Math.round(
    (ctx.maxOI.score / 100) * CONFIDENCE_WEIGHTS.maxOI
  );

  const total = breakoutScore + trendScore + liquidityScore + volumeScore +
    callWritingScore + putWritingScore + pcrScore + ivScore + oiShiftScore + maxOIScore;

  return {
    breakoutScore,
    trendScore,
    liquidityScore,
    volumeScore,
    callWritingScore,
    putWritingScore,
    pcrScore,
    ivScore,
    oiShiftScore,
    maxOIScore,
    total: Math.min(100, total),
  };
}

/**
 * Check if confidence meets the minimum threshold for a trade.
 */
export function isTradeable(confidence: number): boolean {
  return confidence >= MIN_CONFIDENCE;
}

/**
 * Determine trade direction from breakout and option analysis alignment.
 * Requires breakout direction + option chain confirmation.
 */
export function resolveDirection(ctx: AnalysisContext): "BUY" | "SELL" | "NO_TRADE" {
  const breakoutDir = ctx.breakout.direction;
  const optionBias = ctx.optionAnalysis.overallBias;

  // BUY: bullish breakout + bullish option activity
  if (breakoutDir === "BULLISH" && (optionBias === "BULLISH" || optionBias === "NEUTRAL")) {
    return "BUY";
  }

  // SELL: bearish breakdown + bearish option activity
  if (breakoutDir === "BEARISH" && (optionBias === "BEARISH" || optionBias === "NEUTRAL")) {
    return "SELL";
  }

  // Breakout + conflicting option signal = NO_TRADE (fake breakout risk)
  if (breakoutDir !== "NONE" && optionBias !== "NEUTRAL" && optionBias !== breakoutDir) {
    return "NO_TRADE";
  }

  // No breakout detected
  return "NO_TRADE";
}
