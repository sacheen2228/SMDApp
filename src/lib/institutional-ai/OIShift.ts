// ─── OI Shift — Open Interest Migration Detection ─────────────────
// Detects when OI shifts from one strike to another (institutional movement).

import type { OptionData, OIShiftResult } from "./types";
import { OPTION_CONFIG } from "./config";

/**
 * Detect OI migration patterns — when open interest shifts from one
 * strike to an adjacent strike, indicating institutional repositioning.
 */
export function detectOIShift(chain: OptionData[], spotPrice: number): OIShiftResult {
  if (chain.length < 3) {
    return { detected: false, direction: "NONE", fromStrike: 0, toStrike: 0, magnitude: 0, score: 0, details: "Insufficient data" };
  }

  // Sort by strike
  const sorted = [...chain].sort((a, b) => a.strike - b.strike);

  let bestShift = { from: 0, to: 0, magnitude: 0, direction: "NONE" as "BULLISH" | "BEARISH" | "NONE" };

  for (let i = 0; i < sorted.length - 1; i++) {
    const curr = sorted[i];
    const next = sorted[i + 1];

    // Call OI shift: OI decreasing at lower strike, increasing at higher strike
    // = resistance moving up = bullish
    const callShiftUp = (curr.callOIChange < -OPTION_CONFIG.freshShortThreshold &&
      next.callOIChange > OPTION_CONFIG.freshLongThreshold);

    // Call OI shift down: OI increasing at lower strike, decreasing at higher
    // = resistance coming down = bearish
    const callShiftDown = (curr.callOIChange > OPTION_CONFIG.freshLongThreshold &&
      next.callOIChange < -OPTION_CONFIG.freshShortThreshold);

    // Put OI shift up: OI decreasing at lower strike, increasing at higher
    // = support moving up = bullish
    const putShiftUp = (curr.putOIChange < -OPTION_CONFIG.freshShortThreshold &&
      next.putOIChange > OPTION_CONFIG.freshLongThreshold);

    // Put OI shift down: OI increasing at lower strike, decreasing at higher
    // = support coming down = bearish
    const putShiftDown = (curr.putOIChange > OPTION_CONFIG.freshLongThreshold &&
      next.putOIChange < -OPTION_CONFIG.freshShortThreshold);

    const magnitude = Math.abs(curr.callOIChange - next.callOIChange) +
      Math.abs(curr.putOIChange - next.putOIChange);

    if ((callShiftUp || putShiftUp) && magnitude > bestShift.magnitude) {
      bestShift = { from: curr.strike, to: next.strike, magnitude, direction: "BULLISH" };
    }
    if ((callShiftDown || putShiftDown) && magnitude > bestShift.magnitude) {
      bestShift = { from: curr.strike, to: next.strike, magnitude, direction: "BEARISH" };
    }
  }

  const detected = bestShift.direction !== "NONE";
  const score = detected
    ? Math.min(100, Math.round(50 + (bestShift.magnitude / 10000) * 50))
    : 0;

  return {
    detected,
    direction: bestShift.direction,
    fromStrike: bestShift.from,
    toStrike: bestShift.to,
    magnitude: bestShift.magnitude,
    score,
    details: detected
      ? `OI shift ${bestShift.from} → ${bestShift.to} (${bestShift.direction})`
      : "No significant OI migration detected",
  };
}
