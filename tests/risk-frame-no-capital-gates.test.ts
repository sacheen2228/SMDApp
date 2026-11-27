/// <reference types="bun-types" />
// ═══════════════════════════════════════════════════════════════════════════
// THE RISK FRAME — NO FIXED-CAPITAL / FIXED-LOT GATES (user directive 2026-11-21)
//
// WHY THIS FILE EXISTS
// The 20/11 Telegram blackout was NOT a data outage. It was the risk frame:
//   • RISK_LIMITS.maxOpenRisk was pinned to a stale ₹8,000 (₹4,000 × 2 stops)
//     while the live rule is "risk = 20% of what you deploy" (₹45,000 ⇒ ₹9,000)
//     → every full-size candidate was refused as "risk ₹9,000 exceeds the
//     ₹8,000 risk budget",
//   • the "risk ≤ 20% of deployed" check compared a budget-sized risk with a
//     FLOORED deployment (₹45,000 vs ₹43,250) → 20.2% > 20% → blocked by ₹100,
//   • an open position with no verifiable ₹ exposure blocked EVERY candidate
//     (fail closed on 286 candidates on 20/11),
//   • the deployment headroom (₹45,000 total across the book) blocked the
//     second concurrent trade.
//
// THE DIRECTIVE (2026-11-21): no fixed capital / trade-budget / lot-count
// restriction may decide whether a trade is eligible or how big it is. The
// market decides (structure stop, R:R ≥ 1:2); the risk is SHOWN, never used
// as a gate. The loss caps and the loss-streak rule still stop the day.
//
// OFFLINE: pure functions only — no DB, no network, no Telegram.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test, expect } from "bun:test";
import {
  RISK_LIMITS,
  evaluateLossCaps,
  evaluateConcurrentExposure,
  evaluateSignalRiskLimits,
  modelTradeExposure,
} from "@/lib/risk-management";
import { positionSize } from "@/lib/agent-brain-gate";
import {
  PLAN_CONFIG,
  sizeOptionTrade,
  buildOptionPlan,
  selectStrike,
} from "@/lib/option-plan";
import { scannerStockQuantity } from "@/lib/scanner-stock-alerts";

describe("the loss caps are ACCOUNT-derived (the stale ₹8,000 frame is gone)", () => {
  test("the caps scale with the account, not with a fixed ₹4,000 stop", () => {
    expect(RISK_LIMITS.capital).toBe(50_000);
    // daily = capital × 40%
    expect(RISK_LIMITS.maxDailyLoss).toBe(20_000);
    // weekly = min(capital, daily × 2)
    expect(RISK_LIMITS.maxWeeklyLoss).toBe(40_000);
    // monthly = min(capital, weekly × 2)
    expect(RISK_LIMITS.maxMonthlyLoss).toBe(50_000);
    // the stale frame (₹4,000 × 2) must not come back
    expect(RISK_LIMITS.maxDailyLoss).not.toBe(8_000);
  });

  test("RISK_LIMITS carries no per-trade / open-book capital caps", () => {
    expect("maxRiskPerTrade" in RISK_LIMITS).toBe(false);
    expect("maxOpenDeployed" in RISK_LIMITS).toBe(false);
    expect("maxOpenRisk" in RISK_LIMITS).toBe(false);
  });

  test("the loss caps still stop the day (they are the one real gate)", () => {
    expect(evaluateLossCaps({ dailyPnl: -19_999 }).blocked).toBe(false);
    expect(evaluateLossCaps({ dailyPnl: -20_000 }).blocked).toBe(true);
    expect(evaluateLossCaps({ consecutiveLosses: 2 }).blocked).toBe(true);
  });
});

describe("evaluateConcurrentExposure — visibility, never a capital refusal", () => {
  test("a full-size candidate (₹45,000 deployed / ₹9,000 risk) passes", () => {
    const v = evaluateConcurrentExposure({
      openDeployed: 0, openRisk: 0, newDeployed: 45_000, newRisk: 9_000,
    });
    expect(v.blocked).toBe(false);
    expect(v.reasons.length).toBe(0);
  });

  test("two concurrent full-size trades are not refused for capital", () => {
    const v = evaluateConcurrentExposure({
      openDeployed: 45_000, openRisk: 9_000, newDeployed: 45_000, newRisk: 9_000,
    });
    expect(v.blocked).toBe(false);
  });

  test("an UNKNOWN open exposure warns, it does not block", () => {
    const v = evaluateConcurrentExposure({
      openDeployed: 0, openRisk: 0, newDeployed: 45_000, newRisk: 9_000,
      unknownOpenPositions: 2,
    });
    expect(v.blocked).toBe(false);
    expect(v.warnings.join(" ")).toMatch(/2 open position/i);
  });

  test("a market-derived risk wider than 20% of the deployment warns, never blocks", () => {
    const v = evaluateConcurrentExposure({
      openDeployed: 0, openRisk: 0, newDeployed: 10_000, newRisk: 3_000,
    });
    expect(v.blocked).toBe(false);
    expect(v.warnings.join(" ")).toMatch(/30%/);
  });
});

describe("evaluateSignalRiskLimits — only the realised loss stops a trade", () => {
  test("a valid full-size candidate with unpriced open positions passes", () => {
    const v = evaluateSignalRiskLimits({
      state: { dailyPnl: 0, weeklyPnl: 0, monthlyPnl: 0, consecutiveLosses: 0, unpricedOpenPositions: 2 },
      newDeployed: 45_000, newRisk: 9_000,
    });
    expect(v.blocked).toBe(false);
    expect(v.reasons.length).toBe(0);
  });

  test("a blown day still blocks", () => {
    const v = evaluateSignalRiskLimits({
      state: { dailyPnl: -20_000 }, newDeployed: 45_000, newRisk: 9_000,
    });
    expect(v.blocked).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/daily loss/i);
  });
});

describe("modelTradeExposure — the worst case is the account, not a trade budget", () => {
  test("an unsizeable candidate is bounded by the account", () => {
    const e = modelTradeExposure({ entry: null, stopLoss: null, lotSize: null });
    expect(e.unknown).toBe(true);
    expect(e.deployed).toBe(RISK_LIMITS.capital);
    expect(e.risk).toBeCloseTo(RISK_LIMITS.capital * 0.2, 0);
  });

  test("a stated lot count is the real deployment (no cap is applied to it)", () => {
    const e = modelTradeExposure({ entry: 100, stopLoss: 80, lotSize: 65, lots: 3 });
    expect(e.lots).toBe(3);
    expect(e.deployed).toBeCloseTo(3 * 65 * 100, 0);
    expect(e.risk).toBeCloseTo(3 * 65 * 20, 0);
  });
});

describe("positionSize — the one sizing model never refuses on capital", () => {
  test("a contract whose 1 lot costs more than the budget is sized to 0 lots", () => {
    const ps = positionSize({ entry: 900, sl: 720, lotSize: 65 }); // ₹58,500 per lot
    expect(ps.lots).toBe(0);
    expect(ps.ok).toBe(true);
    expect(ps.capitalRequired).toBe(0);
    // nothing is committed when 2 lots don't fit
    expect(ps.maxLoss).toBe(0);
  });

  test("an affordable contract keeps its budgeted size", () => {
    const ps = positionSize({ entry: 100, sl: 80, lotSize: 65 }); // ₹6,500 per lot
    expect(ps.lots).toBeGreaterThanOrEqual(1);
    expect(ps.capitalRequired).toBeGreaterThan(0);
  });
});

describe("option sizing — the 1-lot floor, never a capital rejection", () => {
  test("a contract above the default deployment is still tradable", () => {
    const sizing = sizeOptionTrade({ entryPremium: 900, lotSize: 65 }); // ₹58,500 per lot
    expect(sizing.lots).toBe(2);
    expect(sizing.tradable).toBe(true);
    expect(sizing.deployed).toBeCloseTo(117_000, 0);
    expect(sizing.overBudget).toBe(false);
    expect(sizing.reason).toBeUndefined();
  });

  test("a normal contract is sized from the deployment budget", () => {
    const sizing = sizeOptionTrade({ entryPremium: 100, lotSize: 65 }); // ₹6,500 per lot
    expect(sizing.lots).toBe(2);
    expect(sizing.tradable).toBe(true);
    expect(sizing.overBudget).toBe(false);
  });

  test("an explicit 0 lots is still NO TRADE (the caller's decision)", () => {
    const sizing = sizeOptionTrade({ entryPremium: 100, lotSize: 65, lots: 0 });
    expect(sizing.lots).toBe(0);
    expect(sizing.tradable).toBe(false);
  });

  test("the plan for an over-budget contract is a REAL plan", () => {
    const plan = buildOptionPlan({ symbol: "NIFTY", optionType: "CE", entryPremium: 900, lotSize: 65 });
    expect(plan).not.toBeNull();
    expect(plan!.tradable).toBe(true);
    expect(plan!.lots).toBe(2);
    expect(plan!.stopLoss).toBeLessThan(plan!.entry);
    expect(plan!.targets[0]).toBeGreaterThan(plan!.entry);
    // the risk is 20% of what is actually deployed
    expect(plan!.riskAmount).toBeCloseTo(plan!.deployed * 0.2, 0);
  });
});

describe("strike selection — an expensive contract is not skipped", () => {
  test("1 lot above the deployment budget still yields a strike", () => {
    const chain = [{ strike: 24_000, ce: { ltp: 900, delta: 0.5 } }];
    const pick = selectStrike({ chain, direction: "CALL", spot: 24_000, lotSize: 65, budget: 45_000 });
    expect(pick).not.toBeNull();
    expect(pick!.strike).toBe(24_000);
  });
});

describe("cash equity sizing — the 1-share floor", () => {
  test("a share the budget cannot afford is still 1 share, never 0", () => {
    expect(scannerStockQuantity(25_000, 20_000)).toBe(1);
    expect(scannerStockQuantity(100_000, 20_000)).toBe(1);
  });

  test("a normal budget buys whole shares", () => {
    expect(scannerStockQuantity(2709.2, 20_000)).toBe(7);
    expect(scannerStockQuantity(2709.2, 1400)).toBe(1);
  });

  test("a missing price is still 0 (there is nothing to buy)", () => {
    expect(scannerStockQuantity(0, 20_000)).toBe(0);
  });
});
