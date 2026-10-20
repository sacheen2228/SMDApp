/// <reference types="bun-types" />
// THE WORKFLOW RISK ENGINE — it must not approve unconditionally.
//
// THE DEFECT (2026-10-20): master-workflow.ts had a stub risk engine that
// returned `approved: true`, `maxPositionSize: 1000000` and no warnings for
// EVERY universe. The workflow's final decision inherited that unconditional
// approval — a "fires wrong signals" defect on a ₹25,000 account.

import { describe, test, expect } from "bun:test";
import { evaluateWorkflowRisk } from "@/lib/master-workflow";
import { RISK_LIMITS, type RiskStateSnapshot } from "@/lib/risk-management";

function cleanState(over: Partial<RiskStateSnapshot> = {}): RiskStateSnapshot {
  return {
    dailyPnl: 0,
    weeklyPnl: 0,
    monthlyPnl: 0,
    consecutiveLosses: 0,
    openDeployed: 0,
    openRisk: 0,
    openPositions: 0,
    unpricedOpenPositions: 0,
    ...over,
  };
}

describe("the workflow risk engine", () => {
  test("a clean book is approved — with the REAL position size", () => {
    const r = evaluateWorkflowRisk(cleanState());
    expect(r.approved).toBe(true);
    // NOT ₹10,00,000 — the ₹ DEPLOYED per trade
    expect(r.maxPositionSize).toBe(RISK_LIMITS.perTradeBudget);
    expect(r.maxPositionSize).toBe(20_000);
    // the ₹ at risk on one trade = 20% of the deployment
    expect(r.var95).toBe(RISK_LIMITS.maxRiskPerTrade);
    expect(r.var95).toBe(4_000);
  });

  test("a blown daily loss is NOT approved", () => {
    const r = evaluateWorkflowRisk(cleanState({ dailyPnl: -8_000 }));
    expect(r.approved).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/daily loss/i);
  });

  test("two consecutive losses are NOT approved", () => {
    const r = evaluateWorkflowRisk(cleanState({ consecutiveLosses: 2 }));
    expect(r.approved).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/consecutive losses/i);
  });

  test("an over-exposed book is NOT approved", () => {
    const r = evaluateWorkflowRisk(cleanState({ openDeployed: 40_000, openRisk: 8_000 }));
    expect(r.approved).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/exceeds/i);
  });

  test("an unreadable risk state is NOT approved (fail closed)", () => {
    const r = evaluateWorkflowRisk(null);
    expect(r.approved).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/fail closed/i);
  });

  test("an unpriced open position is surfaced as a warning", () => {
    const r = evaluateWorkflowRisk(cleanState({ unpricedOpenPositions: 3 }));
    expect(r.approved).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/no recorded ₹ risk/i);
  });
});
