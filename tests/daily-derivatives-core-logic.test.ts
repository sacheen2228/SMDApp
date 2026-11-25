// ═══════════════════════════════════════════════════════════════════════════
// Daily Derivatives — CORE LOGIC LOCK
// The card's own strategy (direction bias, strike selection, SL/TP ladder,
// sizing) is the desk's production logic. The CVD / futures-volume / ΔOI read
// is CONTEXT ONLY — it must never change a vote, a strike, a level or a lot.
//
// This suite pins that contract so a future change cannot silently couple the
// flow read into the card's trade logic.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DailyDerivativesService } from "@/lib/DailyDerivatives";
import { buildOptionPlan } from "@/lib/option-plan";

const SRC = readFileSync(join(process.cwd(), "src/lib/DailyDerivatives.ts"), "utf-8");

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = SRC.indexOf(startMarker);
  const end = SRC.indexOf(endMarker, start + startMarker.length);
  return SRC.slice(start, end > start ? end : start + 4000);
}

describe("Daily Derivatives core logic (locked)", () => {
  it("the direction bias has exactly the five canonical factors", () => {
    const service: any = new DailyDerivativesService();
    // spot 24500 BELOW maxPain 24550 → gravity UP → Max Pain votes CALL
    // (fixed 2026-11-25 — was inverted vs sdm-engine / gap-engine).
    const bias = service.computeDirectionBias({
      spot: 24500,
      pcr: 1.12,
      maxPain: 24550,
      topCallOI: [{ oiChange: -1000 }],
      topPutOI: [{ oiChange: 5000 }],
      latestSignals: [],
      sentimentScore: 52,
    });

    expect(bias.votes.map((v: any) => v.factor)).toEqual([
      "PCR",
      "Max Pain",
      "OI Shift",
      "Candles",
      "Sentiment",
    ]);
    // PCR put-heavy CALL · Max Pain gravity-up CALL · OI support CALL → 3-0
    expect(bias.side).toBe("CALL");
    expect(bias.callVotes).toBe(3);
    expect(bias.putVotes).toBe(0);
    expect(bias.votes.find((v: any) => v.factor === "Max Pain").vote).toBe("CALL");
  });

  it("max pain votes with gravity: spot above MP → PUT, below → CALL", () => {
    const service: any = new DailyDerivativesService();
    const above = service.computeDirectionBias({
      spot: 25734,
      pcr: 1.0,
      maxPain: 25700,
      topCallOI: [{ oiChange: 0 }],
      topPutOI: [{ oiChange: 0 }],
      latestSignals: [],
      sentimentScore: 50,
    });
    expect(above.votes.find((v: any) => v.factor === "Max Pain").vote).toBe("PUT");
    expect(above.votes.find((v: any) => v.factor === "Max Pain").detail).toMatch(/gravity down/i);

    const below = service.computeDirectionBias({
      spot: 25650,
      pcr: 1.0,
      maxPain: 25700,
      topCallOI: [{ oiChange: 0 }],
      topPutOI: [{ oiChange: 0 }],
      latestSignals: [],
      sentimentScore: 50,
    });
    expect(below.votes.find((v: any) => v.factor === "Max Pain").vote).toBe("CALL");
    expect(below.votes.find((v: any) => v.factor === "Max Pain").detail).toMatch(/gravity up/i);
  });

  it("the futures flow read never enters the bias", () => {
    const body = sliceBetween("private computeDirectionBias", "async getDailyDerivativesReport");
    expect(body).not.toMatch(/cvd|buildup|futuresFlow|cvdFallback/i);
  });

  it("the strike selection and the plan ladder never read the flow", () => {
    const planBlock = sliceBetween("const plan = buildOptionPlan(", "const plan = buildOptionPlan(");
    expect(planBlock).not.toMatch(/cvd|buildup|futuresFlow/i);
  });

  it("the plan ladder stays the canonical builder (stop below entry, 2R/3R/4R, the 1-lot floor)", () => {
    const plan = buildOptionPlan({
      symbol: "NIFTY",
      optionType: "CE",
      entryPremium: 120,
      lotSize: 65,
      deployedAmount: 12000,
    });
    expect(plan.stopLoss).toBeLessThan(plan.entry);
    expect(plan.rr).toBe(2);
    expect(plan.deployed).toBeLessThanOrEqual(45000);
    expect(plan.riskAmount).toBeCloseTo(plan.deployed * 0.2, 6);

    // Over the per-trade budget → ONE lot (the capital never refuses a valid
    // contract, user directive 2026-11-21) with the over-budget flag raised.
    const overBudget = buildOptionPlan({
      symbol: "RELIANCE",
      optionType: "CE",
      entryPremium: 90,
      lotSize: 500,
      deployedAmount: 20000,
    });
    expect(overBudget.lots).toBe(1);
    expect(overBudget.tradable).toBe(true);
    expect(overBudget.deployed).toBe(45_000);
    expect(overBudget.riskAmount).toBeGreaterThan(0);
    expect(overBudget.notes.join(" ")).toMatch(/above the/);
  });

  it("a PE plan keeps the bought-option geometry (stop BELOW entry)", () => {
    const plan = buildOptionPlan({
      symbol: "NIFTY",
      optionType: "PE",
      entryPremium: 90,
      lotSize: 65,
      deployedAmount: 12000,
    });
    expect(plan.stopLoss).toBeLessThan(plan.entry);
    expect(plan.targets.every((t) => t > plan.entry)).toBe(true);
  });
});
