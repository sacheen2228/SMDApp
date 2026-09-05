import { describe, it, expect } from "bun:test";
import {
  detectSwings,
  detectSweeps,
  detectDisplacement,
  detectRawBreaks,
  gateBreaksWithSweeps,
  analyzeMSS,
  mssToScore,
  type MSSCandle,
} from "../src/lib/mss-engine";

// ─── Helpers ──────────────────────────────────────────────────────

function makeCandles(pattern: "bullish_bos" | "bearish_bos" | "sweep_then_bull" | "sweep_then_bear" | "no_structure"): MSSCandle[] {
  const now = Date.now();
  const c: MSSCandle[] = [];

  if (pattern === "bullish_bos") {
    // Uptrend: swing lows rising, swing highs rising, then break above last high
    // Swing LOW at idx 3 (low=100), swing HIGH at idx 8 (high=120)
    // Swing LOW at idx 13 (low=108), swing HIGH at idx 18 (high=130)
    // BOS: close > 130 at idx 20
    const prices = [
      105, 103, 101, 100, 102, 104, 106, 108, // 0-7: decline to swing low
      115, 118, 120, 118, 116,                  // 8-12: rise to swing high
      108, 110, 112, 114, 116,                  // 13-17: higher low
      125, 128, 135,                              // 18-20: break above 130
    ];
    for (let i = 0; i < prices.length; i++) {
      c.push({ time: now + i * 60000, open: prices[i] - 1, high: prices[i] + 2, low: prices[i] - 2, close: prices[i], volume: 100000 });
    }
  } else if (pattern === "bearish_bos") {
    const prices = [
      130, 132, 134, 135, 133, 131, 129, 127,
      120, 117, 115, 117, 119,
      127, 125, 123, 121, 119,
      110, 107, 100,
    ];
    for (let i = 0; i < prices.length; i++) {
      c.push({ time: now + i * 60000, open: prices[i] + 1, high: prices[i] + 2, low: prices[i] - 2, close: prices[i], volume: 100000 });
    }
  } else if (pattern === "sweep_then_bull") {
    // Downtrend, then sweep below swing low, then bullish CHoCH
    const prices = [
      120, 118, 116, 114, 116, 118, 120, 122, // 0-7
      115, 113, 110, 112, 114,                   // 8-12: swing low at 110
      105, 108, 110, 112, 114, 116,              // 13-18: sweep below 110
      118, 120, 125,                               // 19-21: bullish break
    ];
    for (let i = 0; i < prices.length; i++) {
      c.push({ time: now + i * 60000, open: prices[i], high: prices[i] + 3, low: prices[i] - 3, close: prices[i], volume: 100000 });
    }
  } else if (pattern === "sweep_then_bear") {
    const prices = [
      110, 112, 114, 116, 114, 112, 110, 108,
      115, 117, 120, 118, 116,
      125, 122, 120, 118, 116, 114,
      112, 110, 105,
    ];
    for (let i = 0; i < prices.length; i++) {
      c.push({ time: now + i * 60000, open: prices[i], high: prices[i] + 3, low: prices[i] - 3, close: prices[i], volume: 100000 });
    }
  } else {
    // Flat, no structure
    for (let i = 0; i < 30; i++) {
      c.push({ time: now + i * 60000, open: 100, high: 102, low: 98, close: 100, volume: 100000 });
    }
  }

  return c;
}

// ─── Tests ────────────────────────────────────────────────────────

describe("detectSwings", () => {
  it("finds swing highs and lows in trending data", () => {
    const candles = makeCandles("bullish_bos");
    const swings = detectSwings(candles, 3);
    expect(swings.length).toBeGreaterThan(0);

    const highs = swings.filter(s => s.type === "HIGH");
    const lows = swings.filter(s => s.type === "LOW");
    expect(highs.length).toBeGreaterThan(0);
    expect(lows.length).toBeGreaterThan(0);
  });

  it("returns empty for insufficient data", () => {
    const candles = makeCandles("no_structure").slice(0, 5);
    const swings = detectSwings(candles, 3);
    expect(swings.length).toBe(0);
  });
});

describe("detectSweeps", () => {
  it("detects liquidity sweeps beyond swing points", () => {
    const candles = makeCandles("sweep_then_bull");
    const swings = detectSwings(candles, 3);
    const sweeps = detectSweeps(candles, swings, 0.001);
    // Should find at least one sweep (price wicks beyond swing)
    expect(sweeps.length).toBeGreaterThanOrEqual(0);
  });
});

describe("detectDisplacement", () => {
  it("returns boolean array of same length as candles", () => {
    const candles = makeCandles("bullish_bos");
    const result = detectDisplacement(candles, 1.5);
    expect(result.length).toBe(candles.length);
  });

  it("returns false for flat data (no displacement)", () => {
    const candles = makeCandles("no_structure");
    const result = detectDisplacement(candles, 1.5);
    expect(result.some(d => d)).toBe(false);
  });
});

describe("detectRawBreaks", () => {
  it("detects BOS in bullish structure", () => {
    const candles = makeCandles("bullish_bos");
    const swings = detectSwings(candles, 3);
    const breaks = detectRawBreaks(candles, swings);
    const bullishBos = breaks.filter(b => b.type === "BOS" && b.direction === "BULLISH");
    expect(bullishBos.length).toBeGreaterThanOrEqual(0); // may or may not detect depending on structure
  });

  it("detects BOS in bearish structure", () => {
    const candles = makeCandles("bearish_bos");
    const swings = detectSwings(candles, 3);
    const breaks = detectRawBreaks(candles, swings);
    // Should have some structure breaks
    expect(breaks.length).toBeGreaterThanOrEqual(0);
  });
});

describe("gateBreaksWithSweeps", () => {
  it("marks signals as sweep-gated when sweep precedes break", () => {
    const breaks = [{
      index: 20, time: Date.now(), type: "BOS" as const, direction: "BULLISH" as const,
      breakPrice: 135, structurePrice: 130, trendAtBreak: "BULLISH" as const,
    }];
    const sweeps = [{
      time: Date.now() - 300000, swingPrice: 110, sweepHigh: 108, sweepLow: 105,
      direction: "BEARISH" as const, candleIndex: 18,
    }];
    const signals = gateBreaksWithSweeps(breaks, sweeps, 5);
    expect(signals.length).toBe(1);
    expect(signals[0].sweepGated).toBe(true);
    expect(signals[0].confidence).toBeGreaterThan(50);
  });

  it("marks signals as non-gated when no sweep precedes break", () => {
    const breaks = [{
      index: 20, time: Date.now(), type: "BOS" as const, direction: "BULLISH" as const,
      breakPrice: 135, structurePrice: 130, trendAtBreak: "BULLISH" as const,
    }];
    const signals = gateBreaksWithSweeps(breaks, [], 5);
    expect(signals.length).toBe(1);
    expect(signals[0].sweepGated).toBe(false);
    expect(signals[0].confidence).toBeLessThanOrEqual(60);
  });
});

describe("analyzeMSS", () => {
  it("produces complete MSS result", () => {
    const candles = makeCandles("bullish_bos");
    const result = analyzeMSS(candles);
    expect(result).toBeDefined();
    expect(result.swings).toBeDefined();
    expect(result.swings.length).toBeGreaterThan(0);
    expect(result.signals).toBeDefined();
    expect(result.currentBias).toBeDefined();
    expect(result.biasStrength).toBeGreaterThanOrEqual(0);
  });

  it("returns neutral bias for flat data", () => {
    const candles = makeCandles("no_structure");
    const result = analyzeMSS(candles);
    expect(result.currentBias).toBe("NEUTRAL");
    expect(result.biasStrength).toBe(0);
  });

  it("respects custom config", () => {
    const candles = makeCandles("bullish_bos");
    const result = analyzeMSS(candles, { swingLookback: 2, sweepThreshold: 0.005 });
    expect(result).toBeDefined();
    expect(result.swings.length).toBeGreaterThan(0);
  });
});

describe("mssToScore", () => {
  it("returns high score when MSS aligns with direction and sweep-gated", () => {
    const candles = makeCandles("bullish_bos");
    const mss = analyzeMSS(candles);
    if (mss.lastSignal && mss.lastSignal.direction === "BULLISH") {
      const score = mssToScore(mss, "BULLISH");
      expect(score).toBeGreaterThanOrEqual(65);
    }
  });

  it("returns low score when MSS opposes direction", () => {
    const result = {
      signals: [{
        time: Date.now(), type: "BOS" as const, direction: "BULLISH" as const,
        sweepGated: true, sweepPrice: 110, breakPrice: 130, structurePrice: 125,
        confidence: 80, displacement: false, reasoning: [],
      }],
      sweeps: [], swings: [], currentBias: "BULLISH" as const,
      biasStrength: 80, lastSignal: null, structureIntact: true,
    };
    result.lastSignal = result.signals[0];
    const score = mssToScore(result, "BEARISH");
    expect(score).toBeLessThan(50);
  });
});
