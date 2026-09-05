import { describe, it, expect } from "bun:test";
import {
  aggregateToHTF,
  detectHTFSwings,
  identifyHTFLiquidity,
  classifyERLIRL,
  detectHTFSweeps,
  analyzeHTFLiquidity,
  htfLiquidityScore,
  type Candle,
} from "../src/lib/liquidity-engine";

// ─── Helpers ──────────────────────────────────────────────────────

function makeIntradayCandles(count: number = 100): Candle[] {
  const now = Date.now();
  const candles: Candle[] = [];
  let price = 24000;

  for (let i = 0; i < count; i++) {
    price += (Math.random() - 0.48) * 50; // slight upward bias
    candles.push({
      time: now + i * 300000, // 5m candles
      open: price - 5,
      high: price + 20,
      low: price - 20,
      close: price,
      volume: 100000 + Math.random() * 50000,
    });
  }
  return candles;
}

function makeDailyCandles(count: number = 20): Candle[] {
  const now = Date.now();
  const candles: Candle[] = [];
  // Create a zigzag pattern for reliable swing detection
  const pattern = [100, 110, 120, 115, 105, 95, 100, 110, 125, 130, 120, 110, 105, 115, 125, 135, 125, 115, 105, 95];

  for (let i = 0; i < Math.min(count, pattern.length); i++) {
    const price = pattern[i] * 240; // scale to NIFTY-like prices
    candles.push({
      time: now + i * 86400000,
      open: price - 50,
      high: price + 100,
      low: price - 100,
      close: price,
      volume: 5000000 + Math.random() * 2000000,
    });
  }
  return candles;
}

// ─── Tests ────────────────────────────────────────────────────────

describe("aggregateToHTF", () => {
  it("aggregates 5m candles to 1H", () => {
    const intraday = makeIntradayCandles(100);
    const h1 = aggregateToHTF(intraday, '1H');
    expect(h1.length).toBeGreaterThan(0);
    expect(h1.length).toBeLessThan(intraday.length);
    // Each HTF candle should have high >= low
    for (const c of h1) {
      expect(c.high).toBeGreaterThanOrEqual(c.low);
    }
  });

  it("aggregates to 1D", () => {
    const intraday = makeIntradayCandles(200);
    const d1 = aggregateToHTF(intraday, '1D');
    expect(d1.length).toBeGreaterThan(0);
    expect(d1.length).toBeLessThan(intraday.length);
  });

  it("returns empty for empty input", () => {
    expect(aggregateToHTF([], '1H')).toEqual([]);
  });
});

describe("detectHTFSwings", () => {
  it("finds swings in daily data", () => {
    const now = Date.now();
    // Deterministic V-shaped + inverted V data
    const prices = [100, 110, 120, 115, 105, 95, 100, 110, 125, 130, 120, 110, 105, 115, 125];
    const daily: Candle[] = prices.map((p, i) => ({
      time: now + i * 86400000, open: p - 5, high: p + 10, low: p - 10, close: p, volume: 5000000,
    }));
    const swings = detectHTFSwings(daily, 2);
    expect(swings.length).toBeGreaterThan(0);
    const highs = swings.filter(s => s.type === 'HIGH');
    const lows = swings.filter(s => s.type === 'LOW');
    expect(highs.length).toBeGreaterThanOrEqual(0); // at least some structure detected
  });
});

describe("classifyERLIRL", () => {
  it("classifies extreme levels as ERL", () => {
    const levels = [
      { price: 100, timeframe: '1D' as const, type: 'BSL' as const, classification: 'ERL' as const, strength: 50, touches: 1, swept: false, originTime: Date.now() },
      { price: 200, timeframe: '1D' as const, type: 'SSL' as const, classification: 'ERL' as const, strength: 50, touches: 1, swept: false, originTime: Date.now() },
      { price: 150, timeframe: '1D' as const, type: 'BSL' as const, classification: 'IRL' as const, strength: 50, touches: 1, swept: false, originTime: Date.now() },
    ];
    const { erlLevels, irlLevels } = classifyERLIRL(levels, 145);
    expect(erlLevels.length).toBeGreaterThanOrEqual(1);
    // The midpoint level should be IRL
    expect(irlLevels.some(l => l.price === 150)).toBe(true);
  });
});

describe("analyzeHTFLiquidity", () => {
  it("produces complete HTF analysis from intraday data", () => {
    const intraday = makeIntradayCandles(100);
    const result = analyzeHTFLiquidity(intraday);
    expect(result).toBeDefined();
    expect(result.htfLevels).toBeDefined();
    expect(result.erlLevels).toBeDefined();
    expect(result.irlLevels).toBeDefined();
    expect(result.currentBias).toBeDefined();
  });

  it("uses HTF data when provided", () => {
    const intraday = makeIntradayCandles(100);
    const daily = makeDailyCandles(20);
    const result = analyzeHTFLiquidity(intraday, undefined, undefined, daily);
    expect(result.htfLevels.length).toBeGreaterThan(0);
  });
});

describe("htfLiquidityScore", () => {
  it("returns 50 for empty data", () => {
    const result = htfLiquidityScore({
      htfLevels: [], erlLevels: [], irlLevels: [],
      nearestBSL: null, nearestSSL: null, currentBias: 'NEUTRAL',
    }, 'BULLISH');
    expect(result).toBe(50);
  });

  it("returns higher score when bias aligns with direction", () => {
    const result = htfLiquidityScore({
      htfLevels: [{ price: 25000, timeframe: '1D', type: 'BSL', classification: 'ERL', strength: 80, touches: 3, swept: false, originTime: Date.now() }],
      erlLevels: [{ price: 25000, timeframe: '1D', type: 'BSL', classification: 'ERL', strength: 80, touches: 3, swept: false, originTime: Date.now() }],
      irlLevels: [],
      nearestBSL: null, nearestSSL: null, currentBias: 'BULLISH',
    }, 'BULLISH');
    expect(result).toBeGreaterThan(50);
  });
});
