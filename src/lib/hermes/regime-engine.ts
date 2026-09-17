// Hermes Regime Engine — market regime detection and interpretation
// Wraps existing SMDApp regime detection and adds trade decision interpretation.

import type { HermesContext, FreshData, RegimeData, Direction, MarketRegime } from "./types";

// ── Regime Interpretation ──────────────────────────────────────────────

export interface RegimeInterpretation {
  regime: MarketRegime;
  bias: Direction;
  tradeBias: "LONG" | "SHORT" | "NEUTRAL" | "WAIT";
  confidence: number;
  vixOverride: boolean;
  factors: string[];
  warnings: string[];
}

export function interpretRegime(ctx: HermesContext): RegimeInterpretation {
  const regimeData = ctx.regime.value;
  const vix = ctx.vix.value;
  const spot = ctx.spot.value;

  const warnings: string[] = [];
  const factors: string[] = [];
  let vixOverride = false;

  // VIX override logic
  if (vix > 30) {
    vixOverride = true;
    warnings.push(`VIX very high (${vix.toFixed(1)}) — extreme caution`);
    return {
      regime: "HIGH_VOLATILITY",
      bias: "CONFLICTED",
      tradeBias: "WAIT",
      confidence: 30,
      vixOverride: true,
      factors: [`VIX=${vix.toFixed(1)} (>30 extreme)`],
      warnings,
    };
  }

  if (vix > 25) {
    vixOverride = true;
    warnings.push(`VIX elevated (${vix.toFixed(1)}) — reduced position size`);
  }

  if (vix < 12) {
    factors.push(`VIX very low (${vix.toFixed(1)}) — complacency, breakout potential`);
  }

  // Interpret regime from data
  const regime = regimeData?.type || "UNCERTAIN";
  const bias = regimeData?.bias || "NEUTRAL";
  const confidence = regimeData?.confidence || 0;

  factors.push(`Regime: ${regime}`);
  factors.push(`Bias: ${bias}`);
  if (confidence > 0) factors.push(`Confidence: ${confidence}%`);

  // Map regime to trade bias
  let tradeBias: RegimeInterpretation["tradeBias"] = "NEUTRAL";

  switch (regime) {
    case "TRENDING_UP":
      tradeBias = "LONG";
      factors.push("Uptrend — favor CE BUY");
      break;
    case "TRENDING_DOWN":
      tradeBias = "SHORT";
      factors.push("Downtrend — favor PE BUY");
      break;
    case "RANGE":
      tradeBias = "NEUTRAL";
      factors.push("Range-bound — selective trades only");
      break;
    case "BREAKOUT":
      tradeBias = spot?.change >= 0 ? "LONG" : "SHORT";
      factors.push("Breakout detected — direction depends on breakout side");
      break;
    case "BREAKDOWN":
      tradeBias = "SHORT";
      factors.push("Breakdown — favor PE BUY");
      break;
    case "HIGH_VOLATILITY":
      tradeBias = "WAIT";
      warnings.push("High volatility — reduced confidence");
      break;
    case "LOW_VOLATILITY":
      tradeBias = "NEUTRAL";
      factors.push("Low volatility — potential squeeze setup");
      break;
    case "COMPRESSION":
    case "EXPANSION":
      tradeBias = "WAIT";
      factors.push("Transition phase — wait for clarity");
      break;
    default:
      tradeBias = "NEUTRAL";
      factors.push("Uncertain regime — exercise caution");
  }

  return {
    regime,
    bias,
    tradeBias,
    confidence,
    vixOverride,
    factors,
    warnings,
  };
}

// ── Quick Regime Check ─────────────────────────────────────────────────

export function isTrending(regime: MarketRegime): boolean {
  return regime === "TRENDING_UP" || regime === "TRENDING_DOWN";
}

export function isRangeBound(regime: MarketRegime): boolean {
  return regime === "RANGE" || regime === "COMPRESSION";
}

export function isHighVolatility(regime: MarketRegime, vix: number): boolean {
  return regime === "HIGH_VOLATILITY" || vix > 25;
}

export function shouldWaitForConfirmation(regime: MarketRegime, confidence: number): boolean {
  return regime === "UNCERTAIN" || confidence < 40 || regime === "COMPRESSION";
}
