// Hermes Strike Selector — ITM/ATM/OTM selection engine
// Configurable weighted scoring: delta, gamma, vega, IV, liquidity, spread, volume, OI, expected move, position.
// Context-aware: adapts to regime, VIX level, expiry distance.

import type {
  HermesContext, OptionChainData, OptionStrike, StrikeCandidate, Direction, OptionSide, OptionPosition
} from "./types";

// ── Configurable Weights (total = 100%) ─────────────────────────────

export interface StrikeWeights {
  delta: number;
  liquidity: number;
  spread: number;
  volume: number;
  oi: number;
  gamma: number;
  iv: number;
  vega: number;
  expectedMove: number;
  position: number;
}

export const DEFAULT_WEIGHTS: StrikeWeights = {
  delta: 20,
  liquidity: 15,
  spread: 15,
  volume: 10,
  oi: 10,
  gamma: 10,
  iv: 8,
  vega: 5,
  expectedMove: 5,
  position: 2,
};

// ── Score Breakdown (for UI/explainer) ──────────────────────────────

export interface StrikeScoreBreakdown {
  totalScore: number;
  deltaScore: number;
  gammaScore: number;
  ivScore: number;
  vegaScore: number;
  liquidityScore: number;
  spreadScore: number;
  volumeScore: number;
  oiScore: number;
  expectedMoveScore: number;
  positionScore: number;
  reasons: string[];
}

// ── Context Factors ─────────────────────────────────────────────────

interface ContextFactors {
  vix: number;
  regime: string;
  daysToExpiry: number;
  isEventRisk: boolean;
}

function extractContext(ctx: HermesContext): ContextFactors {
  const vix = typeof ctx.vix?.value === "number" ? ctx.vix.value : 15;
  const regime = ctx.regime?.value?.type || "UNKNOWN";
  const daysToExpiry = ctx.optionChain?.value?.daysToExpiry ?? 5;
  const isEventRisk = regime === "EVENT_RISK" || vix > 25;
  return { vix, regime, daysToExpiry, isEventRisk };
}

// ── Strike Selection ───────────────────────────────────────────────────

export function selectOptimalStrikes(
  ctx: HermesContext,
  direction: Direction,
  side: OptionSide,
  maxResults: number = 5,
  weights: StrikeWeights = DEFAULT_WEIGHTS
): StrikeCandidate[] {
  const chain = ctx.optionChain.value;
  if (!chain || !chain.strikes || chain.strikes.length === 0) {
    return [];
  }

  const spot = chain.spot || ctx.spot.value?.price || 0;
  if (spot <= 0) return [];

  const expectedMove = chain.expectedMove || spot * 0.01;
  const context = extractContext(ctx);
  const candidates: StrikeCandidate[] = [];

  for (const strike of chain.strikes) {
    const optionData = side === "CE" ? strike.ce : strike.pe;
    if (!optionData || optionData.ltp <= 0) continue;

    const distanceFromSpot = Math.abs(strike.strike - spot);
    const distancePct = (distanceFromSpot / spot) * 100;

    // Classify position
    let position: OptionPosition;
    if (strike.strike === chain.atmStrike) {
      position = "ATM";
    } else if (side === "CE") {
      position = strike.strike < spot ? "ITM" : "OTM";
    } else {
      position = strike.strike > spot ? "ITM" : "OTM";
    }

    // Calculate spread
    const spread = optionData.ask - optionData.bid;
    const spreadPct = optionData.ltp > 0 ? (spread / optionData.ltp) * 100 : 100;

    // Liquidity classification
    let liquidity: "HIGH" | "MEDIUM" | "LOW" = "LOW";
    if (optionData.volume > 10000 && spreadPct < 2) liquidity = "HIGH";
    else if (optionData.volume > 1000 && spreadPct < 5) liquidity = "MEDIUM";

    // Within expected move?
    const withinExpectedMove = distanceFromSpot <= expectedMove;

    // Score this strike
    const breakdown = scoreStrike({
      position,
      delta: optionData.delta,
      gamma: optionData.gamma,
      theta: optionData.theta,
      vega: optionData.vega,
      iv: optionData.iv,
      premium: optionData.ltp,
      volume: optionData.volume,
      oi: optionData.oi,
      oiChange: optionData.oiChange,
      spreadPct,
      liquidity,
      distancePct,
      withinExpectedMove,
      direction,
      side,
    }, weights, context);

    candidates.push({
      strike: strike.strike,
      position,
      side,
      delta: optionData.delta,
      gamma: optionData.gamma,
      theta: optionData.theta,
      vega: optionData.vega,
      iv: optionData.iv,
      premium: optionData.ltp,
      volume: optionData.volume,
      oi: optionData.oi,
      oiChange: optionData.oiChange,
      spread,
      spreadPct,
      liquidity,
      distanceFromSpot,
      withinExpectedMove,
      score: breakdown.totalScore,
      reasons: breakdown.reasons,
    });
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  return candidates.slice(0, maxResults);
}

// ── Strike Scoring (weighted, context-aware) ─────────────────────────

interface StrikeScoreInput {
  position: OptionPosition;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  premium: number;
  volume: number;
  oi: number;
  oiChange: number;
  spreadPct: number;
  liquidity: "HIGH" | "MEDIUM" | "LOW";
  distancePct: number;
  withinExpectedMove: boolean;
  direction: Direction;
  side: OptionSide;
}

function scoreStrike(
  input: StrikeScoreInput,
  weights: StrikeWeights,
  ctx: ContextFactors
): StrikeScoreBreakdown {
  const reasons: string[] = [];

  // ── Delta Score (0-20) ──────────────────────────────────────────
  let deltaScore = 0;
  const absDelta = Math.abs(input.delta);
  if (absDelta >= 0.40 && absDelta <= 0.60) {
    deltaScore = weights.delta;
    reasons.push(`Δ ${input.delta.toFixed(2)} — optimal for directional exposure`);
  } else if (absDelta >= 0.30 && absDelta <= 0.70) {
    deltaScore = weights.delta * 0.6;
    reasons.push(`Δ ${input.delta.toFixed(2)} — acceptable`);
  } else if (absDelta < 0.20) {
    deltaScore = 0;
    reasons.push(`Δ ${input.delta.toFixed(2)} — too far OTM, low probability`);
  } else if (absDelta > 0.80) {
    deltaScore = weights.delta * 0.4;
    reasons.push(`Δ ${input.delta.toFixed(2)} — deep ITM, high premium`);
  }

  // ── Liquidity Score (0-15) ─────────────────────────────────────
  let liquidityScore = 0;
  if (input.liquidity === "HIGH") {
    liquidityScore = weights.liquidity;
    reasons.push("High liquidity — easy execution");
  } else if (input.liquidity === "MEDIUM") {
    liquidityScore = weights.liquidity * 0.5;
    reasons.push("Medium liquidity");
  } else {
    liquidityScore = 0;
    reasons.push("Low liquidity — execution risk");
  }

  // ── Spread Score (0-15) ────────────────────────────────────────
  let spreadScore = 0;
  if (input.spreadPct < 1) {
    spreadScore = weights.spread;
    reasons.push("Tight spread — minimal slippage");
  } else if (input.spreadPct < 3) {
    spreadScore = weights.spread * 0.6;
    reasons.push("Moderate spread");
  } else if (input.spreadPct > 10) {
    spreadScore = 0;
    reasons.push(`Wide spread (${input.spreadPct.toFixed(1)}%) — high cost`);
  } else {
    spreadScore = weights.spread * 0.2;
  }

  // ── Volume Score (0-10) ────────────────────────────────────────
  let volumeScore = 0;
  if (input.volume > 10000) {
    volumeScore = weights.volume;
    reasons.push("Strong volume — high conviction");
  } else if (input.volume > 1000) {
    volumeScore = weights.volume * 0.5;
    reasons.push("Moderate volume");
  } else {
    volumeScore = 0;
    reasons.push("Low volume");
  }

  // ── OI Score (0-10) ────────────────────────────────────────────
  let oiScore = 0;
  if (input.oiChange > 0) {
    oiScore = weights.oi;
    reasons.push("OI building — fresh positions");
  } else if (input.oiChange < -1000) {
    oiScore = 0;
    reasons.push("OI declining — positions closing");
  } else {
    oiScore = weights.oi * 0.3;
  }

  // ── Gamma Score (0-10) — Context-aware ─────────────────────────
  let gammaScore = 0;
  if (input.gamma > 0) {
    // Near-expiry: gamma more valuable (0DTE/1DTE)
    if (ctx.daysToExpiry <= 1) {
      gammaScore = weights.gamma;
      reasons.push(`Γ ${input.gamma.toFixed(4)} — high gamma value near expiry`);
    }
    // Event/volatility expansion: gamma valuable for rapid moves
    else if (ctx.isEventRisk) {
      gammaScore = weights.gamma * 0.9;
      reasons.push(`Γ ${input.gamma.toFixed(4)} — valuable in event environment`);
    }
    // ATM: moderate gamma value
    else if (input.position === "ATM") {
      gammaScore = weights.gamma * 0.7;
      reasons.push(`Γ ${input.gamma.toFixed(4)} — good gamma at ATM`);
    }
    // OTM: lower gamma but potential for explosive moves
    else if (input.position === "OTM") {
      gammaScore = weights.gamma * 0.4;
      reasons.push(`Γ ${input.gamma.toFixed(4)} — OTM gamma`);
    }
    // ITM: gamma less significant
    else {
      gammaScore = weights.gamma * 0.3;
      reasons.push(`Γ ${input.gamma.toFixed(4)} — ITM, gamma less significant`);
    }
  }

  // ── IV Score (0-8) — Context-aware, NOT blindly rewarding high IV ──
  let ivScore = 0;
  if (input.iv > 0) {
    // High IV environment: penalize high IV (expensive premium)
    if (ctx.vix > 25) {
      if (input.iv > 30) {
        ivScore = 0;
        reasons.push(`IV ${input.iv}% — expensive in high-VIX environment`);
      } else {
        ivScore = weights.iv;
        reasons.push(`IV ${input.iv}% — relatively cheap in elevated VIX`);
      }
    }
    // Low IV environment: moderate IV is acceptable
    else if (ctx.vix < 12) {
      if (input.iv > 20) {
        ivScore = weights.iv * 0.4;
        reasons.push(`IV ${input.iv}% — elevated for low-VIX`);
      } else {
        ivScore = weights.iv;
        reasons.push(`IV ${input.iv}% — reasonable`);
      }
    }
    // Normal IV: ATM IV preferred (not too high, not too low)
    else {
      if (input.iv >= 12 && input.iv <= 20) {
        ivScore = weights.iv;
        reasons.push(`IV ${input.iv}% — normal range`);
      } else if (input.iv > 20) {
        ivScore = weights.iv * 0.5;
        reasons.push(`IV ${input.iv}% — slightly elevated`);
      } else {
        ivScore = weights.iv * 0.6;
        reasons.push(`IV ${input.iv}% — low`);
      }
    }
  }

  // ── Vega Score (0-5) — Context-aware ───────────────────────────
  let vegaScore = 0;
  if (input.vega > 0) {
    // Volatility expansion expected: vega valuable
    if (ctx.isEventRisk || ctx.vix < 12) {
      vegaScore = weights.vega;
      reasons.push(`V ${input.vega.toFixed(2)} — valuable for vol expansion`);
    }
    // High IV already: vega less attractive (already priced in)
    else if (ctx.vix > 25) {
      vegaScore = weights.vega * 0.3;
      reasons.push(`V ${input.vega.toFixed(2)} — limited upside in high IV`);
    }
    // Normal
    else {
      vegaScore = weights.vega * 0.6;
      reasons.push(`V ${input.vega.toFixed(2)}`);
    }
  }

  // ── Expected Move Score (0-5) ──────────────────────────────────
  let expectedMoveScore = 0;
  if (input.withinExpectedMove) {
    expectedMoveScore = weights.expectedMove;
    reasons.push("Within expected move — achievable target");
  } else {
    expectedMoveScore = 0;
    reasons.push("Outside expected move — low probability");
  }

  // ── Position Score (0-2) ───────────────────────────────────────
  let positionScore = 0;
  if (input.position === "ATM") {
    positionScore = weights.position;
    reasons.push("ATM — balanced risk/reward");
  } else if (input.position === "ITM") {
    positionScore = weights.position * 0.8;
    reasons.push("ITM — higher delta, lower theta %");
  } else {
    // OTM
    if (input.distancePct > 3) {
      positionScore = 0;
      reasons.push(`OTM by ${input.distancePct.toFixed(1)}% — very low probability`);
    } else if (input.distancePct > 1.5) {
      positionScore = weights.position * 0.3;
      reasons.push(`OTM by ${input.distancePct.toFixed(1)}%`);
    } else {
      positionScore = weights.position * 0.6;
      reasons.push(`OTM by ${input.distancePct.toFixed(1)}% — near ATM`);
    }
  }

  // ── Theta penalty (applied after component scores) ─────────────
  let thetaPenalty = 0;
  if (Math.abs(input.theta) > input.premium * 0.05) {
    thetaPenalty = -5;
    reasons.push("High theta cost relative to premium");
  }

  // ── Total ──────────────────────────────────────────────────────
  const totalScore = Math.max(0, Math.min(100,
    deltaScore + liquidityScore + spreadScore + volumeScore + oiScore +
    gammaScore + ivScore + vegaScore + expectedMoveScore + positionScore + thetaPenalty
  ));

  return {
    totalScore,
    deltaScore,
    gammaScore,
    ivScore,
    vegaScore,
    liquidityScore,
    spreadScore,
    volumeScore,
    oiScore,
    expectedMoveScore,
    positionScore,
    reasons,
  };
}

// ── Best Strike Recommendation ─────────────────────────────────────────

export function getBestStrike(
  ctx: HermesContext,
  direction: Direction,
  side: OptionSide
): StrikeCandidate | null {
  const candidates = selectOptimalStrikes(ctx, direction, side, 1);
  return candidates.length > 0 ? candidates[0] : null;
}

export function compareCEvsPE(ctx: HermesContext): {
  bestCE: StrikeCandidate | null;
  bestPE: StrikeCandidate | null;
  preferred: "CE" | "PE" | "NONE";
  reason: string;
} {
  const bestCE = getBestStrike(ctx, "BULLISH", "CE");
  const bestPE = getBestStrike(ctx, "BEARISH", "PE");

  if (!bestCE && !bestPE) return { bestCE: null, bestPE: null, preferred: "NONE", reason: "No valid strikes found" };
  if (!bestCE) return { bestCE: null, bestPE, preferred: "PE", reason: "No valid CE strikes" };
  if (!bestPE) return { bestCE, bestPE: null, preferred: "CE", reason: "No valid PE strikes" };

  if (bestCE.score > bestPE.score + 10) return { bestCE, bestPE, preferred: "CE", reason: `CE score ${bestCE.score} > PE score ${bestPE.score}` };
  if (bestPE.score > bestCE.score + 10) return { bestCE, bestPE, preferred: "PE", reason: `PE score ${bestPE.score} > CE score ${bestCE.score}` };

  return { bestCE, bestPE, preferred: "NONE", reason: "Scores too close — both weak or both equal" };
}
