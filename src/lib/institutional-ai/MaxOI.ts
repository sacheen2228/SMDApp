// ─── MaxOI — Maximum Open Interest Analysis ───────────────────────
// Finds highest call/put OI strikes, nearest S/R, and max pain.

import type { OptionData, MaxOIResult } from "./types";

/**
 * Analyze maximum OI strikes to find institutional positioning.
 * Highest call OI = resistance, highest put OI = support.
 */
export function analyzeMaxOI(chain: OptionData[], spotPrice: number): MaxOIResult {
  if (chain.length === 0) {
    return {
      highestCallOI: { strike: 0, oi: 0 },
      highestPutOI: { strike: 0, oi: 0 },
      nearestResistance: spotPrice,
      nearestSupport: spotPrice,
      maxPain: spotPrice,
      score: 0,
    };
  }

  let highestCallOI = { strike: 0, oi: 0 };
  let highestPutOI = { strike: 0, oi: 0 };

  for (const strike of chain) {
    if (strike.callOI > highestCallOI.oi) {
      highestCallOI = { strike: strike.strike, oi: strike.callOI };
    }
    if (strike.putOI > highestPutOI.oi) {
      highestPutOI = { strike: strike.strike, oi: strike.putOI };
    }
  }

  // Nearest resistance = lowest strike above spot with high call OI
  const resistanceCandidates = chain
    .filter((s) => s.strike > spotPrice && s.callOI > 0)
    .sort((a, b) => a.strike - b.strike);
  const nearestResistance = resistanceCandidates.length > 0
    ? resistanceCandidates[0].strike
    : highestCallOI.strike || spotPrice;

  // Nearest support = highest strike below spot with high put OI
  const supportCandidates = chain
    .filter((s) => s.strike < spotPrice && s.putOI > 0)
    .sort((a, b) => b.strike - a.strike);
  const nearestSupport = supportCandidates.length > 0
    ? supportCandidates[0].strike
    : highestPutOI.strike || spotPrice;

  // Max pain: strike where total OI (call + put) is highest
  const maxPain = computeMaxPain(chain);

  // Score: how clear the levels are (big OI difference = stronger levels)
  const totalOI = chain.reduce((s, c) => s + c.callOI + c.putOI, 0);
  const topConcentration = (highestCallOI.oi + highestPutOI.oi) / Math.max(1, totalOI);
  const score = Math.min(100, Math.round(topConcentration * 200));

  return {
    highestCallOI,
    highestPutOI,
    nearestResistance,
    nearestSupport,
    maxPain,
    score,
  };
}

/** Max pain = strike at which total option-writer payout is minimized.
 *  For each candidate strike K, sum over all strikes S of:
 *    call OI at S × max(0, S − K)  +  put OI at S × max(0, K − S)
 *  The strike minimizing this aggregate loss is the max-pain strike. */
function computeMaxPain(chain: OptionData[]): number {
  if (chain.length === 0) return 0;

  let maxPainStrike = chain[0].strike;
  let minPayout = Infinity;

  for (const k of chain) {
    let totalPayout = 0;
    for (const s of chain) {
      if (s.callOI > 0) totalPayout += s.callOI * Math.max(0, s.strike - k.strike);
      if (s.putOI > 0) totalPayout += s.putOI * Math.max(0, k.strike - s.strike);
    }
    if (totalPayout < minPayout) {
      minPayout = totalPayout;
      maxPainStrike = k.strike;
    }
  }

  return maxPainStrike;
}
