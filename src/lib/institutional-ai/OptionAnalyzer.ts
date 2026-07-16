// ─── OptionAnalyzer — Option Chain Activity Classification ─────────
// Classifies each strike's OI/volume activity into institutional
// patterns: writing, short covering, unwinding, fresh positions.

import type { OptionData, OptionActivityResult, OptionAnalysisResult, OptionActivity } from "./types";
import { OPTION_CONFIG } from "./config";

/**
 * Analyze the full option chain and classify activity at each strike.
 * Returns per-strike classifications and aggregate scores.
 */
export function analyzeOptionChain(
  chain: OptionData[],
  spotPrice: number
): OptionAnalysisResult {
  const activities: OptionActivityResult[] = [];

  for (const strike of chain) {
    const result = classifyStrikeActivity(strike, spotPrice);
    if (result.activity !== "NEUTRAL") {
      activities.push(result);
    }
  }

  const callWritingScore = aggregateScore(activities, "CALL_WRITING");
  const putWritingScore = aggregateScore(activities, "PUT_WRITING");
  const shortCoveringScore =
    aggregateScore(activities, "CALL_SHORT_COVERING") +
    aggregateScore(activities, "PUT_SHORT_COVERING");
  const unwindingScore =
    aggregateScore(activities, "CALL_UNWINDING") +
    aggregateScore(activities, "PUT_UNWINDING");
  const freshLongScore = aggregateScore(activities, "FRESH_LONG");
  const freshShortScore = aggregateScore(activities, "FRESH_SHORT");

  // Overall bias: put writing = bullish, call writing = bearish
  const bullishScore = putWritingScore + shortCoveringScore + freshLongScore;
  const bearishScore = callWritingScore + unwindingScore + freshShortScore;

  let overallBias: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  let biasStrength = 0;
  if (bullishScore > bearishScore && bullishScore > 10) {
    overallBias = "BULLISH";
    biasStrength = Math.min(100, bullishScore);
  } else if (bearishScore > bullishScore && bearishScore > 10) {
    overallBias = "BEARISH";
    biasStrength = Math.min(100, bearishScore);
  }

  return {
    activities,
    callWritingScore: Math.min(100, callWritingScore),
    putWritingScore: Math.min(100, putWritingScore),
    shortCoveringScore: Math.min(100, shortCoveringScore),
    unwindingScore: Math.min(100, unwindingScore),
    freshLongScore: Math.min(100, freshLongScore),
    freshShortScore: Math.min(100, freshShortScore),
    overallBias,
    biasStrength,
  };
}

/** Classify activity at a single strike based on OI change and price direction */
function classifyStrikeActivity(
  strike: OptionData,
  spotPrice: number
): OptionActivityResult {
  const { callOI, putOI, callOIChange, putOIChange, callVolume, putVolume } = strike;
  const isAboveSpot = strike.strike > spotPrice;
  const oiThreshold = Math.max(1000, (callOI + putOI) * OPTION_CONFIG.oiChangeThresholdPercent / 100);

  // Call Writing: call OI increasing (writers adding), price at/below strike
  if (callOIChange > oiThreshold) {
    const confidence = Math.min(100, 50 + (callOIChange / Math.max(1, callOI)) * 50);
    return {
      strike: strike.strike,
      activity: "CALL_WRITING",
      confidence,
      details: `Call OI +${callOIChange.toLocaleString()} @ ${strike.strike} — writers defending resistance`,
    };
  }

  // Put Writing: put OI increasing (writers adding), price at/above strike
  if (putOIChange > oiThreshold) {
    const confidence = Math.min(100, 50 + (putOIChange / Math.max(1, putOI)) * 50);
    return {
      strike: strike.strike,
      activity: "PUT_WRITING",
      confidence,
      details: `Put OI +${putOIChange.toLocaleString()} @ ${strike.strike} — writers defending support`,
    };
  }

  // Call Short Covering: call OI decreasing, price rising (shorts exiting)
  if (callOIChange < -oiThreshold && isAboveSpot) {
    const confidence = Math.min(100, 50 + Math.abs(callOIChange / Math.max(1, callOI)) * 50);
    return {
      strike: strike.strike,
      activity: "CALL_SHORT_COVERING",
      confidence,
      details: `Call OI ${callOIChange.toLocaleString()} @ ${strike.strike} — shorts covering`,
    };
  }

  // Put Short Covering: put OI decreasing, price falling (shorts exiting)
  if (putOIChange < -oiThreshold && !isAboveSpot) {
    const confidence = Math.min(100, 50 + Math.abs(putOIChange / Math.max(1, putOI)) * 50);
    return {
      strike: strike.strike,
      activity: "PUT_SHORT_COVERING",
      confidence,
      details: `Put OI ${putOIChange.toLocaleString()} @ ${strike.strike} — shorts covering`,
    };
  }

  // Put Unwinding: put OI decreasing, price falling (longs exiting)
  if (putOIChange < -oiThreshold && isAboveSpot) {
    const confidence = Math.min(100, 50 + Math.abs(putOIChange / Math.max(1, putOI)) * 50);
    return {
      strike: strike.strike,
      activity: "PUT_UNWINDING",
      confidence,
      details: `Put OI ${putOIChange.toLocaleString()} @ ${strike.strike} — longs unwinding`,
    };
  }

  // Call Unwinding: call OI decreasing, price falling (longs exiting)
  if (callOIChange < -oiThreshold && !isAboveSpot) {
    const confidence = Math.min(100, 50 + Math.abs(callOIChange / Math.max(1, callOI)) * 50);
    return {
      strike: strike.strike,
      activity: "CALL_UNWINDING",
      confidence,
      details: `Call OI ${callOIChange.toLocaleString()} @ ${strike.strike} — longs unwinding`,
    };
  }

  // Fresh Long: both OI increasing with high volume (new positions)
  if (callOIChange > oiThreshold / 2 && putOIChange > oiThreshold / 2) {
    if (callVolume > putVolume * 1.5) {
      return {
        strike: strike.strike,
        activity: "FRESH_LONG",
        confidence: 60,
        details: `Fresh long buildup @ ${strike.strike} — call volume dominant`,
      };
    }
    if (putVolume > callVolume * 1.5) {
      return {
        strike: strike.strike,
        activity: "FRESH_SHORT",
        confidence: 60,
        details: `Fresh short buildup @ ${strike.strike} — put volume dominant`,
      };
    }
  }

  return {
    strike: strike.strike,
    activity: "NEUTRAL",
    confidence: 0,
    details: "No significant activity",
  };
}

function aggregateScore(activities: OptionActivityResult[], type: OptionActivity): number {
  return activities
    .filter((a) => a.activity === type)
    .reduce((sum, a) => sum + a.confidence, 0);
}
