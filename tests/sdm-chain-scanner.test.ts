// SDM chain scanner — scan-plan unit tests (TDD).
// The scanner only supplies requests to /api/option-chain (which owns
// alerting); these tests cover rotation, env-shaped config, and universe
// hygiene — no network.

import { describe, it, expect } from "bun:test";
import { FNO_SCAN_UNIVERSE, getScanPlan } from "@/lib/sdm-chain-scanner";

const INDICES = ["NIFTY", "SENSEX"];

describe("getScanPlan — round-robin rotation", () => {
  it("tick 0 = all indices + first stock", () => {
    expect(getScanPlan(0, INDICES, FNO_SCAN_UNIVERSE)).toEqual([
      "NIFTY", "SENSEX", "RELIANCE",
    ]);
  });

  it("tick 1 = all indices + second stock", () => {
    const plan = getScanPlan(1, INDICES, FNO_SCAN_UNIVERSE);
    expect(plan.slice(0, 2)).toEqual(["NIFTY", "SENSEX"]);
    expect(plan[2]).toBe("TCS");
  });

  it("rotates through the whole universe and wraps", () => {
    const n = FNO_SCAN_UNIVERSE.length;
    expect(getScanPlan(n, INDICES, FNO_SCAN_UNIVERSE)[2]).toBe("RELIANCE");
  });

  it("no stocks configured → indices only", () => {
    expect(getScanPlan(3, INDICES, [])).toEqual(["NIFTY", "SENSEX"]);
  });

  it("empty tick → empty plan", () => {
    expect(getScanPlan(0, [], [])).toEqual([]);
  });
});

describe("FNO_SCAN_UNIVERSE hygiene", () => {
  it("is20 unique uppercase symbols", () => {
    expect(FNO_SCAN_UNIVERSE.length).toBe(20);
    expect(new Set(FNO_SCAN_UNIVERSE).size).toBe(20);
    for (const s of FNO_SCAN_UNIVERSE) expect(s).toBe(s.toUpperCase());
  });

  it("contains no index symbols (indices are scanned every tick)", () => {
    for (const idx of INDICES) expect(FNO_SCAN_UNIVERSE.includes(idx)).toBe(false);
  });
});
