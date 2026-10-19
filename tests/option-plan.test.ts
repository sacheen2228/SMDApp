import { describe, test, expect } from "bun:test";
import { buildOptionPlan, lotsForBudget, PLAN_CONFIG } from "@/lib/option-plan";

describe("option-plan — rupee risk + R:R 1:2/1:3/1:4 ladder", () => {
  test("the user's example: spend ₹10,000 → risk ₹2,000, targets at 2R/3R/4R", () => {
    // 1 NIFTY lot (65) at ₹153.85 → deployed ₹10,000
    const p = buildOptionPlan({
      symbol: "NIFTY", optionType: "CE", entryPremium: 153.85, lotSize: 65, lots: 1,
      deployedAmount: 10_000, riskAmount: 2_000,
    })!;
    expect(p.deployed).toBeCloseTo(10_000, 0);
    expect(p.riskAmount).toBeCloseTo(2_000, 0);
    expect(p.riskPoints).toBeCloseTo(2000 / 65, 5);
    // levels are rounded to the ₹0.05 tick grid
    expect(Math.abs(p.stopLoss - (153.85 - 2000 / 65))).toBeLessThanOrEqual(0.05);
    expect(Math.abs(p.targets[0] - (153.85 + 2 * (2000 / 65)))).toBeLessThanOrEqual(0.05);
    expect(Math.abs(p.targets[1] - (153.85 + 3 * (2000 / 65)))).toBeLessThanOrEqual(0.05);
    expect(Math.abs(p.targets[2] - (153.85 + 4 * (2000 / 65)))).toBeLessThanOrEqual(0.05);
    expect(p.rr).toBeCloseTo(2, 1);
    // ₹ at the targets: 2R = ₹4,000, 3R = ₹6,000, 4R = ₹8,000
    expect(p.rupee.tp1).toBeCloseTo(4_000, -1);   // tick rounding on the price
    expect(p.rupee.tp2).toBeCloseTo(6_000, -1);
    expect(p.rupee.tp3).toBeCloseTo(8_000, -1);
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
    expect(p.riskAmount / p.deployed).toBeCloseTo(PLAN_CONFIG.riskPctOfDeployed, 5);
  });

  test("default sizing uses the live ₹20k deployment budget", () => {
    expect(lotsForBudget(300, 65, 20_000)).toBe(1);   // ₹19,500 per lot
    expect(lotsForBudget(150, 65, 20_000)).toBe(2);   // ₹9,750 per lot
    expect(lotsForBudget(100, 65, 20_000)).toBe(3);   // ₹6,500 per lot
    const p = buildOptionPlan({ symbol: "NIFTY", optionType: "CE", entryPremium: 150, lotSize: 65 })!;
    expect(p.lots).toBe(2);
    expect(p.units).toBe(130);
    expect(p.deployed).toBe(19_500);
  });

  test("the stop is capped at 35% of the premium and the rupee risk shrinks with it", () => {
    const p = buildOptionPlan({
      symbol: "NIFTY", optionType: "CE", entryPremium: 100, lotSize: 65, lots: 1,
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

  test("PE plans mirror the geometry (stop above the entry)", () => {
    const p = buildOptionPlan({
      symbol: "NIFTY", optionType: "PE", entryPremium: 100, lotSize: 65, lots: 1,
      deployedAmount: 6_500, riskAmount: 1_300,
    })!;
    expect(p.stopLoss).toBeGreaterThan(100);
    expect(p.targets[0]).toBeLessThan(100);
  });

  test("no plan when the premium is unknown or the risk exceeds the premium", () => {
    expect(buildOptionPlan({ symbol: "X", optionType: "CE", entryPremium: 0, lotSize: 65 })).toBeNull();
    expect(buildOptionPlan({
      symbol: "X", optionType: "CE", entryPremium: 10, lotSize: 65, lots: 1,
      deployedAmount: 650, riskAmount: 5_000, maxStopPctOfPremium: 2,
    })).toBeNull();
  });
});

describe("session cutoff — no new option premium buys after 13:00 IST", () => {
  test("an option alert after 13:00 IST is hard-blocked", async () => {
    const { evaluateSignalVeto } = await import("@/lib/signal-veto");
    const istHour = new Date(Date.now() + 5.5 * 3600_000).getUTCHours();
    if (istHour < 13) return; // only meaningful after 13:00 IST
    const r = evaluateSignalVeto({
      symbol: "NIFTY", action: "BUY CE", optionType: "CE", strike: 22600,
      entry: 100, stopLoss: 80, tp1: 140, confidence: 75, source: "test",
    });
    expect(r.verdict).toBe("BLOCK");
    expect(r.fails.join(" ")).toMatch(/13:00/);
  });
});
