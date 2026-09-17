// Hermes Flow Intelligence — FII/DII + Participant OI interpretation
// Wraps existing fii-dii.ts data.

import type { HermesContext, FIIDIIData, Direction, FlowBias } from "./types";

// ── Flow Intelligence ──────────────────────────────────────────────────

export interface FlowIntelligence {
  fiiBias: Direction;
  diiBias: Direction;
  combinedBias: Direction;
  flowType: FlowBias;
  participantInterpretation: string;
  fiiIndexLongShort: number;
  diiIndexLongShort: number;
  clientPositioning: string;
  confidence: number;
  factors: string[];
  warnings: string[];
}

export function analyzeFlowIntelligence(ctx: HermesContext): FlowIntelligence {
  const fiiDII = ctx.fiiDII.value;

  const factors: string[] = [];
  const warnings: string[] = [];

  if (!fiiDII) {
    return emptyFlowIntelligence();
  }

  const fiiNet = fiiDII.fiiNet;
  const diiNet = fiiDII.diiNet;

  // FII bias
  let fiiBias: Direction = "NEUTRAL";
  if (fiiNet > 500) {
    fiiBias = "BULLISH";
    factors.push(`FII strong buying: +₹${fiiNet.toFixed(0)} Cr`);
  } else if (fiiNet > 100) {
    fiiBias = "BULLISH";
    factors.push(`FII buying: +₹${fiiNet.toFixed(0)} Cr`);
  } else if (fiiNet < -500) {
    fiiBias = "BEARISH";
    factors.push(`FII strong selling: ₹${fiiNet.toFixed(0)} Cr`);
  } else if (fiiNet < -100) {
    fiiBias = "BEARISH";
    factors.push(`FII selling: ₹${fiiNet.toFixed(0)} Cr`);
  } else {
    factors.push(`FII neutral: ₹${fiiNet.toFixed(0)} Cr`);
  }

  // DII bias
  let diiBias: Direction = "NEUTRAL";
  if (diiNet > 500) {
    diiBias = "BULLISH";
    factors.push(`DII strong buying: +₹${diiNet.toFixed(0)} Cr`);
  } else if (diiNet > 100) {
    diiBias = "BULLISH";
    factors.push(`DII buying: +₹${diiNet.toFixed(0)} Cr`);
  } else if (diiNet < -500) {
    diiBias = "BEARISH";
    factors.push(`DII selling: ₹${diiNet.toFixed(0)} Cr`);
  } else if (diiNet < -100) {
    diiBias = "BEARISH";
    factors.push(`DII selling: ₹${diiNet.toFixed(0)} Cr`);
  } else {
    factors.push(`DII neutral: ₹${diiNet.toFixed(0)} Cr`);
  }

  // Combined bias
  let combinedBias: Direction = "NEUTRAL";
  if (fiiBias === "BULLISH" && diiBias === "BULLISH") combinedBias = "BULLISH";
  else if (fiiBias === "BEARISH" && diiBias === "BEARISH") combinedBias = "BEARISH";
  else if (fiiBias !== diiBias && fiiBias !== "NEUTRAL" && diiBias !== "NEUTRAL") combinedBias = "CONFLICTED";

  // Flow type classification
  let flowType: FlowBias = "NEUTRAL_FLOW";
  if (fiiNet > 200 && diiNet > 200) flowType = "BULLISH_FLOW";
  else if (fiiNet < -200 && diiNet < -200) flowType = "BEARISH_FLOW";
  else if (Math.abs(fiiNet) > 200 || Math.abs(diiNet) > 200) flowType = "MIXED_FLOW";

  // Participant OI interpretation
  let participantInterpretation = "No participant OI data";
  let fiiIndexLongShort = 0;
  let diiIndexLongShort = 0;
  let clientPositioning = "Unknown";

  const poi = fiiDII.participantOI;
  if (poi) {
    fiiIndexLongShort = (poi.fii?.indexLong || 0) - (poi.fii?.indexShort || 0);
    diiIndexLongShort = (poi.dii?.indexLong || 0) - (poi.dii?.indexShort || 0);

    const fiiNetOI = (poi.fii?.totalLong || 0) - (poi.fii?.totalShort || 0);
    const diiNetOI = (poi.dii?.totalLong || 0) - (poi.dii?.totalShort || 0);
    const clientNetOI = (poi.client?.totalLong || 0) - (poi.client?.totalShort || 0);

    participantInterpretation = `FII: ${fiiNetOI > 0 ? "LONG" : "SHORT"} (${fiiNetOI > 0 ? "+" : ""}${fiiNetOI}), ` +
      `DII: ${diiNetOI > 0 ? "LONG" : "SHORT"} (${diiNetOI > 0 ? "+" : ""}${diiNetOI})`;

    if (clientNetOI > 0) clientPositioning = "LONG";
    else if (clientNetOI < 0) clientPositioning = "SHORT";
    else clientPositioning = "NEUTRAL";

    factors.push(participantInterpretation);
    factors.push(`Client positioning: ${clientPositioning}`);
  }

  // Confidence
  let confidence = 50;
  if (Math.abs(fiiNet) > 500) confidence += 10;
  if (Math.abs(diiNet) > 500) confidence += 10;
  if (combinedBias === "BULLISH" || combinedBias === "BEARISH") confidence += 5;
  if (combinedBias === "CONFLICTED") {
    confidence -= 10;
    warnings.push("FII and DII flows conflict");
  }

  // Data freshness warning
  if (fiiDII.dataDate) {
    const dataDate = new Date(fiiDII.dataDate);
    const daysOld = Math.floor((Date.now() - dataDate.getTime()) / 86400000);
    if (daysOld > 1) {
      warnings.push(`FII/DII data is ${daysOld} days old — may not reflect current session`);
    }
  }

  return {
    fiiBias,
    diiBias,
    combinedBias,
    flowType,
    participantInterpretation,
    fiiIndexLongShort,
    diiIndexLongShort,
    clientPositioning,
    confidence,
    factors,
    warnings,
  };
}

function emptyFlowIntelligence(): FlowIntelligence {
  return {
    fiiBias: "NEUTRAL", diiBias: "NEUTRAL", combinedBias: "NEUTRAL",
    flowType: "NEUTRAL_FLOW", participantInterpretation: "No data",
    fiiIndexLongShort: 0, diiIndexLongShort: 0, clientPositioning: "Unknown",
    confidence: 0, factors: ["FII/DII data unavailable"], warnings: ["No flow data available"],
  };
}
