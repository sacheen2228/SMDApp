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

describe("the loss caps fit a ₹25,000 account and a 20% per-trade risk", () => {
  test("the caps are derived from the per-trade model", () => {
    expect(RISK_LIMITS.capital).toBe(25_000);
    expect(RISK_LIMITS.perTradeBudget).toBe(20_000);
    expect(RISK_LIMITS.riskPctOfTrade).toBe(20);
    // one stop is the FIXED ₹2,000 cap (20% of deployed, never more)
    expect(RISK_LIMITS.maxRiskPerTrade).toBe(2_000);
    // the daily cap is the 2-stop limit — reachable, and never above the account
    expect(RISK_LIMITS.maxDailyLoss).toBe(4_000);
    expect(RISK_LIMITS.maxWeeklyLoss).toBe(8_000);
    // the MONTHLY cap must never exceed the account (it used to be ₹50,000)
    expect(RISK_LIMITS.maxMonthlyLoss).toBeLessThanOrEqual(RISK_LIMITS.capital);
    expect(RISK_LIMITS.maxMonthlyLoss).toBe(16_000);
    // monotone: a bigger bucket allows a bigger loss
    expect(RISK_LIMITS.maxDailyLoss).toBeLessThan(RISK_LIMITS.maxWeeklyLoss);
    expect(RISK_LIMITS.maxWeeklyLoss).toBeLessThanOrEqual(RISK_LIMITS.maxMonthlyLoss);
    // and every cap is inside the account
    expect(RISK_LIMITS.maxDailyLoss).toBeLessThanOrEqual(RISK_LIMITS.capital);
    expect(RISK_LIMITS.maxWeeklyLoss).toBeLessThanOrEqual(RISK_LIMITS.capital);
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
    s = updateRiskState(s, -2_500);       // −₹4,500 → past the ₹4,000 cap
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
      dailyPnl: -4_001, weeklyPnl: -4_001, monthlyPnl: -4_001, consecutiveLosses: 0,
    });
    expect(v.blocked).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/daily loss/);
  });

  test("hitting the cap exactly blocks (one rupee less does not)", () => {
    expect(evaluateLossCaps({ dailyPnl: -3_999 }).blocked).toBe(false);
    expect(evaluateLossCaps({ dailyPnl: -4_000 }).blocked).toBe(true);
  });

  test("the weekly and monthly caps block on their own", () => {
    expect(evaluateLossCaps({ dailyPnl: 0, weeklyPnl: -8_001 }).blocked).toBe(true);
    expect(evaluateLossCaps({ dailyPnl: 0, weeklyPnl: 0, monthlyPnl: -16_001 }).blocked).toBe(true);
    expect(evaluateLossCaps({ dailyPnl: 0, weeklyPnl: 0, monthlyPnl: -16_000 }).blocked).toBe(true);
    expect(evaluateLossCaps({ dailyPnl: 0, weeklyPnl: 0, monthlyPnl: -15_999 }).blocked).toBe(false);
  });

  test("two consecutive losses end the session (the streak rule)", () => {
    expect(evaluateLossCaps({ consecutiveLosses: 1 }).blocked).toBe(false);
    const v = evaluateLossCaps({ consecutiveLosses: 2 });
    expect(v.blocked).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/consecutive losses/);
  });
});

describe("evaluateConcurrentExposure — Σ deployed and Σ risk", () => {
  test("a single full-size trade fits the account", () => {
    const v = evaluateConcurrentExposure({
      openDeployed: 0, openRisk: 0, newDeployed: 20_000, newRisk: 2_000,
    });
    expect(v.blocked).toBe(false);
  });

  test("3 × ₹20,000 = ₹60,000 deployed is refused (the account is ₹25,000)", () => {
    const v = evaluateConcurrentExposure({
      openDeployed: 40_000, openRisk: 8_000, newDeployed: 20_000, newRisk: 4_000,
    });
    expect(v.blocked).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/exceeds the ₹25,000 account|deployed/i);
  });

  test("the risk sum may not exceed the risk budget (the daily cap)", () => {
    const v = evaluateConcurrentExposure({
      openDeployed: 20_000, openRisk: 4_000, newDeployed: 4_000, newRisk: 1_000,
    });
    expect(v.blocked).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/risk budget/i);
  });

  test("the deployment sum is checked even when the risk sum is fine", () => {
    const v = evaluateConcurrentExposure({
      openDeployed: 20_000, openRisk: 1_000, newDeployed: 12_000, newRisk: 500,
    });
    expect(v.blocked).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/deployed/i);
  });

  test("an UNKNOWN open exposure fails closed (it is not a zero exposure)", () => {
    const v = evaluateConcurrentExposure({
      openDeployed: 0, openRisk: 0, newDeployed: 1_000, newRisk: 200,
      unknownOpenPositions: 1,
    });
    expect(v.blocked).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/cannot be verified|fail closed/i);
  });

  test("the open-deployment budget is the per-trade budget (₹20,000)", () => {
    expect(RISK_LIMITS.maxOpenDeployed).toBe(20_000);
    expect(RISK_LIMITS.maxOpenDeployed).toBeLessThanOrEqual(RISK_LIMITS.capital);
    expect(RISK_LIMITS.maxOpenRisk).toBeLessThanOrEqual(RISK_LIMITS.capital);
    // ₹20,000 + ₹1 more is over the line
    expect(evaluateConcurrentExposure({ openDeployed: 20_000, openRisk: 0, newDeployed: 1, newRisk: 0 }).blocked).toBe(true);
    expect(evaluateConcurrentExposure({ openDeployed: 20_000, openRisk: 0, newDeployed: 0, newRisk: 0 }).blocked).toBe(false);
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
      state: { dailyPnl: -9_000, weeklyPnl: -9_000, monthlyPnl: -9_000, consecutiveLosses: 0, openDeployed: 0, openRisk: 0 },
      newDeployed: 1_000, newRisk: 200,
    });
    expect(v.blocked).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/daily loss/);
  });

  test("a full exposure blocks even when the day is clean", () => {
    const v = evaluateSignalRiskLimits({
      state: { dailyPnl: 0, weeklyPnl: 0, monthlyPnl: 0, consecutiveLosses: 0, openDeployed: 20_000, openRisk: 4_000 },
      newDeployed: 20_000, newRisk: 2_000,
    });
    expect(v.blocked).toBe(true);
  });
});

describe("modelTradeExposure — the candidate's own ₹ exposure", () => {
  test("a NIFTY lot at ₹100 with a 20% stop risks ₹1,300 and deploys ₹6,500", () => {
    const e = modelTradeExposure({ entry: 100, stopLoss: 80, lotSize: 65 });
    expect(e.lots).toBe(1);                 // ₹2,000 cap / ₹1,300 per lot = 1 lot
    expect(e.deployed).toBeCloseTo(65 * 100, 0);
    expect(e.risk).toBeCloseTo(65 * 20, 0);
    expect(e.unknown).toBe(false);
  });

  test("an unknown lot size is the WORST case (fail closed), never zero", () => {
    const e = modelTradeExposure({ entry: 100, stopLoss: 80, lotSize: null });
    expect(e.unknown).toBe(true);
    expect(e.deployed).toBe(RISK_LIMITS.perTradeBudget);
    expect(e.risk).toBe(RISK_LIMITS.maxRiskPerTrade);
  });

  test("the exposure never exceeds the per-trade budget", () => {
    const e = modelTradeExposure({ entry: 400, stopLoss: 320, lotSize: 65 });
    expect(e.deployed).toBeLessThanOrEqual(RISK_LIMITS.perTradeBudget);
    expect(e.risk).toBeLessThanOrEqual(RISK_LIMITS.maxRiskPerTrade);
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

  test("real strategy rows are kept", () => {
    expect(isSyntheticTradeRow({ tradeId: "ZERO_HERO_AI-NIFTY-1", strategy: "ZERO_HERO_AI" })).toBe(false);
    expect(isSyntheticTradeRow({ tradeId: "SMART_MONEY-NIFTY-1", strategy: "SMART_MONEY" })).toBe(false);
    expect(isSyntheticTradeRow({ tradeId: "api-123", strategy: "option-chain-api" })).toBe(false);
  });
});
