// ─── AI Scanner Adapter ───────────────────────────────────────────
// Converts scanner data format → OptionChainInstitutionalAI input format.
// Bridges the gap between the scanner's SDMOptionStrike[] and the AI
// engine's OptionData[] + Candle[] types.

import type { SDMOptionStrike } from "@/types/sdm";
import type { Candle, OptionData, Input, TradeSignal } from "@/lib/institutional-ai/types";
import { OptionChainInstitutionalAI } from "@/lib/institutional-ai";

/**
 * Convert scanner's SDMOptionStrike[] → AI engine's OptionData[].
 * Maps CE/PE OI, volume, and IV fields.
 */
export function toOptionData(chain: SDMOptionStrike[]): OptionData[] {
  return chain
    .filter((s) => s.ce || s.pe)
    .map((s) => ({
      strike: s.strike,
      callOI: s.ce?.oi ?? 0,
      putOI: s.pe?.oi ?? 0,
      callOIChange: s.ce?.oiChg ?? 0,
      putOIChange: s.pe?.oiChg ?? 0,
      callVolume: s.ce?.volume ?? 0,
      putVolume: s.pe?.volume ?? 0,
      callIV: s.ce?.iv ?? 0,
      putIV: s.pe?.iv ?? 0,
    }));
}

/**
 * Convert Yahoo Finance candle array → AI engine's Candle[].
 * Yahoo candles already have time, open, high, low, close, volume.
 */
export function toCandles(yahooCandles: { time: number; open: number; high: number; low: number; close: number; volume: number }[]): Candle[] {
  return yahooCandles.map((c) => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

/**
 * Build AI engine Input from scanner data.
 * @param candles  Per-stock candles (3mo daily from Yahoo Finance)
 * @param optionChain  NIFTY index option chain (market context)
 * @param spotPrice  Stock's current price
 */
export function buildAIInput(
  candles: Candle[],
  optionChain: SDMOptionStrike[],
  spotPrice: number
): Input {
  return {
    candles,
    optionChain: toOptionData(optionChain),
    spotPrice,
  };
}

/**
 * Run the AI engine on a single stock candidate.
 * Returns the TradeSignal with direction, confidence, and reasons.
 * If insufficient data, returns NO_TRADE with confidence 0.
 */
const aiEngine = new OptionChainInstitutionalAI();

export function runAIOnCandidate(
  candles: Candle[],
  optionChain: SDMOptionStrike[],
  spotPrice: number
): TradeSignal {
  if (!candles.length || !optionChain.length || spotPrice <= 0) {
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
      reasons: ["Insufficient data for AI analysis"],
      warnings: [],
    };
  }

  const input = buildAIInput(candles, optionChain, spotPrice);
  return aiEngine.analyze(input);
}
