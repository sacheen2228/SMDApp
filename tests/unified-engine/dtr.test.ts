import { describe, test, expect } from "bun:test";
import {
  calculateDTR,
  calculateSessionDTR,
  type DtrResult,
} from "../../src/lib/unified-engine/dtr";

// ────────────────────────────────────────────────────────────────────────────
// Test helpers — build synthetic candles (no network, offline only)
// ────────────────────────────────────────────────────────────────────────────

function candle(time: number, open: number, high: number, low: number, close: number, volume: number) {
  return { time, open, high, low, close, volume };
}

function todayCandles(opensHigh: number, closesLow: number, n = 60) {
  // 60 intraday candles spanning the day's range
  const candles: ReturnType<typeof candle>[] = [];
  const start = opensHigh;
  const end = closesLow;
  const step = (end - start) / (n - 1);
  for (let i = 0; i < n; i++) {
    const o = start + step * i;
    const c = start + step * (i + 1);
    const h = Math.max(o, c) + 5;
    const l = Math.min(o, c) - 5;
    candles.push(candle(Date.now() - (n - i) * 300_000, o, h, l, c, 1000));
  }
  return candles;
}

function historicalCandles(sessions: number, baseDtr: number, nPerSession = 60) {
  const candles: ReturnType<typeof candle>[] = [];
  let dayStart = 20000;
  for (let s = 0; s < sessions; s++) {
    for (let i = 0; i < nPerSession; i++) {
      const o = dayStart + (i / nPerSession) * baseDtr;
      const c = dayStart + ((i + 1) / nPerSession) * baseDtr;
      const h = Math.max(o, c) + baseDtr * 0.1;
      const l = Math.min(o, c) - baseDtr * 0.1;
      candles.push(candle(Date.now() - (sessions - s) * 86_400_000 - (nPerSession - i) * 300_000, o, h, l, c, 1000));
    }
    dayStart += baseDtr * 0.5; // drift up each session
  }
  return candles;
}

// ────────────────────────────────────────────────────────────────────────────
// DTR calculation
// ────────────────────────────────────────────────────────────────────────────

describe("DTR — basic calculation", () => {
  test("computes DTR = high − low", () => {
    const todays = todayCandles(20000, 20100);
    const hist = historicalCandles(20, 100);
    const r = calculateDTR(todays, hist, 20050);
    expect(r.sufficientData).toBe(true);
    expect(r.dtr).toBeGreaterThan(0);
    expect(r.insufficientReason).toBeNull();
  });

  test("DTR utilization is 0–1", () => {
    // Controlled candles: low = 20000, high = 20100, close at low
    const todays = [
      candle(Date.now() - 120_000, 20010, 20100, 20000, 20005, 1000),
      candle(Date.now() - 60_000, 20005, 20090, 19998, 20080, 1000),
      candle(Date.now(), 20080, 20100, 20070, 20000, 1000),
    ];
    const hist = historicalCandles(20, 100);
    const r = calculateDTR(todays, hist, 20000); // at low → utilization ≈ 0
    expect(r.dtrUtilization).toBeLessThan(0.05);
    const r2 = calculateDTR(todays, hist, 20100); // at high → utilization ≈ 1
    expect(r2.dtrUtilization).toBeGreaterThan(0.95);
  });

  test("DTR utilization null when DTR is 0", () => {
    const flat = [candle(Date.now(), 100, 100, 100, 100, 1000)];
    const hist = historicalCandles(20, 100);
    const r = calculateDTR(flat, hist, 100);
    expect(r.dtr).toBeNull();
    expect(r.dtrUtilization).toBeNull();
    expect(r.sufficientData).toBe(false);
  });

  test("insufficient today candles → insufficientData false", () => {
    const r = calculateDTR([], historicalCandles(20, 100));
    expect(r.sufficientData).toBe(false);
    expect(r.insufficientReason).toBe("no today candles");
  });
});

describe("DTR — historical comparison", () => {
  test("today's DTR vs average historical DTR", () => {
    const todays = todayCandles(20000, 20200); // DTR = 200
    const hist = historicalCandles(20, 100);    // avg DTR ≈ 100
    const r = calculateDTR(todays, hist, 20100);
    expect(r.avgHistoricalDtr).toBeGreaterThan(0);
    expect(r.dtrVsAverage).toBeGreaterThan(1); // expanded
    expect(r.rangeRegime).toBe("EXPANDED");
  });

  test("compressed range regime", () => {
    const todays = todayCandles(20000, 20030); // DTR = 30
    const hist = historicalCandles(20, 100);    // avg DTR ≈ 100
    const r = calculateDTR(todays, hist, 20015);
    expect(r.dtrVsAverage).toBeLessThan(0.7);
    expect(r.rangeRegime).toBe("COMPRESSED");
  });

  test("normal range regime", () => {
    const todays = todayCandles(20000, 20100); // DTR = 100
    const hist = historicalCandles(20, 100);    // avg DTR ≈ 100
    const r = calculateDTR(todays, hist, 20050);
    expect(r.dtrVsAverage).toBeGreaterThanOrEqual(0.7);
    expect(r.dtrVsAverage).toBeLessThanOrEqual(1.4);
    expect(r.rangeRegime).toBe("NORMAL");
  });
});

describe("DTR — opening gap", () => {
  test("opening gap calculation", () => {
    const todays = todayCandles(20050, 20100); // open at 20050
    const hist = historicalCandles(20, 100);    // last close ≈ 20000 + drift
    const r = calculateDTR(todays, hist, 20075);
    expect(r.openingGap).not.toBeNull();
    expect(r.openingGapPct).not.toBeNull();
  });
});

describe("DTR — ATR regime", () => {
  test("ATR regime classification", () => {
    const todays = todayCandles(20000, 20100);
    const hist = historicalCandles(20, 100);
    const r = calculateDTR(todays, hist, 20050);
    expect(["low", "normal", "high", "extreme", null]).toContain(r.atrRegime);
  });
});

describe("DTR — remaining range", () => {
  test("remaining range when price near low", () => {
    const todays = todayCandles(20000, 20100);
    const hist = historicalCandles(20, 100);
    const r = calculateDTR(todays, hist, 20010); // near low
    expect(r.remainingRange).toBeGreaterThan(0);
    expect(r.remainingRangePct).toBeGreaterThan(50);
  });

  test("remaining range when price near high", () => {
    const todays = todayCandles(20000, 20100);
    const hist = historicalCandles(20, 100);
    const r = calculateDTR(todays, hist, 20095); // near high
    expect(r.remainingRange).toBeGreaterThanOrEqual(0);
    expect(r.remainingRangePct).toBeLessThan(50);
  });
});

describe("DTR — session-only convenience", () => {
  test("calculateSessionDTR works without history", () => {
    const todays = [
      candle(Date.now() - 120_000, 20010, 20100, 20000, 20005, 1000),
      candle(Date.now() - 60_000, 20005, 20090, 19998, 20080, 1000),
      candle(Date.now(), 20080, 20100, 20070, 20050, 1000),
    ];
    const r = calculateSessionDTR(todays, 20050); // midpoint → utilization ≈ 0.5
    expect(r.dtr).toBeGreaterThan(0);
    expect(r.dtrUtilization).toBeGreaterThan(0.4);
    expect(r.dtrUtilization).toBeLessThan(0.6);
  });

  test("calculateSessionDTR empty candles", () => {
    const r = calculateSessionDTR([]);
    expect(r.dtr).toBeNull();
    expect(r.dtrUtilization).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Data sufficiency — missing/stale never interpreted as valid
// ────────────────────────────────────────────────────────────────────────────

describe("DTR — data quality", () => {
  test("insufficient historical candles → not sufficient", () => {
    const todays = todayCandles(20000, 20100);
    const r = calculateDTR(todays, [candle(Date.now(), 100, 110, 90, 100, 1000)]);
    expect(r.sufficientData).toBe(false);
  });

  test("non-finite price falls back to last close (still computable)", () => {
    const todays = todayCandles(20000, 20100);
    const hist = historicalCandles(20, 100);
    const r = calculateDTR(todays, hist, NaN);
    expect(r.sufficientData).toBe(true); // NaN falls back to last close
    expect(r.dtr).toBeGreaterThan(0);
  });

  test("insufficient candles → not sufficient regardless of price", () => {
    const r = calculateDTR([candle(Date.now(), 100, 110, 90, 100, 1000)], [], 100);
    expect(r.sufficientData).toBe(false);
  });
});
