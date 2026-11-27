import { describe, test, expect } from "bun:test";
import { buildOptionPlan, lotsForBudget, PLAN_CONFIG } from "@/lib/option-plan";

describe("option-plan — rupee risk + R:R 1:2/1:3/1:4 ladder", () => {
  test("the user's example: spend ₹10,000 → risk ₹2,000, targets at 2R/3R/4R", () => {
    // 1 lot (65) at ₹153.85 costs ₹10,000 — under the 2-lot default → lots=0, not tradable
    const p = buildOptionPlan({
      symbol: "NIFTY", optionType: "CE", entryPremium: 153.85, lotSize: 65, lots: 0,
      deployedAmount: 10_000, riskAmount: 2_000,
    })!;
    expect(p.lots).toBe(0);
    expect(p.tradable).toBe(false);
    expect(p.deployed).toBe(0);
    expect(p.riskAmount).toBe(0);
    expect(p.riskPoints).toBeCloseTo(2000 / 65, 5);
    // levels are rounded to the ₹0.05 tick grid (per-unit, still meaningful)
    expect(Math.abs(p.stopLoss - (153.85 - 2000 / 65))).toBeLessThanOrEqual(0.05);
    expect(Math.abs(p.targets[0] - (153.85 + 2 * (2000 / 65)))).toBeLessThanOrEqual(0.05);
    expect(Math.abs(p.targets[1] - (153.85 + 3 * (2000 / 65)))).toBeLessThanOrEqual(0.05);
    expect(Math.abs(p.targets[2] - (153.85 + 4 * (2000 / 65)))).toBeLessThanOrEqual(0.05);
    expect(p.rr).toBeCloseTo(2, 1);
    // ₹ P&L at targets is 0 when not tradable
    expect(p.rupee.tp1).toBe(0);
    expect(p.rupee.tp2).toBe(0);
    expect(p.rupee.tp3).toBe(0);
  });

  test("a 4R target is dropped when the premium cannot reach it", () => {
    const p = buildOptionPlan({
      symbol: "NIFTY", optionType: "CE", entryPremium: 100, lotSize: 65, lots: 1,
      deployedAmount: 6_500, riskAmount: 2_000,
    })!;
    expect(p.targets.length).toBe(2);            // 4R would need +123 pts on a ₹100 premium
    expect(p.notes.join(" ")).toMatch(/unreachable/);
  });

  test("risk defaults to 20% of the amount deployed", () => {
    const p = buildOptionPlan({
      symbol: "NIFTY", optionType: "CE", entryPremium: 100, lotSize: 65, lots: 1, deployedAmount: 10_000,
    })!;
    expect(p.lots).toBe(0);
    expect(p.tradable).toBe(false);
    expect(p.deployed).toBe(0);
    expect(p.riskAmount).toBe(0);
  });

  test("default sizing uses the 2-lot rule (0 when 2 lots don't fit)", () => {
    expect(lotsForBudget(300, 65, 20_000)).toBe(0);   // ₹19,500 per lot — only 1 fits → not tradable
    expect(lotsForBudget(150, 65, 20_000)).toBe(2);   // ₹9,750 per lot — 2 fit → 2 lots
    expect(lotsForBudget(100, 65, 20_000)).toBe(2);   // ₹6,500 per lot — 3 fit, capped at 2 lots
    const p = buildOptionPlan({ symbol: "NIFTY", optionType: "CE", entryPremium: 150, lotSize: 65 })!;
    expect(p.lots).toBe(2);                           // capped at defaultLots (2)
    expect(p.units).toBe(130);
    expect(p.deployed).toBe(19_500);
  });

  test("the stop is capped at 35% of the premium and the rupee risk shrinks with it", () => {
    const p = buildOptionPlan({
      // 10 units: the ₹2,000 risk cap allows a 200-pt stop, well past the 35% cap
      symbol: "NIFTY", optionType: "CE", entryPremium: 100, lotSize: 10, lots: 1,
      deployedAmount: 10_000, riskAmount: 6_000, // wants a 92% stop — must be capped
    })!;
    expect(p.stopLoss).toBeCloseTo(100 * 0.65, 1);
    expect(p.riskAmount).toBeLessThan(6_000);
    expect(p.notes.join(" ")).toMatch(/capped/);
  });

  test("the stop is never tighter than the noise floor (8 ticks)", () => {
    const p = buildOptionPlan({
      symbol: "NTPC", optionType: "CE", entryPremium: 4.2, lotSize: 500, lots: 1,
      deployedAmount: 2_100, riskAmount: 50,
    })!;
    expect(p.riskPoints).toBeCloseTo(8 * 0.05, 5);
    expect(p.notes.join(" ")).toMatch(/noise floor/);
  });

  test("unreachable targets are dropped and reported", () => {
    const p = buildOptionPlan({
      symbol: "NIFTY", optionType: "CE", entryPremium: 10, lotSize: 65, lots: 1,
      deployedAmount: 650, riskAmount: 300, // 4R = 12 points > premium 10
    })!;
    expect(p.targets.length).toBeLessThan(3);
    expect(p.notes.join(" ")).toMatch(/unreachable/);
  });

  test("a plan the gate will reject says so (R:R < 1.5)", () => {
    const p = buildOptionPlan({
      symbol: "NIFTY", optionType: "CE", entryPremium: 100, lotSize: 65, lots: 1,
      deployedAmount: 6_500, riskAmount: 6_000, maxStopPctOfPremium: 0.9,
      targetMultipliers: [1],
    })!;
    expect(p.rr).toBeCloseTo(1, 5);
    expect(p.notes.join(" ")).toMatch(/below the gate/);
  });

  // CORRECTED 2026-10-31 (audit defect D-1): this test used to assert the
  // MIRRORED geometry (stop ABOVE entry for a PE) — the "mirror" intuition is
  // wrong for a long option. A bought PE loses when the premium FALLS, so the
  // stop must sit BELOW the premium paid and the targets ABOVE it — the same
  // long-option risk convention as a CE (user spec, remediation R1 approval).
  // The old assertion enshrined a plan where the displayed "stop" was a +20%
  // profit exit and the "targets" were −40%/−60%/−80% losses.
  test("PE plans use the long-option geometry (stop BELOW the entry, targets above)", () => {
    const p = buildOptionPlan({
      symbol: "NIFTY", optionType: "PE", entryPremium: 100, lotSize: 65, lots: 1,
      deployedAmount: 6_500, riskAmount: 1_300,
    })!;
    expect(p.lots).toBe(0);
    expect(p.tradable).toBe(false);
    expect(p.deployed).toBe(0);
    expect(p.riskAmount).toBe(0);
    expect(p.stopLoss).toBeLessThan(100);
    expect(p.targets[0]).toBeGreaterThan(100);
    expect(p.targets[1]).toBeGreaterThan(p.targets[0]);
    expect(p.targets[2]).toBeGreaterThan(p.targets[1]);
    // the ₹ P&L at each target is 0 when not tradable
    expect(p.rupee.tp1).toBe(0);
    expect(p.rupee.tp2).toBe(0);
    expect(p.rupee.tp3).toBe(0);
    // signed R:R — risk = entry − stop (positive only for a correct stop)
    expect(p.rr).toBeGreaterThan(0);
    expect(p.rr).toBeCloseTo(2, 1);
  });

  test("PE and CE of the same premium produce the SAME geometry (audit regression: ADANIPORTS 1840 PE)", () => {
    // The reported defect: "Buy ADANIPORTS 1840 PE @ ₹39.1 | SL ₹46.9 |
    // T1 ₹23.45 | T2 ₹15.65 | T3 ₹7.8" — SL above entry, targets below.
    // 1 lot = 500 units; risk = 20% of deployed = ₹3,910 → ₹7.82 premium
    // points: SL 31.28, T1 54.72… (the FIXED ₹2,000-cap era gave SL 35.10)
    const pe = buildOptionPlan({
      symbol: "ADANIPORTS", optionType: "PE", entryPremium: 39.1, lotSize: 500, lots: 1,
    })!;
    const ce = buildOptionPlan({
      symbol: "ADANIPORTS", optionType: "CE", entryPremium: 39.1, lotSize: 500, lots: 1,
    })!;
    expect(pe.stopLoss).toBeLessThan(39.1);
    // 20% of (39.1 × 500) = ₹3,910 → 7.82 pts → SL ≈ 31.28 (±tick)
    expect(pe.stopLoss).toBeCloseTo(39.1 - (39.1 * 500 * 0.2) / 500, 1);
    expect(pe.targets[0]).toBeGreaterThan(39.1);
    // identical levels for CE and PE of the same premium
    expect(pe.stopLoss).toBe(ce.stopLoss);
    expect(pe.targets).toEqual(ce.targets);
    expect(pe.rr).toBeCloseTo(2, 1);
    expect(pe.rupee.tp1).toBe(0);
    // the OLD (wrong) numbers must never come back
    expect(pe.stopLoss).not.toBe(46.9);
    expect(pe.targets).not.toContain(23.45);
    expect(pe.targets).not.toContain(15.65);
    expect(pe.targets).not.toContain(7.8);
    expect(pe.lots).toBe(0);
    expect(pe.tradable).toBe(false);
    expect(pe.rupee.tp1).toBe(0);
  });

  test("a stop ABOVE the entry can never be reported as a valid R:R (signed risk)", () => {
    // The signed check: risk = entry − stopLoss. A wrong-side stop yields a
    // non-positive risk → rr 0 → the gate note fires. The old Math.abs formula
    // reported rr 2.0 for exactly that broken plan.
    const p = buildOptionPlan({
      symbol: "NIFTY", optionType: "PE", entryPremium: 100, lotSize: 65, lots: 1,
      deployedAmount: 6_500, riskAmount: 1_300,
    })!;
    const risk = p.entry - p.stopLoss;
    expect(risk).toBeGreaterThan(0);
    expect(p.rr).toBe((p.targets[0] - p.entry) / risk);
  });

  test("no plan when the premium is unknown or the risk exceeds the premium", () => {
    expect(buildOptionPlan({ symbol: "X", optionType: "CE", entryPremium: 0, lotSize: 65 })).toBeNull();
    expect(buildOptionPlan({
      symbol: "X", optionType: "CE", entryPremium: 10, lotSize: 65, lots: 1,
      deployedAmount: 650, riskAmount: 5_000, maxStopPctOfPremium: 2,
    })).toBeNull();
  });
});

