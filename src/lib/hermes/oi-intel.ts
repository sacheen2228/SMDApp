// Hermes OI Intelligence — OI pattern interpretation for trade decisions
// Wraps existing sdm-oianalysis.ts functions.

import type { HermesContext, OptionChainData, Direction } from "./types";

// ── OI Intelligence ────────────────────────────────────────────────────

export interface OIIntelligence {
  callWriting: boolean;
  putWriting: boolean;
  callUnwinding: boolean;
  putUnwinding: boolean;
  longBuildup: boolean;
  shortBuildup: boolean;
  shortCovering: boolean;
  longUnwinding: boolean;
  pcrInterpretation: string;
  oiBias: Direction;
  supportFromOI: number;
  resistanceFromOI: number;
  freshWritingSignals: string[];
  traps: string[];
  confidence: number;
  factors: string[];
  warnings: string[];
}

export function analyzeOIIntelligence(ctx: HermesContext): OIIntelligence {
  const chain = ctx.optionChain.value;
  if (!chain) {
    return emptyOIIntelligence();
  }

  const spot = chain.spot || ctx.spot.value?.price || 0;
  const factors: string[] = [];
  const warnings: string[] = [];
  const freshWritingSignals: string[] = [];
  const traps: string[] = [];

  // PCR interpretation
  const pcr = chain.pcrOI;
  let pcrInterpretation = "NEUTRAL";
  if (pcr == null) pcrInterpretation = "N/A";
  else if (pcr > 1.5) pcrInterpretation = "VERY_BULLISH";
  else if (pcr > 1.2) pcrInterpretation = "BULLISH";
  else if (pcr > 0.8) pcrInterpretation = "NEUTRAL";
  else if (pcr > 0.5) pcrInterpretation = "BEARISH";
  else pcrInterpretation = "VERY_BEARISH";

  if (pcr == null) factors.push("PCR OI: N/A");
  else factors.push(`PCR OI: ${pcr.toFixed(2)} (${pcrInterpretation})`);

  // OI change analysis
  const callOiChg = chain.callOiChange;
  const putOiChg = chain.putOiChange;

  // Call writing = call OI increases + spot below strike = bearish
  const callWriting = callOiChg > 0 && Math.abs(callOiChg) > Math.abs(putOiChg) * 1.2;
  // Put writing = put OI increases + spot above strike = bullish
  const putWriting = putOiChg > 0 && Math.abs(putOiChg) > Math.abs(callOiChg) * 1.2;
  // Call unwinding = call OI decreases = potentially bullish
  const callUnwinding = callOiChg < 0 && Math.abs(callOiChg) > chain.totalCallOI * 0.02;
  // Put unwinding = put OI decreases = potentially bearish
  const putUnwinding = putOiChg < 0 && Math.abs(putOiChg) > chain.totalPutOI * 0.02;

  if (callWriting) {
    factors.push("Call writing detected — resistance building");
    freshWritingSignals.push("Call writing");
  }
  if (putWriting) {
    factors.push("Put writing detected — support building");
    freshWritingSignals.push("Put writing");
  }
  if (callUnwinding) {
    factors.push("Call unwinding — bearish positions closing");
    freshWritingSignals.push("Call unwinding");
  }
  if (putUnwinding) {
    factors.push("Put unwinding — bullish positions closing");
    freshWritingSignals.push("Put unwinding");
  }

  // Buildup classification
  const longBuildup = putWriting && spot > 0;
  const shortBuildup = callWriting && spot > 0;
  const shortCovering = callUnwinding && spot > 0;
  const longUnwinding = putUnwinding && spot > 0;

  if (longBuildup) factors.push("Long buildup — put writing + bullish flow");
  if (shortBuildup) factors.push("Short buildup — call writing + bearish flow");
  if (shortCovering) factors.push("Short covering — call unwinding");
  if (longUnwinding) factors.push("Long unwinding — put unwinding");

  // OI-based support/resistance
  const supportFromOI = chain.putWall || chain.maxPain * 0.99;
  const resistanceFromOI = chain.callWall || chain.maxPain * 1.01;

  if (supportFromOI > 0) factors.push(`OI support: ₹${supportFromOI.toLocaleString("en-IN")}`);
  if (resistanceFromOI > 0) factors.push(`OI resistance: ₹${resistanceFromOI.toLocaleString("en-IN")}`);

  // Trap detection (simplified)
  if (spot > 0 && chain.callWall > 0 && spot > chain.callWall) {
    traps.push("Call writers trapped — potential short squeeze");
  }
  if (spot > 0 && chain.putWall > 0 && spot < chain.putWall) {
    traps.push("Put writers trapped — potential long unwinding");
  }

  // Overall OI bias
  let oiBias: Direction = "NEUTRAL";
  let confidence = 50;

  if (putWriting && !callWriting) {
    oiBias = "BULLISH";
    confidence = 65;
  } else if (callWriting && !putWriting) {
    oiBias = "BEARISH";
    confidence = 65;
  } else if (longBuildup) {
    oiBias = "BULLISH";
    confidence = 60;
  } else if (shortBuildup) {
    oiBias = "BEARISH";
    confidence = 60;
  } else if (pcr != null && pcr > 1.2) {
    oiBias = "BULLISH";
    confidence = 55;
  } else if (pcr != null && pcr < 0.8) {
    oiBias = "BEARISH";
    confidence = 55;
  }

  // Warnings
  if (pcr != null && pcr > 2.0) warnings.push("PCR extremely high — potential reversal");
  if (pcr != null && pcr < 0.3) warnings.push("PCR extremely low — potential reversal");
  if (Math.abs(callOiChg) > chain.totalCallOI * 0.1) warnings.push("Large OI change — verify data freshness");
  if (chain.totalCallOI === 0 && chain.totalPutOI === 0) warnings.push("OI data unavailable");

  return {
    callWriting,
    putWriting,
    callUnwinding,
    putUnwinding,
    longBuildup,
    shortBuildup,
    shortCovering,
    longUnwinding,
    pcrInterpretation,
    oiBias,
    supportFromOI,
    resistanceFromOI,
    freshWritingSignals,
    traps,
    confidence,
    factors,
    warnings,
  };
}

function emptyOIIntelligence(): OIIntelligence {
  return {
    callWriting: false, putWriting: false, callUnwinding: false, putUnwinding: false,
    longBuildup: false, shortBuildup: false, shortCovering: false, longUnwinding: false,
    pcrInterpretation: "UNKNOWN", oiBias: "NEUTRAL",
    supportFromOI: 0, resistanceFromOI: 0,
    freshWritingSignals: [], traps: [],
    confidence: 0, factors: ["OI data unavailable"], warnings: ["No option chain data"],
  };
}
