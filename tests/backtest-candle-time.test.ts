// backtest-candle-time.test.ts
//
// Regression for the single-day/multi-day breakout backtest crash
// (29 Sep 2026): runMultiDayBacktest feeds HistoricalCandle rows
// ({ time: string, open, high, low, close, volume }) into
// detectPriceActionBreakouts, which was written against a candle shape with a
// `timestamp: Date` field — real candles crashed every backtest with
// "Cannot read properties of undefined (reading 'toISOString')".
//
// These tests replay the exact shape the data provider returns.

import { describe, test, expect } from "bun:test";
import { detectPriceActionBreakouts, type HistoricalCandle } from "../src/lib/backtest-engine";

function flatCandles(n: number, base: number): HistoricalCandle[] {
  const out: HistoricalCandle[] = [];
  for (let i = 0; i < n; i++) {
    const hh = 9 * 60 + 15 + i * 5;
    const h = Math.floor(hh / 60);
    const m = hh % 60;
    const time = `2026-09-29 ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
    out.push({ time, open: base, high: base + 1, low: base - 0.5, close: base + 0.2, volume: 1000 });
  }
  return out;
}

describe("detectPriceActionBreakouts — HistoricalCandle.time shape (timestamp crash fix)", () => {
  test("bullish breakout on time-string candles → ISO timestamp, no throw", () => {
    const candles = flatCandles(15, 100);
    // Final candle breaks above the rolling range high (≈101)
    candles[14] = {
      time: "2026-09-29 10:25:00",
      open: 101,
      high: 105.5,
      low: 100.5,
      close: 105,
      volume: 5000,
    };
    const prevDay = { high: 101, low: 99, close: 100 };

    const breaks = detectPriceActionBreakouts(candles, prevDay);
    expect(breaks.length).toBeGreaterThanOrEqual(1);
    const b = breaks[0];
    expect(b.direction).toBe("bullish");
    expect(b.entryPrice).toBe(105);
    // timestamp must be a valid ISO string derived from candle.time
    expect(typeof b.timestamp).toBe("string");
    expect(Number.isNaN(new Date(b.timestamp).getTime())).toBe(false);
    expect(b.timestamp).toBe(new Date("2026-09-29 10:25:00").toISOString());
  });

  test("bearish breakdown on time-string candles → ISO timestamp, no throw", () => {
    const candles = flatCandles(15, 100);
    candles[14] = {
      time: "2026-09-29 10:25:00",
      open: 99,
      high: 99.5,
      low: 94.5,
      close: 95,
      volume: 5000,
    };
    const prevDay = { high: 101, low: 99, close: 100 };

    const breaks = detectPriceActionBreakouts(candles, prevDay);
    expect(breaks.length).toBeGreaterThanOrEqual(1);
    expect(breaks[0].direction).toBe("bearish");
    expect(breaks[0].entryPrice).toBe(95);
    expect(Number.isNaN(new Date(breaks[0].timestamp).getTime())).toBe(false);
  });

  test("flat market (no breakout) → empty result, no throw", () => {
    const candles = flatCandles(20, 100);
    const prevDay = { high: 101, low: 99, close: 100 };
    expect(detectPriceActionBreakouts(candles, prevDay).length).toBe(0);
  });

  test("too few candles → empty result (no crash)", () => {
    const candles = flatCandles(5, 100);
    expect(detectPriceActionBreakouts(candles, { high: 101, low: 99, close: 100 }).length).toBe(0);
  });
});
