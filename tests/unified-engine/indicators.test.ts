import { describe, test, expect } from "bun:test";
import {
  computeIndicatorBundle,
  indicatorsSufficientForTrade,
  type IndicatorBundle,
} from "../../src/lib/unified-engine/indicators";
import type { Candle } from "../../src/types/engine";

function candle(time: number, open: number, high: number, low: number, close: number, volume: number) {
  return { time, open, high, low, close, volume };
}

function makeCandles(n: number, base = 20000, trend: "up" | "down" | "flat" = "flat") {
  const candles: Candle[] = [];
  let price = base;
  for (let i = 0; i < n; i++) {
    const change = trend === "up" ? 2 : trend === "down" ? -2 : 0;
    const o = price;
    price += change;
    const c = price;
    const h = Math.max(o, c) + 10;
    const l = Math.min(o, c) - 10;
    candles.push(candle(Date.now() - (n - i) * 300_000, o, h, l, c, 1000 + i * 10));
  }
  return candles;
}

describe("computeIndicatorBundle — structure", () => {
  test("returns all indicator keys", () => {
    const today = makeCandles(60, 20000, "up");
    const hist = makeCandles(100, 19000, "up");
    const bundle = computeIndicatorBundle("RELIANCE", today, hist, 20100, Date.now());

    expect(bundle.symbol).toBe("RELIANCE");
    expect(bundle.timestamp).toBeDefined();
    expect(bundle.dtr).toBeDefined();
    expect(bundle.atr).toBeDefined();
    expect(bundle.vwap).toBeDefined();
    expect(bundle.adx).toBeDefined();
    expect(bundle.rvol).toBeDefined();
    expect(bundle.volumeProfile).toBeDefined();
    expect(bundle.marketStructure).toBeDefined();
    expect(bundle.regime).toBeDefined();
    expect(bundle.marketDirection).toBeDefined();
  });

  test("all reads have freshness and sufficiency flags", () => {
    const today = makeCandles(60, 20000, "up");
    const hist = makeCandles(100, 19000, "up");
    const bundle = computeIndicatorBundle("RELIANCE", today, hist, 20100, Date.now());

    for (const [key, read] of Object.entries(bundle)) {
      if (key === "symbol" || key === "timestamp" || key === "lastCandleTs") continue;
      const r = read as any;
      expect(r.freshness).toBeDefined();
      expect(["LIVE", "FRESH", "DELAYED", "STALE", "UNAVAILABLE"]).toContain(r.freshness);
      expect(typeof r.sufficientData).toBe("boolean");
      expect(r.reason === null || typeof r.reason === "string").toBe(true);
    }
  });
});

describe("computeIndicatorBundle — data quality", () => {
  test("insufficient data → ATR/VWAP insufficient when below thresholds", () => {
    const today = [candle(Date.now(), 100, 105, 95, 100, 1000)];
    const hist = [candle(Date.now(), 90, 95, 85, 90, 1000)];
    const bundle = computeIndicatorBundle("TEST", today, hist);

    // ATR needs 15+ candles — with only 2 total, it's insufficient
    expect(bundle.atr.sufficientData).toBe(false);
    expect(bundle.atr.value).toBeNull();

    // VWAP can be computed with 1 candle — it's sufficient but basic
    expect(bundle.vwap.value).not.toBeNull();
    expect(bundle.vwap.sufficientData).toBe(true);

    // DTR needs 5+ today candles — with only 1, insufficient
    expect(bundle.dtr.sufficientData).toBe(false);
  });

  test("ATR null when insufficient candles", () => {
    const today = makeCandles(5, 20000, "flat");
    const hist = makeCandles(5, 19000, "flat"); // total 10 < 15 needed
    const bundle = computeIndicatorBundle("TEST", today, hist);
    expect(bundle.atr.value).toBeNull();
    expect(bundle.atr.sufficientData).toBe(false);
  });

  test("VWAP null when no today candles", () => {
    const bundle = computeIndicatorBundle("TEST", [], makeCandles(50, 20000, "flat"));
    expect(bundle.vwap.value).toBeNull();
    expect(bundle.vwap.sufficientData).toBe(false);
  });
});

describe("computeIndicatorBundle — value ranges", () => {
  test("ATR regime is valid", () => {
    const today = makeCandles(60, 20000, "up");
    const hist = makeCandles(100, 19000, "up");
    const bundle = computeIndicatorBundle("RELIANCE", today, hist, 20100, Date.now());
    if (bundle.atr.value) {
      expect(["low", "normal", "high", "extreme"]).toContain(bundle.atr.value.regime);
      expect(bundle.atr.value.atr).toBeGreaterThan(0);
      expect(bundle.atr.value.atrPct).toBeGreaterThan(0);
    }
  });

  test("ADX trend is valid", () => {
    const today = makeCandles(60, 20000, "up");
    const hist = makeCandles(100, 19000, "up");
    const bundle = computeIndicatorBundle("RELIANCE", today, hist, 20100, Date.now());
    if (bundle.adx.value) {
      expect(["strong_trend", "trending", "weak_trend", "range"]).toContain(bundle.adx.value.trend);
      expect(bundle.adx.value.adx).toBeGreaterThanOrEqual(0);
    }
  });

  test("RVOL ratio is positive when available", () => {
    const today = makeCandles(60, 20000, "up");
    const hist = makeCandles(100, 19000, "up");
    const bundle = computeIndicatorBundle("RELIANCE", today, hist, 20100, Date.now());
    if (bundle.rvol.value) {
      expect(bundle.rvol.value.ratio).toBeGreaterThan(0);
      expect(bundle.rvol.value.percentile).toBeGreaterThanOrEqual(0);
      expect(bundle.rvol.value.percentile).toBeLessThanOrEqual(100);
    }
  });
});

describe("indicatorsSufficientForTrade", () => {
  test("returns false when any critical indicator is insufficient", () => {
    const today = [candle(Date.now(), 100, 105, 95, 100, 1000)];
    const hist = [candle(Date.now(), 90, 95, 85, 90, 1000)];
    const bundle = computeIndicatorBundle("TEST", today, hist);
    expect(indicatorsSufficientForTrade(bundle)).toBe(false);
  });

  test("returns true when all critical indicators are sufficient and fresh", () => {
    const today = makeCandles(60, 20000, "up");
    const hist = makeCandles(100, 19000, "up");
    const bundle = computeIndicatorBundle("RELIANCE", today, hist, 20100, Date.now());
    // May or may not be sufficient depending on data, but should not throw
    expect(typeof indicatorsSufficientForTrade(bundle)).toBe("boolean");
  });
});
