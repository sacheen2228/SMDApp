// Safety Tests — Critical production guards
// Tests for option selling rejection, expiry gates, stale data, R:R enforcement

import { describe, it, expect } from "bun:test";
import { qualityGrade } from "../src/lib/smc-engine";
import { isExpiryDay, getExpiryTypeForDate } from "../src/lib/expiry-calculator";

// ═══════════════════════════════════════════════════════════════
// 1. OPTION SELLING REJECTION
// ═══════════════════════════════════════════════════════════════

describe("SAFETY: Option Selling Rejection", () => {
  it("ML engine cannot produce SELL action", () => {
    const { runMLAnalysis } = require("../src/lib/ml-engine");
    const result = runMLAnalysis(
      Array.from({ length: 20 }, (_, i) => ({
        time: Date.now() - (20 - i) * 60000,
        open: 24000, high: 24100, low: 23900, close: 24000, volume: 100000,
      })),
      [],
      24000
    );
    expect(result.action).not.toBe("SELL");
    expect(["BUY_CE", "BUY_PE", "NO_TRADE"]).toContain(result.action);
  });

  it("addTrade rejects SELL_CALL direction", () => {
    const { addTrade } = require("../src/lib/sdm-trade-tracker");
    const trade = addTrade("SELL_CALL", 24000, 100, 120, 130, 140, 80, false);
    expect(trade).toBeNull(); // Runtime guard rejects sell direction
  });

  it("addTrade rejects SELL_PUT direction", () => {
    const { addTrade } = require("../src/lib/sdm-trade-tracker");
    const trade = addTrade("SELL_PUT", 24000, 100, 120, 130, 140, 80, false);
    expect(trade).toBeNull(); // Runtime guard rejects sell direction
  });

  it("addTrade accepts CALL direction", () => {
    const { addTrade } = require("../src/lib/sdm-trade-tracker");
    const trade = addTrade("CALL", 24000, 100, 120, 130, 140, 80, false);
    expect(trade).not.toBeNull();
    expect(trade?.direction).toBe("CALL");
  });

  it("addTrade accepts PUT direction", () => {
    const { addTrade } = require("../src/lib/sdm-trade-tracker");
    const trade = addTrade("PUT", 24000, 100, 120, 130, 140, 80, false);
    expect(trade).not.toBeNull();
    expect(trade?.direction).toBe("PUT");
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. QUALITY GRADE BOUNDARIES
// ═══════════════════════════════════════════════════════════════

describe("SAFETY: Quality Grade Boundaries", () => {
  it("A+ requires confidence >= 85", () => {
    expect(qualityGrade(85, 2)).toBe("A+");
    expect(qualityGrade(100, 2)).toBe("A+");
    expect(qualityGrade(84, 2)).not.toBe("A+");
  });

  it("A requires confidence 75-84", () => {
    expect(qualityGrade(75, 2)).toBe("A");
    expect(qualityGrade(84, 2)).toBe("A");
    expect(qualityGrade(74, 2)).not.toBe("A");
  });

  it("B requires confidence 65-74", () => {
    expect(qualityGrade(65, 2)).toBe("B");
    expect(qualityGrade(74, 2)).toBe("B");
    expect(qualityGrade(64, 2)).not.toBe("B");
  });

  it("C requires confidence 50-64", () => {
    expect(qualityGrade(50, 2)).toBe("C");
    expect(qualityGrade(64, 2)).toBe("C");
    expect(qualityGrade(49, 2)).not.toBe("C");
  });

  it("D requires confidence < 50", () => {
    expect(qualityGrade(0, 1)).toBe("D");
    expect(qualityGrade(49, 1)).toBe("D");
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. EXPIRY DAY CALCULATIONS
// ═══════════════════════════════════════════════════════════════

describe("SAFETY: Expiry Day Logic", () => {
  it("isExpiryDay returns boolean for F&O symbols", () => {
    const result = isExpiryDay("NIFTY");
    expect(typeof result).toBe("boolean");
  });

  it("isExpiryDay returns false for non-F&O symbols", () => {
    expect(isExpiryDay("RELIANCE")).toBe(false);
    expect(isExpiryDay("TCS")).toBe(false);
  });

  it("getExpiryTypeForDate returns null for non-F&O", () => {
    expect(getExpiryTypeForDate("RELIANCE")).toBeNull();
  });

  it("getExpiryTypeForDate returns weekly/monthly for F&O", () => {
    const result = getExpiryTypeForDate("NIFTY");
    // Result depends on whether today is expiry day
    if (result) {
      expect(["weekly", "monthly"]).toContain(result);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. DATA FRESHNESS
// ═══════════════════════════════════════════════════════════════

describe("SAFETY: Data Freshness", () => {
  it("freshness classifier handles all states", () => {
    const { classifyFreshnessMs } = require("../src/lib/hermes/freshness");
    expect(classifyFreshnessMs(0, "tick")).toBe("LIVE");
    expect(classifyFreshnessMs(5000, "tick")).toBe("LIVE");
    expect(classifyFreshnessMs(60000, "optionChain")).toBe("FRESH");
    expect(classifyFreshnessMs(300000, "optionChain")).toBe("DELAYED");
    expect(classifyFreshnessMs(600000, "optionChain")).toBe("DELAYED"); // exactly at boundary
    expect(classifyFreshnessMs(700000, "optionChain")).toBe("STALE");
  });

  it("isDataUsable rejects STALE for TRADE mode", () => {
    const { isDataUsable } = require("../src/lib/hermes/freshness");
    expect(isDataUsable("LIVE", "TRADE")).toBe(true);
    expect(isDataUsable("FRESH", "TRADE")).toBe(true);
    expect(isDataUsable("DELAYED", "TRADE")).toBe(false);
    expect(isDataUsable("STALE", "TRADE")).toBe(false);
  });

  it("isDataUsable allows DELAYED for RESEARCH mode", () => {
    const { isDataUsable } = require("../src/lib/hermes/freshness");
    expect(isDataUsable("DELAYED", "RESEARCH")).toBe(true);
    expect(isDataUsable("STALE", "RESEARCH")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. PAPER TRADING ISOLATION
// ═══════════════════════════════════════════════════════════════

describe("SAFETY: Paper Trading Isolation", () => {
  it("paper-engine has no broker imports", async () => {
    const fs = require("fs");
    const content = fs.readFileSync("src/lib/hermes/paper-engine.ts", "utf-8");
    expect(content).not.toContain("placeOrder");
    expect(content).not.toContain("cancelOrder");
    expect(content).not.toContain("modifyOrder");
    expect(content).not.toContain("icici-breeze/orders");
  });

  it("paper-worker has no broker imports", async () => {
    const fs = require("fs");
    const content = fs.readFileSync("src/lib/hermes/paper-worker.ts", "utf-8");
    expect(content).not.toContain("placeOrder");
    expect(content).not.toContain("cancelOrder");
    expect(content).not.toContain("modifyOrder");
    expect(content).not.toContain("icici-breeze/orders");
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. HERMES NO-TRADE ENGINE
// ═══════════════════════════════════════════════════════════════

const makeCtx = (overrides: any = {}) => ({
  spot: { value: { price: 24000, source: "test" }, freshness: "LIVE" },
  optionChain: { value: { strikes: [] }, freshness: "LIVE" },
  vix: { value: 15, freshness: "LIVE" },
  regime: { value: "BULLISH", freshness: "LIVE" },
  fiiDii: { value: { net: 0 }, freshness: "LIVE" },
  news: { value: null, freshness: "LIVE" },
  marketStatus: "MARKET_OPEN",
  exchange: "NSE",
  ...overrides,
});

describe("SAFETY: Hermes No-Trade Engine", () => {
  it("evaluateNoTrade exists and returns array", () => {
    const { evaluateNoTrade } = require("../src/lib/hermes/no-trade-engine");
    const reasons = evaluateNoTrade(makeCtx());
    expect(Array.isArray(reasons)).toBe(true);
  });

  it("rejects stale spot data as CRITICAL", () => {
    const { evaluateNoTrade, shouldRejectTrade } = require("../src/lib/hermes/no-trade-engine");
    const reasons = evaluateNoTrade(makeCtx({
      spot: { value: { price: 24000, source: "test" }, freshness: "STALE" },
    }));
    expect(shouldRejectTrade(reasons)).toBe(true);
    expect(reasons.some((r: any) => r.category === "DATA" && r.severity === "CRITICAL")).toBe(true);
  });

  it("rejects R:R < 1.5 as CRITICAL", () => {
    const { evaluateNoTrade, shouldRejectTrade } = require("../src/lib/hermes/no-trade-engine");
    const reasons = evaluateNoTrade(
      makeCtx(),
      { entry: 100, sl: 95, tp1: 102, tp2: 105, riskReward: 0.4, score: 70, type: "CE", strike: 24000 }
    );
    expect(shouldRejectTrade(reasons)).toBe(true);
    expect(reasons.some((r: any) => r.category === "RISK")).toBe(true);
  });

  it("rejects VIX > 30 as CRITICAL", () => {
    const { evaluateNoTrade, shouldRejectTrade } = require("../src/lib/hermes/no-trade-engine");
    const reasons = evaluateNoTrade(makeCtx({
      vix: { value: 35, freshness: "LIVE" },
    }));
    expect(shouldRejectTrade(reasons)).toBe(true);
    expect(reasons.some((r: any) => r.category === "VOLATILITY" && r.severity === "CRITICAL")).toBe(true);
  });
});
