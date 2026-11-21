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
//   stopLoss    = entry − riskPoints   (LONG-option geometry for BOTH CE and PE)
//   targets     = entry + {2R, 3R, 4R} (R:R 1:2 / 1:3 / 1:4)
//
// LONG-OPTION GEOMETRY (remediation R1, 2026-10-31 — audit defect D-1):
//   A bought option — CE or PE — LOSES when the premium falls below what you
//   paid and WINS when it rises. The stop therefore sits BELOW the premium
//   paid and the targets ABOVE it, for both letters. The old
//   `sign = isCall ? -1 : 1` "mirror" put a PE's stop above its entry and its
//   targets below (SL ₹46.9 on a ₹39.1 entry), which is short-premium
//   geometry mislabelled "BUY PE": the displayed stop was a +20% profit exit
//   and the "targets" were −40%/−60%/−80% losses. R:R is now SIGNED
//   (risk = entry − stop), so a wrong-side stop reports rr 0 and trips the
//   gate note instead of being Math.abs'd into a plausible 2.0.
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
import { impliedVolFromPremium, parseExpiryToYears, calculateGreeks } from "./greeks";

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
  /** ₹ DEPLOYED per trade when the caller does not say otherwise — a SIZE, not a
   *  cap (user directive 2026-11-21: no fixed capital / lot-count restriction
   *  may decide whether a trade is eligible). */
  defaultDeployedAmount: GATE_CONFIG.tradeBudget,
  /** Plan the gates accept: option R:R after the plan must clear this. */
  minOptionRR: GATE_CONFIG.minOptionRR,
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
 * `lots: 0` is a REAL, REPRESENTABLE outcome: the caller explicitly asked
 * for no trade, or the premium / lot size is unknown.
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
  /** true when the deployment is above the sizing budget (1 lot already costs more) */
  overBudget: boolean;
  reason?: string;             // why 0 lots / why over budget (human readable)
}

/**
 * Size the position from the deployment budget (the live rule).
 *
 * THE 1-LOT FLOOR: the deployment budget decides the SIZE; the market stop
 * decides the RISK. A contract whose one lot costs more than the budget is
 * still tradable as ONE lot — the deployment is reported honestly and the
 * over-budget flag is raised. Capital never refuses a valid contract
 * (user directive 2026-11-21).
 */
export function lotsForBudget(entryPremium: number, lotSize: number, deployedAmount = PLAN_CONFIG.defaultDeployedAmount): number {
  const entry = Number(entryPremium);
  const lot = Number(lotSize);
  const budget = Number(deployedAmount);
  if (!(entry > 0) || !(lot > 0) || !(budget > 0)) return 0;
  return Math.max(1, Math.floor(budget / (entry * lot)));
}

/**
 * The sizing verdict (lots / units / ₹ committed / ₹ at risk) for one contract.
 * The ₹ DEPLOYED is reported as it is — it is never silently forced down to a
 * budget, and it never refuses the trade.
 */
export function sizeOptionTrade(input: {
  entryPremium: number;
  lotSize: number;
  deployedAmount?: number;
  lots?: number;
}): OptionSizing {
  const entry = Number(input.entryPremium);
  const lotSize = Number(input.lotSize);
  const budget = Number(input.deployedAmount) > 0 ? Number(input.deployedAmount) : PLAN_CONFIG.defaultDeployedAmount;
  if (!(entry > 0) || !(lotSize > 0)) {
    return {
      lots: 0, units: 0, costPerLot: 0, budget,
      deployed: 0, riskAmount: 0, tradable: false, sizedFromBudget: false,
      overBudget: false,
      reason: "unknown premium or lot size",
    };
  }

  const costPerLot = entry * lotSize;
  const requested = input.lots != null && Number.isFinite(Number(input.lots))
    ? Math.floor(Number(input.lots))
    : undefined;
  const sizedFromBudget = requested == null;
  const affordable = Math.floor(budget / costPerLot);
  const lots = requested != null ? requested : Math.max(1, affordable);

  if (lots < 1) {
    return {
      lots: 0, units: 0, costPerLot, budget,
      deployed: 0, riskAmount: 0, tradable: false, sizedFromBudget,
      overBudget: false,
      reason: requested != null
        ? "0 lots requested"
        : "no tradable size",
    };
  }

  const units = lots * lotSize;
  const deployed = entry * units;
  const overBudget = deployed > budget;

  return {
    lots,
    units,
    costPerLot,
    budget,
    deployed,
    // risk = riskPct % of the amount DEPLOYED — no fixed ₹ cap (user rule,
    // 2026-11-17: ₹10k deployed → ₹2k risk; the lots decide the deployment).
    riskAmount: deployed * PLAN_CONFIG.riskPctOfDeployed,
    tradable: true,
    sizedFromBudget,
    overBudget,
    reason: overBudget
      ? `1 lot costs ₹${Math.round(costPerLot).toLocaleString("en-IN")} — over the ₹${Math.round(budget).toLocaleString("en-IN")} default deployment`
      : undefined,
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
  // Nothing is committed when the caller asked for no trade.
  const lots = tradable ? sizing.lots : 0;
  const units = tradable ? sizing.units : 0;
  const actualDeployed = tradable ? sizing.deployed : 0;
  // The geometry is priced on ONE lot when there is no trade: the per-unit levels
  // (entry / stop / targets) stay meaningful, only the ₹ amounts are 0.
  const sizingUnits = tradable ? units : lotSize;

  const maxStopPct = input.maxStopPctOfPremium ?? PLAN_CONFIG.maxStopPctOfPremium;
  const minStopTicks = input.minStopTicks ?? PLAN_CONFIG.minStopTicks;

  // Rupee risk → premium points per unit. 20% of deployed, no fixed cap:
  // a wider deployment widens the stop in proportion (user rule 2026-11-17).
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

  // LONG-OPTION GEOMETRY FOR BOTH LETTERS (remediation R1, 2026-10-31 —
  // audit defect D-1, pinned by tests/option-plan.test.ts). A bought option —
  // CE or PE — LOSES when the premium falls: stop BELOW entry, targets ABOVE.
  // A bought PE PROFITS when the premium rises (spot falls), so a stop ABOVE
  // the entry was a +20% profit exit mislabelled "SL" and the "targets" below
  // the entry were losses — short-premium geometry on a BUY plan. The mirror
  // (`isCall ? entry - riskPoints : entry + riskPoints`) regressed back in
  // 45d9054; the in-file header still documented the fix, the code had lost it.
  const isCall = input.optionType === "CE";
  const stopLoss = roundTick(entry - riskPoints);

  // Targets: 2R / 3R / 4R ABOVE the entry, dropping the unreachable ones.
  const mults = input.targetMultipliers ?? [...PLAN_CONFIG.targetMultipliers];
  const targets: number[] = [];
  const rupee = { tp1: 0, tp2: 0, tp3: 0 };
  for (const k of mults) {
    const pts = riskPoints * k;
    if (pts >= entry) { notes.push(`${k}R target unreachable (${(pts).toFixed(2)} pts ≥ premium ${entry}) — dropped`); continue; }
    const px = roundTick(entry + pts);
    targets.push(px);
    const gain = tradable ? (px - entry) * units : 0;
    if (targets.length === 1) rupee.tp1 = gain;
    else if (targets.length === 2) rupee.tp2 = gain;
    else rupee.tp3 = gain;
  }
  if (!targets.length) return null;

  const riskAmount = tradable ? riskPoints * units : 0;
  // SIGNED R:R: risk = |entry − stop|, reward = |target1 − entry|.
  const risk = Math.abs(entry - stopLoss);
  const reward = targets.length ? Math.abs(targets[0] - entry) : 0;
  const rr = risk > 0 && reward > 0 ? reward / risk : 0;
  if (rr < PLAN_CONFIG.minOptionRR) {
    notes.push(`R:R ${rr.toFixed(2)} is below the gate's ${PLAN_CONFIG.minOptionRR} — this plan will be blocked`);
  }
  if (!tradable) {
    notes.push(
      `0 lots — ${sizing.reason} → NO TRADE (₹0 deployed, ₹0 at risk)`
    );
  } else if (sizing.overBudget) {
    notes.push(
      `${lots} lot × ${lotSize} = ₹${Math.round(actualDeployed).toLocaleString("en-IN")} deployed — one lot is above the ₹${Math.round(sizing.budget).toLocaleString("en-IN")} default deployment`,
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
  // `Math.round(x / tick) * tick` leaves float noise behind (938 * 0.05 =
  // 46.900000000000006), which then leaks into every displayed SL/TP.
  // The final toFixed(2) snaps it back to the tick grid.
  return Number((Math.round(x / PLAN_CONFIG.tickSize) * PLAN_CONFIG.tickSize).toFixed(2));
}

// ─────────────────────────────────────────────────────────────
// STRUCTURE-DERIVED OPTION PLAN (user directive 2026-11-21)
//
// The stop must come from the MARKET STRUCTURE (the underlying's
// invalidation level), not from a fixed % of the premium, and the 3R/4R
// targets may only be quoted when live data confirms the move.
//
// The underlying's structural stop/targets are repriced onto the option
// with the live premium (implied vol inverted from the chain), so the
// option's own R:R is measured, not assumed.
// ─────────────────────────────────────────────────────────────

export interface StructureConfirmation {
  priceAction?: boolean;
  ema?: boolean;
  vwapVolume?: boolean;
  oiChain?: boolean;
  srLiquidity?: boolean;
  atr?: boolean;
  underlyingPremium?: boolean;
}

export interface StructureOptionPlanInput {
  symbol: string;
  optionType: "CE" | "PE";
  entryPremium: number;
  strike: number;
  expiry: string;                 // YYYY-MM-DD
  lotSize: number;
  underlying: {
    entry: number;
    stop: number;
    target1: number;
    target2?: number;
    target3?: number;
  };
  deployedAmount?: number;
  confirmation?: StructureConfirmation;
  now?: Date;
}

export interface StructureOptionPlan {
  ok: boolean;
  /** Why the structure plan could not be used (the caller falls back only on
   *  "no_structure_data" — an R:R below the floor is a REJECT, not a fallback). */
  reason?: "no_structure_data" | "rr_below_floor" | "invalid_geometry" | "unknown_lot";
  message?: string;
  entry: number;
  stopLoss: number;
  targets: number[];
  rr: number;
  lots: number;
  units: number;
  deployed: number;
  riskAmount: number;
  confirmedCount: number;
  notes: string[];
  tradable: boolean;
}

export function countConfirmations(confirmation?: StructureConfirmation): number {
  if (!confirmation) return 0;
  return Object.values(confirmation).filter(Boolean).length;
}

export function buildStructureOptionPlan(input: StructureOptionPlanInput): StructureOptionPlan {
  const premium = Number(input.entryPremium);
  const lotSize = Number(input.lotSize);
  const notes: string[] = [];
  const confirmedCount = countConfirmations(input.confirmation);

  const base: StructureOptionPlan = {
    ok: false,
    entry: premium,
    stopLoss: 0,
    targets: [],
    rr: 0,
    lots: 0,
    units: 0,
    deployed: 0,
    riskAmount: 0,
    confirmedCount,
    notes,
    tradable: false,
  };

  if (!(premium > 0) || !(input.strike > 0) || !(lotSize > 0) || !input.expiry) {
    return { ...base, reason: "no_structure_data", message: "no live premium / strike / lot size" };
  }

  const u = input.underlying;
  if (!(u.entry > 0) || !(u.stop > 0) || !(u.target1 > 0)) {
    return { ...base, reason: "no_structure_data", message: "no underlying structure (entry/stop/target)" };
  }

  const isCall = input.optionType === "CE";
  const entry = roundTick(premium);

  // The UNDERLYING's own R:R decides whether the setup has room at all.
  const underlyingRisk = Math.abs(u.entry - u.stop);
  const underlyingReward = Math.abs(u.target1 - u.entry);
  const structureRR = underlyingRisk > 0 ? underlyingReward / underlyingRisk : 0;
  if (!(underlyingRisk > 0) || !(underlyingReward > 0)) {
    return { ...base, reason: "invalid_geometry", message: "underlying structure has no risk/reward" };
  }
  if (structureRR < PLAN_CONFIG.minOptionRR) {
    return {
      ...base,
      reason: "rr_below_floor",
      message: `structure R:R 1:${structureRR.toFixed(2)} is below the 1:${PLAN_CONFIG.minOptionRR} floor`,
    };
  }

  // The premium's stop distance is the UNDERLYING's structural distance mapped
  // through the option's delta (first order). A full Black-Scholes reprice of
  // the stop was tried and rejected: near expiry the gamma turns a 4%
  // underlying stop into a 35% premium stop and a +130% target — a plan the
  // option cannot reach in a session.
  const tte = parseExpiryToYears(input.expiry, input.now);
  if (tte == null) {
    return { ...base, reason: "no_structure_data", message: `unparseable expiry ${input.expiry}` };
  }
  const iv = impliedVolFromPremium(premium, u.entry, input.strike, tte, isCall);
  const delta = iv == null ? 0 : Math.abs(calculateGreeks(u.entry, input.strike, tte, iv, isCall).delta);
  if (!(delta > 0.05)) {
    return { ...base, reason: "no_structure_data", message: "no usable delta for the structural stop" };
  }

  let riskPoints = underlyingRisk * delta;
  const minPoints = PLAN_CONFIG.minStopTicks * PLAN_CONFIG.tickSize;
  const maxPoints = entry * PLAN_CONFIG.maxStopPctOfPremium;

  if (riskPoints < minPoints) {
    riskPoints = minPoints;
    notes.push(`stop widened to the ${PLAN_CONFIG.minStopTicks}-tick noise floor (${minPoints.toFixed(2)} pts)`);
  }
  if (riskPoints > maxPoints) {
    riskPoints = maxPoints;
    notes.push(`stop capped at ${(PLAN_CONFIG.maxStopPctOfPremium * 100).toFixed(0)}% of premium — rupee risk reduced`);
  }
  if (riskPoints >= entry) {
    return { ...base, reason: "invalid_geometry", message: "structural stop is not inside the option's value" };
  }

  const stopLoss = roundTick(entry - riskPoints);
  const sizing = sizeOptionTrade({
    entryPremium: entry,
    lotSize,
    deployedAmount: input.deployedAmount,
  });
  const units = sizing.units;
  const riskAmount = riskPoints * units;

  const targets: number[] = [];
  const multipliers = confirmedCount >= 2
    ? [2, 3, 4]
    : confirmedCount >= 1
      ? [2, 3]
      : [2];
  for (const k of multipliers) {
    const pts = riskPoints * k;
    if (pts >= entry) {
      notes.push(`${k}R target unreachable (${pts.toFixed(2)} pts ≥ premium ${entry}) — dropped`);
      continue;
    }
    targets.push(roundTick(entry + pts));
  }
  if (confirmedCount < 2) notes.push("TP3 (4R) withheld — no live-data confirmation");
  if (confirmedCount < 1) notes.push("TP2 (3R) withheld — no live-data confirmation");

  const reward = targets.length ? targets[0] - entry : 0;
  const rr = riskPoints > 0 ? reward / riskPoints : 0;
  if (rr < PLAN_CONFIG.minOptionRR) {
    return {
      ...base,
      reason: "rr_below_floor",
      message: `option R:R 1:${rr.toFixed(2)} is below the 1:${PLAN_CONFIG.minOptionRR} floor`,
      stopLoss,
      rr,
    };
  }

  notes.unshift(
    `stop from the underlying structure (${u.stop.toFixed(2)} ${isCall ? "call" : "put"}, delta ${delta.toFixed(2)}) — ${confirmedCount} confirmation${confirmedCount === 1 ? "" : "s"}`,
  );

  return {
    ok: true,
    entry,
    stopLoss,
    targets,
    rr,
    lots: sizing.lots,
    units,
    deployed: sizing.deployed,
    riskAmount,
    confirmedCount,
    notes,
    tradable: sizing.tradable,
  };
}

// ─────────────────────────────────────────────────────────────
// STRIKE SELECTION — the deterministic contract picker for the BUY card.
//
// The card used to hardcode ATM and never validate the contract: a
// lottery-ticket |delta| 0.20 CE or a contract whose ONE lot costs more than
// the per-trade budget would still render as a BUY plan.
//
// Every rule here comes from the gate config (GATE_CONFIG — one source of
// truth) or the live chain itself. Nothing is invented:
//   • ATM-or-OTM side only, within maxOtmSteps (3) strikes of ATM
//   • |delta| ≥ minAbsDelta (0.35) when the provider publishes delta
//   • 1 lot must fit the per-trade budget — else the contract is skipped
//     (0 lots is a real outcome; it is never "sized up" to 1)
//   • ltp > 0 — a strike without a real premium is not a contract
//   • no delta anywhere → nearest tradable ATM..OTM leg, honestly labelled
// ─────────────────────────────────────────────────────────────

export interface ChainLegLike {
  ltp: number | null;
  delta?: number | null;
  /** Where delta came from — "bs" gets an honest "(BS)" suffix in the strike reason. */
  deltaSource?: "provider" | "bs" | null;
  oi?: number | null;
  oiChange?: number | null;
  iv?: number | null;
  volume?: number | null;
}

export interface ChainRowLike {
  strike: number;
  ce?: ChainLegLike | null;
  pe?: ChainLegLike | null;
}

export interface SelectedStrike {
  strike: number;
  optionType: "CE" | "PE";
  /** Real premium of the selected leg (its live ltp). */
  entry: number;
  delta: number | null;
  /** "provider" = exchange/broker greeks, "bs" = Black-Scholes from live IV. */
  deltaSource: "provider" | "bs" | null;
  iv: number | null;
  oi: number | null;
  /** Strikes away from ATM (0 = ATM). */
  otmSteps: number;
  isAtm: boolean;
  /** Why this strike (or why none). */
  reason: string;
}

export function selectStrike(input: {
  chain: ChainRowLike[];
  direction: "CALL" | "PUT";
  spot: number;
  lotSize: number;
  budget?: number;
}): SelectedStrike | null {
  const chain = Array.isArray(input.chain) ? input.chain : [];
  const spot = Number(input.spot);
  const lotSize = Number(input.lotSize);
  if (!chain.length || !(spot > 0) || !(lotSize > 0)) return null;

  const wantCall = input.direction === "CALL";
  const optionType: "CE" | "PE" = wantCall ? "CE" : "PE";

  // ATM = the listed strike closest to spot (the chain's own grid, not a step guess).
  const sorted = [...chain].sort((a, b) => a.strike - b.strike);
  let atmIdx = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (Math.abs(sorted[i].strike - spot) < Math.abs(sorted[atmIdx].strike - spot)) atmIdx = i;
  }

  // Walk ATM → OTM within the gate's step window (calls walk UP, puts walk DOWN).
  const maxSteps = GATE_CONFIG.maxOtmSteps;

  for (let step = 0; step <= maxSteps; step++) {
    const idx = wantCall ? atmIdx + step : atmIdx - step;
    if (idx < 0 || idx >= sorted.length) break;
    const row = sorted[idx];
    const leg = wantCall ? row.ce : row.pe;
    if (!leg) continue;
    const ltp = Number(leg.ltp);
    if (!(ltp > 0)) continue;                                  // no real premium → not a contract

    const cost = ltp * lotSize;

    const delta = leg.delta != null && Number.isFinite(Number(leg.delta)) ? Number(leg.delta) : null;
    const deltaSource = leg.deltaSource === "provider" || leg.deltaSource === "bs" ? leg.deltaSource : null;
    if (delta != null && Math.abs(delta) < GATE_CONFIG.minAbsDelta) {
      continue;                                                // lottery ticket
    }

    const deltaLabel = delta == null
      ? "delta unavailable — nearest tradable ATM..OTM contract"
      : `|delta| ${Math.abs(delta).toFixed(2)}${deltaSource === "bs" ? " (BS)" : ""}`;
    return {
      strike: row.strike,
      optionType,
      entry: ltp,
      delta,
      deltaSource,
      iv: leg.iv != null && Number.isFinite(Number(leg.iv)) ? Number(leg.iv) : null,
      oi: leg.oi != null && Number.isFinite(Number(leg.oi)) ? Number(leg.oi) : null,
      otmSteps: step,
      isAtm: step === 0,
      reason: delta == null
        ? deltaLabel
        : step === 0
          ? `ATM · ${deltaLabel} · 1 lot ₹${Math.round(cost).toLocaleString("en-IN")}`
          : `${step} step${step > 1 ? "s" : ""} OTM · ${deltaLabel} · 1 lot ₹${Math.round(cost).toLocaleString("en-IN")}`,
    };
  }

  // Nothing passed — report the real reason, never a fabricated contract.
  return null;
}

// ─────────────────────────────────────────────────────────────
// TP ACHIEVABILITY vs OI — "can these targets actually be reached per data?"
//
// The R-ladder says WHERE premium must go; this maps each target to the spot
// the underlying must reach (via the option's delta) and checks whether a
// concentrated opposing OI wall sits in that path:
//   • CE (spot must RISE) → resistance = CALL OI above spot
//   • PE (spot must FALL) → support    = PUT  OI below spot
// A wall = the nearest in-path strike whose OI ≥ wallOiMult × the median OI
// of the whole opposing ladder (median keeps one fat strike from defining
// "normal"). A wall must be BROKEN for the target to print — fresh writing
// (oiChange > 0) means it is actively defended; unwinding means it is rotting.
// Honest outputs only: no wall in the path → achievable; delta missing → a
// labelled 0.50 estimate, never a silent one.
// ─────────────────────────────────────────────────────────────

export interface TargetReach {
  /** The premium target this check is about. */
  target: number;
  /** Spot the underlying must reach for this TP (entry→target ÷ |delta|). */
  requiredSpot: number;
  /** The opposing OI wall the spot must break to get there, if any. */
  wall?: { strike: number; oi: number; oiChange: number; side: "call" | "put" };
  /** false = a top-OI wall sits between spot and this target. */
  achievable: boolean;
  /** Plain-language verdict for the UI (always set for blocked targets). */
  note?: string;
}

export function assessTargets(input: {
  optionType: "CE" | "PE";
  spot: number;
  entry: number;
  targets: number[];
  delta: number | null;
  /** true when delta came from ATM greeks rather than the chosen leg. */
  deltaEstimated?: boolean;
  chain: ChainRowLike[];
  /** wall if OI ≥ mult × median opposing-ladder OI (default 2.5). */
  wallOiMult?: number;
}): TargetReach[] {
  const { optionType, spot, entry, targets, chain } = input;
  if (!(spot > 0) || !(entry > 0) || !targets?.length) return [];

  let delta = Number(input.delta);
  let estimated = !!input.deltaEstimated;
  if (!Number.isFinite(delta) || delta === 0) {
    delta = 0.5; // labelled estimate — never silent
    estimated = true;
  }
  const absDelta = Math.abs(delta);
  const mult = Number(input.wallOiMult) > 0 ? Number(input.wallOiMult) : 2.5;
  const isCE = optionType === "CE";

  // Opposing ladder: CE → call strikes above spot, PE → put strikes below.
  const ladder = chain
    .filter((r) => {
      const leg = isCE ? r.ce : r.pe;
      if (!leg || !(Number(leg.oi) > 0)) return false;
      return isCE ? r.strike > spot : r.strike < spot;
    })
    .sort((a, b) => (isCE ? a.strike - b.strike : b.strike - a.strike)); // nearest-to-spot first

  const ois = ladder.map((r) => Number((isCE ? r.ce : r.pe)!.oi));
  const sortedOi = [...ois].sort((a, b) => a - b);
  const median = sortedOi.length
    ? sortedOi.length % 2
      ? sortedOi[(sortedOi.length - 1) / 2]
      : (sortedOi[sortedOi.length / 2 - 1] + sortedOi[sortedOi.length / 2]) / 2
    : 0;
  const wallFloor = median * mult;

  const fmtL = (n: number) => `${(n / 100000).toFixed(1)}L`;

  return targets.map((target) => {
    const premiumPts = target - entry;
    const spotPts = premiumPts / absDelta;
    const requiredSpot = isCE ? spot + spotPts : spot - spotPts;

    // In-path: opposing strikes the spot must trade through to get there.
    const inPath = ladder.filter((r) =>
      isCE ? r.strike <= requiredSpot : r.strike >= requiredSpot
    );
    const wallRow = inPath.find((r) => Number((isCE ? r.ce : r.pe)!.oi) >= wallFloor);
    const estSuffix = estimated ? " (delta est.)" : "";

    if (!wallRow) {
      return {
        target,
        requiredSpot: Number(requiredSpot.toFixed(2)),
        achievable: true,
        note: `TP needs spot ${requiredSpot.toFixed(0)} — no opposing OI wall in the path${estSuffix}`,
      };
    }

    const leg = (isCE ? wallRow.ce : wallRow.pe)!;
    const oi = Number(leg.oi);
    const oiChange = Number(leg.oiChange) || 0;
    const flow =
      oiChange > 0 ? `+${fmtL(oiChange)} writing` :
      oiChange < 0 ? `${fmtL(Math.abs(oiChange))} unwinding` : "flat";
    return {
      target,
      requiredSpot: Number(requiredSpot.toFixed(2)),
      wall: { strike: wallRow.strike, oi, oiChange, side: isCE ? "call" : "put" },
      achievable: false,
      note: `TP needs spot ${requiredSpot.toFixed(0)} — ${isCE ? "call" : "put"} wall ${wallRow.strike} (${fmtL(oi)} OI, ${flow}) in the way${estSuffix}`,
    };
  });
}
