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

  it("addTrade rejects SELL_CALL direction", async () => {
    const { addTrade } = require("../src/lib/sdm-trade-tracker");
    const trade = await addTrade("SELL_CALL", 24000, 100, 120, 130, 140, 80, false);
    expect(trade).toBeNull(); // Runtime guard rejects sell direction
  });

  it("addTrade rejects SELL_PUT direction", async () => {
    const { addTrade } = require("../src/lib/sdm-trade-tracker");
    const trade = await addTrade("SELL_PUT", 24000, 100, 120, 130, 140, 80, false);
    expect(trade).toBeNull(); // Runtime guard rejects sell direction
  });

  it("addTrade does not reject CALL direction on option-selling guard", async () => {
    const { addTrade } = require("../src/lib/sdm-trade-tracker");
    const errors: string[] = [];
    const spy = console.error;
    console.error = (msg: any) => errors.push(String(msg));
    try {
      await addTrade("CALL", 24000, 100, 120, 130, 140, 80, false);
    } finally {
      console.error = spy;
    }
    // The option-selling guard must NOT fire for a buy direction. (The trade may
    // still be rejected downstream by the liquidity validator with volume/OI 0 —
    // that is a separate guard, not the option-selling safety check.)
    expect(errors.some(e => e.includes("option selling is not allowed"))).toBe(false);
  });

  it("addTrade does not reject PUT direction on option-selling guard", async () => {
    const { addTrade } = require("../src/lib/sdm-trade-tracker");
    const errors: string[] = [];
    const spy = console.error;
    console.error = (msg: any) => errors.push(String(msg));
    try {
      await addTrade("PUT", 24000, 100, 120, 130, 140, 80, false);
    } finally {
      console.error = spy;
    }
    expect(errors.some(e => e.includes("option selling is not allowed"))).toBe(false);
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

// ═══════════════════════════════════════════════════════════════
// 7. PHASE 1: CE/PE BUY-ONLY SAFETY GATE
// ═══════════════════════════════════════════════════════════════

describe("SAFETY: CE/PE Buy-Only Gate (trade-validator-gate)", () => {
  const { validateCandidateTrade, isOptionSelling, rejectOptionSelling } = require("../src/lib/trade-validator-gate");

  const baseCandidate = {
    symbol: "NIFTY", strike: 24000, optionType: "CE", exchange: "NFO",
    instrument: "CALL",
    entry: 150, stopLoss: 130, target1: 180, target2: 200,
    spotPrice: 24000, lotSize: 25, source: "test",
    volume: 50000, oi: 100000, spread: 1, premium: 150,
    marketOpen: true, marketStatus: "OPEN",
    expiry: "2026-09-25", expiryValid: true, daysToExpiry: 3,
  };

  // ─── Instrument-Aware 6-Combination Matrix ──────────────────
  // OPTION + SELL → REJECT
  // OPTION + BUY  → PASS
  // EQUITY + SELL → PASS
  // EQUITY + BUY  → PASS
  // FUTURES + SELL → PASS
  // FUTURES + BUY  → PASS

  it("OPTION + SELL_CE → REJECT", () => {
    const result = validateCandidateTrade({ ...baseCandidate, instrument: "CALL", direction: "SELL_CE" });
    expect(result.valid).toBe(false);
    expect(result.reasons.some((e: string) => e.includes("Option selling not allowed"))).toBe(true);
  });

  it("OPTION + SELL_PE → REJECT", () => {
    const result = validateCandidateTrade({ ...baseCandidate, instrument: "PUT", optionType: "PE", direction: "SELL_PE" });
    expect(result.valid).toBe(false);
    expect(result.reasons.some((e: string) => e.includes("Option selling not allowed"))).toBe(true);
  });

  it("OPTION + BUY_CE → PASS", () => {
    const result = validateCandidateTrade({ ...baseCandidate, instrument: "CALL", direction: "BUY_CE" });
    expect(result.valid).toBe(true);
  });

  it("OPTION + BUY_PE → PASS", () => {
    const result = validateCandidateTrade({ ...baseCandidate, instrument: "PUT", optionType: "PE", direction: "BUY_PE" });
    expect(result.valid).toBe(true);
  });

  it("EQUITY + SELL → PASS (equity selling allowed)", () => {
    const result = validateCandidateTrade({
      ...baseCandidate, instrument: "EQUITY", direction: "SELL",
      strike: undefined, optionType: undefined,
    });
    expect(result.valid).toBe(true);
  });

  it("EQUITY + BUY → PASS", () => {
    const result = validateCandidateTrade({
      ...baseCandidate, instrument: "EQUITY", direction: "BUY",
      strike: undefined, optionType: undefined,
    });
    expect(result.valid).toBe(true);
  });

  it("FUTURES + SELL → PASS (futures selling allowed)", () => {
    const result = validateCandidateTrade({
      ...baseCandidate, instrument: "FUTURES", direction: "SELL",
      optionType: "FUT",
    });
    expect(result.valid).toBe(true);
  });

  it("FUTURES + BUY → PASS", () => {
    const result = validateCandidateTrade({
      ...baseCandidate, instrument: "FUTURES", direction: "BUY",
      optionType: "FUT",
    });
    expect(result.valid).toBe(true);
  });

  it("STRADDLE strategy is rejected (premium-selling, always blocked)", () => {
    const result = validateCandidateTrade({ ...baseCandidate, instrument: "CALL", direction: "BUY_CE", strategy: "STRADDLE" });
    expect(result.valid).toBe(false);
    expect(result.reasons.some((e: string) => e.includes("OPTION_SELLING_NOT_ALLOWED"))).toBe(true);
  });

  it("STRANGLE strategy is rejected (premium-selling, always blocked)", () => {
    const result = validateCandidateTrade({ ...baseCandidate, instrument: "CALL", direction: "BUY_CE", strategy: "STRANGLE" });
    expect(result.valid).toBe(false);
    expect(result.reasons.some((e: string) => e.includes("OPTION_SELLING_NOT_ALLOWED"))).toBe(true);
  });

  // ─── Standalone guard functions (instrument-aware) ──────────

  it("isOptionSelling: OPTION + SELL → true", () => {
    expect(isOptionSelling("SELL_CALL", undefined, "CALL")).toBe(true);
    expect(isOptionSelling("SELL_PUT", undefined, "PUT")).toBe(true);
    expect(isOptionSelling("SHORT", undefined, "CALL")).toBe(true);
  });

  it("isOptionSelling: EQUITY + SELL → false (equity selling allowed)", () => {
    expect(isOptionSelling("SELL", undefined, "EQUITY")).toBe(false);
  });

  it("isOptionSelling: FUTURES + SELL → false (futures selling allowed)", () => {
    expect(isOptionSelling("SELL", undefined, "FUTURES")).toBe(false);
  });

  it("isOptionSelling: no instrument + SELL → false (cannot assume option)", () => {
    expect(isOptionSelling("SELL")).toBe(false);
  });

  it("isOptionSelling: STRADDLE/STRANGLE always true regardless of instrument", () => {
    expect(isOptionSelling(undefined, "STRADDLE")).toBe(true);
    expect(isOptionSelling(undefined, "STRANGLE")).toBe(true);
    expect(isOptionSelling(undefined, "SELL_STRADDLE")).toBe(true);
  });

  it("rejectOptionSelling: OPTION + SELL → rejection reason", () => {
    expect(rejectOptionSelling("SELL_CALL", undefined, "CALL")).toContain("OPTION_SELLING_NOT_ALLOWED");
    expect(rejectOptionSelling("SELL_PE", undefined, "PUT")).toContain("OPTION_SELLING_NOT_ALLOWED");
  });

  it("rejectOptionSelling: EQUITY + SELL → null (allowed)", () => {
    expect(rejectOptionSelling("SELL", undefined, "EQUITY")).toBeNull();
  });

  it("rejectOptionSelling: FUTURES + SELL → null (allowed)", () => {
    expect(rejectOptionSelling("SELL", undefined, "FUTURES")).toBeNull();
  });

  it("rejectOptionSelling: STRADDLE strategy → always rejected", () => {
    expect(rejectOptionSelling(undefined, "STRADDLE")).toContain("OPTION_SELLING_NOT_ALLOWED");
    expect(rejectOptionSelling(undefined, "STRANGLE")).toContain("OPTION_SELLING_NOT_ALLOWED");
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. PHASE 1: CAS PRODUCTION SAFETY GATE
// ═══════════════════════════════════════════════════════════════

describe("SAFETY: CAS STRADDLE/STRANGLE → NO_TRADE", () => {
  const { generateStrategySignalV2, DEFAULT_CONFIG } = require("../src/lib/cas-straddle-strategy-v2");

  const makeSnap = (overrides: any = {}) => ({
    timestamp: new Date().toISOString(), spot: 24000, symbol: "NIFTY",
    casReferencePrice: 24000, casDislocationPct: 0.1, casDislocationStrength: "WEAK",
    casVelocity: 0, casAboveReference: true, casBuyQty: 100, casSellQty: 90, casImbalance: 0.52,
    atmStrike: 24000, atmCE: 150, atmPE: 140, combinedPremium: 290,
    expectedMove: 290, pcr: 1.1, maxPain: 24000, iv: 15, chain: [],
    regime: "RANGING", vix: 15, realizedVol: 15,
    futuresPrice: 24010, futuresBasis: 10,
    currentVolume: 100000, avgVolume: 100000, volumeRatio: 1,
    atr: 120, atrPct: 0.5,
    candles: [], prevClose: 24000, prevPCR: 1.0, prevIV: 15,
    ...overrides,
  });

  it("STRADDLE strategy is converted to NO_TRADE in production", () => {
    const snap = makeSnap({ casDislocationPct: 0.05, regime: "RANGING" });
    const config = { ...DEFAULT_CONFIG, strategy: "STRADDLE" };
    const signal = generateStrategySignalV2(snap, config);
    // The production gate should convert STRADDLE to NO_TRADE
    if (signal.strategy === "STRADDLE") {
      // If the engine produced STRADDLE, the safety gate must have converted it
      expect(signal.strategy).not.toBe("STRADDLE");
    }
    // The rejection reasons should mention the selling prohibition
    expect(signal.rejectionReasons.some((r: string) => r.includes("OPTION_SELLING_NOT_ALLOWED"))).toBe(true);
  });

  it("STRANGLE strategy is converted to NO_TRADE in production", () => {
    const snap = makeSnap({ casDislocationPct: 0.05, regime: "RANGING", iv: 12 });
    const config = { ...DEFAULT_CONFIG, strategy: "STRANGLE" };
    const signal = generateStrategySignalV2(snap, config);
    if (signal.strategy === "STRANGLE") {
      expect(signal.strategy).not.toBe("STRANGLE");
    }
    expect(signal.rejectionReasons.some((r: string) => r.includes("OPTION_SELLING_NOT_ALLOWED"))).toBe(true);
  });

  it("CALL strategy is allowed in production", () => {
    const snap = makeSnap({ casDislocationPct: 0.5, casAboveReference: true, regime: "TRENDING_UP" });
    const config = { ...DEFAULT_CONFIG, strategy: "CALL" };
    const signal = generateStrategySignalV2(snap, config);
    // CALL should not be blocked by the selling gate
    expect(signal.rejectionReasons.some((r: string) => r.includes("OPTION_SELLING_NOT_ALLOWED"))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. PHASE 1: SDM EXPIRY THETA → WAIT (NOT SELL)
// ═══════════════════════════════════════════════════════════════

describe("SAFETY: SDM Expiry Theta No-Sell", () => {
  it("SDM recommendation never produces SELL_CALL or SELL_PUT", () => {
    // Read the source code to verify no SELL flip exists
    const fs = require("fs");
    const content = fs.readFileSync("src/lib/sdm-recommendation.ts", "utf-8");
    // The old code had: direction = direction === 'CALL' ? 'SELL_PUT' : 'SELL_CALL'
    // After fix, this line should not exist
    expect(content).not.toContain("direction === 'CALL' ? 'SELL_PUT' : 'SELL_CALL'");
    expect(content).not.toContain("direction === 'CALL' ? 'SELL_PUT': 'SELL_CALL'");
  });

  it("SDM direction on expiry theta becomes WAIT, not SELL", () => {
    const fs = require("fs");
    const content = fs.readFileSync("src/lib/sdm-recommendation.ts", "utf-8");
    // The fix should set direction = 'WAIT' instead of flipping to SELL
    expect(content).toContain("direction = 'WAIT'");
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. PHASE 1: TELEGRAM SAFETY (sell directions blocked)
// ═══════════════════════════════════════════════════════════════

describe("SAFETY: Telegram SELL Rejection", () => {
  it("sendTradeAlert source code is instrument-aware", () => {
    const fs = require("fs");
    const content = fs.readFileSync("src/lib/telegram.ts", "utf-8");
    // Must check instrument before blocking SELL
    expect(content).toContain("params.instrument === 'CALL' || params.instrument === 'PUT'");
    expect(content).toContain("option selling not allowed");
  });

  it("option-chain route uses side: 'BUY' (options-only route)", () => {
    const fs = require("fs");
    const content = fs.readFileSync("src/app/api/option-chain/route.ts", "utf-8");
    // option-chain is options-only, hardcoded BUY is correct
    expect(content).toContain("side: 'BUY' as const");
  });

  it("trade/register route uses rejectOptionSelling (instrument-aware)", () => {
    const fs = require("fs");
    const content = fs.readFileSync("src/app/api/trade/register/route.ts", "utf-8");
    // Must import and use the safety gate
    expect(content).toContain("rejectOptionSelling");
    expect(content).not.toContain("side: 'BUY' as const");
  });
});

describe("SAFETY: strike scale guard (wrong-symbol strikes never register)", () => {
  const { isStrikeOnSymbolScale } = require("../src/lib/trade-validator-gate");

  it("rejects NIFTY-scale strikes registered under SENSEX", () => {
    // The Jul-15 records: ZERO_HERO_AI-SENSEX-24200-CE with real spot ~77000
    expect(isStrikeOnSymbolScale("SENSEX", 24200, 77000)).toBe(false);
    expect(isStrikeOnSymbolScale("SENSEX", 24200, 0)).toBe(false); // no spot either
  });

  it("accepts real SENSEX strikes", () => {
    expect(isStrikeOnSymbolScale("SENSEX", 77000, 77120)).toBe(true);
    expect(isStrikeOnSymbolScale("SENSEX", 77000, 0)).toBe(true);
  });

  it("accepts NIFTY/BANKNIFTY strikes on their scale", () => {
    expect(isStrikeOnSymbolScale("NIFTY", 24200, 24150)).toBe(true);
    expect(isStrikeOnSymbolScale("BANKNIFTY", 52100, 52050)).toBe(true);
    expect(isStrikeOnSymbolScale("FINNIFTY", 26000, 26050)).toBe(true);
    expect(isStrikeOnSymbolScale("MIDCPNIFTY", 13000, 12980)).toBe(true);
  });

  it("rejects a strike >25% away from the provided spot", () => {
    expect(isStrikeOnSymbolScale("TECHM", 1550, 1547)).toBe(true);
    expect(isStrikeOnSymbolScale("SBIN", 900, 820)).toBe(true); // 9.8% drift — fine
    expect(isStrikeOnSymbolScale("SBIN", 1100, 820)).toBe(false); // 34% — wrong
  });

  it("equity rows (strike 0 / absent) are allowed", () => {
    expect(isStrikeOnSymbolScale("HDFCBANK", 0, 0)).toBe(true);
    expect(isStrikeOnSymbolScale("HDFCBANK", 0, 805)).toBe(true);
  });

  it("unknown symbols without spot are allowed (cannot judge)", () => {
    expect(isStrikeOnSymbolScale("SOMENEW", 123, 0)).toBe(true);
  });
});

describe("SAFETY: confidence floor — options with conf 0 must NOT bypass", () => {
  const { meetsConfidenceFloor } = require("../src/lib/trade-validator-gate");

  it("option rows need the floor even when confidence is 0/missing", () => {
    // The conf=0 option-chain-api rows lost -4427 — `conf > 0 && conf < floor`
    // used to let conf=0 straight through.
    expect(meetsConfidenceFloor("CE", 0)).toBe(false);
    expect(meetsConfidenceFloor("PE", 0)).toBe(false);
    expect(meetsConfidenceFloor("CE", 54)).toBe(false);
    expect(meetsConfidenceFloor("PE", 64)).toBe(false);
    expect(meetsConfidenceFloor("CE", 55)).toBe(true);
    expect(meetsConfidenceFloor("PE", 65)).toBe(true);
    expect(meetsConfidenceFloor("PE", 70)).toBe(true);
  });

  it("non-option rows keep legacy behaviour (0/absent passes, bad values checked)", () => {
    expect(meetsConfidenceFloor("", 0)).toBe(true);
    expect(meetsConfidenceFloor(null, 0)).toBe(true);
    expect(meetsConfidenceFloor("", 40)).toBe(false); // 0 < conf < floor still rejected
    expect(meetsConfidenceFloor("", 60)).toBe(true);
  });
});

describe("SAFETY: option-chain auto-signal session gate (source contract)", () => {
  const fs = require("fs");
  const content = fs.readFileSync("src/app/api/option-chain/route.ts", "utf-8");

  it("auto-registration consults isTradeAllowed before addTrade", () => {
    // POST_CLOSE entries historically won 0/17 (-4299). The session config
    // (market-session.ts allowedActions) must gate the auto trade.
    expect(content).toContain("isTradeAllowed");
    expect(content).toMatch(/sessGate|sessionGate|allowedActions/);
  });
});
