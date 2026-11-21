import { describe, test, expect } from "bun:test";
import {
  buildStructureOptionPlan,
  countConfirmations,
  PLAN_CONFIG,
} from "@/lib/option-plan";
import { GATE_CONFIG } from "@/lib/agent-brain-gate";

const EXPIRY = "2026-11-24";

function structureInput(over: Partial<Parameters<typeof buildStructureOptionPlan>[0]> = {}) {
  return {
    symbol: "RELIANCE",
    optionType: "CE" as const,
    entryPremium: 300,
    strike: 2500,
    expiry: EXPIRY,
    lotSize: 500,
    underlying: {
      entry: 2500,
      stop: 2460,      // 1.6% structural stop
      target1: 2600,   // 4% structural target → R:R 2.5 on the underlying
      target2: 2650,
    },
    confirmation: {
      priceAction: true,
      ema: true,
      vwapVolume: true,
      oiChain: true,
    },
    ...over,
  };
}

describe("scanner dynamic plan — structure stop, R:R floor, confirmed targets", () => {
  test("the gate floor is 1:2 on both the option and the underlying", () => {
    expect(GATE_CONFIG.minOptionRR).toBe(2);
    expect(GATE_CONFIG.minUnderlyingRR).toBe(2);
    expect(PLAN_CONFIG.minOptionRR).toBe(2);
  });

  test("the stop comes from the underlying structure, not a fixed % of the premium", () => {
    const plan = buildStructureOptionPlan(structureInput());
    expect(plan.ok).toBe(true);
    expect(plan.stopLoss).toBeGreaterThan(0);
    expect(plan.stopLoss).toBeLessThan(plan.entry);
    // The premium stop must NOT be the legacy 20%-of-premium default.
    expect(Math.abs(plan.entry - plan.stopLoss)).not.toBeCloseTo(20, 1);
    expect(plan.notes.join(" ")).toMatch(/structure/);
  });

  test("a structure whose R:R is below 1:2 is rejected, not silently re-cut", () => {
    const plan = buildStructureOptionPlan(structureInput({
      underlying: { entry: 2500, stop: 2450, target1: 2550, target2: 2600 },
    }));
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe("rr_below_floor");
    expect(plan.message).toMatch(/1:2/);
  });

  test("missing structure data falls back to the rupee-risk plan", () => {
    const plan = buildStructureOptionPlan(structureInput({
      underlying: { entry: 0, stop: 0, target1: 0 },
    }));
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe("no_structure_data");
  });

  test("TP3 is withheld without confirmation and quoted with it", () => {
    const unconfirmed = buildStructureOptionPlan(structureInput({ confirmation: undefined }));
    expect(unconfirmed.ok).toBe(true);
    expect(unconfirmed.confirmedCount).toBe(0);
    expect(unconfirmed.targets.length).toBe(1);
    expect(unconfirmed.notes.join(" ")).toMatch(/TP3.*withheld/);

    const confirmed = buildStructureOptionPlan(structureInput());
    expect(confirmed.confirmedCount).toBe(4);
    expect(confirmed.targets.length).toBeGreaterThanOrEqual(3);
  });

  test("the confirmation counter only counts live-data signals", () => {
    expect(countConfirmations(undefined)).toBe(0);
    expect(countConfirmations({ priceAction: true, ema: false })).toBe(1);
    expect(countConfirmations({ priceAction: true, ema: true, atr: true })).toBe(3);
  });

  test("the plan reports the size and the rupee risk", () => {
    const plan = buildStructureOptionPlan(structureInput());
    expect(plan.lots).toBeGreaterThanOrEqual(1);
    expect(plan.units).toBe(plan.lots * 500);
    expect(plan.deployed).toBeGreaterThan(0);
    expect(plan.riskAmount).toBeGreaterThan(0);
  });
});
