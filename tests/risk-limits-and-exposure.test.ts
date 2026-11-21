/// <reference types="bun-types" />
// THE LOSS CAPS + THE CONCURRENT-EXPOSURE CHECK.
//
// THE DEFECT (2026-10-20): risk-management.ts carried a ₹50,000 monthly cap on a
// ₹25,000 account, and checkRiskLimits/getDefaultRiskConfig/updateRiskState were
// called from NOWHERE — the scanner / Zero-Hero / master-bot Telegram paths were
// not day-loss limited at all. There was also no concurrent-exposure check:
// 3 × ₹20,000 = ₹60,000 deployed (₹12,000 = 48% of the account at risk).
//
// These tests pin the new caps and the fail-closed behaviour. Offline: no DB,
// no network (the journal loader is exercised separately).

import { describe, test, expect } from "bun:test";
import {
  RISK_LIMITS,
  evaluateLossCaps,
  evaluateConcurrentExposure,
  evaluateSignalRiskLimits,
  modelTradeExposure,
  istDayKey,
  istDaysAgo,
  getDefaultRiskConfig,
  updateRiskState,
} from "@/lib/risk-management";
import { GATE_CONFIG } from "@/lib/agent-brain-gate";
import { isSyntheticTradeRow } from "@/lib/risk-state.server";

describe("the loss caps fit a ₹50,000 account and a 20% per-trade risk", () => {
  test("the caps are derived from the ACCOUNT (no stale fixed-stop frame)", () => {
    expect(RISK_LIMITS.capital).toBe(50_000);
    expect(RISK_LIMITS.perTradeBudget).toBe(45_000);
    expect(RISK_LIMITS.riskPctOfTrade).toBe(20);
    // daily = capital × 40%, weekly = min(capital, daily × 2),
    // monthly = min(capital, weekly × 2) — never above the account.
    expect(RISK_LIMITS.maxDailyLoss).toBe(20_000);
    expect(RISK_LIMITS.maxWeeklyLoss).toBe(40_000);
    expect(RISK_LIMITS.maxMonthlyLoss).toBeLessThanOrEqual(RISK_LIMITS.capital);
    expect(RISK_LIMITS.maxMonthlyLoss).toBe(50_000);
    // monotone: a bigger bucket allows a bigger loss
    expect(RISK_LIMITS.maxDailyLoss).toBeLessThan(RISK_LIMITS.maxWeeklyLoss);
    expect(RISK_LIMITS.maxWeeklyLoss).toBeLessThanOrEqual(RISK_LIMITS.maxMonthlyLoss);
    // and every cap is inside the account
    expect(RISK_LIMITS.maxDailyLoss).toBeLessThanOrEqual(RISK_LIMITS.capital);
    expect(RISK_LIMITS.maxWeeklyLoss).toBeLessThanOrEqual(RISK_LIMITS.capital);
    // no fixed per-trade / open-book capital caps (user directive 2026-11-21)
    expect("maxRiskPerTrade" in RISK_LIMITS).toBe(false);
    expect("maxOpenDeployed" in RISK_LIMITS).toBe(false);
    expect("maxOpenRisk" in RISK_LIMITS).toBe(false);
  });

  test("the default risk state uses the new caps", () => {
    const s = getDefaultRiskConfig();
    expect(s.maxDailyLoss).toBe(RISK_LIMITS.maxDailyLoss);
    expect(s.maxWeeklyLoss).toBe(RISK_LIMITS.maxWeeklyLoss);
    expect(s.maxMonthlyLoss).toBe(RISK_LIMITS.maxMonthlyLoss);
  });

  test("updateRiskState blocks trading once the daily cap is hit", () => {
    let s = getDefaultRiskConfig();
    s = updateRiskState(s, -2_000);
    expect(s.canTrade).toBe(true);
    s = updateRiskState(s, -18_500);      // −₹20,500 → past the ₹20,000 daily cap
    expect(s.canTrade).toBe(false);
    expect(s.blockReason).toMatch(/daily loss limit/i);
  });
});

describe("evaluateLossCaps — a loss beyond the cap blocks the next trade", () => {
  test("a clean book trades", () => {
    const v = evaluateLossCaps({ dailyPnl: 0, weeklyPnl: 0, monthlyPnl: 0, consecutiveLosses: 0 });
    expect(v.blocked).toBe(false);
    expect(v.reasons.length).toBe(0);
  });

  test("a loss beyond the daily cap blocks", () => {
    const v = evaluateLossCaps({
      dailyPnl: -20_001, weeklyPnl: -20_001, monthlyPnl: -20_001, consecutiveLosses: 0,
    });
    expect(v.blocked).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/daily loss/);
  });

  test("hitting the cap exactly blocks (one rupee less does not)", () => {
    expect(evaluateLossCaps({ dailyPnl: -19_999 }).blocked).toBe(false);
    expect(evaluateLossCaps({ dailyPnl: -20_000 }).blocked).toBe(true);
  });

  test("the weekly and monthly caps block on their own", () => {
    expect(evaluateLossCaps({ dailyPnl: 0, weeklyPnl: -40_001 }).blocked).toBe(true);
    expect(evaluateLossCaps({ dailyPnl: 0, weeklyPnl: 0, monthlyPnl: -50_001 }).blocked).toBe(true);
    expect(evaluateLossCaps({ dailyPnl: 0, weeklyPnl: 0, monthlyPnl: -50_000 }).blocked).toBe(true);
    expect(evaluateLossCaps({ dailyPnl: 0, weeklyPnl: 0, monthlyPnl: -49_999 }).blocked).toBe(false);
  });

  test("two consecutive losses end the session (the streak rule)", () => {
    expect(evaluateLossCaps({ consecutiveLosses: 1 }).blocked).toBe(false);
    const v = evaluateLossCaps({ consecutiveLosses: 2 });
    expect(v.blocked).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/consecutive losses/);
  });
});

describe("evaluateConcurrentExposure — visibility, never a capital refusal", () => {
  test("a single full-size trade fits the account", () => {
    const v = evaluateConcurrentExposure({
      openDeployed: 0, openRisk: 0, newDeployed: 45_000, newRisk: 9_000,
    });
    expect(v.blocked).toBe(false);
  });

  test("a book above the account is WARNED about, never refused", () => {
    const v = evaluateConcurrentExposure({
      openDeployed: 40_000, openRisk: 8_000, newDeployed: 20_000, newRisk: 4_000,
    });
    expect(v.blocked).toBe(false);
    expect(v.warnings.join(" ")).toMatch(/deployed/i);
  });

  test("the risk sum above the daily cap is warned about, never refused", () => {
    const v = evaluateConcurrentExposure({
      openDeployed: 20_000, openRisk: 7_000, newDeployed: 4_000, newRisk: 2_000,
    });
    expect(v.blocked).toBe(false);
    expect(v.warnings.join(" ")).toMatch(/risk/i);
  });

  test("an UNKNOWN open exposure warns and names the positions", () => {
    const v = evaluateConcurrentExposure({
      openDeployed: 0, openRisk: 0, newDeployed: 1_000, newRisk: 200,
      unknownOpenPositions: 1, unknownOpenSymbols: ["NIFTY"],
    });
    expect(v.blocked).toBe(false);
    expect(v.warnings.join(" ")).toMatch(/cannot be verified/i);
    expect(v.warnings.join(" ")).toMatch(/NIFTY/);
  });

  test("a market stop wider than 20% of the deployment warns, never refuses", () => {
    const v = evaluateConcurrentExposure({
      openDeployed: 0, openRisk: 0, newDeployed: 10_000, newRisk: 3_000,
    });
    expect(v.blocked).toBe(false);
    expect(v.warnings.join(" ")).toMatch(/30%/);
  });
});

describe("evaluateSignalRiskLimits — the whole signal-path verdict", () => {
  test("a clean book with room trades", () => {
    const v = evaluateSignalRiskLimits({
      state: { dailyPnl: 0, weeklyPnl: 0, monthlyPnl: 0, consecutiveLosses: 0, openDeployed: 0, openRisk: 0 },
      newDeployed: 11_000, newRisk: 2_000,
    });
    expect(v.blocked).toBe(false);
  });

  test("a blown day blocks even when the exposure is tiny", () => {
    const v = evaluateSignalRiskLimits({
      state: { dailyPnl: -20_000, weeklyPnl: -20_000, monthlyPnl: -20_000, consecutiveLosses: 0, openDeployed: 0, openRisk: 0 },
      newDeployed: 1_000, newRisk: 200,
    });
    expect(v.blocked).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/daily loss/);
  });

  test("a full book never blocks on capital alone (the day is clean)", () => {
    const v = evaluateSignalRiskLimits({
      state: { dailyPnl: 0, weeklyPnl: 0, monthlyPnl: 0, consecutiveLosses: 0, openDeployed: 30_000, openRisk: 6_000 },
      newDeployed: 20_000, newRisk: 4_000,
    });
    expect(v.blocked).toBe(false);
  });
});

describe("modelTradeExposure — the candidate's own ₹ exposure", () => {
  test("a NIFTY lot at ₹100 with a 20% stop is sized to the 20%-of-deployed budget", () => {
    const e = modelTradeExposure({ entry: 100, stopLoss: 80, lotSize: 65 });
    // 20% of the ₹45k budget = ₹9,000 / ₹1,300 per lot = 6 lots (₹7,800 at risk)
    expect(e.lots).toBe(6);
    expect(e.deployed).toBeCloseTo(6 * 65 * 100, 0);
    expect(e.risk).toBeCloseTo(6 * 65 * 20, 0);
    expect(e.unknown).toBe(false);
  });

  test("an unknown lot size is the WORST case (the whole account), never zero", () => {
    const e = modelTradeExposure({ entry: 100, stopLoss: 80, lotSize: null });
    expect(e.unknown).toBe(true);
    expect(e.deployed).toBe(RISK_LIMITS.capital);
    expect(e.risk).toBe(RISK_LIMITS.capital * 0.2);   // worst case = 20% of the account
  });

  test("a stated lot count is the real deployment (no cap is applied to it)", () => {
    const e = modelTradeExposure({ entry: 400, stopLoss: 320, lotSize: 65, lots: 3 });
    expect(e.deployed).toBeCloseTo(3 * 65 * 400, 0);
    expect(e.risk).toBeCloseTo(3 * 65 * 80, 0);
  });
});

describe("IST day bucketing", () => {
  test("the day key is the IST calendar day", () => {
    // 2026-10-20 18:30 UTC = 2026-10-21 00:00 IST
    expect(istDayKey("2026-10-20T18:30:00.000Z")).toBe("2026-10-21");
    expect(istDayKey("2026-10-20T18:29:00.000Z")).toBe("2026-10-20");
  });

  test("istDaysAgo counts IST days, not UTC days", () => {
    const now = Date.parse("2026-10-20T12:00:00.000Z");
    expect(istDaysAgo(Date.parse("2026-10-20T10:00:00.000Z"), now)).toBe(0);
    expect(istDaysAgo(Date.parse("2026-10-19T10:00:00.000Z"), now)).toBe(1);
    expect(istDaysAgo(Date.parse("2026-10-14T10:00:00.000Z"), now)).toBe(6);
  });
});

describe("the gate config the caps are derived from", () => {
  test("the per-trade model is the one GATE_CONFIG says", () => {
    expect(GATE_CONFIG.capital).toBe(RISK_LIMITS.capital);
    expect(GATE_CONFIG.tradeBudget).toBe(RISK_LIMITS.perTradeBudget);
    expect(GATE_CONFIG.riskPctOfTrade).toBe(RISK_LIMITS.riskPctOfTrade);
  });
});

describe("synthetic rows never move the real loss caps", () => {
  test("test/e2e strategies and probe ids are excluded", () => {
    expect(isSyntheticTradeRow({ tradeId: "test-trade-3", strategy: "test" })).toBe(true);
    expect(isSyntheticTradeRow({ tradeId: "provenance-1", strategy: "e2e-test" })).toBe(true);
    expect(isSyntheticTradeRow({ tradeId: "probe-real-1", strategy: "sdm" })).toBe(true);
    expect(isSyntheticTradeRow({ tradeId: "zz-inline-1", strategy: "sdm" })).toBe(true);
    expect(isSyntheticTradeRow({ tradeId: "monerr-1", strategy: "sdm" })).toBe(true);
  });

  test("an option row with no expiry is unmonitorable, never real", () => {
    expect(isSyntheticTradeRow({
      tradeId: "ZERO_HERO_AI-NIFTY-23000-CE-20261110",
      strategy: "ZERO_HERO_AI",
      type: "CE",
      expiry: null,
    })).toBe(true);
    expect(isSyntheticTradeRow({
      tradeId: "ZERO_HERO_AI-NIFTY-23000-CE-20261110",
      strategy: "ZERO_HERO_AI",
      type: "CE",
      expiry: "2026-11-17",
    })).toBe(false);
    // Equity has no contract expiry — it stays valid.
    expect(isSyntheticTradeRow({
      tradeId: "BTST-NIFTYBEES-1",
      strategy: "BTST",
      type: "EQ",
      expiry: null,
    })).toBe(false);
  });

  test("real strategy rows are kept", () => {
    expect(isSyntheticTradeRow({ tradeId: "ZERO_HERO_AI-NIFTY-1", strategy: "ZERO_HERO_AI" })).toBe(false);
    expect(isSyntheticTradeRow({ tradeId: "SMART_MONEY-NIFTY-1", strategy: "SMART_MONEY" })).toBe(false);
    expect(isSyntheticTradeRow({ tradeId: "api-123", strategy: "option-chain-api" })).toBe(false);
  });
});
