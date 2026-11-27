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
import {
  impliedVolFromPremium,
  parseExpiryToYears,
  calculateGreeks,
  bsPrice,
} from "./greeks";

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
  defaultDeployedAmount: 999_999_999,
  /** DEFAULT lot count when the caller does not state one (user rule
   *  2026-11-27: "keep only 2 lots by default for all in this app"). */
  defaultLots: 2,
  /** Plan the gates accept: option R:R after the plan must clear this. */
  minOptionRR: GATE_CONFIG.minOptionRR,
  /** How far the LIVE premium may drift from a frozen plan entry before the
   *  ladder is re-anchored to the market (5% of the premium). A 0DTE premium
   *  routinely moves 10% inside the plan TTL — the ladder must follow it, but
   *  not on every tick (that would jitter the SL/TP on each poll). */
  reanchorPremiumDriftPct: 0.05,
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
  /**
   * THE AUTHORITATIVE GEOMETRY (Wave 4, 2026-11-27).
   *
   * When this block is present the plan is priced from the MARKET — the
   * underlying's structural stop (validated against ATR) mapped onto the
   * premium through the leg's delta + theta (+ the IV term), with the targets
   * mapped from the underlying path. Without it the legacy rupee-risk ladder
   * runs unchanged (the other engines still use it).
   */
  geometry?: OptionGeometryInput;
  /** Strike — required by the geometry mode (Black-Scholes mapping). */
  strike?: number;
  /** Expiry (YYYY-MM-DD) — required by the geometry mode. */
  expiry?: string;
  /** Clock for the geometry mode (expiry maths + hold window). */
  now?: Date;
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
  // ── The authoritative geometry (Wave 4, 2026-11-27) ──────────────────
  /** "structure-atr" when the plan was priced from the market (not a fixed %). */
  geometrySource?: "structure-atr" | null;
  /** Why the plan is NOT tradable — the honest reason (never a fallback). */
  reason?: GeometryReason | null;
  /** The NUMERIC underlying level that invalidates the idea. */
  invalidation?: number | null;
  /** The underlying stop the premium stop was mapped from. */
  underlyingStop?: number | null;
  /** The underlying level that must break for the setup to fire. */
  underlyingTrigger?: number | null;
  /** The entry zone — the live book, or a band around the LTP. */
  entryZone?: { low: number; high: number; source: "book" | "ltp-band" } | null;
  /** ₹ lost if the stop fills (the same money as `riskAmount`). */
  maxLoss?: number;
  /** The ₹ rupee-risk allowance the lots were sized against. */
  riskBudget?: number;
  /** riskAmount ÷ deployed — the risk as a % of what the trade commits. */
  riskPctOfDeployed?: number;
  /** Each target's market level + its R multiple on the option's own risk. */
  targetDetails?: OptionTargetDetail[];
}

// ─────────────────────────────────────────────────────────────
// THE AUTHORITATIVE GEOMETRY (Wave 4, 2026-11-27)
//
// The DD card used to print a FIXED-percentage ladder: a 20% stop on the
// premium for EVERY strike and EVERY symbol, targets at +40% / +60% / +80% of
// the premium, R:R 2.00 by construction (live proof 2026-11-27 12:58 IST:
// NIFTY PE 25700 @ ₹172 → SL ₹137.60 → TP ₹240.80 / 275.20 / 309.60). ATR,
// IV, delta and the market structure were never consulted.
//
// THE REPLACEMENT — ONE plan, priced from the market:
//   1. the UNDERLYING's structural stop (a swing low for a call, a swing high
//      for a put) is the invalidation; it is clamped to the ATR envelope
//      [0.5×ATR, 2.5×ATR] so a stop can never be noise (too tight) nor a
//      thesis change (too wide);
//   2. that stop is mapped onto the PREMIUM through the leg's delta, plus the
//      carry over the hold (theta) and the IV term (vega);
//   3. the targets are the MARKET's own levels (structure / FVG / liquidity /
//      OI wall) repriced through Black-Scholes at the leg's IV — each rung of
//      the [2R, 3R, 4R] ladder takes the nearest level that carries it, and a
//      level beyond the desk's target horizon (maxTargetR) is DROPPED and
//      reported;
//   4. the invalidation is a NUMERIC underlying level, and the lots, the
//      deployment and the max loss all come from the SAME plan object;
//   5. a missing structure / ATR / IV / path degrades to a WAIT with the
//      reason — NEVER a fixed-% fallback.
//
// The rupee-risk rule survives as a SIZE rule: the risk allowance is 20% of
// the budget the lots are sized against, and a stop that costs more than
// that allowance sizes the trade down (or to zero lots) instead of quietly
// widening the stop.
// ─────────────────────────────────────────────────────────────

export const GEOMETRY_CONFIG = {
  /** The structural stop is clamped to this ATR envelope (a multiple of ATR). */
  minStopAtrMult: 0.5,
  maxStopAtrMult: 2.5,
  /** The IV shock applied at the stop, in vol points (the vega term of the carry). */
  ivShockVolPoints: 1,
  /** The entry band around the LTP when there is no book (fraction of the premium). */
  entryZoneBandPct: 0.0025,
  /** The desk's target horizon — a market level beyond this many R is not a target. */
  maxTargetR: 6,
  /** The IV band a leg may sit in before it counts as broken data. */
  minIv: 0.005,
  maxIv: 5,
} as const;

/** Why an authoritative plan is not tradable — every reason is a REAL gap. */
export type GeometryReason =
  | "no_structure_data"
  | "no_atr"
  | "no_iv"
  | "no_delta"
  | "no_path_target"
  | "rr_below_floor"
  | "risk_above_envelope"
  | "invalid_geometry";

/** One market level in the trade direction (a structure swing, an FVG edge, a pool, a wall). */
export interface GeometryPathLevel {
  price: number;
  kind?: string;
}

/** Everything the geometry needs about the MARKET (never about the option's %). */
export interface OptionGeometryInput {
  /** The underlying spot. */
  spot: number;
  /** The structural invalidation on the UNDERLYING (a swing low for a call). */
  underlyingStop: number | null;
  /** The underlying level that must break for the setup to fire. */
  underlyingTrigger?: number | null;
  /** The market's own path in the trade direction. */
  pathTargets?: Array<number | GeometryPathLevel>;
  /** The underlying's ATR — REQUIRED (no ATR ⇒ the stop cannot be validated). */
  atr: number;
  /** Decimal IV for the leg (the chain's IV is in PERCENT — convert first). */
  iv?: number | null;
  /** |delta| for the leg. */
  delta?: number | null;
  /** Theta per day (negative for a long). */
  theta?: number | null;
  /** Vega per 1 vol point. */
  vega?: number | null;
  /** The holding window in days. */
  holdDays?: number | null;
  /** The live book of the leg. */
  bid?: number | null;
  ask?: number | null;
}

/** The premium stop mapped from the underlying stop — the core of the geometry. */
export interface PremiumStopMapping {
  /** Underlying points of risk. */
  underlyingPts: number;
  /** |delta| used for the mapping. */
  delta: number;
  /** Premium points the underlying move is worth (delta-mapped). */
  deltaPts: number;
  /** Theta carry over the hold (premium points). */
  thetaPts: number;
  /** IV (vega) carry over the hold (premium points). */
  ivPts: number;
  /** The premium risk — delta + theta + IV. */
  riskPts: number;
  /** The premium stop level (entry − riskPts). */
  stopPremium: number;
}

/**
 * Map an UNDERLYING stop distance onto the PREMIUM.
 *
 * The premium's risk is NOT a % of itself: it is what the underlying's move
 * is worth through the leg's delta, plus the carry the trade pays while it
 * waits (theta) and the IV term (vega). This is why the SAME 100-point
 * underlying stop costs a 0.50-delta leg materially more premium than a
 * 0.20-delta leg — the old fixed-% ladder could never express that.
 */
export function mapUnderlyingStopToPremium(input: {
  entryPremium: number;
  underlyingPts: number;
  delta: number;
  theta?: number | null;
  holdDays?: number | null;
  vega?: number | null;
  ivShockVolPoints?: number | null;
}): PremiumStopMapping {
  const entry = Number(input.entryPremium);
  const pts = Math.abs(Number(input.underlyingPts));
  const deltaRaw = Number(input.delta);
  const delta = Number.isFinite(deltaRaw) ? Math.abs(deltaRaw) : 0;
  const holdDays = Number(input.holdDays) > 0 ? Number(input.holdDays) : 0;
  const shock = Number(input.ivShockVolPoints) > 0 ? Number(input.ivShockVolPoints) : 0;
  const thetaRaw = Number(input.theta ?? 0);
  const vegaRaw = Number(input.vega ?? 0);
  const thetaPts = (Number.isFinite(thetaRaw) ? Math.abs(thetaRaw) : 0) * holdDays;
  const ivPts = (Number.isFinite(vegaRaw) ? Math.abs(vegaRaw) : 0) * shock;
  const deltaPts = pts * delta;
  const riskPts = deltaPts + thetaPts + ivPts;
  return {
    underlyingPts: pts,
    delta,
    deltaPts,
    thetaPts,
    ivPts,
    riskPts,
    stopPremium: roundTick(entry - riskPts),
  };
}

/** One target — the market level it needs and the R multiple it carries. */
export interface OptionTargetDetail {
  /** The R multiple on the option's own risk (the target premium − entry ÷ risk). */
  r: number;
  /** The premium target. */
  premium: number;
  /** The underlying level that must be reached. */
  underlying: number;
  /** What the level IS (swing high / FVG edge / liquidity / OI wall). */
  kind: string;
}

export interface GeometryPlanInput {
  symbol: string;
  optionType: "CE" | "PE";
  entryPremium: number;
  strike: number;
  expiry: string;
  lotSize: number;
  geometry: OptionGeometryInput;
  /** Lots to take. Omit to size from the rupee-risk envelope. */
  lots?: number;
  /** ₹ budget the lots are sized against (default: the desk's 2-lot deployment). */
  deployedAmount?: number;
  targetMultipliers?: number[];
  now?: Date;
}

export interface GeometryPlan {
  ok: boolean;
  reason?: GeometryReason;
  message?: string;
  entry: number;
  stopLoss: number;
  targets: number[];
  targetDetails: OptionTargetDetail[];
  rr: number;
  lots: number;
  units: number;
  deployed: number;
  riskAmount: number;
  maxLoss: number;
  riskPoints: number;
  riskBudget: number;
  riskPctOfDeployed: number;
  lotCost: number;
  entryZone: { low: number; high: number; source: "book" | "ltp-band" };
  underlyingStop: number | null;
  underlyingTrigger: number | null;
  invalidation: number | null;
  geometrySource: "structure-atr";
  tradable: boolean;
  notes: string[];
}

/**
 * Build the ONE authoritative plan — priced from the market, never from a
 * fixed % of the premium. Pure: no network, no clock (the caller passes
 * `now`), so the same call can be replayed by a test or a cron.
 */
export function buildGeometryPlan(input: GeometryPlanInput): GeometryPlan {
  const notes: string[] = [];
  const isCall = input.optionType === "CE";
  const rawEntry = Number(input.entryPremium);
  const lotSize = Number(input.lotSize);
  const strike = Number(input.strike);
  const spot = Number(input.geometry?.spot);
  const mults = input.targetMultipliers ?? [...PLAN_CONFIG.targetMultipliers];

  const blank = (
    reason: GeometryReason,
    message: string,
    over: Partial<GeometryPlan> = {},
  ): GeometryPlan => ({
    ok: false,
    reason,
    message,
    entry: roundTick(rawEntry > 0 ? rawEntry : 0),
    stopLoss: 0,
    targets: [],
    targetDetails: [],
    rr: 0,
    lots: 0,
    units: 0,
    deployed: 0,
    riskAmount: 0,
    maxLoss: 0,
    riskPoints: 0,
    riskBudget: 0,
    riskPctOfDeployed: 0,
    lotCost: 0,
    entryZone: { low: 0, high: 0, source: "ltp-band" },
    underlyingStop: null,
    underlyingTrigger: input.geometry?.underlyingTrigger ?? null,
    invalidation: null,
    geometrySource: "structure-atr",
    tradable: false,
    notes: [...notes, message],
    ...over,
  });

  if (!(rawEntry > 0) || !(lotSize > 0) || !(strike > 0) || !input.expiry) {
    return blank("no_structure_data", "no live premium / strike / lot size / expiry — no plan");
  }
  const entry = roundTick(rawEntry);
  if (!(spot > 0)) {
    return blank("no_structure_data", "no underlying spot — no plan");
  }

  // ── 1 — ATR: the structural stop cannot be validated without it ────────
  const atrNow = Number(input.geometry.atr);
  if (!(atrNow > 0)) {
    return blank(
      "no_atr",
      "no ATR on the tape — the structural stop cannot be validated (never a fixed-% fallback)",
    );
  }

  // ── 2 — the structural stop and its ATR envelope ───────────────────────
  const rawStop = Number(input.geometry.underlyingStop);
  if (!(rawStop > 0)) {
    return blank(
      "no_structure_data",
      `no structural stop (the ${isCall ? "swing low" : "swing high"} that invalidates the ${isCall ? "call" : "put"}) — no invalidation level`,
    );
  }
  if (isCall ? rawStop >= spot : rawStop <= spot) {
    return blank(
      "no_structure_data",
      `the structural stop ${rawStop.toFixed(1)} is not on the ${isCall ? "call" : "put"} side of spot ${spot.toFixed(1)}`,
    );
  }
  let underlyingStop = rawStop;
  let dist = Math.abs(spot - rawStop);
  const minDist = GEOMETRY_CONFIG.minStopAtrMult * atrNow;
  const maxDist = GEOMETRY_CONFIG.maxStopAtrMult * atrNow;
  if (dist < minDist) {
    underlyingStop = isCall ? spot - minDist : spot + minDist;
    notes.push(
      `structural stop ${rawStop.toFixed(1)} is only ${(dist / atrNow).toFixed(2)}×ATR away — widened to the ${GEOMETRY_CONFIG.minStopAtrMult}×ATR floor (${underlyingStop.toFixed(1)})`,
    );
    dist = minDist;
  } else if (dist > maxDist) {
    underlyingStop = isCall ? spot - maxDist : spot + maxDist;
    notes.push(
      `structural stop ${rawStop.toFixed(1)} is ${(dist / atrNow).toFixed(2)}×ATR away — pulled in to the ${GEOMETRY_CONFIG.maxStopAtrMult}×ATR ceiling (${underlyingStop.toFixed(1)})`,
    );
    dist = maxDist;
  }

  // ── 3 — time to expiry and the leg's IV ───────────────────────────────
  const tte = parseExpiryToYears(input.expiry, input.now);
  if (tte == null) {
    return blank("no_structure_data", `unparseable expiry ${input.expiry}`);
  }
  const ivRaw = input.geometry.iv;
  let iv = 0;
  let ivSource: "provider" | "inverted" = "provider";
  if (ivRaw != null && Number.isFinite(Number(ivRaw))) {
    iv = Number(ivRaw);
    if (!(iv > GEOMETRY_CONFIG.minIv && iv < GEOMETRY_CONFIG.maxIv)) {
      return blank(
        "no_iv",
        `the leg's IV (${(iv * 100).toFixed(2)}%) is not usable — no plan`,
      );
    }
  } else {
    const solved = impliedVolFromPremium(rawEntry, spot, strike, tte, isCall);
    if (solved == null || !(solved > GEOMETRY_CONFIG.minIv)) {
      return blank(
        "no_iv",
        "no usable IV for this leg (the chain carries none and it cannot be inverted from the premium) — no plan",
      );
    }
    iv = solved;
    ivSource = "inverted";
  }

  // ── 4 — the leg's greeks ───────────────────────────────────────────────
  const greeks = calculateGreeks(spot, strike, tte, iv, isCall);
  const deltaRaw = input.geometry.delta;
  const delta =
    deltaRaw != null && Number.isFinite(Number(deltaRaw))
      ? Math.abs(Number(deltaRaw))
      : Math.abs(greeks.delta);
  if (!(delta > 0.05)) {
    return blank(
      "no_delta",
      "no usable delta for this leg — the premium stop cannot be mapped",
    );
  }
  const thetaRaw = Number(input.geometry.theta);
  const vegaRaw = Number(input.geometry.vega);
  const theta = input.geometry.theta != null && Number.isFinite(thetaRaw) ? thetaRaw : greeks.theta;
  const vega = input.geometry.vega != null && Number.isFinite(vegaRaw) ? vegaRaw : greeks.vega;
  const holdDays = Number(input.geometry.holdDays) > 0 ? Number(input.geometry.holdDays) : 0;

  // ── 5 — the premium stop: the underlying stop through delta + the carry ─
  const mapping = mapUnderlyingStopToPremium({
    entryPremium: rawEntry,
    underlyingPts: dist,
    delta,
    theta,
    holdDays,
    vega,
    ivShockVolPoints: GEOMETRY_CONFIG.ivShockVolPoints,
  });
  let riskPts = mapping.riskPts;
  const minPts = PLAN_CONFIG.minStopTicks * PLAN_CONFIG.tickSize;
  if (riskPts < minPts) {
    riskPts = minPts;
    notes.push(
      `the mapped stop was ${mapping.riskPts.toFixed(2)} pts — widened to the ${PLAN_CONFIG.minStopTicks}-tick noise floor (${minPts.toFixed(2)} pts)`,
    );
  }
  const maxPts = entry * PLAN_CONFIG.maxStopPctOfPremium;
  if (riskPts > maxPts) {
    return blank(
      "invalid_geometry",
      `the structural stop maps to ${((riskPts / entry) * 100).toFixed(0)}% of the premium — beyond the ${(PLAN_CONFIG.maxStopPctOfPremium * 100).toFixed(0)}% cap`,
    );
  }
  if (riskPts >= entry) {
    return blank("invalid_geometry", "the structural stop is not inside the option's value");
  }
  const stopLoss = roundTick(entry - riskPts);
  const effectiveRisk = entry - stopLoss;

  // ── 6 — the targets: the market's own levels, repriced and laddered ───
  const tExit = Math.max(tte - holdDays, 1 / 365);
  const pathLevels = (input.geometry.pathTargets ?? [])
    .map((l) =>
      typeof l === "number"
        ? { price: Number(l), kind: "structure" }
        : { price: Number(l?.price), kind: String(l?.kind ?? "structure") },
    )
    .filter((l) => Number.isFinite(l.price) && l.price > 0);
  const dirLevels = pathLevels
    .filter((l) => (isCall ? l.price > spot : l.price < spot))
    .sort((a, b) => (isCall ? a.price - b.price : b.price - a.price));
  if (!dirLevels.length) {
    return blank(
      "no_path_target",
      `no market level in the ${isCall ? "up" : "down"} path — no target to map`,
    );
  }
  const candidates = dirLevels
    .map((l) => {
      const premiumAt = bsPrice(l.price, strike, tExit, iv, isCall);
      const r = effectiveRisk > 0 ? (premiumAt - entry) / effectiveRisk : 0;
      return { ...l, premiumAt, r };
    })
    .filter((c) => c.premiumAt > entry && c.r > 0);
  if (!candidates.length) {
    return blank(
      "no_path_target",
      "the market's path carries no premium above the entry — no target to map",
    );
  }
  const targets: number[] = [];
  const targetDetails: OptionTargetDetail[] = [];
  const used = new Set<number>();
  for (let i = 0; i < mults.length; i++) {
    const k = mults[i];
    const pickIdx = candidates.findIndex((c, idx) => !used.has(idx) && c.r >= k);
    if (pickIdx < 0) {
      notes.push(`TP${i + 1} (${k}R) dropped — no market level in the path carries ${k}R`);
      continue;
    }
    const pick = candidates[pickIdx];
    if (pick.r > GEOMETRY_CONFIG.maxTargetR) {
      notes.push(
        `TP${i + 1} (${k}R) dropped — the next market level is ${pick.r.toFixed(2)}R, beyond the desk's ${GEOMETRY_CONFIG.maxTargetR}R horizon`,
      );
      continue;
    }
    used.add(pickIdx);
    targets.push(roundTick(pick.premiumAt));
    targetDetails.push({
      r: pick.r,
      premium: roundTick(pick.premiumAt),
      underlying: pick.price,
      kind: pick.kind,
    });
  }
  if (!targets.length) {
    return blank(
      "no_path_target",
      `no market level carries the ${mults[0]}R minimum within the ${GEOMETRY_CONFIG.maxTargetR}R horizon — no target`,
    );
  }

  const reward = targets[0] - entry;
  const rr = effectiveRisk > 0 ? reward / effectiveRisk : 0;
  if (rr < PLAN_CONFIG.minOptionRR) {
    return blank(
      "rr_below_floor",
      `option R:R 1:${rr.toFixed(2)} is below the 1:${PLAN_CONFIG.minOptionRR} floor`,
      { stopLoss, rr, underlyingStop, invalidation: underlyingStop, riskPoints: effectiveRisk },
    );
  }

  // ── 7 — sizing: the rupee-risk envelope is a SIZE rule ────────────────
  const costPerLot = entry * lotSize;
  const budget =
    Number(input.deployedAmount) > 0
      ? Number(input.deployedAmount)
      : entry * PLAN_CONFIG.defaultLots * lotSize; // the desk's 2-lot deployment
  const riskBudget = budget * PLAN_CONFIG.riskPctOfDeployed;
  const affordable = Math.floor(budget / costPerLot);
  const requested =
    input.lots != null && Number.isFinite(Number(input.lots))
      ? Math.floor(Number(input.lots))
      : undefined;
  let lots =
    requested != null ? requested : (affordable >= PLAN_CONFIG.defaultLots ? PLAN_CONFIG.defaultLots : 0);
  const riskPerLot = effectiveRisk * lotSize;
  if (requested == null && riskPerLot > 0) {
    const lotsByRisk = Math.floor(riskBudget / riskPerLot);
    if (lotsByRisk < lots) {
      notes.push(
        `the rupee-risk allowance (₹${Math.round(riskBudget).toLocaleString("en-IN")} = 20% of the ₹${Math.round(budget).toLocaleString("en-IN")} deployment) only fits ${lotsByRisk} lot${lotsByRisk === 1 ? "" : "s"} at this stop — sized down from ${lots}`,
      );
      lots = lotsByRisk;
    }
  }
  if (lots < 1) {
    return blank(
      "risk_above_envelope",
      `the structural stop risks ₹${Math.round(riskPerLot).toLocaleString("en-IN")} per lot — above the ₹${Math.round(riskBudget).toLocaleString("en-IN")} rupee-risk allowance (20% of the ₹${Math.round(budget).toLocaleString("en-IN")} deployment) → 0 lots`,
      { stopLoss, underlyingStop, invalidation: underlyingStop, riskPoints: effectiveRisk, riskBudget },
    );
  }
  const units = lots * lotSize;
  const deployed = entry * units;
  const maxLoss = effectiveRisk * units;
  const riskPctOfDeployed = deployed > 0 ? maxLoss / deployed : 0;

  // ── 8 — the entry zone: the live book, else a band around the LTP ─────
  const bid = Number(input.geometry.bid);
  const ask = Number(input.geometry.ask);
  const hasBook =
    Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && ask >= bid;
  const band = GEOMETRY_CONFIG.entryZoneBandPct;
  const entryZone = hasBook
    ? { low: roundTick(bid), high: roundTick(ask), source: "book" as const }
    : {
        low: roundTick(entry * (1 - band)),
        high: roundTick(entry * (1 + band)),
        source: "ltp-band" as const,
      };

  notes.unshift(
    `stop from the underlying structure: invalidation ${underlyingStop.toFixed(1)} (${dist.toFixed(0)} pts = ${(dist / atrNow).toFixed(2)}×ATR) · |delta| ${delta.toFixed(2)} · IV ${(iv * 100).toFixed(1)}% (${ivSource})`,
  );
  notes.push(
    `premium risk ${effectiveRisk.toFixed(2)} pts = Δ ${mapping.deltaPts.toFixed(2)} + θ ${mapping.thetaPts.toFixed(2)} + IV ${mapping.ivPts.toFixed(2)}`,
  );
  notes.push(
    `max loss ₹${Math.round(maxLoss).toLocaleString("en-IN")} on ₹${Math.round(deployed).toLocaleString("en-IN")} deployed (${(riskPctOfDeployed * 100).toFixed(1)}% of the deployment; the allowance is ₹${Math.round(riskBudget).toLocaleString("en-IN")})`,
  );

  return {
    ok: true,
    entry,
    stopLoss,
    targets,
    targetDetails,
    rr,
    lots,
    units,
    deployed,
    riskAmount: maxLoss,
    maxLoss,
    riskPoints: effectiveRisk,
    riskBudget,
    riskPctOfDeployed,
    lotCost: costPerLot,
    entryZone,
    underlyingStop,
    underlyingTrigger: input.geometry.underlyingTrigger ?? null,
    invalidation: underlyingStop,
    geometrySource: "structure-atr",
    tradable: lots === PLAN_CONFIG.defaultLots,
    notes,
  };
}

/** The geometry plan as the canonical `OptionPlan` shape. */
function geometryToOptionPlan(g: GeometryPlan): OptionPlan {
  const units = g.units;
  return {
    entry: g.entry,
    stopLoss: g.stopLoss,
    targets: g.targets,
    units,
    lots: g.lots,
    deployed: g.deployed,
    riskAmount: g.riskAmount,
    riskPoints: g.riskPoints,
    rr: g.rr,
    rupee: {
      tp1: g.targets[0] != null && units > 0 ? (g.targets[0] - g.entry) * units : 0,
      tp2: g.targets[1] != null && units > 0 ? (g.targets[1] - g.entry) * units : 0,
      tp3: g.targets[2] != null && units > 0 ? (g.targets[2] - g.entry) * units : 0,
    },
    stopPctOfPremium: g.entry > 0 && g.riskPoints > 0 ? g.riskPoints / g.entry : 0,
    notes: g.notes,
    tradable: g.tradable,
    lotCost: g.lotCost,
    geometrySource: g.geometrySource,
    reason: g.reason ?? null,
    invalidation: g.invalidation,
    underlyingStop: g.underlyingStop,
    underlyingTrigger: g.underlyingTrigger,
    entryZone: g.entryZone,
    maxLoss: g.maxLoss,
    riskBudget: g.riskBudget,
    riskPctOfDeployed: g.riskPctOfDeployed,
    targetDetails: g.targetDetails,
  };
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
  reason?: string;             // why 0 lots / why overBudget (human readable)
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
  const affordable = Math.floor(budget / (entry * lot));
  return affordable >= PLAN_CONFIG.defaultLots ? PLAN_CONFIG.defaultLots : 0;
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
  const lots = requested != null ? requested : (affordable >= PLAN_CONFIG.defaultLots ? PLAN_CONFIG.defaultLots : 0);

  if (lots < 1) {
    return {
      lots: 0, units: 0, costPerLot, budget,
      deployed: 0, riskAmount: 0, tradable: false, sizedFromBudget,
      overBudget: false,
      reason: requested != null
        ? `expected ${PLAN_CONFIG.defaultLots} lot(s), got ${lots}`
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
    tradable: lots === PLAN_CONFIG.defaultLots,
    sizedFromBudget,
    overBudget,
    reason: requested != null && lots !== PLAN_CONFIG.defaultLots
      ? `expected ${PLAN_CONFIG.defaultLots} lot(s), got ${lots}`
      : overBudget
        ? `1 lot costs ₹${Math.round(costPerLot).toLocaleString("en-IN")} — over the ₹${Math.round(budget).toLocaleString("en-IN")} default deployment`
        : undefined,
  };
}

export function buildOptionPlan(input: OptionPlanInput): OptionPlan | null {
  // THE AUTHORITATIVE GEOMETRY — when the caller supplies the market's
  // geometry, the plan is priced from the MARKET (the structural stop mapped
  // through delta + the carry, the targets from the market's own path). The
  // legacy rupee-risk ladder below is unchanged for every other engine.
  if (input.geometry) {
    return geometryToOptionPlan(
      buildGeometryPlan({
        symbol: input.symbol,
        optionType: input.optionType,
        entryPremium: input.entryPremium,
        strike: Number(input.strike ?? 0),
        expiry: String(input.expiry ?? ""),
        lotSize: input.lotSize,
        geometry: input.geometry,
        lots: input.lots,
        deployedAmount: input.deployedAmount,
        targetMultipliers: input.targetMultipliers,
        now: input.now,
      }),
    );
  }
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
  /**
   * The legacy structure block (entry / stop / target1…). Required in the
   * legacy mode; ignored in the authoritative mode, which reads the market's
   * geometry from `geometry` instead.
   */
  underlying?: {
    entry: number;
    stop: number;
    target1: number;
    target2?: number;
    target3?: number;
  };
  deployedAmount?: number;
  confirmation?: StructureConfirmation;
  now?: Date;
  /**
   * "authoritative" — ONE plan object, priced from the market (the same core
   * `buildOptionPlan` uses). "legacy" (default) — the structure block above.
   */
  mode?: "legacy" | "authoritative";
  /** The market's geometry — required in the authoritative mode. */
  geometry?: OptionGeometryInput;
}

export interface StructureOptionPlan {
  ok: boolean;
  /** Why the structure plan could not be used (the caller falls back only on
   *  "no_structure_data" — an R:R below the floor is a REJECT, not a fallback). */
  reason?: GeometryReason | "unknown_lot";
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
  // ── The authoritative geometry (Wave 4, 2026-11-27) ──────────────────
  /** The NUMERIC underlying level that invalidates the idea. */
  invalidation?: number | null;
  /** The underlying stop the premium stop was mapped from. */
  underlyingStop?: number | null;
  /** The underlying level that must break for the setup to fire. */
  underlyingTrigger?: number | null;
  /** The entry zone — the live book, or a band around the LTP. */
  entryZone?: { low: number; high: number; source: "book" | "ltp-band" } | null;
  /** ₹ lost if the stop fills. */
  maxLoss?: number;
  /** The ₹ rupee-risk allowance the lots were sized against. */
  riskBudget?: number;
  /** Each target's market level + its R multiple. */
  targetDetails?: OptionTargetDetail[];
}

export function countConfirmations(confirmation?: StructureConfirmation): number {
  if (!confirmation) return 0;
  return Object.values(confirmation).filter(Boolean).length;
}

export function buildStructureOptionPlan(input: StructureOptionPlanInput): StructureOptionPlan {
  // THE AUTHORITATIVE MODE — the SAME core the plan builder uses, so the two
  // can never print two different ladders for one contract.
  if (input.mode === "authoritative") {
    const g = buildGeometryPlan({
      symbol: input.symbol,
      optionType: input.optionType,
      entryPremium: input.entryPremium,
      strike: input.strike,
      expiry: input.expiry,
      lotSize: input.lotSize,
      geometry: input.geometry ?? {
        spot: 0,
        underlyingStop: null,
        atr: 0,
      },
      deployedAmount: input.deployedAmount,
      now: input.now,
    });
    return {
      ok: g.ok,
      reason: g.reason,
      message: g.message,
      entry: g.entry,
      stopLoss: g.stopLoss,
      targets: g.targets,
      rr: g.rr,
      lots: g.lots,
      units: g.units,
      deployed: g.deployed,
      riskAmount: g.riskAmount,
      confirmedCount: countConfirmations(input.confirmation),
      notes: g.notes,
      tradable: g.tradable,
      invalidation: g.invalidation,
      underlyingStop: g.underlyingStop,
      underlyingTrigger: g.underlyingTrigger,
      entryZone: g.entryZone,
      maxLoss: g.maxLoss,
      riskBudget: g.riskBudget,
      targetDetails: g.targetDetails,
    };
  }
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
  if (!u || !(u.entry > 0) || !(u.stop > 0) || !(u.target1 > 0)) {
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
  // Structure R:R is reported, not enforced: the engine never rejects a
  // candidate solely because its calculated R:R is below a fixed floor.
  if (structureRR < PLAN_CONFIG.minOptionRR) {
    notes.push(`structure R:R 1:${structureRR.toFixed(2)} is below the house reference 1:${PLAN_CONFIG.minOptionRR}`);
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
  // Option R:R is reported, not enforced: the engine never rejects a
  // candidate solely because its calculated R:R is below a fixed floor.
  if (rr < PLAN_CONFIG.minOptionRR) {
    notes.push(`option R:R 1:${rr.toFixed(2)} is below the house reference 1:${PLAN_CONFIG.minOptionRR}`);
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

/** Human-readable "why this strike" line.
 *
 *  ONE format, shared by the strike picker and the plan re-anchor (which
 *  rebuilds a card for an already-chosen strike) — the two must never drift
 *  into different wording for the same fact. */
export function describeStrike(sel: {
  entry: number;
  delta: number | null;
  deltaSource?: "provider" | "bs" | null;
  otmSteps: number;
  lotSize: number;
}): string {
  const deltaLabel = sel.delta == null
    ? "delta unavailable — nearest tradable ATM..OTM contract"
    : `|delta| ${Math.abs(sel.delta).toFixed(2)}${sel.deltaSource === "bs" ? " (BS)" : ""}`;
  if (sel.delta == null) return deltaLabel;
  const cost = Math.round(Number(sel.entry) * Number(sel.lotSize)).toLocaleString("en-IN");
  return sel.otmSteps === 0
    ? `ATM · ${deltaLabel} · 1 lot ₹${cost}`
    : `${sel.otmSteps} step${sel.otmSteps > 1 ? "s" : ""} OTM · ${deltaLabel} · 1 lot ₹${cost}`;
}

/** Must a frozen plan ladder be RE-ANCHORED to the live premium?
 *
 *  The ladder is anchored to the STRIKE, not to the price. When the live
 *  premium drifts materially from the frozen entry (routine on a 0DTE), the
 *  frozen entry / SL / TP / lots are no longer the market's: the card would
 *  print an entry 10% away from the live price, a rupee risk that is not the
 *  real risk, and a lot count that deploys over the budget when filled at the
 *  live premium.
 *
 *  Re-anchor when the live premium moved by more than `premiumDriftPct`
 *  (default PLAN_CONFIG.reanchorPremiumDriftPct). Below that band the ladder
 *  stays put so the SL/TP do not jitter on every poll.
 *
 *  A missing / invalid live premium NEVER re-anchors — the frozen ladder is
 *  kept and the card says so; a price is never invented. */
export function shouldReanchorPlan(input: {
  frozenEntry: number;
  livePremium: number | null | undefined;
  lots: number;
  lotSize: number;
  premiumDriftPct?: number;
}): { reanchor: boolean; reason: string; driftPct: number | null } {
  const entry = Number(input.frozenEntry);
  const lotSize = Number(input.lotSize);
  const live = input.livePremium == null ? NaN : Number(input.livePremium);
  if (!(entry > 0) || !(lotSize > 0) || !Number.isFinite(live) || !(live > 0)) {
    return { reanchor: false, reason: "no live premium for the frozen strike — keeping the plan", driftPct: null };
  }
  const driftPct = Math.abs(live - entry) / entry;
  const threshold = input.premiumDriftPct ?? PLAN_CONFIG.reanchorPremiumDriftPct;
  if (driftPct >= threshold) {
    const dir = live > entry ? "above" : "below";
    return {
      reanchor: true,
      reason: `live premium ${dir} the plan entry by ${(driftPct * 100).toFixed(1)}%`,
      driftPct,
    };
  }
  return {
    reanchor: false,
    reason: `live premium within ${(threshold * 100).toFixed(0)}% of the plan entry`,
    driftPct,
  };
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

    const delta = leg.delta != null && Number.isFinite(Number(leg.delta)) ? Number(leg.delta) : null;
    const deltaSource = leg.deltaSource === "provider" || leg.deltaSource === "bs" ? leg.deltaSource : null;
    if (delta != null && Math.abs(delta) < GATE_CONFIG.minAbsDelta) {
      continue;                                                // lottery ticket
    }

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
      reason: describeStrike({
        entry: ltp,
        delta,
        deltaSource,
        otmSteps: step,
        lotSize,
      }),
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
    // ── Wall integrity ──────────────────────────────────────────────────
    // A wall whose OI is being UNWOUND is being taken out — the break is
    // live, so the target is reachable THROUGH it. A wall that is being
    // WRITTEN is defended — the target stays blocked. A flat wall is
    // treated as defended (conservative: never assume a wall will move).
    const unwinding = oiChange < 0;
    return {
      target,
      requiredSpot: Number(requiredSpot.toFixed(2)),
      wall: { strike: wallRow.strike, oi, oiChange, side: isCE ? "call" : "put" },
      achievable: unwinding,
      note: unwinding
        ? `TP needs spot ${requiredSpot.toFixed(0)} — ${isCE ? "call" : "put"} wall ${wallRow.strike} (${fmtL(oi)} OI, ${flow}) — being taken out, the break is live${estSuffix}`
        : `TP needs spot ${requiredSpot.toFixed(0)} — ${isCE ? "call" : "put"} wall ${wallRow.strike} (${fmtL(oi)} OI, ${flow}) — defended, the target is blocked${estSuffix}`,
    };
  });
}
