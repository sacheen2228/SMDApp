// ─── Buy-Only Hedge Builder Engine ──────────────────────────────
// Decision-support tool — NOT investment advice.
// All thresholds are tunable constants at the top.

// ═══════════════════════════════════════════════════════════════════
// TUNABLE CONSTANTS
// ═══════════════════════════════════════════════════════════════════

export const HEDGE_CONFIG = {
  // Delta band for hedge candidates (absolute value)
  DELTA_MIN: 0.10,
  DELTA_MAX: 0.20,

  // Liquidity floor: top percentile among OTM strikes on same side
  OI_PERCENTILE_FLOOR: 0.4,

  // Penalty threshold for OI unwinding
  OI_UNWIND_THRESHOLD: -30000,

  // IV penalty: if hedge IV exceeds primary IV by more than this ratio
  IV_PENALTY_RATIO: 1.3,

  // Score weights (must sum to 100)
  WEIGHT_LIQUIDITY: 30,
  WEIGHT_COST_EFFICIENCY: 25,
  WEIGHT_RELATIVE_IV: 20,
  WEIGHT_RESPONSIVENESS: 15,
  WEIGHT_MOMENTUM_CAUTION: 10,

  // SL / Target multiples per leg
  SL_PCT_OF_PREMIUM: 0.30,
  TARGET1_MULT: 1.5,
  TARGET2_MULT: 2.5,

  // Capital allocation between primary and hedge (75/25 split)
  PRIMARY_ALLOC_PCT: 0.75,
  HEDGE_ALLOC_PCT: 0.25,
} as const;

export const LOT_SIZES: Record<string, number> = {
  NIFTY: 65,
  SENSEX: 20,
} as const;

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface LegData {
  ltp: number;
  oi: number;
  oiChg: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  volume: number;
}

export interface HedgeCandidate {
  strike: number;
  type: "CE" | "PE";
  delta: number;
  premium: number;
  oi: number;
  oiChg: number;
  theta: number;
  gamma: number;
  iv: number;

  // Scores (0-100 each)
  liquidityScore: number;
  costEfficiencyScore: number;
  relativeIVScore: number;
  responsivenessScore: number;
  momentumScore: number;
  totalScore: number;

  // Reasoning fragments
  reasons: string[];
}

export interface HedgeSelection {
  primaryLeg: { strike: number; type: "CE" | "PE"; premium: number; delta: number; iv: number };
  hedgeLeg: HedgeCandidate | null;
  fallbackWarning?: string;
  totalScore?: number;
}

// ═══════════════════════════════════════════════════════════════════
// TRADE PLAN TYPES
// ═══════════════════════════════════════════════════════════════════

export interface LegTradePlan {
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  lots: number;
  cost: number;
  minLoss: number;
  maxLossAtExpiry: number;
  gainAtT1: number;
  gainAtT2: number;
}

export interface FullTradePlan {
  lotSize: number;
  primary: { strike: number; side: "CE" | "PE"; delta: number; iv: number; oi: number } & LegTradePlan;
  hedge:
    | ({ strike: number; side: "CE" | "PE"; delta: number; theta: number; gamma: number; iv: number; oi: number; reasons: string[]; thinLiquidity?: string } & LegTradePlan)
    | { skipped: true; note: string };
  summary: {
    capitalCap: number;
    totalCost: number;
    leftover: number;
    combinedMaxLoss: number;
    combinedMinLoss: number;
    combinedGainAtT1: number;
    combinedGainAtT2: number;
    breakevenLower: number | null;
    breakevenUpper: number | null;
    note: string;
  };
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════
// PER-LEG TRADE PLAN
// ═══════════════════════════════════════════════════════════════════

export function legTradePlan(
  premium: number,
  lots: number,
  lotSize: number,
): LegTradePlan {
  const risk = premium * HEDGE_CONFIG.SL_PCT_OF_PREMIUM;
  const sl = +Math.max(premium - risk, 0.05).toFixed(2);
  const t1 = +(premium + risk * HEDGE_CONFIG.TARGET1_MULT).toFixed(2);
  const t2 = +(premium + risk * HEDGE_CONFIG.TARGET2_MULT).toFixed(2);
  const cost = +(premium * lots * lotSize).toFixed(2);
  return {
    entry: premium,
    stopLoss: sl,
    target1: t1,
    target2: t2,
    lots,
    cost,
    minLoss: +((premium - sl) * lots * lotSize).toFixed(2),
    maxLossAtExpiry: cost,
    gainAtT1: +((t1 - premium) * lots * lotSize).toFixed(2),
    gainAtT2: +((t2 - premium) * lots * lotSize).toFixed(2),
  };
}

// ═══════════════════════════════════════════════════════════════════
// FULL HEDGED TRADE PLAN
// ═══════════════════════════════════════════════════════════════════

export function buildFullTradePlan(params: {
  chainData: any[];
  spot: number;
  primaryStrike: number;
  primarySide: "CE" | "PE";
  primaryIv: number;
  primaryDelta: number;
  primaryPremium: number;
  primaryOi: number;
  symbol: string;
  capital?: number;
  primaryLotsOverride?: number;
  hedgeLotsOverride?: number;
}): FullTradePlan {
  const {
    chainData, spot, primaryStrike, primarySide,
    primaryIv, primaryDelta, primaryPremium, primaryOi,
    symbol, capital = 20000,
    primaryLotsOverride, hedgeLotsOverride,
  } = params;

  const lotSize = LOT_SIZES[symbol] ?? 50;
  const hedgeSide: "CE" | "PE" = primarySide === "CE" ? "PE" : "CE";

  // --- Primary leg sizing ---
  const primaryBudget = capital * HEDGE_CONFIG.PRIMARY_ALLOC_PCT;
  const maxPrimaryLots = Math.max(0, Math.floor(primaryBudget / (primaryPremium * lotSize)));
  const primaryLots = primaryLotsOverride !== undefined
    ? Math.min(primaryLotsOverride, maxPrimaryLots)
    : maxPrimaryLots;

  if (primaryLots < 1) {
    return {
      lotSize,
      primary: null as any,
      hedge: { skipped: true, note: "" },
      summary: null as any,
      error: `Premium ₹${primaryPremium.toFixed(2)} too high for this budget at ${primaryStrike} ${primarySide} — try a further OTM strike`,
    } as FullTradePlan;
  }

  const primaryPlan = legTradePlan(primaryPremium, primaryLots, lotSize);

  // --- Hedge selection ---
  const hedgeResult = pickHedgeStrike(
    chainData, spot, primaryStrike, primarySide, primaryIv, primaryDelta, primaryPremium,
  );

  let hedgePlan: LegTradePlan | null = null;
  let hedgeObj: any = { skipped: true, note: "" };

  if (hedgeResult.hedgeLeg) {
    const hedgeBudget = capital * HEDGE_CONFIG.HEDGE_ALLOC_PCT;
    const hedgePremium = hedgeResult.hedgeLeg.premium;
    const maxHedgeLots = Math.max(0, Math.floor(hedgeBudget / (hedgePremium * lotSize)));
    const hLots = hedgeLotsOverride !== undefined
      ? Math.min(hedgeLotsOverride, maxHedgeLots)
      : maxHedgeLots;

    if (hLots >= 1) {
      hedgePlan = legTradePlan(hedgePremium, hLots, lotSize);
      hedgeObj = {
        strike: hedgeResult.hedgeLeg.strike,
        side: hedgeSide,
        delta: hedgeResult.hedgeLeg.delta,
        theta: hedgeResult.hedgeLeg.theta,
        gamma: hedgeResult.hedgeLeg.gamma,
        iv: hedgeResult.hedgeLeg.iv,
        oi: hedgeResult.hedgeLeg.oi,
        reasons: hedgeResult.hedgeLeg.reasons,
        thinLiquidity: hedgeResult.fallbackWarning,
        ...hedgePlan,
      };
    } else {
      hedgeObj = {
        skipped: true,
        note: `Hedge premium ₹${hedgePremium} too high for remaining ₹${hedgeBudget.toFixed(0)} budget — try a closer strike`,
      };
    }
  } else if (hedgeResult.fallbackWarning) {
    hedgeObj = { skipped: true, note: hedgeResult.fallbackWarning };
  } else {
    hedgeObj = { skipped: true, note: "No suitable hedge strike found in delta band" };
  }

  // --- Combined summary ---
  const totalCost = primaryPlan.cost + (hedgePlan ? hedgePlan.cost : 0);
  const combinedGainAtT1 = primaryPlan.gainAtT1 - (hedgePlan ? hedgePlan.cost : 0);
  const combinedGainAtT2 = primaryPlan.gainAtT2 - (hedgePlan ? hedgePlan.cost : 0);

  // Breakeven points (bought strangle behaviour)
  const totalPremiumPerLot = primaryPremium + (hedgeResult.hedgeLeg?.premium ?? 0);
  let breakevenLower: number | null = null;
  let breakevenUpper: number | null = null;
  if (hedgePlan && totalPremiumPerLot > 0) {
    if (primarySide === "CE") {
      breakevenLower = hedgeResult.hedgeLeg!.strike - totalPremiumPerLot;
      breakevenUpper = primaryStrike + totalPremiumPerLot;
    } else {
      breakevenLower = primaryStrike - totalPremiumPerLot;
      breakevenUpper = hedgeResult.hedgeLeg!.strike + totalPremiumPerLot;
    }
  }

  return {
    lotSize,
    primary: {
      strike: primaryStrike,
      side: primarySide,
      delta: primaryDelta,
      iv: primaryIv,
      oi: primaryOi,
      ...primaryPlan,
    },
    hedge: hedgeObj,
    summary: {
      capitalCap: capital,
      totalCost: +totalCost.toFixed(2),
      leftover: +(capital - totalCost).toFixed(2),
      combinedMaxLoss: +totalCost.toFixed(2),
      combinedMinLoss: +totalCost.toFixed(2),
      combinedGainAtT1: +combinedGainAtT1.toFixed(2),
      combinedGainAtT2: +combinedGainAtT2.toFixed(2),
      breakevenLower: breakevenLower !== null ? +breakevenLower.toFixed(2) : null,
      breakevenUpper: breakevenUpper !== null ? +breakevenUpper.toFixed(2) : null,
      note: "Primary leg profit is theoretically open-ended beyond Target 2 since it is a pure long option.",
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function normalize(value: number, min: number, max: number): number {
  if (max <= min) return 0.5;
  return clamp((value - min) / (max - min), 0, 1);
}

function percentileFloor(values: number[], pct: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * pct);
  return sorted[idx] ?? 0;
}

// ═══════════════════════════════════════════════════════════════════
// PICK HEDGE STRIKE — scored shortlist engine
// ═══════════════════════════════════════════════════════════════════

export function pickHedgeStrike(
  chainData: any[],
  spot: number,
  primaryStrike: number,
  primaryType: "CE" | "PE",
  primaryIv: number,
  primaryDelta: number,
  primaryPremium: number,
): HedgeSelection {
  const primaryLeg = {
    strike: primaryStrike,
    type: primaryType,
    premium: primaryPremium,
    delta: primaryDelta,
    iv: primaryIv,
  };

  // Determine hedge side (opposite of primary)
  const hedgeType: "CE" | "PE" = primaryType === "CE" ? "PE" : "CE";

  // Collect all OTM strikes on the hedge side
  const isCallHedge = hedgeType === "CE";
  const otmCandidates: { strike: number; leg: any }[] = [];

  for (const row of chainData) {
    const leg = row[hedgeType === "CE" ? "ce" : "pe"];
    if (!leg || !leg.ltp || leg.ltp <= 0) continue;

    // OTM filter: call hedge = strike above spot, put hedge = strike below spot
    if (isCallHedge ? row.strike <= spot : row.strike >= spot) continue;

    // Delta band filter
    const absDelta = Math.abs(leg.delta ?? 0);
    if (absDelta < HEDGE_CONFIG.DELTA_MIN || absDelta > HEDGE_CONFIG.DELTA_MAX) continue;

    otmCandidates.push({ strike: row.strike, leg });
  }

  if (otmCandidates.length === 0) {
    return {
      primaryLeg,
      hedgeLeg: null,
      fallbackWarning: "No OTM strikes within delta band (0.10–0.20). Consider a wider stop instead.",
    };
  }

  // --- Step 1: Filter by liquidity floor ---
  const allOi = otmCandidates.map(c => c.leg.oi ?? 0);
  const floor = percentileFloor(allOi, HEDGE_CONFIG.OI_PERCENTILE_FLOOR);

  let liquid = otmCandidates.filter(c => (c.leg.oi ?? 0) >= floor);

  // --- Step 5: Fallback if no candidate clears liquidity floor ---
  if (liquid.length === 0) {
    // Fall back to the highest-OI strike regardless of floor
    liquid = [otmCandidates.sort((a, b) => (b.leg.oi ?? 0) - (a.leg.oi ?? 0))[0]];
    const fallbackOi = liquid[0].leg.oi ?? 0;
    return {
      primaryLeg,
      hedgeLeg: scoreCandidate(liquid[0], otmCandidates, primaryIv, false),
      fallbackWarning:
        `Hedge liquidity is thin at this expiry (top OI strike only ${(fallbackOi / 1000).toFixed(0)}K) — consider a wider stop instead.`,
    };
  }

  // --- Step 2-3: Score each candidate and pick best ---
  const scored = liquid.map(c => scoreCandidate(c, otmCandidates, primaryIv, true));
  scored.sort((a, b) => b.totalScore - a.totalScore);

  return {
    primaryLeg,
    hedgeLeg: scored[0],
    totalScore: scored[0].totalScore,
  };
}

function scoreCandidate(
  candidate: { strike: number; leg: any },
  allOtm: { strike: number; leg: any }[],
  primaryIv: number,
  passedLiquidity: boolean,
): HedgeCandidate {
  const leg = candidate.leg;
  const reasons: string[] = [];

  // --- Liquidity score (normalized OI among all OTM candidates) ---
  const allOi = allOtm.map(c => c.leg.oi ?? 0);
  const oiMax = Math.max(...allOi, 1);
  const oiMin = Math.min(...allOi, 0);
  const rawLiquidity = normalize(leg.oi ?? 0, oiMin, oiMax);
  const liquidityScore = Math.round(rawLiquidity * HEDGE_CONFIG.WEIGHT_LIQUIDITY);
  if (passedLiquidity) {
    reasons.push(`adequate liquidity (OI ${formatNum(leg.oi ?? 0)})`);
  }

  // --- Cost efficiency: theta / premium (lower absolute decay per rupee = better) ---
  const theta = leg.theta ?? 0;
  const premium = leg.ltp ?? 1;
  const thetaRatio = premium > 0 ? Math.abs(theta) / premium : 0;
  // Normalize: lower thetaRatio = better. Cap at 2.0 for normalization.
  const rawCostEfficiency = 1 - clamp(thetaRatio / 2.0, 0, 1);
  const costEfficiencyScore = Math.round(rawCostEfficiency * HEDGE_CONFIG.WEIGHT_COST_EFFICIENCY);
  reasons.push(`low decay (θ ${theta.toFixed(1)} at ₹${premium.toFixed(0)} premium)`);

  // --- Relative IV: prefer hedge IV <= primary IV ---
  const hedgeIv = leg.iv ?? 0;
  let rawIv = 1;
  let ivReason = "IV in line with primary leg";
  if (hedgeIv > 0 && primaryIv > 0) {
    if (hedgeIv <= primaryIv) {
      rawIv = 1;
      ivReason = `IV ${hedgeIv.toFixed(1)}% ≤ primary ${primaryIv.toFixed(1)}% (fairly priced protection)`;
    } else if (hedgeIv > primaryIv * HEDGE_CONFIG.IV_PENALTY_RATIO) {
      rawIv = 0;
      ivReason = `IV ${hedgeIv.toFixed(1)}% > ${HEDGE_CONFIG.IV_PENALTY_RATIO}x primary ${primaryIv.toFixed(1)}% (overpriced hedge)`;
    } else {
      rawIv = 0.5;
      ivReason = `IV ${hedgeIv.toFixed(1)}% moderately above primary ${primaryIv.toFixed(1)}%`;
    }
  }
  const relativeIVScore = Math.round(rawIv * HEDGE_CONFIG.WEIGHT_RELATIVE_IV);
  reasons.push(ivReason);

  // --- Responsiveness: gamma bonus ---
  const gamma = leg.gamma ?? 0;
  // Normalize gamma among all candidates
  const allGamma = allOtm.map(c => Math.abs(c.leg.gamma ?? 0));
  const gammaMax = Math.max(...allGamma, 0.0001);
  const rawResponsiveness = normalize(Math.abs(gamma), 0, gammaMax);
  const responsivenessScore = Math.round(rawResponsiveness * HEDGE_CONFIG.WEIGHT_RESPONSIVENESS);
  if (gamma > 0.001) {
    reasons.push(`responsive (γ ${gamma.toFixed(4)})`);
  }

  // --- Momentum caution: penalize strong OI unwinding ---
  const oiChg = leg.oiChg ?? 0;
  let rawMomentum = 1;
  if (oiChg < HEDGE_CONFIG.OI_UNWIND_THRESHOLD) {
    rawMomentum = 0;
    reasons.push(`⚠ OI unwinding (OI Chg ${formatNum(oiChg)}) — hedge may lose protection`);
  } else if (oiChg < 0) {
    rawMomentum = 0.5;
    reasons.push(`minor OI decline (OI Chg ${formatNum(oiChg)})`);
  } else {
    reasons.push(`OI adding (OI Chg +${formatNum(oiChg)})`);
  }
  const momentumScore = Math.round(rawMomentum * HEDGE_CONFIG.WEIGHT_MOMENTUM_CAUTION);

  const totalScore = liquidityScore + costEfficiencyScore + relativeIVScore + responsivenessScore + momentumScore;

  return {
    strike: candidate.strike,
    type: candidate.leg.type || (candidate.strike > 0 ? "PE" : "CE"),
    delta: leg.delta ?? 0,
    premium: leg.ltp ?? 0,
    oi: leg.oi ?? 0,
    oiChg: leg.oiChg ?? 0,
    theta: leg.theta ?? 0,
    gamma: leg.gamma ?? 0,
    iv: leg.iv ?? 0,
    liquidityScore,
    costEfficiencyScore,
    relativeIVScore,
    responsivenessScore,
    momentumScore,
    totalScore,
    reasons,
  };
}

function formatNum(n: number): string {
  if (Math.abs(n) >= 100000) return (n / 100000).toFixed(1) + "L";
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(0) + "K";
  return n.toFixed(0);
}
