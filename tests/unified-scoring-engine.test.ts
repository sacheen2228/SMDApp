// Acceptance Tests — Unified Scoring Engine v2.0
// 12 tests covering core requirements

import { describe, it, expect } from "bun:test";
import {
  scoreTrade,
  scoreAndRank,
  computeAllFactors,
  getProfileWeights,
  getWeightTotal,
  formatScoreDisplay,
  getScoreInterpretation,
  STRATEGY_PROFILES,
  SCORING_VERSION,
  type MarketDataInput,
  type StrategyProfile,
} from "../src/lib/unified-scoring-engine";

// ─── Helpers ──────────────────────────────────────────────────────

function makeInput(overrides: Partial<MarketDataInput> = {}): MarketDataInput {
  return {
    symbol: "NIFTY",
    strategy: "EQUITY_SWING",
    direction: "BULLISH",
    spot: 24500,
    prevClose: 24400,
    dayHigh: 24600,
    dayLow: 24300,
    candles: Array.from({ length: 20 }, (_, i) => ({
      time: Date.now() - (20 - i) * 60000,
      open: 24400 + i * 5,
      high: 24400 + i * 5 + 10,
      low: 24400 + i * 5 - 10,
      close: 24400 + i * 5,
      volume: 100000,
    })),
    marketStructure: "BULLISH",
    swingHigh: 24600,
    swingLow: 24300,
    rsi: 62,
    adx: 28,
    vwap: 24450,
    ema9: 24520,
    ema21: 24480,
    ema50: 24400,
    vix: 14,
    avgVolume: 500000,
    currentVolume: 600000,
    relativeVolume: 1.2,
    orderBlocks: [{ price: 24350, direction: "BULLISH" }],
    fvgs: [{ price: 24400, direction: "BULLISH" }],
    liquidityLevels: [{ price: 24300, type: "swing_low", swept: false }],
    pcr: 1.1,
    maxPain: 24500,
    newsScore: 10,
    historicalWinRate: 0.65,
    historicalRR: 2.5,
    regime: "TRENDING_BULL",
    regimeConfidence: 0.75,
    isMarketOpen: true,
    capital: 15000,
    riskPercent: 2,
    lotSize: 50,
    entryPrice: 24520,
    stopLoss: 24420,
    target1: 24720,
    target2: 24820,
    ...overrides,
  };
}

function makeOptionChain(spot: number) {
  const chain = [];
  for (let s = spot - 500; s <= spot + 500; s += 100) {
    chain.push({
      strike: s,
      ce: {
        ltp: Math.max(1, (spot - s + 200) / 10),
        oi: 500000 + Math.random() * 200000,
        oiChg: Math.random() * 50000,
        volume: 100000 + Math.random() * 50000,
        iv: 15 + Math.random() * 5,
        delta: s < spot ? 0.7 : s === spot ? 0.5 : 0.3,
        theta: -0.5,
        gamma: 0.02,
        vega: 0.1,
      },
      pe: {
        ltp: Math.max(1, (s - spot + 200) / 10),
        oi: 500000 + Math.random() * 200000,
        oiChg: Math.random() * 50000,
        volume: 100000 + Math.random() * 50000,
        iv: 15 + Math.random() * 5,
        delta: s > spot ? -0.7 : s === spot ? -0.5 : -0.3,
        theta: -0.5,
        gamma: 0.02,
        vega: 0.1,
      },
    });
  }
  return chain;
}

// ─── Tests ────────────────────────────────────────────────────────

describe("Unified Scoring Engine — Acceptance Tests", () => {
  // TEST 1: Factor scores are 0-100
  it("all factor scores are within 0-100 range", () => {
    const input = makeInput();
    const factors = computeAllFactors(input);
    for (const f of factors) {
      expect(f.score).toBeGreaterThanOrEqual(0);
      expect(f.score).toBeLessThanOrEqual(100);
    }
  });

  // TEST 2: Hard gates block trades when data is missing
  it("hard gates FAIL when spot price is missing", () => {
    const input = makeInput({ spot: 0 });
    const decision = scoreTrade(input);
    expect(decision.hardGateStatus.passed).toBe(false);
    expect(decision.hardGateStatus.failedGates).toContain("DATA_VALIDATION");
    expect(decision.decision).toBe("NO_TRADE");
  });

  // TEST 3: Hard gates block trades when liquidity is insufficient
  it("hard gates FAIL when avg volume is too low", () => {
    const input = makeInput({ avgVolume: 10000 });
    const decision = scoreTrade(input);
    const liqGate = decision.hardGateStatus.gates.find(g => g.name === "LIQUIDITY");
    expect(liqGate?.status).toBe("FAIL");
    expect(decision.decision).toBe("NO_TRADE");
  });

  // TEST 4: Score is deterministic for identical inputs
  it("same input produces identical score", () => {
    const input = makeInput();
    const d1 = scoreTrade(input);
    const d2 = scoreTrade(input);
    expect(d1.score).toBe(d2.score);
    expect(d1.grade).toBe(d2.grade);
    expect(d1.decision).toBe(d2.decision);
  });

  // TEST 5: All 5 strategy profiles produce valid scores
  it("all 5 profiles produce valid scores", () => {
    const profiles: StrategyProfile[] = ["EQUITY_SWING", "FO", "OPTIONS", "CAS", "HERO_ZERO"];
    for (const profile of profiles) {
      const input = makeInput({
        strategy: profile,
        optionChain: profile !== "EQUITY_SWING" ? makeOptionChain(24500) : undefined,
        pcr: profile !== "EQUITY_SWING" ? 1.1 : undefined,
      });
      const decision = scoreTrade(input);
      expect(decision.score).toBeGreaterThanOrEqual(0);
      expect(decision.score).toBeLessThanOrEqual(100);
      expect(decision.strategyProfile).toBe(profile);
      expect(decision.scoringVersion).toBe(SCORING_VERSION);
    }
  });

  // TEST 6: Weight totals match profile definitions
  it("weight totals are consistent per profile", () => {
    const profiles: StrategyProfile[] = ["EQUITY_SWING", "FO", "OPTIONS", "CAS", "HERO_ZERO"];
    for (const profile of profiles) {
      const weights = getProfileWeights(profile);
      const total = getWeightTotal(weights);
      expect(total).toBeGreaterThan(50);
      expect(total).toBeLessThanOrEqual(100);
    }
  });

  // TEST 7: Strong bullish input produces grade A or A+
  it("strong bullish input produces A or A+ grade", () => {
    const input = makeInput({
      direction: "BULLISH",
      marketStructure: "BULLISH",
      swingHigh: 24600,
      swingLow: 24300,
      mssBias: "BULLISH",
      mssSweepGated: true,
      mssScore: 85,
      supertrendDirection: "UP",
      supertrendAligned: true,
      supertrendScore: 80,
      rsi: 62,
      adx: 28,
      pcr: 1.2,
      vix: 14,
      relativeVolume: 1.5,
      vwap: 24450,
      orderBlocks: [{ price: 24350, direction: "BULLISH" }],
      fvgs: [{ price: 24400, direction: "BULLISH" }],
    });
    const decision = scoreTrade(input);
    expect(["A+", "A"]).toContain(decision.grade);
  });

  // TEST 8: Opposing signals produce grade B, WATCH, or NO_TRADE
  it("opposing signals produce lower grade", () => {
    const input = makeInput({
      direction: "BULLISH",
      marketStructure: "BEARISH",
      swingHigh: 24600,
      swingLow: 24300,
      mssBias: "BEARISH",
      mssSweepGated: false,
      supertrendDirection: "DOWN",
      supertrendAligned: false,
      rsi: 75,  // overbought
      pcr: 0.7, // bearish PCR
    });
    const decision = scoreTrade(input);
    expect(["B", "WATCH", "NO_TRADE"]).toContain(decision.grade);
  });

  // TEST 9: Trade Decision has all required fields
  it("Trade Decision has all required fields populated", () => {
    const input = makeInput();
    const decision = scoreTrade(input);
    expect(decision.symbol).toBeTruthy();
    expect(decision.strategy).toBeTruthy();
    expect(decision.scoringVersion).toBe(SCORING_VERSION);
    expect(decision.scoreBreakdown.length).toBeGreaterThan(0);
    expect(decision.hardGateStatus.gates.length).toBeGreaterThan(0);
    expect(decision.timestamp).toBeGreaterThan(0);
    expect(decision.weightsUsed).toBeTruthy();
  });

  // TEST 10: scoreAndRank returns sorted results
  it("scoreAndRank returns results sorted by score descending", () => {
    const candidates = [
      makeInput({ symbol: "RELIANCE", direction: "BEARISH", marketStructure: "BEARISH" }),
      makeInput({ symbol: "TCS", direction: "BULLISH", marketStructure: "BULLISH" }),
      makeInput({ symbol: "SBIN", direction: "BULLISH", rsi: 75, pcr: 0.7 }),
    ];
    const ranked = scoreAndRank(candidates, 10);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });

  // TEST 11: Missing optional data does not crash
  it("scoring works with minimal data (no optional fields)", () => {
    const input: MarketDataInput = {
      symbol: "TEST",
      strategy: "EQUITY_SWING",
      direction: "NEUTRAL",
      spot: 1000,
      candles: [{ time: Date.now(), open: 1000, high: 1005, low: 995, close: 1000, volume: 1000 }],
    };
    const decision = scoreTrade(input);
    expect(decision.score).toBeGreaterThanOrEqual(0);
    expect(decision.score).toBeLessThanOrEqual(100);
    expect(decision.scoreBreakdown.length).toBeGreaterThan(0);
    // Some factors should be unavailable
    const unavailable = decision.scoreBreakdown.filter(f => !f.available);
    expect(unavailable.length).toBeGreaterThan(0);
  });

  // TEST 12: Hard gates block Hero-Zero in extreme VIX
  it("Hero-Zero hard gates FAIL when VIX > 30", () => {
    const input = makeInput({
      strategy: "HERO_ZERO",
      vix: 35,
      optionChain: makeOptionChain(24500),
      pcr: 0.8,
    });
    const decision = scoreTrade(input);
    const regimeGate = decision.hardGateStatus.gates.find(g => g.name === "MARKET_REGIME");
    expect(regimeGate?.status).toBe("FAIL");
  });
});
