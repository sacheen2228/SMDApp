// Hermes Gamma Intelligence — gamma analysis for trade decisions
// Wraps existing gamma-blast.ts.

import type { HermesContext, GammaData, Direction } from "./types";

// ── Gamma Intelligence ─────────────────────────────────────────────────

export interface GammaIntelligence {
  gammaRegime: "POSITIVE" | "NEGATIVE" | "TRANSITION" | "UNKNOWN";
  dealerBias: Direction;
  squeezePotential: number;
  gammaWallStrike: number;
  gammaWallType: string;
  gammaFlip: number;
  estimatedGEX: number;
  tradeImplication: string;
  confidence: number;
  factors: string[];
  warnings: string[];
}

export function analyzeGammaIntelligence(ctx: HermesContext): GammaIntelligence {
  const gamma = ctx.gamma.value;
  const vix = ctx.vix.value;
  const spot = ctx.spot.value?.price || 0;
  const chain = ctx.optionChain.value;

  const factors: string[] = [];
  const warnings: string[] = [];

  if (!gamma && !chain) {
    return emptyGammaIntelligence();
  }

  // Gamma regime
  const gammaRegime: GammaIntelligence["gammaRegime"] =
    gamma?.regime || (vix < 15 ? "POSITIVE" : vix > 25 ? "NEGATIVE" : "UNKNOWN");

  // Dealer bias from gamma data or derive from OI
  let dealerBias: Direction = "NEUTRAL";
  if (gamma?.dealerBias === "BULLISH") dealerBias = "BULLISH";
  else if (gamma?.dealerBias === "BEARISH") dealerBias = "BEARISH";

  // Squeeze potential
  const squeezePotential = gamma?.squeezePotential || 0;
  if (squeezePotential > 70) {
    factors.push(`High squeeze potential (${squeezePotential.toFixed(0)}%)`);
    warnings.push("Gamma squeeze possible — expect rapid moves");
  }

  // Gamma wall
  const gammaWallStrike = gamma?.gammaWallStrike || chain?.gammaWall || 0;
  const gammaWallType = gamma?.gammaWallType || "NONE";

  if (gammaWallStrike > 0 && spot > 0) {
    const distFromWall = Math.abs(gammaWallStrike - spot) / spot * 100;
    if (distFromWall < 1) {
      factors.push(`Near gamma wall at ₹${gammaWallStrike.toLocaleString("en-IN")} — pinning risk`);
      warnings.push("Price near gamma wall — reduced directional conviction");
    } else {
      factors.push(`Gamma wall at ₹${gammaWallStrike.toLocaleString("en-IN")} (${distFromWall.toFixed(1)}% away)`);
    }
  }

  // Gamma flip
  const gammaFlip = chain?.gammaFlip || 0;
  if (gammaFlip > 0 && spot > 0) {
    if (Math.abs(gammaFlip - spot) / spot < 0.005) {
      factors.push("Near gamma flip level — regime transition possible");
    }
  }

  // GEX (Gamma Exposure)
  const estimatedGEX = gamma?.estimatedGEX || 0;
  if (estimatedGEX > 0) {
    factors.push(`Estimated GEX: ${(estimatedGEX / 1e8).toFixed(1)} Cr`);
  }

  // Trade implication
  let tradeImplication = "NEUTRAL";
  let confidence = 50;

  if (gammaRegime === "POSITIVE") {
    tradeImplication = "MEAN_REVERSION";
    confidence = 55;
    factors.push("Positive gamma — mean-reverting environment");
  } else if (gammaRegime === "NEGATIVE") {
    tradeImplication = "TRENDING";
    confidence = 55;
    factors.push("Negative gamma — trending environment");
  } else if (squeezePotential > 60) {
    tradeImplication = "BREAKOUT_PENDING";
    confidence = 50;
    factors.push("Squeeze building — breakout potential");
  }

  // VIX-based gamma context
  if (vix < 12) {
    factors.push("Very low VIX — gamma compression, breakout setup");
    confidence += 5;
  } else if (vix > 20) {
    factors.push("Elevated VIX — gamma expansion, trending potential");
  }

  return {
    gammaRegime,
    dealerBias,
    squeezePotential,
    gammaWallStrike,
    gammaWallType,
    gammaFlip,
    estimatedGEX,
    tradeImplication,
    confidence,
    factors,
    warnings,
  };
}

function emptyGammaIntelligence(): GammaIntelligence {
  return {
    gammaRegime: "UNKNOWN", dealerBias: "NEUTRAL", squeezePotential: 0,
    gammaWallStrike: 0, gammaWallType: "NONE", gammaFlip: 0, estimatedGEX: 0,
    tradeImplication: "UNKNOWN", confidence: 0,
    factors: ["Gamma data unavailable"], warnings: ["No gamma data available"],
  };
}
