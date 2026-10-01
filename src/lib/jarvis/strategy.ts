// Picks ONE named strategy (S1-S8) given the regime and level map, mirroring
// references/strategies.md from the nse-options-signal skill. This is a
// classifier for "which playbook fits", not an execution engine — the
// actual entry/SL/TP numbers are built in orchestrator.ts.
import type { GreeksResult, LevelsResult, StrategyId } from "./types";

export type Regime = "trend" | "range" | "event";

export function classifyRegime(greeks: GreeksResult, vix: number | undefined, gapPct: number): Regime {
  if (vix !== undefined && vix > 25) return "event";
  if (greeks.regime === "trending" && Math.abs(gapPct) > 0.4) return "trend";
  if (greeks.regime === "pinned") return "range";
  return "trend";
}

export interface StrategyPick {
  id: StrategyId;
  name: string;
  rationale: string;
}

const STRATEGY_NAMES: Record<StrategyId, string> = {
  S1: "OI wall rejection (range fade)",
  S2: "OI wall breakout with unwinding",
  S3: "Liquidity sweep reversal",
  S4: "Opening range breakout",
  S5: "VWAP trend pullback",
  S6: "Short-covering / writers' panic",
  S7: "Overnight / next-day gap bias",
  S8: "Defined-risk debit spread",
};

/**
 * `atWall`: true if spot is within 0.15% of oiResistance/oiSupport.
 * `wallOiRising`: OI change sign at the touched wall (true = writers defending -> S1; false = writers leaving -> S2).
 * `sweptLevel`: name of a liquidity level (pdh/pdl/orHigh/orLow/round) whose wick was pierced and closed back inside, or null.
 * `heavyTheta`: true if greeks.atmThetaPerDayPctOfPremium > 8 or hoursToExpiry < 3.
 */
export function pickStrategy(params: {
  regime: Regime;
  levels: LevelsResult;
  greeks: GreeksResult;
  atWall: "resistance" | "support" | null;
  wallOiRising: boolean | null;
  sweptLevel: string | null;
  priceHeldBeyondWall: boolean;
  orBreakout: "up" | "down" | null;
  vwapPullbackDirection: "up" | "down" | null;
  shortCoveringDirection: "up" | "down" | null;
  isPostClose: boolean;
  vix: number | undefined;
}): StrategyPick | null {
  const { regime, atWall, wallOiRising, sweptLevel, priceHeldBeyondWall, orBreakout,
          vwapPullbackDirection, shortCoveringDirection, isPostClose, greeks, vix } = params;

  const heavyTheta = (greeks.atmThetaPerDayPctOfPremium ?? 0) > 8 || greeks.hoursToExpiry < 3;
  if (regime === "event" || heavyTheta || (vix !== undefined && vix > 18)) {
    return { id: "S8", name: STRATEGY_NAMES.S8, rationale: "Rich premiums / event risk / heavy theta -> defined-risk spread over naked buy." };
  }
  if (isPostClose) {
    return { id: "S7", name: STRATEGY_NAMES.S7, rationale: "Post 15:30: set next-session bias only, do not hold options overnight." };
  }
  if (sweptLevel && !priceHeldBeyondWall) {
    return { id: "S3", name: STRATEGY_NAMES.S3, rationale: `Wick through ${sweptLevel} closed back inside -> liquidity-sweep reversal.` };
  }
  if (atWall && priceHeldBeyondWall && wallOiRising === false) {
    return { id: "S2", name: STRATEGY_NAMES.S2, rationale: "Held beyond OI wall with writers unwinding -> breakout continuation." };
  }
  if (atWall && wallOiRising === true && regime !== "trend") {
    return { id: "S1", name: STRATEGY_NAMES.S1, rationale: "Touched OI wall, writers still defending, range regime -> fade." };
  }
  if (orBreakout) {
    return { id: "S4", name: STRATEGY_NAMES.S4, rationale: `Opening-range ${orBreakout} break with gap/bias context.` };
  }
  if (vwapPullbackDirection && regime === "trend") {
    return { id: "S5", name: STRATEGY_NAMES.S5, rationale: `Trend day, pullback to VWAP holding ${vwapPullbackDirection} side.` };
  }
  if (shortCoveringDirection) {
    return { id: "S6", name: STRATEGY_NAMES.S6, rationale: `Price/OI mismatch: ${shortCoveringDirection} move on unwinding open interest.` };
  }
  return null; // no clean setup -> caller should return NO_TRADE
}
