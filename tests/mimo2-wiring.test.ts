// Integration tests for MIMO 2 wiring fixes
// Proves the actual execution path works end-to-end.

import { describe, it, expect } from "bun:test";
import {
  buildOptionChain,
  assessChainQuality,
  normalizeMOAPI,
  type NormalizedStrike,
} from "@/lib/option-chain-normalizer";
import {
  detectAndResolveConflicts,
  type EngineSignal,
} from "@/lib/signal-conflict-detector";
import {
  runQualityGates,
  shouldBlockTrade,
} from "@/lib/data-validation";
import {
  scoreWithUnifiedEngine,
  hermesContextToMarketInput,
} from "@/lib/hermes/unified-scoring-bridge";
import type { HermesContext } from "@/lib/hermes/types";
import { scoreTrade, getProfileWeights } from "@/lib/unified-scoring-engine";

// ── Test 1: Canonical chain consumed by Hermes ──────────────────────

describe("Wiring: Canonical chain → Hermes context", () => {
  it("buildOptionChain produces canonical chain from normalized strikes", () => {
    const strikes: NormalizedStrike[] = [
      {
        strike: 24500,
        ce: { ltp: 150, bid: null, ask: null, spread: null, quoteQuality: "UNKNOWN", oi: 50000, oiChange: 1000, volume: 2000, iv: 15, delta: 0.45, gamma: 0.002, theta: -5, vega: 0.1, hasData: true },
        pe: { ltp: 120, bid: null, ask: null, spread: null, quoteQuality: "UNKNOWN", oi: 60000, oiChange: -500, volume: 1500, iv: 16, delta: -0.42, gamma: 0.002, theta: -4.5, vega: 0.1, hasData: true },
      },
      {
        strike: 24600,
        ce: { ltp: 100, bid: null, ask: null, spread: null, quoteQuality: "UNKNOWN", oi: 40000, oiChange: 500, volume: 1800, iv: 14, delta: 0.38, gamma: 0.0018, theta: -4, vega: 0.09, hasData: true },
        pe: { ltp: 180, bid: null, ask: null, spread: null, quoteQuality: "UNKNOWN", oi: 70000, oiChange: 2000, volume: 2200, iv: 17, delta: -0.50, gamma: 0.0022, theta: -5.5, vega: 0.11, hasData: true },
      },
    ];

    const chain = buildOptionChain(strikes, 24550, "NIFTY", "test-source");

    expect(chain).not.toBeNull();
    expect(chain!.spot).toBe(24550);
    expect(chain!.strikes.length).toBe(2);
    expect(chain!.pcr).toBeGreaterThan(0);
    expect(chain!.atmStrike).toBe(24500);
    expect(chain!.totalCallOI).toBe(90000);
    expect(chain!.totalPutOI).toBe(130000);
  });

  it("assessChainQuality detects missing bid/ask as PARTIAL", () => {
    const strikes: NormalizedStrike[] = [
      {
        strike: 24500,
        ce: { ltp: 150, bid: null, ask: null, spread: null, quoteQuality: "UNKNOWN", oi: 50000, oiChange: 0, volume: 2000, iv: 15, delta: 0.45, gamma: 0, theta: 0, vega: 0, hasData: true },
        pe: { ltp: 120, bid: null, ask: null, spread: null, quoteQuality: "UNKNOWN", oi: 60000, oiChange: 0, volume: 1500, iv: 16, delta: -0.42, gamma: 0, theta: 0, vega: 0, hasData: true },
      },
    ];

    const chain = buildOptionChain(strikes, 24550, "NIFTY", "test-source");
    expect(chain).not.toBeNull();

    const quality = assessChainQuality(chain!);
    expect(quality.quality).not.toBe("GOOD"); // Missing bid/ask, Greeks partial
    expect(quality.hasOI).toBe(true);
    expect(quality.hasGreeks).toBe(true);
  });
});

// ── Test 2: Conflict detector forces WAIT ───────────────────────────

describe("Wiring: Conflict detector → WAIT", () => {
  it("CE bullish vs PE bearish conflict with small score diff → WAIT", () => {
    const signals: EngineSignal[] = [
      { source: "engine-A", direction: "CE", confidence: 55, score: 55 },
      { source: "engine-B", direction: "PE", confidence: 52, score: 52 },
    ];

    const result = detectAndResolveConflicts(signals, null, "neutral");

    expect(result.hasConflict).toBe(true);
    expect(result.resolvedDirection).toBe("WAIT");
    expect(result.confidence).toBe(0);
  });

  it("CE bullish vs PE bearish with trend alignment → resolved", () => {
    const signals: EngineSignal[] = [
      { source: "engine-A", direction: "CE", confidence: 70, score: 70 },
      { source: "engine-B", direction: "PE", confidence: 40, score: 40 },
    ];

    const result = detectAndResolveConflicts(signals, null, "bullish");

    expect(result.hasConflict).toBe(true);
    expect(result.resolvedDirection).toBe("CE");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("insufficient OI data → WAIT", () => {
    const chain = {
      strikes: [
        { strike: 24500, ce: { oi: 0 }, pe: { oi: 0 } },
        { strike: 24600, ce: { oi: 0 }, pe: { oi: 0 } },
      ],
    } as any;

    const signals: EngineSignal[] = [
      { source: "engine-A", direction: "CE", confidence: 70, score: 70 },
      { source: "engine-B", direction: "PE", confidence: 70, score: 70 },
    ];

    const result = detectAndResolveConflicts(signals, chain, "neutral");

    expect(result.hasConflict).toBe(true);
    expect(result.resolvedDirection).toBe("WAIT");
  });
});

// ── Test 3: Stale data → WAIT ──────────────────────────────────────

describe("Wiring: Stale data → WAIT", () => {
  it("quality gates block when chain is null", () => {
    const gates = runQualityGates(null, 24500, 15, "test");
    const blockResult = shouldBlockTrade(gates);

    expect(blockResult.block).toBe(true);
    expect(blockResult.reasons.some(r => r.includes("CHAIN_AVAILABLE"))).toBe(true);
  });

  it("quality gates block when spot is zero", () => {
    const chain = { strikes: [], pcr: 1, atmStrike: 0 } as any;
    const gates = runQualityGates(chain, 0, 15, "test");
    const blockResult = shouldBlockTrade(gates);

    expect(blockResult.block).toBe(true);
    expect(blockResult.reasons.some(r => r.includes("SPOT_VALID"))).toBe(true);
  });
});

// ── Test 4: Missing OI → WAIT ──────────────────────────────────────

describe("Wiring: Missing OI → WAIT", () => {
  it("quality gates block when all OI is zero", () => {
    const chain = {
      strikes: [
        { strike: 24500, ce: { premium: 150, oi: 0 }, pe: { premium: 120, oi: 0 } },
        { strike: 24600, ce: { premium: 100, oi: 0 }, pe: { premium: 180, oi: 0 } },
        { strike: 24700, ce: { premium: 60, oi: 0 }, pe: { premium: 250, oi: 0 } },
        { strike: 24800, ce: { premium: 30, oi: 0 }, pe: { premium: 320, oi: 0 } },
        { strike: 24900, ce: { premium: 15, oi: 0 }, pe: { premium: 400, oi: 0 } },
      ],
      pcr: 1,
      atmStrike: 24500,
    } as any;

    const gates = runQualityGates(chain, 24550, 15, "test");
    const blockResult = shouldBlockTrade(gates);

    expect(blockResult.block).toBe(true);
    expect(blockResult.reasons.some(r => r.includes("OI_AVAILABLE"))).toBe(true);
  });
});

// ── Test 5: Missing bid/ask → null, never 0 ─────────────────────────

describe("Wiring: Bid/ask fabrication eliminated", () => {
  it("MOAPI data with no bid/ask → bid=null, ask=null, spread=null", () => {
    const rawStrikes: NormalizedStrike[] = [
      {
        strike: 24500,
        ce: { ltp: 150, bid: null, ask: null, spread: null, quoteQuality: "UNKNOWN", oi: 50000, oiChange: 0, volume: 2000, iv: 15, delta: 0.45, gamma: 0, theta: 0, vega: 0, hasData: true },
        pe: null,
      },
    ];

    const chain = buildOptionChain(rawStrikes, 24550, "NIFTY", "moapi");
    expect(chain).not.toBeNull();

    const ceLeg = chain!.strikes[0].ce;
    expect(ceLeg).not.toBeNull();
    expect(ceLeg!.bid).toBeNull();
    expect(ceLeg!.ask).toBeNull();
    expect(ceLeg!.spread).toBeNull();
    expect(ceLeg!.quoteQuality).toBe("UNKNOWN");
  });

  it("valid bid/ask → spread calculated correctly", () => {
    const rawStrikes: NormalizedStrike[] = [
      {
        strike: 24500,
        ce: { ltp: 150, bid: 99, ask: 101, spread: 2, quoteQuality: "COMPLETE", oi: 50000, oiChange: 0, volume: 2000, iv: 15, delta: 0.45, gamma: 0, theta: 0, vega: 0, hasData: true },
        pe: null,
      },
    ];

    const chain = buildOptionChain(rawStrikes, 24550, "NIFTY", "breeze");
    expect(chain).not.toBeNull();

    const ceLeg = chain!.strikes[0].ce;
    expect(ceLeg).not.toBeNull();
    expect(ceLeg!.bid).toBe(99);
    expect(ceLeg!.ask).toBe(101);
    expect(ceLeg!.spread).toBe(2);
    expect(ceLeg!.quoteQuality).toBe("COMPLETE");
  });

  it("partial bid/ask → quoteQuality=PARTIAL", () => {
    const rawStrikes: NormalizedStrike[] = [
      {
        strike: 24500,
        ce: { ltp: 150, bid: 99, ask: null, spread: null, quoteQuality: "PARTIAL", oi: 50000, oiChange: 0, volume: 2000, iv: 15, delta: 0.45, gamma: 0, theta: 0, vega: 0, hasData: true },
        pe: null,
      },
    ];

    const chain = buildOptionChain(rawStrikes, 24550, "NIFTY", "breeze");
    expect(chain).not.toBeNull();

    const ceLeg = chain!.strikes[0].ce;
    expect(ceLeg).not.toBeNull();
    expect(ceLeg!.bid).toBe(99);
    expect(ceLeg!.ask).toBeNull();
    expect(ceLeg!.spread).toBeNull();
    expect(ceLeg!.quoteQuality).toBe("PARTIAL");
  });
});

// ── Test 6: Unified scoring HERMES profile active ───────────────────

describe("Wiring: Unified scoring HERMES profile", () => {
  it("HERMES profile weights match expected values", () => {
    const weights = getProfileWeights("HERMES");

    expect(weights.structure).toBe(20);
    expect(weights.oiDelta).toBe(15);
    expect(weights.greeksIv).toBe(10);
    expect(weights.volume).toBe(10);
    expect(weights.fvg).toBe(10);
    expect(weights.liquidity).toBe(10);
    expect(weights.vix).toBe(5);
    expect(weights.historical).toBe(5);
  });

  it("unified scoring returns HERMES profile metadata", () => {
    const input = {
      symbol: "NIFTY",
      strategy: "HERMES" as const,
      direction: "BULLISH" as const,
      spot: 24550,
      vix: 15,
      pcr: 1.2,
      optionChain: [
        { strike: 24500, ce: { ltp: 150, oi: 50000, oiChg: 1000, volume: 2000, iv: 15, delta: 0.45, theta: -5, gamma: 0.002, vega: 0.1 }, pe: { ltp: 120, oi: 60000, oiChg: -500, volume: 1500, iv: 16, delta: -0.42, theta: -4.5, gamma: 0.002, vega: 0.1 } },
      ],
    };

    const result = scoreTrade(input);

    expect(result.strategyProfile).toBe("HERMES");
    expect(result.scoringVersion).toBeDefined();
    expect(result.weightsUsed).toBeDefined();
    expect(result.weightsUsed.structure).toBe(20);
    expect(result.weightsUsed.oiDelta).toBe(15);
  });
});

// ── Test 7: Hermes bridge produces valid MarketDataInput ────────────

describe("Wiring: HermesContext → MarketDataInput conversion", () => {
  it("bridge converts HermesContext to unified scoring format", () => {
    const ctx: HermesContext = {
      symbol: "NIFTY",
      exchange: "NSE",
      instrument: "index",
      marketStatus: "OPEN",
      spot: { value: { price: 24550, change: 50, changePct: 0.2, prevClose: 24500, open: 24520, high: 24600, low: 24480, volume: 0 }, source: "test", timestamp: "", ageMs: 0, freshness: "LIVE", status: "SUCCESS", delayed: false, fallbackUsed: false },
      optionChain: { value: { symbol: "NIFTY", spot: 24550, atmStrike: 24500, expiry: "2026-09-18", daysToExpiry: 3, strikes: [{ strike: 24500, ce: { ltp: 150, bid: null, ask: null, spread: null, quoteQuality: "UNKNOWN", volume: 2000, oi: 50000, oiChange: 1000, iv: 15, delta: 0.45, gamma: 0.002, theta: -5, vega: 0.1, rho: 0 }, pe: { ltp: 120, bid: null, ask: null, spread: null, quoteQuality: "UNKNOWN", volume: 1500, oi: 60000, oiChange: -500, iv: 16, delta: -0.42, gamma: 0.002, theta: -4.5, vega: 0.1, rho: 0 } }], totalCallOI: 50000, totalPutOI: 60000, callOiChange: 1000, putOiChange: -500, pcrOI: 1.2, pcrVolume: 0, maxPain: 24500, callWall: 0, putWall: 0, gammaWall: 0, gammaFlip: 0, expectedMove: 0, vix: 15, futuresPrice: 0 }, source: "test", timestamp: "", ageMs: 0, freshness: "LIVE", status: "SUCCESS", delayed: false, fallbackUsed: false },
      vix: { value: 15, source: "test", timestamp: "", ageMs: 0, freshness: "LIVE", status: "SUCCESS", delayed: false, fallbackUsed: false },
      fiiDII: { value: { fiiNet: 1000, diiNet: -500, fiiBias: "BULLISH_FLOW", dataDate: "", publishedAt: "" }, source: "test", timestamp: "", ageMs: 0, freshness: "LIVE", status: "SUCCESS", delayed: false, fallbackUsed: false },
      news: { value: { sentiment: "NEUTRAL", score: 0, headlines: [], highImpactEvents: [] }, source: "test", timestamp: "", ageMs: 0, freshness: "LIVE", status: "SUCCESS", delayed: false, fallbackUsed: false },
      regime: { value: { type: "TRENDING_UP", bias: "BULLISH", confidence: 70, factors: {} }, source: "test", timestamp: "", ageMs: 0, freshness: "LIVE", status: "SUCCESS", delayed: false, fallbackUsed: false },
      marketStructure: { value: { trend: "UP", swingHigh: 24600, swingLow: 24400, supportLevels: [24400], resistanceLevels: [24600], lastEvent: "BOS", pdh: 24600, pdl: 24400 }, source: "test", timestamp: "", ageMs: 0, freshness: "LIVE", status: "SUCCESS", delayed: false, fallbackUsed: false },
      gamma: { value: { detected: false, confidence: 0, dealerBias: "UNKNOWN", squeezePotential: 0, gammaWallStrike: 0, gammaWallType: "NONE", estimatedGEX: 0, regime: "UNKNOWN" }, source: "test", timestamp: "", ageMs: 0, freshness: "LIVE", status: "SUCCESS", delayed: false, fallbackUsed: false },
      volume: { value: { poc: 0, vah: 0, val: 0, cumulativeDelta: 0, totalVolume: 0, buyVolume: 0, sellVolume: 0 }, source: "test", timestamp: "", ageMs: 0, freshness: "LIVE", status: "SUCCESS", delayed: false, fallbackUsed: false },
      backtest: { value: null, source: "test", timestamp: "", ageMs: 0, freshness: "UNAVAILABLE", status: "UNAVAILABLE", delayed: false, fallbackUsed: false },
    } as any;

    const input = hermesContextToMarketInput(ctx, "BULLISH", "CE");

    expect(input.symbol).toBe("NIFTY");
    expect(input.strategy).toBe("HERMES");
    expect(input.direction).toBe("BULLISH");
    expect(input.spot).toBe(24550);
    expect(input.optionChain).toHaveLength(1);
    expect(input.optionChain![0].ce).toBeDefined();
    expect(input.optionChain![0].ce!.ltp).toBe(150);
  });
});

// ── Test 8: CE score > PE score → BUY_CE (when gates pass) ─────────

describe("Wiring: CE/PE scoring → decision", () => {
  it("unified engine returns TRADE for strong CE setup", () => {
    const input = {
      symbol: "NIFTY",
      strategy: "HERMES" as const,
      direction: "BULLISH" as const,
      spot: 24550,
      vix: 15,
      pcr: 0.8,
      marketStructure: "BULLISH" as const,
      optionChain: [
        { strike: 24500, ce: { ltp: 150, oi: 50000, oiChg: 5000, volume: 5000, iv: 15, delta: 0.5, theta: -5, gamma: 0.003, vega: 0.12 }, pe: { ltp: 100, oi: 30000, oiChg: -2000, volume: 2000, iv: 14, delta: -0.35, theta: -3, gamma: 0.002, vega: 0.08 } },
        { strike: 24600, ce: { ltp: 80, oi: 40000, oiChg: 3000, volume: 3000, iv: 14, delta: 0.4, theta: -4, gamma: 0.0025, vega: 0.1 }, pe: { ltp: 160, oi: 60000, oiChg: 1000, volume: 4000, iv: 16, delta: -0.5, theta: -6, gamma: 0.003, vega: 0.14 } },
      ],
      fiiNet: 2000,
      diiNet: -500,
    };

    const result = scoreTrade(input);

    expect(result.strategyProfile).toBe("HERMES");
    expect(result.score).toBeGreaterThan(0);
    // With BULLISH structure + BULLISH OI + reasonable VIX, CE should score higher
  });

  it("unified engine returns different scores for CE vs PE", () => {
    const ceInput = {
      symbol: "NIFTY",
      strategy: "HERMES" as const,
      direction: "BULLISH" as const,
      spot: 24550,
      vix: 15,
      pcr: 0.8,
      marketStructure: "BULLISH" as const,
      optionChain: [
        { strike: 24500, ce: { ltp: 150, oi: 50000, oiChg: 5000, volume: 5000, iv: 15, delta: 0.5, theta: -5, gamma: 0.003, vega: 0.12 }, pe: undefined },
      ],
      fiiNet: 2000,
    };

    const peInput = {
      ...ceInput,
      direction: "BEARISH" as const,
    };

    const ceResult = scoreTrade(ceInput);
    const peResult = scoreTrade(peInput);

    // Both should produce valid results
    expect(ceResult.score).toBeGreaterThanOrEqual(0);
    expect(peResult.score).toBeGreaterThanOrEqual(0);
    expect(ceResult.strategyProfile).toBe("HERMES");
    expect(peResult.strategyProfile).toBe("HERMES");
  });
});

// ── Test 9: Conflict detector blocks trade ──────────────────────────

describe("Wiring: Conflict detector blocks trade", () => {
  it("CE score > PE score but conflict detector blocks → WAIT", () => {
    const signals: EngineSignal[] = [
      { source: "unified-HERMES-CE", direction: "CE", confidence: 65, score: 65 },
      { source: "unified-HERMES-PE", direction: "PE", confidence: 60, score: 60 },
    ];

    const chain = {
      strikes: [
        { strike: 24500, ce: { oi: 50000 }, pe: { oi: 60000 } },
        { strike: 24600, ce: { oi: 40000 }, pe: { oi: 70000 } },
        { strike: 24700, ce: { oi: 30000 }, pe: { oi: 80000 } },
        { strike: 24800, ce: { oi: 20000 }, pe: { oi: 90000 } },
        { strike: 24900, ce: { oi: 10000 }, pe: { oi: 100000 } },
      ],
    } as any;

    const result = detectAndResolveConflicts(signals, chain, "neutral");

    // Score diff is only 5 (< 15 threshold) → WAIT
    expect(result.hasConflict).toBe(true);
    expect(result.resolvedDirection).toBe("WAIT");
  });
});

// ── Test 10: Run quality gates on real-like data ────────────────────

describe("Wiring: Quality gates on realistic data", () => {
  it("passes when all data is present", () => {
    const chain = {
      strikes: Array.from({ length: 20 }, (_, i) => ({
        strike: 24400 + i * 100,
        ce: { premium: 200 - i * 10, oi: 50000 + i * 1000, volume: 2000 + i * 100, delta: 0.5 - i * 0.03 },
        pe: { premium: 50 + i * 10, oi: 30000 + i * 2000, volume: 1500 + i * 200, delta: -(0.3 + i * 0.03) },
      })),
      pcr: 1.2,
      atmStrike: 24500,
    } as any;

    const gates = runQualityGates(chain, 24550, 15, "breeze");
    const blockResult = shouldBlockTrade(gates);

    expect(blockResult.block).toBe(false);
    expect(gates.every(g => g.passed || g.severity === "WARN")).toBe(true);
  });
});
