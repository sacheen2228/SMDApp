// option-plan.ts
// ONE plan builder for every option signal: the stop is a RUPEE amount (a % of what
// the trade deploys) and the targets are clean R multiples of that risk.
//
// THE BUG THIS REPLACES: intraday-scanner / sdm-recommendation / sdm-engine /
// morning-scan each hardcoded their own % of premium (SL −15%, TP1 +15% → R:R 1:1).
// A 1:1 plan needs >50% win-rate BEFORE costs; measured on the ledger those engines
// ran 21–24% (PF 0.81–1.05) while the one engine with a 1:3.2 plan ran 64% (PF 4.70).
//
// RULE (user-defined, 2026-10-20):
//   "if I spend ₹10,000 I take ₹2,000 of risk and make ₹3,000"  →
//   riskAmount  = deployedAmount × riskPctOfDeployed   (default 20% → ₹10k → ₹2k)
//   riskPoints  = riskAmount / units
//   stopLoss    = entry ∓ riskPoints
//   targets     = entry ± {2R, 3R, 4R}   (R:R 1:2 / 1:3 / 1:4)
//
// Guardrails (they never widen the risk beyond what the user signed up for):
//   - the stop is capped at maxStopPctOfPremium of the premium; when the cap binds,
//     the ACTUAL rupee risk is reduced and reported (never silently increased)
//   - the stop is floored at minStopTicks ticks, so a ₹4 premium option is not
//     stopped out by a single tick of noise
//   - targets that are unreachable (multiples × risk > premium) are dropped, and the
//     plan says so instead of quoting a target the option can never reach
import { GATE_CONFIG } from "./agent-brain-gate";

export const PLAN_CONFIG = {
  /** Rupee risk as a fraction of the amount DEPLOYED in the trade (0.20 → ₹10k ⇒ ₹2k). */
  riskPctOfDeployed: 0.20,
  /** Target ladder in R multiples: TP1 2R, TP2 3R, TP3 4R (R:R 1:2 / 1:3 / 1:4). */
  targetMultipliers: [2, 3, 4] as number[],
  /** Hard cap: the stop may never exceed this % of the premium. */
  maxStopPctOfPremium: 0.35,
  /** Floor: the stop must be at least this many ticks (tick = ₹0.05 for NSE options). */
  minStopTicks: 8,
  tickSize: 0.05,
  /** Per-trade deployment used when the caller does not say otherwise (the live rule). */
  defaultDeployedAmount: 20_000,
  /** Plan the gates accept: option R:R after the plan must clear this. */
  minOptionRR: GATE_CONFIG.minOptionRR,
} as const;

export interface OptionPlanInput {
  symbol: string;
  optionType: "CE" | "PE";
  entryPremium: number;        // premium paid per unit
  lotSize: number;
  lots?: number;               // when omitted, sized from the deployment budget
  deployedAmount?: number;     // ₹ deployed (default: the live ₹20k budget rule)
  riskAmount?: number;         // ₹ risk (default: deployedAmount × riskPctOfDeployed)
  targetMultipliers?: number[];
  maxStopPctOfPremium?: number;
  minStopTicks?: number;
}

export interface OptionPlan {
  entry: number;
  stopLoss: number;
  targets: number[];           // [2R, 3R, 4R] (reachable ones only)
  units: number;
  lots: number;
  deployed: number;            // ₹ deployed
  riskAmount: number;          // ₹ at risk (ACTUAL, after the cap)
  riskPoints: number;          // premium points per R
  rr: number;                  // TP1 R multiple (e.g. 2)
  rupee: { tp1: number; tp2: number; tp3: number };  // ₹ P&L at each target
  stopPctOfPremium: number;
  notes: string[];
}

/** Size the position from the deployment budget (the live rule) — lots & amount live here. */
export function lotsForBudget(entryPremium: number, lotSize: number, deployedAmount = PLAN_CONFIG.defaultDeployedAmount): number {
  if (!(entryPremium > 0) || !(lotSize > 0)) return 1;
  return Math.max(1, Math.floor(deployedAmount / (entryPremium * lotSize)));
}

export function buildOptionPlan(input: OptionPlanInput): OptionPlan | null {
  const entry = Number(input.entryPremium);
  const lotSize = Number(input.lotSize);
  if (!(entry > 0) || !(lotSize > 0)) return null;

  const deployed = Number(input.deployedAmount) > 0
    ? Number(input.deployedAmount)
    : entry * lotSize * lotsForBudget(entry, lotSize);
  const lots = input.lots && input.lots > 0 ? Math.floor(input.lots) : Math.max(1, Math.round(deployed / (entry * lotSize)));
  const units = lots * lotSize;
  const actualDeployed = entry * units;

  const notes: string[] = [];
  const maxStopPct = input.maxStopPctOfPremium ?? PLAN_CONFIG.maxStopPctOfPremium;
  const minStopTicks = input.minStopTicks ?? PLAN_CONFIG.minStopTicks;

  // Rupee risk → premium points per unit
  const wantedRisk = Number(input.riskAmount) > 0
    ? Number(input.riskAmount)
    : actualDeployed * PLAN_CONFIG.riskPctOfDeployed;
  let riskPoints = wantedRisk / units;

  // Guardrail 1: never let the stop exceed maxStopPct of the premium.
  const maxPoints = entry * maxStopPct;
  if (riskPoints > maxPoints) {
    riskPoints = maxPoints;
    notes.push(`stop capped at ${(maxStopPct * 100).toFixed(0)}% of premium — rupee risk reduced to ₹${Math.round(riskPoints * units).toLocaleString("en-IN")}`);
  }
  // Guardrail 2: never tighter than N ticks (noise floor).
  const minPoints = minStopTicks * PLAN_CONFIG.tickSize;
  if (riskPoints < minPoints) {
    riskPoints = minPoints;
    notes.push(`stop widened to the ${minStopTicks}-tick noise floor (${minPoints.toFixed(2)} pts)`);
  }
  if (riskPoints >= entry) {
    notes.push("risk exceeds the premium — no valid stop inside the option's value");
    return null;
  }

  const isCall = input.optionType === "CE";
  const sign = isCall ? -1 : 1;
  const stopLoss = roundTick(entry + sign * riskPoints);

  // Targets: 2R / 3R / 4R, dropping the unreachable ones.
  const mults = input.targetMultipliers ?? [...PLAN_CONFIG.targetMultipliers];
  const targets: number[] = [];
  const rupee = { tp1: 0, tp2: 0, tp3: 0 };
  for (const k of mults) {
    const pts = riskPoints * k;
    if (pts >= entry) { notes.push(`${k}R target unreachable (${(pts).toFixed(2)} pts ≥ premium ${entry}) — dropped`); continue; }
    const px = roundTick(entry - sign * pts);
    targets.push(px);
    const gain = (px - entry) * units;
    if (targets.length === 1) rupee.tp1 = gain;
    else if (targets.length === 2) rupee.tp2 = gain;
    else rupee.tp3 = gain;
  }
  if (!targets.length) return null;

  const riskAmount = riskPoints * units;
  const rr = targets.length ? Math.abs(targets[0] - entry) / Math.abs(entry - stopLoss) : 0;
  if (rr < PLAN_CONFIG.minOptionRR) {
    notes.push(`R:R ${rr.toFixed(2)} is below the gate's ${PLAN_CONFIG.minOptionRR} — this plan will be blocked`);
  }
  if (Math.abs(actualDeployed - deployed) > 1) {
    notes.push(`deployed ₹${Math.round(actualDeployed).toLocaleString("en-IN")} (${lots} lot × ${lotSize})`);
  }

  return {
    entry: roundTick(entry),
    stopLoss,
    targets,
    units,
    lots,
    deployed: actualDeployed,
    riskAmount,
    riskPoints,
    rr,
    rupee,
    stopPctOfPremium: riskPoints / entry,
    notes,
  };
}

function roundTick(x: number): number {
  return Math.round(x / PLAN_CONFIG.tickSize) * PLAN_CONFIG.tickSize;
}
