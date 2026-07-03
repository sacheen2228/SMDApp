// SDM Anti-Repaint Logic
// Prevents recommendation recalculation within the same 5-minute candle
// Safety overrides allow immediate updates on direction flips or trade closures

import type { SDMOptionStrike, SDMRecommendation } from "@/types/sdm";
import { generateRecommendation } from "./sdm-recommendation";

// ─── State (module-level, private) ───────────────────────────────
let lastCandleTime = 0;
let lastRecommendation: SDMRecommendation | null = null;
const CANDLE_INTERVAL = 5 * 60 * 1000; // 5 minutes in ms

// ─── Main Function ───────────────────────────────────────────────
export function getRecommendation(
  optionChain: SDMOptionStrike[],
  spotPrice: number,
  symbol: string,
  expiryDate: string,
  currentTime: Date,
  vix?: number,
  tradesTakenToday: number = 0,
  lastUpdate?: string,
  source: string = "simulation"
): SDMRecommendation {
  const nowMs = currentTime.getTime();
  const currentCandleStart =
    Math.floor(nowMs / CANDLE_INTERVAL) * CANDLE_INTERVAL;

  // First call ever — generate fresh
  if (lastCandleTime === 0) {
    const result = generateRecommendation(
      optionChain,
      spotPrice,
      symbol,
      expiryDate,
      currentTime,
      vix,
      tradesTakenToday,
      lastUpdate,
      source
    );
    lastCandleTime = currentCandleStart;
    lastRecommendation = result;
    return result;
  }

  // Same candle — return cached (anti-repaint)
  if (nowMs < lastCandleTime + CANDLE_INTERVAL && lastRecommendation) {
    return lastRecommendation;
  }

  // New candle — generate fresh
  const result = generateRecommendation(
    optionChain,
    spotPrice,
    symbol,
    expiryDate,
    currentTime,
    vix,
    tradesTakenToday,
    lastUpdate,
    source
  );

  // Safety: allow update if direction flipped or went to WAIT
  if (lastRecommendation) {
    const lastDir = lastRecommendation.direction;
    const newDir = result.direction;
    const directionChanged =
      (lastDir !== "WAIT" && newDir === "WAIT") ||
      (lastDir === "CALL" && newDir === "PUT") ||
      (lastDir === "PUT" && newDir === "CALL") ||
      (lastDir === "SELL_CALL" && newDir === "SELL_PUT") ||
      (lastDir === "SELL_PUT" && newDir === "SELL_CALL") ||
      (lastDir === "WAIT" && newDir !== "WAIT");

    if (!directionChanged && currentCandleStart === lastCandleTime) {
      // Same candle, no direction change — return cached
      return lastRecommendation;
    }
  }

  lastCandleTime = currentCandleStart;
  lastRecommendation = result;
  return result;
}

// ─── Force Reset ─────────────────────────────────────────────────
// Called when TP/SL hit or manual reset needed
export function forceReset(): void {
  lastCandleTime = 0;
  lastRecommendation = null;
}

// ─── Get Last Recommendation (no recalculation) ──────────────────
export function getLastRecommendation(): SDMRecommendation | null {
  return lastRecommendation;
}
