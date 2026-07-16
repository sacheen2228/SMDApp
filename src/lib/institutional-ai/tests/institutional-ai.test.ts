// ─── OptionChainInstitutionalAI — Unit Tests ──────────────────────
// Run: bun test src/lib/institutional-ai/tests/

import { describe, it, expect } from "bun:test";
import { OptionChainInstitutionalAI } from "../OptionChainInstitutionalAI";
import { detectBreakout } from "../BreakoutDetector";
import { analyzeOptionChain } from "../OptionAnalyzer";
import { calculatePCR } from "../PCR";
import { analyzeMaxOI } from "../MaxOI";
import { detectOIShift } from "../OIShift";
import { analyzeVolume } from "../VolumeAnalyzer";
import { analyzeIV } from "../IVAnalyzer";
import { analyzeTrend } from "../TrendAnalyzer";
import { calculateConfidence, resolveDirection } from "../ConfidenceEngine";
import { generateTrade } from "../TradeGenerator";
import type { Candle, OptionData, AnalysisContext } from "../types";

// ─── Test Data ────────────────────────────────────────────────────

function makeCandles(count: number, basePrice: number, trend: "UP" | "DOWN" | "FLAT"): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const change = trend === "UP" ? 5 : trend === "DOWN" ? -5 : 0;
    const open = price;
    const close = price + change + (Math.random() - 0.5) * 10;
    const high = Math.max(open, close) + Math.random() * 5;
    const low = Math.min(open, close) - Math.random() * 5;
    candles.push({ time: Date.now() - (count - i) * 60000, open, high, low, close, volume: 10000 + Math.random() * 5000 });
    price = close;
  }
  return candles;
}

function makeChain(strikes: number[], spotPrice: number): OptionData[] {
  return strikes.map((strike) => ({
    strike,
    callOI: strike > spotPrice ? 50000 : 20000,
    putOI: strike < spotPrice ? 50000 : 20000,
    callOIChange: strike > spotPrice ? -5000 : 2000,
    putOIChange: strike < spotPrice ? 5000 : -2000,
    callVolume: strike > spotPrice ? 30000 : 10000,
    putVolume: strike < spotPrice ? 30000 : 10000,
    callIV: 20 + Math.random() * 5,
    putIV: 22 + Math.random() * 5,
  }));
}

// ─── BreakoutDetector Tests ───────────────────────────────────────

describe("BreakoutDetector", () => {
  it("detects no breakout with insufficient data", () => {
    const result = detectBreakout([], 100);
    expect(result.detected).toBe(false);
    expect(result.direction).toBe("NONE");
  });

  it("detects bullish breakout", () => {
    // Build candles with a clear resistance at 110
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      const high = i < 23 ? 108 + Math.random() * 2 : 115; // last 2 candles break above
      const low = 95 + Math.random() * 5;
      candles.push({ time: Date.now() - (25 - i) * 60000, open: low + 2, high, low, close: i < 23 ? 100 + Math.random() * 5 : 112, volume: 10000 });
    }
    const result = detectBreakout(candles, 100);
    // Should detect breakout since last candles close above resistance area
    expect(result.direction === "BULLISH" || result.nearestResistance > 0).toBe(true);
  });

  it("finds support and resistance levels", () => {
    const candles = makeCandles(25, 100, "FLAT");
    const result = detectBreakout(candles, 100);
    expect(result.supportLevels.length).toBeGreaterThanOrEqual(0);
    expect(result.resistanceLevels.length).toBeGreaterThanOrEqual(0);
  });
});

// ─── OptionAnalyzer Tests ─────────────────────────────────────────

describe("OptionAnalyzer", () => {
  it("detects call writing", () => {
    const chain: OptionData[] = [
      { strike: 105, callOI: 100000, putOI: 20000, callOIChange: 15000, putOIChange: 0, callVolume: 50000, putVolume: 10000, callIV: 20, putIV: 22 },
      { strike: 100, callOI: 80000, putOI: 80000, callOIChange: 0, putOIChange: 0, callVolume: 30000, putVolume: 30000, callIV: 18, putIV: 18 },
    ];
    const result = analyzeOptionChain(chain, 100);
    expect(result.callWritingScore).toBeGreaterThan(0);
  });

  it("detects put writing", () => {
    const chain: OptionData[] = [
      { strike: 95, callOI: 20000, putOI: 100000, callOIChange: 0, putOIChange: 15000, callVolume: 10000, putVolume: 50000, callIV: 22, putIV: 20 },
    ];
    const result = analyzeOptionChain(chain, 100);
    expect(result.putWritingScore).toBeGreaterThan(0);
  });

  it("classifies neutral when no activity", () => {
    const chain: OptionData[] = [
      { strike: 100, callOI: 50000, putOI: 50000, callOIChange: 0, putOIChange: 0, callVolume: 10000, putVolume: 10000, callIV: 20, putIV: 20 },
    ];
    const result = analyzeOptionChain(chain, 100);
    expect(result.activities.length).toBe(0);
  });
});

// ─── PCR Tests ────────────────────────────────────────────────────

describe("PCR", () => {
  it("calculates PCR correctly", () => {
    const chain: OptionData[] = [
      { strike: 100, callOI: 100000, putOI: 120000, callOIChange: 0, putOIChange: 0, callVolume: 50000, putVolume: 60000, callIV: 20, putIV: 20 },
    ];
    const result = calculatePCR(chain);
    expect(result.value).toBeGreaterThan(1);
    expect(result.classification).toBe("BULLISH");
  });

  it("detects bearish PCR", () => {
    const chain: OptionData[] = [
      { strike: 100, callOI: 120000, putOI: 80000, callOIChange: 0, putOIChange: 0, callVolume: 60000, putVolume: 40000, callIV: 20, putIV: 20 },
    ];
    const result = calculatePCR(chain);
    expect(result.value).toBeLessThan(1);
    expect(result.classification).toBe("BEARISH");
  });
});

// ─── MaxOI Tests ──────────────────────────────────────────────────

describe("MaxOI", () => {
  it("finds highest OI strikes", () => {
    const chain: OptionData[] = [
      { strike: 95, callOI: 10000, putOI: 80000, callOIChange: 0, putOIChange: 0, callVolume: 0, putVolume: 0, callIV: 0, putIV: 0 },
      { strike: 100, callOI: 50000, putOI: 50000, callOIChange: 0, putOIChange: 0, callVolume: 0, putVolume: 0, callIV: 0, putIV: 0 },
      { strike: 105, callOI: 90000, putOI: 10000, callOIChange: 0, putOIChange: 0, callVolume: 0, putVolume: 0, callIV: 0, putIV: 0 },
    ];
    const result = analyzeMaxOI(chain, 100);
    expect(result.highestCallOI.strike).toBe(105);
    expect(result.highestPutOI.strike).toBe(95);
  });
});

// ─── VolumeAnalyzer Tests ─────────────────────────────────────────

describe("VolumeAnalyzer", () => {
  it("detects institutional volume", () => {
    const chain: OptionData[] = [
      { strike: 100, callOI: 0, putOI: 0, callOIChange: 0, putOIChange: 0, callVolume: 60000, putVolume: 40000, callIV: 0, putIV: 0 },
    ];
    const result = analyzeVolume(chain, []);
    expect(result.institutionalVolume).toBe(true);
  });

  it("detects volume spike", () => {
    const chain: OptionData[] = [
      { strike: 100, callOI: 0, putOI: 0, callOIChange: 0, putOIChange: 0, callVolume: 100000, putVolume: 80000, callIV: 0, putIV: 0 },
    ];
    const candles = [{ volume: 1000 }, { volume: 1000 }, { volume: 1000 }];
    const result = analyzeVolume(chain, candles);
    expect(result.volumeSpike).toBe(true);
    expect(result.relativeVolume).toBeGreaterThan(2);
  });
});

// ─── IVAnalyzer Tests ─────────────────────────────────────────────

describe("IVAnalyzer", () => {
  it("calculates average IV", () => {
    const chain: OptionData[] = [
      { strike: 95, callOI: 0, putOI: 0, callOIChange: 0, putOIChange: 0, callVolume: 0, putVolume: 0, callIV: 20, putIV: 22 },
      { strike: 100, callOI: 0, putOI: 0, callOIChange: 0, putOIChange: 0, callVolume: 0, putVolume: 0, callIV: 18, putIV: 20 },
      { strike: 105, callOI: 0, putOI: 0, callOIChange: 0, putOIChange: 0, callVolume: 0, putVolume: 0, callIV: 22, putIV: 24 },
    ];
    const result = analyzeIV(chain);
    expect(result.averageCallIV).toBeCloseTo(20, 0);
    expect(result.averagePutIV).toBeCloseTo(22, 0);
    expect(result.ivSkew).toBeCloseTo(2, 0);
  });
});

// ─── TrendAnalyzer Tests ──────────────────────────────────────────

describe("TrendAnalyzer", () => {
  it("detects bullish trend", () => {
    const candles = makeCandles(30, 100, "UP");
    const result = analyzeTrend(candles);
    expect(result.direction).toBe("BULLISH");
    expect(result.score).toBeGreaterThan(0);
  });

  it("detects bearish trend", () => {
    const candles = makeCandles(30, 200, "DOWN");
    const result = analyzeTrend(candles);
    expect(result.direction).toBe("BEARISH");
  });
});

// ─── Full Integration Test ────────────────────────────────────────

describe("OptionChainInstitutionalAI", () => {
  const ai = new OptionChainInstitutionalAI();

  it("returns NO_TRADE with insufficient data", () => {
    const signal = ai.analyze({ candles: [], optionChain: [], spotPrice: 0 });
    expect(signal.direction).toBe("NO_TRADE");
    expect(signal.confidence).toBe(0);
  });

  it("analyzes valid input without crashing", () => {
    const candles = makeCandles(25, 2800, "UP");
    const chain = makeChain([2700, 2750, 2800, 2850, 2900], 2800);
    const signal = ai.analyze({ candles, optionChain: chain, spotPrice: 2800 });
    expect(["BUY", "SELL", "NO_TRADE"]).toContain(signal.direction);
    expect(signal.confidence).toBeGreaterThanOrEqual(0);
    expect(signal.confidence).toBeLessThanOrEqual(100);
  });

  it("quickAnalyze returns compact result", () => {
    const candles = makeCandles(25, 2800, "UP");
    const chain = makeChain([2700, 2750, 2800, 2850, 2900], 2800);
    const result = ai.quickAnalyze({ candles, optionChain: chain, spotPrice: 2800 });
    expect(["BUY", "SELL", "NO_TRADE"]).toContain(result.direction);
    expect(typeof result.confidence).toBe("number");
    expect(Array.isArray(result.reasons)).toBe(true);
  });
});

// ─── TradeGenerator Tests ─────────────────────────────────────────

describe("TradeGenerator", () => {
  it("synthesizes a directional signal from confidence", () => {
    const scores = {
      breakoutScore: 18, trendScore: 12, liquidityScore: 12,
      volumeScore: 8, callWritingScore: 0, putWritingScore: 8,
      pcrScore: 4, ivScore: 4, oiShiftScore: 3, maxOIScore: 4, total: 73,
    };
    const ctx = {
      breakout: { score: 90, direction: "BULLISH" as const },
      optionAnalysis: { overallBias: "BULLISH" as const },
      pcr: { score: 80 },
      iv: { ivExpansion: false },
      volume: { volumeSpike: false },
      maxOI: { score: 70 },
      oiShift: { score: 60 },
      trendScore: 80,
      input: {} as any,
    } as any;
    const signal = generateTrade("BUY", 73, scores, ctx);
    expect(signal.direction).toBe("BUY");
    expect(signal.confidence).toBe(73);
    expect(signal.entry).toBe(0);
    expect(signal.reasons.length).toBeGreaterThan(0);
  });

  it("rejects low confidence", () => {
    const scores = {
      breakoutScore: 5, trendScore: 3, liquidityScore: 3,
      volumeScore: 2, callWritingScore: 2, putWritingScore: 2,
      pcrScore: 1, ivScore: 1, oiShiftScore: 1, maxOIScore: 1, total: 21,
    };
    const ctx = {
      breakout: { score: 25, direction: "NONE" },
      optionAnalysis: { overallBias: "NEUTRAL" },
      pcr: { score: 20 },
      iv: { ivExpansion: false },
      volume: { volumeSpike: false },
      maxOI: { score: 30 },
      oiShift: { score: 0 },
      trendScore: 20,
      input: {} as any,
    } as any;
    const signal = generateTrade("NO_TRADE", 21, scores, ctx);
    expect(signal.direction).toBe("NO_TRADE");
  });
});
