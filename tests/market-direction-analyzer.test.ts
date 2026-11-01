// market-direction-analyzer.test.ts — D-4: multi-timeframe trend from real candles
//
// Replaces PCR-only analyzeMarketDirection with:
//   • Multi-timeframe EMA alignment (5m/15m/30m/daily)
//   • VWAP position + slope
//   • RSI, MACD, ADX, ATR from real OHLC
//   • Relative volume vs 20-day average
//   • Real breadth from sector heatmap
//   • Breakout/pullback/momentum classification
import { describe, test, expect } from "bun:test";
import { analyzeMarketDirection, type MarketDirectionInput } from "@/lib/market-direction-analyzer";

// Helper: generate synthetic daily candles with a clear trend
function makeDailyCandles(trend: "up" | "down" | "flat", count = 60) {
  const candles = [];
  const base = 100;
  const step = trend === "up" ? 0.5 : trend === "down" ? -0.5 : 0;
  for (let i = 0; i < count; i++) {
    // i = 0 → newest, i = count-1 → oldest
    const close = base + (count - 1 - i) * step;
    const change = step;
    const open = close - change;
    const high = Math.max(open, close) + Math.abs(change) * 0.5;
    const low = Math.min(open, close) - Math.abs(change) * 0.5;
    candles.unshift({
      timestamp: Date.now() - i * 86400000,
      open, high, low, close, volume: 1_000_000,
    });
  }
  return candles;
}

describe("analyzeMarketDirection: multi-timeframe from real candles", () => {
  const baseInput: MarketDirectionInput = {
    spotPrice: 24000,
    vix: 15,
    pcr: 1.1,
    maxPain: 24000,
    totalCallOI: 100000,
    totalPutOI: 110000,
    dailyCandles: makeDailyCandles("up"),
    intradayCandles: { "5m": makeDailyCandles("up", 100), "15m": makeDailyCandles("up", 50) },
    breadth: { advancing: 65, declining: 35, unchanged: 0 },
  };

  test("strong uptrend: EMA aligned bullish, price > VWAP, breadth advancing → BULLISH", () => {
    const out = analyzeMarketDirection(baseInput);
    expect(out.trend).toMatch(/BULLISH/);
    expect(out.score).toBeGreaterThan(60);
    expect(out.multiTimeframe).toBeDefined();
    expect(out.multiTimeframe?.emaAlignment).toBe("BULLISH");
    expect(out.multiTimeframe?.vwapPosition).toBe("ABOVE");
    expect(out.multiTimeframe?.breadth).toBe("ADVANCING");
  });

  test("strong downtrend: EMA aligned bearish, price < VWAP, breadth declining → BEARISH", () => {
    const input = { ...baseInput, dailyCandles: makeDailyCandles("down"), intradayCandles: { "5m": makeDailyCandles("down", 100), "15m": makeDailyCandles("down", 50) }, breadth: { advancing: 30, declining: 70, unchanged: 0 } };
    const out = analyzeMarketDirection(input);
    expect(out.trend).toMatch(/BEARISH/);
    expect(out.score).toBeLessThan(45);
    expect(out.multiTimeframe?.emaAlignment).toBe("BEARISH");
    expect(out.multiTimeframe?.vwapPosition).toBe("BELOW");
    expect(out.multiTimeframe?.breadth).toBe("DECLINING");
  });

  test("sideways: mixed EMA, price near VWAP, breadth mixed → SIDEWAYS", () => {
    const input = { ...baseInput, dailyCandles: makeDailyCandles("flat"), intradayCandles: { "5m": makeDailyCandles("flat", 100), "15m": makeDailyCandles("flat", 50) }, breadth: { advancing: 46, declining: 44, unchanged: 10 } };
    const out = analyzeMarketDirection(input);
    expect(out.trend).toBe("SIDEWAYS");
    expect(out.multiTimeframe?.emaAlignment).toBe("MIXED");
    expect(out.multiTimeframe?.breadth).toBe("MIXED");
  });

  test("PCR is confirming factor only, not sole driver", () => {
    // Bullish candles but PCR bearish (<0.9) → trend still BULLISH (candles win)
    const input = { ...baseInput, dailyCandles: makeDailyCandles("up"), pcr: 0.8 };
    const out = analyzeMarketDirection(input);
    expect(out.trend).toMatch(/BULLISH/);
    expect(out.details).toContain("PCR");
  });

  test("missing candles → gracefully returns NEUTRAL with low confidence", () => {
    const input = { ...baseInput, dailyCandles: [], intradayCandles: undefined, breadth: undefined };
    const out = analyzeMarketDirection(input);
    expect(out.trend).toBe("SIDEWAYS");
    expect(out.score).toBeLessThanOrEqual(55);
    expect(out.details).toContain("insufficient candle data");
  });

  test("no fabricated defaults — all indicators come from candles or are null", () => {
    const input = { ...baseInput, dailyCandles: makeDailyCandles("up", 20) }; // insufficient for 50 EMA
    const out = analyzeMarketDirection(input);
    // ema50 should be null or derived from available data, not basePrice*0.997
    expect(out.multiTimeframe?.ema50).not.toBe(baseInput.spotPrice * 0.997);
  });
});