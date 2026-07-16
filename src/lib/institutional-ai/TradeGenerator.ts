// ─── TradeGenerator — Direction + Confidence Synthesis ──────────────
// The engine receives a SPOT price (not an option premium), so it cannot
// compute meaningful premium SL/TP here. Instead it synthesizes a clean
// directional signal with confidence + reasoning. The downstream scanner
// (intraday-scanner.ts → monthlyOptionTrade) builds the actual option
// trade with premium-based SL/TP.

import type { TradeSignal, AnalysisContext, ConfidenceScores } from "./types";
import { TRADE_CONFIG } from "./config";

/**
 * Synthesize a trade signal from confidence analysis.
 * Returns direction, confidence, and human-readable reasons.
 */
export function generateTrade(
  direction: "BUY" | "SELL" | "NO_TRADE",
  confidence: number,
  scores: ConfidenceScores,
  ctx: AnalysisContext
): TradeSignal {
  if (direction === "NO_TRADE" || confidence < TRADE_CONFIG.noTradeConfidence) {
    return noTrade(direction, confidence, scores, ctx, "Confidence below actionable threshold");
  }

  const reasons: string[] = [];
  const warnings: string[] = [];

  // Build reasons
  if (scores.breakoutScore >= 15) reasons.push("Strong breakout confirmation");
  if (scores.trendScore >= 10) reasons.push("Trend aligned with direction");
  if (scores.volumeScore >= 7) reasons.push("Volume confirms move");
  if (scores.putWritingScore >= 7) reasons.push("Put writing = institutional support");
  if (scores.callWritingScore >= 7) reasons.push("Call writing = institutional resistance");
  if (scores.oiShiftScore >= 3) reasons.push("OI migration detected");
  if (scores.liquidityScore >= 10) reasons.push("Strong OI liquidity at levels");

  // Build warnings
  if (ctx.iv.ivExpansion) warnings.push("IV expanding — premium inflated");
  if (ctx.volume.volumeSpike) warnings.push("Volume spike — possible news-driven");
  if (scores.breakoutScore < 10) warnings.push("Weak breakout confirmation");
  if (confidence < TRADE_CONFIG.minConfidence) warnings.push("Moderate confidence — partial size recommended");

  const probability = Math.min(95, Math.max(5, Math.round(confidence * 0.9)));

  return {
    direction,
    confidence,
    entry: 0,
    stopLoss: 0,
    target1: 0,
    target2: 0,
    target3: 0,
    breakoutScore: scores.breakoutScore,
    trendScore: scores.trendScore,
    volumeScore: scores.volumeScore,
    optionScore: scores.callWritingScore + scores.putWritingScore,
    liquidityScore: scores.liquidityScore,
    probability,
    reasons,
    warnings,
  };
}

function noTrade(
  direction: "BUY" | "SELL" | "NO_TRADE",
  confidence: number,
  scores: ConfidenceScores,
  ctx: AnalysisContext,
  reason: string
): TradeSignal {
  return {
    direction: "NO_TRADE",
    confidence,
    entry: 0,
    stopLoss: 0,
    target1: 0,
    target2: 0,
    target3: 0,
    breakoutScore: scores.breakoutScore,
    trendScore: scores.trendScore,
    volumeScore: scores.volumeScore,
    optionScore: scores.callWritingScore + scores.putWritingScore,
    liquidityScore: scores.liquidityScore,
    probability: 0,
    reasons: [reason],
    warnings: ["Trade rejected by AI confidence filter"],
  };
}
