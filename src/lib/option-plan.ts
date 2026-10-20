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
//
// THE P0 FIX (0 lots is representable, 2026-10-20):
//   The old sizing was `Math.max(1, …)` — a contract that could not be afforded was
//   still traded as ONE lot. RELIANCE CE ₹90 × lot 500 → 1 lot → ₹45,000 deployed
//   (2.25× the ₹20,000 cap); SBIN CE ₹300 × lot 750 → 1 lot → ₹2,25,000 deployed
//   (11× the cap, 1.8× the whole ₹25,000 account).
//   NOW: the sizing returns the HONEST FLOOR (0 when the contract does not fit the
//   per-trade budget), the plan reports `lots: 0` with `deployed: 0` and
//   `riskAmount: 0` (nothing is committed), and every caller bails on 0 lots.
//   A plan NEVER reports a deployment larger than the cap.
import { GATE_CONFIG } from "./agent-brain-gate";

export const PLAN_CONFIG = {
  /** Rupee risk as a fraction of the amount DEPLOYED in the trade (0.20 → ₹10k ⇒ ₹2k).
   *  Sourced from GATE_CONFIG.riskPctOfTrade so there is exactly ONE definition. */
  riskPctOfDeployed: GATE_CONFIG.riskPctOfTrade / 100,
  /** Target ladder in R multiples: TP1 2R, TP2 3R, TP3 4R (R:R 1:2 / 1:3 / 1:4). */
  targetMultipliers: [2, 3, 4] as number[],
  /** Hard cap: the stop may never exceed this % of the premium. */
  maxStopPctOfPremium: 0.35,
  /** Floor: the stop must be at least this many ticks (tick = ₹0.05 for NSE options). */
  minStopTicks: 8,
  tickSize: 0.05,
  /** Per-trade deployment used when the caller does not say otherwise (the live rule). */
  defaultDeployedAmount: GATE_CONFIG.tradeBudget,
  /** Plan the gates accept: option R:R after the plan must clear this. */
  minOptionRR: GATE_CONFIG.minOptionRR,
  /** HARD CAP: the ₹ DEPLOYED in one trade may never exceed this (the per-trade budget). */
  maxDeployedAmount: GATE_CONFIG.tradeBudget,
  /**
   * RECORDING CONVENTION — NOT A SIZING RULE.
   *
   * The audit ledger records AT LEAST one lot so a candidate stays visible in
   * the ledger even when the sizing engine produced none ("minimum 1 lot even
   * if that alone exceeds the budget"). That rule belongs to the RECORDER —
   * trade-audit/src/utils/sizing.ts → defaultQuantity() — and it must never be
   * used to SIZE a trade: a 0-lot candidate is a NO TRADE, not a 1-lot trade.
   * This constant only names the concept so the two are never confused.
   */
  recordingMinimumLots: 1,
} as const;

export interface OptionPlanInput {
  symbol: string;
  optionType: "CE" | "PE";
  entryPremium: number;        // premium paid per unit
  lotSize: number;
  /** Lots to take. Omit to size from the deployment budget. 0 = explicitly NO trade. */
  lots?: number;
  deployedAmount?: number;     // ₹ budget to size from (default: the live ₹20k rule)
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
  lots: number;                // 0 = NOT tradable (the contract does not fit the cap)
  deployed: number;            // ₹ ACTUALLY deployed (0 when not tradable)
  riskAmount: number;          // ₹ at risk (ACTUAL, after the cap; 0 when not tradable)
  riskPoints: number;          // premium points per R
  rr: number;                  // TP1 R multiple (e.g. 2)
  rupee: { tp1: number; tp2: number; tp3: number };  // ₹ P&L at each target (0 when not tradable)
  stopPctOfPremium: number;
  notes: string[];
  /** false when the contract does not fit the per-trade budget (lots === 0). */
  tradable: boolean;
  /** ₹ for ONE lot (entry × lot size) — the smallest possible commitment. */
  lotCost: number;
}

/**
 * The sizing verdict for one option contract.
 * `lots: 0` is a REAL, REPRESENTABLE outcome: the contract does not fit the
 * per-trade budget, so nothing is deployed and nothing is at risk.
 */
export interface OptionSizing {
  lots: number;                // 0 = NOT tradable
  units: number;               // lots × lot size (0 when not tradable)
  costPerLot: number;          // ₹ for one lot
  budget: number;              // the sizing budget used
  deployed: number;            // ₹ ACTUALLY committed (0 when not tradable)
  riskAmount: number;          // ₹ at risk (0 when not tradable)
  tradable: boolean;
  /** true when the lots were derived from the budget (not stated by the caller). */
  sizedFromBudget: boolean;
  reason?: string;             // why 0 lots (human readable)
}

/**
 * Size the position from the deployment budget (the live rule).
 *
 * The HONEST FLOOR: 0 when the premium of ONE lot does not fit the budget.
 * The old `Math.max(1, …)` made an unaffordable contract tradable as one lot —
 * that is the P0 this file fixes. A caller that wants "at least one lot" must
 * say so explicitly (see PLAN_CONFIG.recordingMinimumLots — a RECORDING rule).
 */
export function lotsForBudget(entryPremium: number, lotSize: number, deployedAmount = PLAN_CONFIG.defaultDeployedAmount): number {
  const entry = Number(entryPremium);
  const lot = Number(lotSize);
  const budget = Number(deployedAmount);
  if (!(entry > 0) || !(lot > 0) || !(budget > 0)) return 0;
  return Math.floor(budget / (entry * lot));
}

/**
 * The sizing verdict (lots / units / ₹ committed / ₹ at risk) for one contract.
 * The ₹ DEPLOYED never exceeds the per-trade cap (PLAN_CONFIG.maxDeployedAmount).
 */
export function sizeOptionTrade(input: {
  entryPremium: number;
  lotSize: number;
  deployedAmount?: number;
  lots?: number;
}): OptionSizing {
  const entry = Number(input.entryPremium);
  const lotSize = Number(input.lotSize);
  const cap = PLAN_CONFIG.maxDeployedAmount;
  const budget = Math.min(
    Number(input.deployedAmount) > 0 ? Number(input.deployedAmount) : PLAN_CONFIG.defaultDeployedAmount,
    cap,
  );
  if (!(entry > 0) || !(lotSize > 0)) {
    return {
      lots: 0, units: 0, costPerLot: 0, budget,
      deployed: 0, riskAmount: 0, tradable: false, sizedFromBudget: false,
      reason: "unknown premium or lot size",
    };
  }

  const costPerLot = entry * lotSize;
  const requested = input.lots != null && Number.isFinite(Number(input.lots))
    ? Math.floor(Number(input.lots))
    : undefined;
  const sizedFromBudget = requested == null;
  const lots = requested != null ? requested : Math.floor(budget / costPerLot);

  if (lots < 1) {
    return {
      lots: 0, units: 0, costPerLot, budget,
      deployed: 0, riskAmount: 0, tradable: false, sizedFromBudget,
      reason: requested != null
        ? "0 lots requested"
        : `1 lot costs ₹${Math.round(costPerLot).toLocaleString("en-IN")} — over the ₹${Math.round(budget).toLocaleString("en-IN")} per-trade budget`,
    };
  }

  const units = lots * lotSize;
  const deployed = entry * units;
  if (deployed > cap) {
    // The CAP is the hard limit — a plan never reports a deployment above it.
    return {
      lots: 0, units: 0, costPerLot, budget,
      deployed: 0, riskAmount: 0, tradable: false, sizedFromBudget,
      reason: `${lots} lot × ${lotSize} = ₹${Math.round(deployed).toLocaleString("en-IN")} — over the ₹${Math.round(cap).toLocaleString("en-IN")} per-trade cap`,
    };
  }

  return {
    lots,
    units,
    costPerLot,
    budget,
    deployed,
    riskAmount: deployed * PLAN_CONFIG.riskPctOfDeployed,
    tradable: true,
    sizedFromBudget,
  };
}

export function buildOptionPlan(input: OptionPlanInput): OptionPlan | null {
  const entry = Number(input.entryPremium);
  const lotSize = Number(input.lotSize);
  if (!(entry > 0) || !(lotSize > 0)) return null;

  const notes: string[] = [];
  const sizing = sizeOptionTrade({
    entryPremium: entry,
    lotSize,
    deployedAmount: input.deployedAmount,
    lots: input.lots,
  });

  const tradable = sizing.tradable;
  // Nothing is committed when the contract does not fit the cap.
  const lots = tradable ? sizing.lots : 0;
  const units = tradable ? sizing.units : 0;
  const actualDeployed = tradable ? sizing.deployed : 0;
  // The geometry is priced on ONE lot when there is no trade: the per-unit levels
  // (entry / stop / targets) stay meaningful, only the ₹ amounts are 0.
  const sizingUnits = tradable ? units : lotSize;

  const maxStopPct = input.maxStopPctOfPremium ?? PLAN_CONFIG.maxStopPctOfPremium;
  const minStopTicks = input.minStopTicks ?? PLAN_CONFIG.minStopTicks;

  // Rupee risk → premium points per unit
  const wantedRisk = Number(input.riskAmount) > 0
    ? Number(input.riskAmount)
    : (tradable ? actualDeployed : entry * lotSize) * PLAN_CONFIG.riskPctOfDeployed;
  let riskPoints = wantedRisk / sizingUnits;

  // Guardrail 1: never let the stop exceed maxStopPct of the premium.
  const maxPoints = entry * maxStopPct;
  if (riskPoints > maxPoints) {
    riskPoints = maxPoints;
    notes.push(`stop capped at ${(maxStopPct * 100).toFixed(0)}% of premium — rupee risk reduced to ₹${Math.round(riskPoints * sizingUnits).toLocaleString("en-IN")}`);
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
    const gain = tradable ? (px - entry) * units : 0;
    if (targets.length === 1) rupee.tp1 = gain;
    else if (targets.length === 2) rupee.tp2 = gain;
    else rupee.tp3 = gain;
  }
  if (!targets.length) return null;

  const riskAmount = tradable ? riskPoints * units : 0;
  const rr = targets.length ? Math.abs(targets[0] - entry) / Math.abs(entry - stopLoss) : 0;
  if (rr < PLAN_CONFIG.minOptionRR) {
    notes.push(`R:R ${rr.toFixed(2)} is below the gate's ${PLAN_CONFIG.minOptionRR} — this plan will be blocked`);
  }
  if (!tradable) {
    notes.push(
      `0 lots — ${sizing.reason} → NO TRADE (₹0 deployed, ₹0 at risk)`
    );
  } else if (!sizing.sizedFromBudget && Math.abs(actualDeployed - sizing.budget) > 1) {
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
    tradable,
    lotCost: sizing.costPerLot,
  };
}

function roundTick(x: number): number {
  return Math.round(x / PLAN_CONFIG.tickSize) * PLAN_CONFIG.tickSize;
}
