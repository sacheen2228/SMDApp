import { describe, it, expect } from "bun:test";
import {
  computeSuperTrend,
  supertrendToScore,
  supertrendFilter,
  type SuperTrendCandle,
} from "../src/lib/supertrend-engine";

// ─── Helpers ──────────────────────────────────────────────────────

function makeTrendCandles(direction: "up" | "down" | "flat"): SuperTrendCandle[] {
  const now = Date.now();
  const candles: SuperTrendCandle[] = [];
  let price = 24000;

  for (let i = 0; i < 30; i++) {
    if (direction === "up") price += 30 + Math.random() * 20;
    else if (direction === "down") price -= 30 + Math.random() * 20;
    else price += (Math.random() - 0.5) * 10;

    candles.push({
      time: now + i * 60000,
      open: price - 5,
      high: price + 15,
      low: price - 15,
      close: price,
      volume: 100000,
    });
  }
  return candles;
}

// ─── Tests ────────────────────────────────────────────────────────

describe("computeSuperTrend", () => {
  it("returns UP direction for bullish trend", () => {
    const candles = makeTrendCandles("up");
    const result = computeSuperTrend(candles);
    expect(result.bars.length).toBe(candles.length);
    expect(result.currentDirection).toBe("UP");
    expect(result.currentValue).toBeGreaterThan(0);
  });

  it("returns DOWN direction for bearish trend", () => {
    const candles = makeTrendCandles("down");
    const result = computeSuperTrend(candles);
    expect(result.currentDirection).toBe("DOWN");
    expect(result.currentValue).toBeGreaterThan(0);
  });

  it("has few flips in trending data", () => {
    const candles = makeTrendCandles("up");
    const result = computeSuperTrend(candles);
    // In a clean uptrend, should have very few flips
    expect(result.flips).toBeLessThan(10);
  });

  it("respects custom config", () => {
    const candles = makeTrendCandles("up");
    const result = computeSuperTrend(candles, { period: 7, multiplier: 2.0 });
    expect(result.bars.length).toBe(candles.length);
    expect(result.currentDirection).toBe("UP");
  });

  it("returns empty for insufficient data", () => {
    const candles = makeTrendCandles("up").slice(0, 5);
    const result = computeSuperTrend(candles);
    expect(result.bars.length).toBe(0);
  });
});

describe("supertrendToScore", () => {
  it("returns high score when aligned with trend", () => {
    const candles = makeTrendCandles("up");
    const result = computeSuperTrend(candles);
    const score = supertrendToScore(result, "BULLISH", candles);
    expect(score).toBeGreaterThanOrEqual(70);
  });

  it("returns low score when counter-trend", () => {
    const candles = makeTrendCandles("up");
    const result = computeSuperTrend(candles);
    const score = supertrendToScore(result, "BEARISH", candles);
    expect(score).toBeLessThan(50);
  });

  it("returns 50 for empty data", () => {
    const score = supertrendToScore({ bars: [], currentDirection: "UP", currentValue: 0, trendAge: 0, flips: 0 }, "BULLISH", []);
    expect(score).toBe(50);
  });
});

describe("supertrendFilter", () => {
  it("passes when aligned", () => {
    const candles = makeTrendCandles("up");
    const result = computeSuperTrend(candles);
    const filter = supertrendFilter(result, "BULLISH");
    expect(filter.passes).toBe(true);
  });

  it("rejects when counter-trend and old flip", () => {
    const candles = makeTrendCandles("up");
    const result = computeSuperTrend(candles);
    // Force trendAge to be high
    result.trendAge = 10;
    const filter = supertrendFilter(result, "BEARISH");
    expect(filter.passes).toBe(false);
  });

  it("passes when counter-trend but recent flip (reversal entry)", () => {
    const candles = makeTrendCandles("up");
    const result = computeSuperTrend(candles);
    result.trendAge = 1;
    const filter = supertrendFilter(result, "BEARISH");
    expect(filter.passes).toBe(true);
  });

  it("passes when no data", () => {
    const filter = supertrendFilter({ bars: [], currentDirection: "UP", currentValue: 0, trendAge: 0, flips: 0 }, "BULLISH");
    expect(filter.passes).toBe(true);
  });
});
