// Hermes Scoring Engine — deterministic 100-point trade scoring
// No ML, no LLM scoring. Pure deterministic evidence-based scoring.

import type {
  HermesContext, ScoreBreakdown, ScoreResult, Direction, OptionSide, TradeGrade
} from "./types";
import { analyzeOIIntelligence } from "./oi-intel";
import { analyzeGammaIntelligence } from "./gamma-intel";
import { analyzeFlowIntelligence } from "./flow-intel";

// ── Scoring Weights ────────────────────────────────────────────────────

interface ScoringWeights {
  structure: number;
  oi: number;
  greeks: number;
  volume: number;
  gamma: number;
  vix: number;
  fiiDii: number;
  cas: number;
  expectedMove: number;
  news: number;
  riskReward: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  structure: 20,
  oi: 15,
  greeks: 10,
  volume: 10,
  gamma: 10,
  vix: 5,
  fiiDii: 5,
  cas: 10,
  expectedMove: 5,
  news: 5,
  riskReward: 5,
};

// MCX-specific weights: heavier on structure/volatility, lighter on FII/DII/CAS
const MCX_WEIGHTS: ScoringWeights = {
  structure: 25,
  oi: 12,
  greeks: 8,
  volume: 12,
  gamma: 5,
  vix: 8,
  fiiDii: 0,  // not applicable for MCX
  cas: 0,     // not applicable for MCX
  expectedMove: 10,
  news: 5,
  riskReward: 15,
};

function getWeightsForContext(ctx: HermesContext): ScoringWeights {
  if (ctx.exchange === "MCX") return MCX_WEIGHTS;
  return DEFAULT_WEIGHTS;
}

// ── Scoring Functions ──────────────────────────────────────────────────

export function scoreTradeCandidate(
  ctx: HermesContext,
  direction: Direction,
  optionSide: OptionSide,
  weights: ScoringWeights = getWeightsForContext(ctx)
): ScoreResult {
  const breakdown: ScoreBreakdown[] = [];

  // 1. Structure (20 points)
  breakdown.push(scoreStructure(ctx, direction, weights.structure));

  // 2. OI (15 points)
  breakdown.push(scoreOI(ctx, direction, weights.oi));

  // 3. Greeks (10 points)
  breakdown.push(scoreGreeks(ctx, optionSide, weights.greeks));

  // 4. Volume (10 points)
  breakdown.push(scoreVolume(ctx, weights.volume));

  // 5. Gamma (10 points)
  breakdown.push(scoreGamma(ctx, direction, weights.gamma));

  // 6. VIX (5 points)
  breakdown.push(scoreVIX(ctx, weights.vix));

  // 7. FII/DII (5 points)
  breakdown.push(scoreFIIDII(ctx, direction, weights.fiiDii));

  // 8. CAS (10 points)
  breakdown.push(scoreCAS(ctx, weights.cas));

  // 9. Expected Move (5 points)
  breakdown.push(scoreExpectedMove(ctx, direction, weights.expectedMove));

  // 10. News (5 points)
  breakdown.push(scoreNews(ctx, direction, weights.news));

  // 11. Risk/Reward (5 points)
  breakdown.push(scoreRiskReward(ctx, weights.riskReward));

  // 12. MCX Intelligence (bonus factor for MCX commodities)
  if (ctx.exchange === "MCX" && ctx.mcxIntelligence?.value) {
    breakdown.push(scoreMCXIntelligence(ctx, direction, weights));
  }

  // Calculate total
  const total = breakdown.reduce((sum, b) => sum + b.weighted, 0);
  const grade = getTradeGrade(total);

  return {
    total: Math.round(total),
    grade,
    breakdown,
    direction,
    optionSide,
  };
}

// ── Individual Scoring Functions ────────────────────────────────────────

function scoreStructure(ctx: HermesContext, direction: Direction, weight: number): ScoreBreakdown {
  const structure = ctx.marketStructure.value;
  let score = 50; // neutral
  let reason = "Structure neutral";

  if (structure) {
    const trend = structure.trend;
    if (direction === "BULLISH" && trend === "UP") {
      score = 85;
      reason = "Bullish structure aligns with CE BUY";
    } else if (direction === "BEARISH" && trend === "DOWN") {
      score = 85;
      reason = "Bearish structure aligns with PE BUY";
    } else if (direction === "BULLISH" && trend === "DOWN") {
      score = 20;
      reason = "Bullish request but bearish structure — conflict";
    } else if (direction === "BEARISH" && trend === "UP") {
      score = 20;
      reason = "Bearish request but bullish structure — conflict";
    } else {
      score = 50;
      reason = `Structure ${trend} — neutral for ${direction}`;
    }
  }

  return {
    factor: "Structure",
    score,
    weighted: (score * weight) / 100,
    weight,
    available: !!structure,
    reason,
    direction,
  };
}

function scoreOI(ctx: HermesContext, direction: Direction, weight: number): ScoreBreakdown {
  const oi = analyzeOIIntelligence(ctx);
  let score = 50;
  let reason = "OI neutral";

  if (direction === "BULLISH") {
    if (oi.oiBias === "BULLISH") {
      score = 80;
      reason = `OI bullish: ${oi.freshWritingSignals.join(", ") || "put writing"}`;
    } else if (oi.oiBias === "BEARISH") {
      score = 25;
      reason = `OI bearish — conflict with bullish request`;
    }
  } else if (direction === "BEARISH") {
    if (oi.oiBias === "BEARISH") {
      score = 80;
      reason = `OI bearish: ${oi.freshWritingSignals.join(", ") || "call writing"}`;
    } else if (oi.oiBias === "BULLISH") {
      score = 25;
      reason = `OI bullish — conflict with bearish request`;
    }
  }

  return {
    factor: "OI",
    score,
    weighted: (score * weight) / 100,
    weight,
    available: true,
    reason,
    direction,
  };
}

function scoreGreeks(ctx: HermesContext, side: OptionSide, weight: number): ScoreBreakdown {
  const greeks = ctx.greeks.value;
  let score = 50;
  let reason = "Greeks neutral";

  if (greeks) {
    const delta = greeks.delta;
    const theta = greeks.theta;

    // Good delta for buying (0.35-0.65)
    if (delta >= 0.35 && delta <= 0.65) {
      score = 70;
      reason = `Delta ${delta.toFixed(2)} — good range for ${side} BUY`;
    } else if (delta < 0.2) {
      score = 25;
      reason = `Delta ${delta.toFixed(2)} — too far OTM, low probability`;
    } else if (delta > 0.8) {
      score = 40;
      reason = `Delta ${delta.toFixed(2)} — deep ITM, high premium cost`;
    }

    // Theta decay warning
    if (Math.abs(theta) > 5) {
      score -= 10;
      reason += `; High theta decay (${theta.toFixed(2)})`;
    }
  }

  return {
    factor: "Greeks",
    score: Math.max(0, Math.min(100, score)),
    weighted: (Math.max(0, Math.min(100, score)) * weight) / 100,
    weight,
    available: !!greeks,
    reason,
    direction: "NEUTRAL",
  };
}

function scoreVolume(ctx: HermesContext, weight: number): ScoreBreakdown {
  const volume = ctx.volume.value;
  const chain = ctx.optionChain.value;
  let score = 50;
  let reason = "Volume neutral";

  const totalVolume = volume?.totalVolume || chain?.strikes?.reduce((s, st) =>
    s + (st.ce?.volume || 0) + (st.pe?.volume || 0), 0) || 0;

  if (totalVolume > 100000) {
    score = 80;
    reason = `High volume (${totalVolume.toLocaleString()}) — strong participation`;
  } else if (totalVolume > 50000) {
    score = 65;
    reason = `Moderate volume (${totalVolume.toLocaleString()})`;
  } else if (totalVolume > 10000) {
    score = 50;
    reason = `Low volume (${totalVolume.toLocaleString()}) — caution`;
  } else {
    score = 30;
    reason = `Very low volume — illiquid`;
  }

  return {
    factor: "Volume",
    score,
    weighted: (score * weight) / 100,
    weight,
    available: totalVolume > 0,
    reason,
    direction: "NEUTRAL",
  };
}

function scoreGamma(ctx: HermesContext, direction: Direction, weight: number): ScoreBreakdown {
  const gamma = analyzeGammaIntelligence(ctx);
  let score = 50;
  let reason = "Gamma neutral";

  if (gamma.gammaRegime === "POSITIVE" && direction === "BULLISH") {
    score = 65;
    reason = "Positive gamma supports mean reversion — bullish";
  } else if (gamma.gammaRegime === "NEGATIVE" && direction === "BEARISH") {
    score = 65;
    reason = "Negative gamma supports trending — bearish";
  } else if (gamma.squeezePotential > 60) {
    score = 60;
    reason = `Squeeze potential ${gamma.squeezePotential.toFixed(0)}% — breakout`;
  }

  return {
    factor: "Gamma",
    score,
    weighted: (score * weight) / 100,
    weight,
    available: gamma.gammaRegime !== "UNKNOWN",
    reason,
    direction,
  };
}

function scoreVIX(ctx: HermesContext, weight: number): ScoreBreakdown {
  const vix = ctx.vix.value;
  let score = 50;
  let reason = "VIX neutral";

  if (vix < 12) {
    score = 70;
    reason = `VIX very low (${vix.toFixed(1)}) — low cost options`;
  } else if (vix < 15) {
    score = 65;
    reason = `VIX low (${vix.toFixed(1)}) — favorable`;
  } else if (vix < 20) {
    score = 50;
    reason = `VIX normal (${vix.toFixed(1)})`;
  } else if (vix < 25) {
    score = 35;
    reason = `VIX elevated (${vix.toFixed(1)}) — expensive options`;
  } else {
    score = 15;
    reason = `VIX very high (${vix.toFixed(1)}) — extreme caution`;
  }

  return {
    factor: "VIX",
    score,
    weighted: (score * weight) / 100,
    weight,
    available: vix > 0,
    reason,
    direction: "NEUTRAL",
  };
}

function scoreFIIDII(ctx: HermesContext, direction: Direction, weight: number): ScoreBreakdown {
  const flow = analyzeFlowIntelligence(ctx);
  let score = 50;
  let reason = "FII/DII neutral";

  if (direction === "BULLISH" && flow.combinedBias === "BULLISH") {
    score = 80;
    reason = "FII + DII both buying — bullish flow";
  } else if (direction === "BEARISH" && flow.combinedBias === "BEARISH") {
    score = 80;
    reason = "FII + DII both selling — bearish flow";
  } else if (flow.combinedBias === "CONFLICTED") {
    score = 35;
    reason = "FII and DII flows conflict";
  }

  return {
    factor: "FII/DII",
    score,
    weighted: (score * weight) / 100,
    weight,
    available: true,
    reason,
    direction,
  };
}

function scoreCAS(ctx: HermesContext, weight: number): ScoreBreakdown {
  const cas = ctx.expiryLiquidity.value;
  let score = 50;
  let reason = "CAS neutral";

  if (cas?.casDirection && cas.casDirection !== "UNKNOWN") {
    score = 60;
    reason = `CAS direction: ${cas.casDirection}`;
  }

  return {
    factor: "CAS",
    score,
    weighted: (score * weight) / 100,
    weight,
    available: cas?.casDirection !== "UNKNOWN",
    reason,
    direction: "NEUTRAL",
  };
}

function scoreExpectedMove(ctx: HermesContext, direction: Direction, weight: number): ScoreBreakdown {
  const chain = ctx.optionChain.value;
  let score = 50;
  let reason = "Expected move neutral";

  if (chain?.expectedMove && chain.expectedMove > 0) {
    const spot = chain.spot || ctx.spot.value?.price || 0;
    if (spot > 0) {
      const movePct = (chain.expectedMove / spot) * 100;
      if (movePct > 1) {
        score = 65;
        reason = `Expected move ${movePct.toFixed(1)}% — supports directional trade`;
      } else if (movePct < 0.3) {
        score = 35;
        reason = `Expected move ${movePct.toFixed(1)}% — limited room`;
      }
    }
  }

  return {
    factor: "Expected Move",
    score,
    weighted: (score * weight) / 100,
    weight,
    available: !!chain?.expectedMove,
    reason,
    direction,
  };
}

function scoreNews(ctx: HermesContext, direction: Direction, weight: number): ScoreBreakdown {
  const news = ctx.news.value;
  let score = 50;
  let reason = "News neutral";

  if (news) {
    const sentiment = news.sentiment;
    if (direction === "BULLISH" && sentiment === "BULLISH") {
      score = 75;
      reason = "News sentiment bullish — aligns with CE BUY";
    } else if (direction === "BEARISH" && sentiment === "BEARISH") {
      score = 75;
      reason = "News sentiment bearish — aligns with PE BUY";
    } else if (
      (direction === "BULLISH" && sentiment === "BEARISH") ||
      (direction === "BEARISH" && sentiment === "BULLISH")
    ) {
      score = 30;
      reason = `News ${sentiment} — conflicts with ${direction} request`;
    }
  }

  return {
    factor: "News",
    score,
    weighted: (score * weight) / 100,
    weight,
    available: !!news,
    reason,
    direction,
  };
}

function scoreRiskReward(ctx: HermesContext, weight: number): ScoreBreakdown {
  // RR is calculated later by trade-validator; score neutral for now
  return {
    factor: "Risk/Reward",
    score: 50,
    weighted: (50 * weight) / 100,
    weight,
    available: false,
    reason: "RR calculated during validation",
    direction: "NEUTRAL",
  };
}

// MCX Intelligence scoring — uses commodity-specific intel from MCX engines
function scoreMCXIntelligence(ctx: HermesContext, direction: Direction, weights: ScoringWeights): ScoreBreakdown {
  const intel = ctx.mcxIntelligence?.value;
  if (!intel) {
    return { factor: "MCX Intel", score: 50, weighted: 0, weight: 5, available: false, reason: "No MCX intel", direction: "NEUTRAL" };
  }

  let score = 50;
  const evidence: string[] = [];

  // Regime alignment
  const regimeDir = intel.regime.includes('BULLISH') ? 'LONG' : intel.regime.includes('BEARISH') ? 'SHORT' : 'NEUTRAL';
  if ((direction === 'BULLISH' && regimeDir === 'LONG') || (direction === 'BEARISH' && regimeDir === 'SHORT')) {
    score += 15;
    evidence.push(`Regime ${intel.regime} aligns`);
  } else if (regimeDir !== 'NEUTRAL') {
    score -= 10;
    evidence.push(`Regime ${intel.regime} conflicts`);
  }

  // OI confirmation
  const oiDir = intel.oiClassification.includes('LONG') ? 'LONG' : intel.oiClassification.includes('SHORT') ? 'SHORT' : 'NEUTRAL';
  if ((direction === 'BULLISH' && oiDir === 'LONG') || (direction === 'BEARISH' && oiDir === 'SHORT')) {
    score += 10;
    evidence.push(`OI ${intel.oiClassification} confirms`);
  }

  // Chain quality
  if (intel.chainQuality === 'GOOD') { score += 10; evidence.push('Chain GOOD'); }
  else if (intel.chainQuality === 'POOR') { score -= 10; evidence.push('Chain POOR'); }

  // OI divergence penalty
  if (intel.oiDivergence) { score -= 15; evidence.push('OI divergence penalty'); }

  // RR bonus
  if (intel.bestCandidateRR > 2) { score += 10; evidence.push(`RR ${intel.bestCandidateRR.toFixed(1)}:1`); }
  else if (intel.bestCandidateRR < 1) { score -= 10; evidence.push(`RR ${intel.bestCandidateRR.toFixed(1)}:1 — poor`); }

  score = Math.max(0, Math.min(100, score));
  const weight = 5; // MCX intel is a bonus factor
  return { factor: "MCX Intel", score, weighted: (score * weight) / 100, weight, available: true, reason: evidence.join('; ') || 'MCX intel neutral', direction: "NEUTRAL" };
}

// ── Grade Calculation ──────────────────────────────────────────────────

export function getTradeGrade(score: number): TradeGrade {
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}

export function getGradeThresholds(): Record<TradeGrade, [number, number]> {
  return {
    A: [80, 100],
    B: [70, 79],
    C: [60, 69],
    D: [50, 59],
    F: [0, 49],
  };
}

export function isTradeable(score: number, minGrade: TradeGrade = "C"): boolean {
  const grade = getTradeGrade(score);
  const grades: TradeGrade[] = ["A", "B", "C", "D", "F"];
  return grades.indexOf(grade) <= grades.indexOf(minGrade);
}
