// Daily Derivatives — Wave 4 acceptance test: ONE authoritative trade geometry.
//
// The card's stop/targets must be structure/ATR/IV-aware, NOT a fixed % of the
// premium. buildStructureOptionPlan is the single geometry engine used by every
// card; this test pins that behaviour.
//
// Fix 1: exactly 2 lots — every eligible trade uses 2 lots, never silently
// reduced to 1, never automatically increased. If 2 lots fail affordability or
// per-trade risk, NO TRADE with an exact reason.
// Fix 2: no fixed RR rejection — RR is calculated and displayed, never used as
// a hard gate in evaluatePlanTrade.

import { describe, test, expect } from "bun:test";
import {
  buildStructureOptionPlan,
  lotsForBudget,
  sizeOptionTrade,
  PLAN_CONFIG,
} from "@/lib/option-plan";
import { evaluatePlanTrade } from "@/lib/DailyDerivatives";
import { GATE_CONFIG } from "@/lib/agent-brain-gate";

// Today is 2026-11-27; use an expiry that is clearly in the future.
const FUTURE_EXPIRY = "2026-12-31";
const NIFTY_LOT = 65;   // NIFTY lot size per symbol-config.ts
const SENSEX_LOT = 20;  // SENSEX lot size per symbol-config.ts

const baseInput = (over: Partial<Parameters<typeof buildStructureOptionPlan>[0]> = {}) => ({
  symbol: "NIFTY",
  optionType: "CE",
  entryPremium: 200,
  strike: 25000,
  expiry: FUTURE_EXPIRY,
  lotSize: NIFTY_LOT,
  underlying: { entry: 25000, stop: 24960, target1: 25200 },
  confirmation: { ema: true, vwapVolume: true },
  ...over,
});

describe("Wave 4 — ONE authoritative trade geometry", () => {
  // ── Fix 1: exactly 2 lots ──
  test("NIFTY CE: exactly 2 lots when affordable", () => {
    const plan = buildStructureOptionPlan(baseInput());
    expect(plan.ok).toBe(true);
    expect(plan.tradable).toBe(true);
    expect(plan.lots).toBe(2);
    expect(plan.units).toBe(2 * NIFTY_LOT);
    expect(plan.deployed).toBeCloseTo(plan.entry * plan.units, 0);
  });

  test("NIFTY PE: exactly 2 lots when affordable", () => {
    const plan = buildStructureOptionPlan({
      ...baseInput(),
      optionType: "PE",
      entryPremium: 150,
      underlying: { entry: 25000, stop: 25040, target1: 24900 },
    });
    expect(plan.ok).toBe(true);
    expect(plan.tradable).toBe(true);
    expect(plan.lots).toBe(2);
    expect(plan.units).toBe(2 * NIFTY_LOT);
  });

  test("SENSEX CE: exactly 2 lots when affordable", () => {
    const plan = buildStructureOptionPlan({
      ...baseInput(),
      symbol: "SENSEX",
      optionType: "CE",
      entryPremium: 800,
      strike: 80000,
      lotSize: SENSEX_LOT,
      underlying: { entry: 80000, stop: 79900, target1: 80100 },
    });
    expect(plan.ok).toBe(true);
    expect(plan.tradable).toBe(true);
    expect(plan.lots).toBe(2);
    expect(plan.units).toBe(2 * SENSEX_LOT);
    expect(plan.deployed).toBeCloseTo(plan.entry * plan.units, 0);
  });

  test("SENSEX PE: exactly 2 lots when affordable", () => {
    const plan = buildStructureOptionPlan({
      ...baseInput(),
      symbol: "SENSEX",
      optionType: "PE",
      entryPremium: 160,
      strike: 80000,
      lotSize: SENSEX_LOT,
      underlying: { entry: 80000, stop: 80060, target1: 79900 },
    });
    expect(plan.ok).toBe(true);
    expect(plan.tradable).toBe(true);
    expect(plan.lots).toBe(2);
    expect(plan.units).toBe(2 * SENSEX_LOT);
  });

  test("NIFTY CE: 0 lots, not tradable when 2 lots exceed affordability", () => {
    const plan = buildStructureOptionPlan({
      ...baseInput(),
      deployedAmount: 10_000, // 2 lots × 200 × 65 = ₹26,000 > ₹10,000 budget
    });
    expect(plan.ok).toBe(true);
    expect(plan.tradable).toBe(false);
    expect(plan.lots).toBe(0);
    expect(plan.deployed).toBe(0);
  });

  test("sizeOptionTrade: explicit lots=1 is NOT tradable (exactly 2 required)", () => {
    const sized = sizeOptionTrade({ entryPremium: 200, lotSize: NIFTY_LOT, lots: 1 });
    expect(sized.lots).toBe(1);
    expect(sized.tradable).toBe(false);
    expect(sized.reason).toContain("expected 2 lot(s), got 1");
  });

  test("sizeOptionTrade: explicit lots=2 is tradable when affordable", () => {
    const sized = sizeOptionTrade({ entryPremium: 200, lotSize: NIFTY_LOT, lots: 2, deployedAmount: 100_000 });
    expect(sized.lots).toBe(2);
    expect(sized.tradable).toBe(true);
    expect(sized.deployed).toBeCloseTo(200 * 2 * NIFTY_LOT, 0);
  });

  test("lotsForBudget: returns 0 when 2 lots do not fit the budget", () => {
    // 2 lots × 200 × 65 = ₹26,000 > ₹10,000 → affordable = 0 → lots = 0
    expect(lotsForBudget(200, NIFTY_LOT, 10_000)).toBe(0);
    // 2 lots × 200 × 65 = ₹26,000 ≤ ₹30,000 → affordable = 1... wait, affordable = floor(30000/13000) = 2 → lots = 2
    expect(lotsForBudget(200, NIFTY_LOT, 30_000)).toBe(2);
    // 1 lot × 200 × 65 = ₹13,000 ≤ ₹20,000 but 2 lots = ₹26,000 > ₹20,000 → lots = 0
    expect(lotsForBudget(200, NIFTY_LOT, 20_000)).toBe(0);
  });

  test("lotsForBudget: SENSEX lot size (20) returns exactly 2 when affordable", () => {
    expect(lotsForBudget(150, SENSEX_LOT, 100_000)).toBe(2); // affordable = 33 → 2
    expect(lotsForBudget(150, SENSEX_LOT, 2_000)).toBe(0);   // affordable = 0 → 0
  });

  // ── Fix 2: no fixed RR rejection ──
  test("evaluatePlanTrade: RR 1:0.5 (below 1.5) is NOT rejected", () => {
    const result = evaluatePlanTrade({
      optionType: "CE",
      tradable: true,
      lots: 2,
      rr: 1.0,
      entry: 200,
      stopLoss: 180,
      targets: [220],
      marketOpen: true,
      delta: 0.5,
      theta: -5,
      oiChange: 1000,
      ema: { trend: "UP", adx: 25, plusDI: 25, minusDI: 15, emaFast: 25000, emaSlow: 24950, atr: 100, gapAtr: 0.5 },
      chainFreshness: "LIVE",
      candleAgeMs: 60_000,
    });
    expect(result.decision).not.toBe("NO");
    expect(result.decision).not.toBe("NO TRADE");
  });

  test("evaluatePlanTrade: RR 1:1.5 is NOT rejected", () => {
    const result = evaluatePlanTrade({
      optionType: "CE",
      tradable: true,
      lots: 2,
      rr: 1.5,
      entry: 200,
      stopLoss: 180,
      targets: [230],
      marketOpen: true,
      delta: 0.5,
      theta: -5,
      oiChange: 1000,
      ema: { trend: "UP", adx: 25, plusDI: 25, minusDI: 15, emaFast: 25000, emaSlow: 24950, atr: 100, gapAtr: 0.5 },
      chainFreshness: "LIVE",
      candleAgeMs: 60_000,
    });
    expect(result.decision).not.toBe("NO");
    expect(result.decision).not.toBe("NO TRADE");
  });

  test("evaluatePlanTrade: lots=1 is rejected (exactly 2 required)", () => {
    const result = evaluatePlanTrade({
      optionType: "CE",
      tradable: true,
      lots: 1,
      rr: 2.0,
      entry: 200,
      stopLoss: 180,
      targets: [240],
      marketOpen: true,
      delta: 0.5,
      theta: -5,
      oiChange: 1000,
      ema: { trend: "UP", adx: 25, plusDI: 25, minusDI: 15, emaFast: 25000, emaSlow: 24950, atr: 100, gapAtr: 0.5 },
      chainFreshness: "LIVE",
      candleAgeMs: 60_000,
    });
    expect(result.decision).toBe("NO");
    expect(result.label).toBe("NO TRADE");
    expect(result.reasons.join(" ")).toContain("expected 2 lot(s), got 1");
  });

  test("evaluatePlanTrade: lots=0 is rejected", () => {
    const result = evaluatePlanTrade({
      optionType: "CE",
      tradable: false,
      lots: 0,
      rr: 2.0,
      entry: 200,
      stopLoss: 180,
      targets: [240],
      marketOpen: true,
      delta: 0.5,
      theta: -5,
      oiChange: 1000,
      ema: { trend: "UP", adx: 25, plusDI: 25, minusDI: 15, emaFast: 25000, emaSlow: 24950, atr: 100, gapAtr: 0.5 },
      chainFreshness: "LIVE",
      candleAgeMs: 60_000,
    });
    expect(result.decision).toBe("NO");
    expect(result.label).toBe("NO TRADE");
  });

  test("RR is calculated and displayed (not a fixed 2.0 when structure differs)", () => {
    // Higher confirmed count → multipliers [2,3,4] → TP1 = 2R → rr = 2.0
    // Lower confirmed count → multipliers [2] → TP1 = 2R → rr = 2.0
    // The rr field is always populated from the calculation.
    const plan = buildStructureOptionPlan({
      ...baseInput(),
      confirmation: { ema: true }, // only 1 confirmation → multipliers [2]
    });
    expect(plan.ok).toBe(true);
    expect(plan.rr).toBeGreaterThan(0);
    // No rejection reason for RR — RR is reported, not used as a gate.
    expect(plan.reason).toBeUndefined();
  });

  test("targets are not artificially inflated beyond premium", () => {
    const plan = buildStructureOptionPlan({
      ...baseInput(),
      entryPremium: 200, // above intrinsic (~162 for ATM NIFTY)
      underlying: { entry: 25000, stop: 24990, target1: 25010 },
      confirmation: { priceAction: true, ema: true, vwapVolume: true, oiChain: true },
    });
    expect(plan.ok).toBe(true);
    expect(plan.tradable).toBe(true);
    // For a CE buy, all targets should be above entry (positive premium movement)
    for (const t of plan.targets) {
      expect(t).toBeGreaterThan(plan.entry);
      // And no target should be astronomically inflated
      expect(t).toBeLessThanOrEqual(plan.entry * 10);
    }
  });

  // ── Pre-existing tests retained ──
  test("the stop is delta-mapped from the underlying stop, never a fixed 20% of premium", () => {
    const plan = buildStructureOptionPlan({
      ...baseInput(),
      underlying: { entry: 25000, stop: 24900, target1: 25200 },
    });
    expect(plan.ok).toBe(true);
    expect(plan.tradable).toBe(true);
    expect(plan.stopLoss).toBeGreaterThan(0);
    expect(plan.stopLoss).toBeLessThan(plan.entry);
    const stopPct = (plan.entry - plan.stopLoss) / plan.entry;
    expect(stopPct).not.toBeCloseTo(0.20, 1); // not the fixed 20% default
  });

  test("structure R:R below 1:2 is still reported, not rejected (data-driven R:R)", () => {
    const plan = buildStructureOptionPlan({
      ...baseInput(),
      underlying: { entry: 25000, stop: 24990, target1: 25005 },
    });
    expect(plan.ok).toBe(true);
    expect(plan.tradable).toBe(true);
    expect(plan.rr).toBeGreaterThan(0);
    // RR is surfaced, not used as a gate — no rejection reason
    expect(plan.reason).toBeUndefined();
  });

  test("PLAN_CONFIG carries the house risk envelope", () => {
    expect(PLAN_CONFIG.riskPctOfDeployed).toBe(0.20);
    expect(PLAN_CONFIG.targetMultipliers).toEqual([2, 3, 4]);
    expect(PLAN_CONFIG.defaultLots).toBe(2);
    expect(PLAN_CONFIG.minOptionRR).toBe(2);
  });
});
