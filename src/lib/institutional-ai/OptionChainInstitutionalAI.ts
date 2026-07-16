// ─── OptionChainInstitutionalAI — Main Orchestrator ───────────────
// Entry point for the institutional breakout prediction engine.
// Wires all analysis modules together and produces a TradeSignal.

import type { Input, TradeSignal, AnalysisContext } from "./types";
import { detectBreakout } from "./BreakoutDetector";
import { analyzeOptionChain } from "./OptionAnalyzer";
import { calculatePCR } from "./PCR";
import { analyzeMaxOI } from "./MaxOI";
import { detectOIShift } from "./OIShift";
import { analyzeVolume } from "./VolumeAnalyzer";
import { analyzeIV } from "./IVAnalyzer";
import { analyzeTrend } from "./TrendAnalyzer";
import { calculateConfidence, resolveDirection, isTradeable } from "./ConfidenceEngine";
import { generateTrade } from "./TradeGenerator";

/**
 * Institutional AI engine for stock option day trading.
 *
 * Analyzes candle data + option chain to predict whether a support/resistance
 * breakout will CONTINUE or FAIL. Returns a trade signal with confidence,
 * entry, SL, and targets.
 *
 * @example
 * ```ts
 * const ai = new OptionChainInstitutionalAI();
 * const signal = ai.analyze({
 *   candles: [...],
 *   optionChain: [...],
 *   spotPrice: 2850,
 * });
 * if (signal.direction !== "NO_TRADE") {
 *   console.log(`${signal.direction} @ ${signal.entry} SL ${signal.stopLoss}`);
 * }
 * ```
 */
export class OptionChainInstitutionalAI {
  /**
   * Run the full analysis pipeline and return a trade signal.
   */
  analyze(input: Input): TradeSignal {
    // Validate input
    if (!input.candles.length || !input.optionChain.length || input.spotPrice <= 0) {
      return this.emptySignal("Insufficient input data");
    }

    // Step 1: Breakout detection
    const breakout = detectBreakout(input.candles, input.spotPrice);

    // Step 2: Option chain analysis
    const optionAnalysis = analyzeOptionChain(input.optionChain, input.spotPrice);

    // Step 3: PCR
    const pcr = calculatePCR(input.optionChain);

    // Step 4: Max OI
    const maxOI = analyzeMaxOI(input.optionChain, input.spotPrice);

    // Step 5: OI Shift
    const oiShift = detectOIShift(input.optionChain, input.spotPrice);

    // Step 6: Volume
    const volume = analyzeVolume(input.optionChain, input.candles);

    // Step 7: IV
    const iv = analyzeIV(input.optionChain);

    // Step 8: Trend
    const trend = analyzeTrend(input.candles);

    // Build analysis context
    const ctx: AnalysisContext = {
      input,
      breakout,
      optionAnalysis,
      pcr,
      maxOI,
      oiShift,
      volume,
      iv,
      trendScore: trend.score,
    };

    // Step 9: Confidence engine
    const scores = calculateConfidence(ctx);

    // Step 10: Direction resolution
    const direction = resolveDirection(ctx);

    // Step 11: Trade generation — direction + confidence synthesis.
    // The engine only receives a spot price, so premium SL/TP is built
    // downstream by the scanner. We return direction + confidence + reasons.
    return generateTrade(direction, scores.total, scores, ctx);
  }

  /**
   * Quick analysis returning only confidence and direction (no trade levels).
   */
  quickAnalyze(input: Input): { direction: "BUY" | "SELL" | "NO_TRADE"; confidence: number; reasons: string[] } {
    const signal = this.analyze(input);
    return {
      direction: signal.direction,
      confidence: signal.confidence,
      reasons: signal.reasons,
    };
  }

  private emptySignal(reason: string): TradeSignal {
    return {
      direction: "NO_TRADE",
      confidence: 0,
      entry: 0,
      stopLoss: 0,
      target1: 0,
      target2: 0,
      target3: 0,
      breakoutScore: 0,
      trendScore: 0,
      volumeScore: 0,
      optionScore: 0,
      liquidityScore: 0,
      probability: 0,
      reasons: [reason],
      warnings: ["Insufficient data for analysis"],
    };
  }
}
