// ─── PCR — Put-Call Ratio Analysis ────────────────────────────────
// Calculates PCR from OI and volume, classifies market sentiment.

import type { OptionData, PCRResult } from "./types";
import { OPTION_CONFIG } from "./config";

/**
 * Calculate Put-Call Ratio from option chain data.
 * Uses OI-based PCR (more reliable than volume-based for sentiment).
 */
export function calculatePCR(chain: OptionData[]): PCRResult {
  let totalCallOI = 0;
  let totalPutOI = 0;
  let totalCallVolume = 0;
  let totalPutVolume = 0;

  for (const strike of chain) {
    totalCallOI += strike.callOI;
    totalPutOI += strike.putOI;
    totalCallVolume += strike.callVolume;
    totalPutVolume += strike.putVolume;
  }

  const oiPCR = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;
  const volPCR = totalCallVolume > 0 ? totalPutVolume / totalCallVolume : 1;
  // Weight OI PCR 70%, volume PCR 30%
  const value = oiPCR * 0.7 + volPCR * 0.3;

  let classification: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  let score = 0;
  let details = "";

  if (value >= OPTION_CONFIG.pcrBullish) {
    classification = "BULLISH";
    // High PCR = heavy put buying = bullish (contrarian)
    score = Math.min(100, Math.round(50 + (value - 1) * 100));
    details = `PCR ${value.toFixed(2)} — heavy put activity, contrarian bullish`;
  } else if (value <= OPTION_CONFIG.pcrBearish) {
    classification = "BEARISH";
    // Low PCR = heavy call buying = bearish (contrarian)
    score = Math.min(100, Math.round(50 + (1 - value) * 100));
    details = `PCR ${value.toFixed(2)} — heavy call activity, contrarian bearish`;
  } else {
    classification = "NEUTRAL";
    score = 20;
    details = `PCR ${value.toFixed(2)} — balanced activity`;
  }

  return { value, classification, score, details };
}
