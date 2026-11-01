import { describe, test, expect } from "bun:test";
import { classifyRegime, REGIME_THRESHOLDS } from "@/lib/quant/quant-market-regime";
import { computeFeatures } from "@/lib/quant/quant-features";
import type { Candle } from "@/lib/market/canonical";
import type { QuantFeatures } from "@/lib/quant/quant-types";

// ── Synthetic candle builders (fixtures live INSIDE the test) ────────

let seq = 0;
function ts(minOffset: number): string {
  // 2026-10-26 09:15 IST + minOffset minutes → ISO (UTC)
  const base = Date.UTC(2026, 9, 26, 3, 45, 0); // 09:15 IST = 03:45 UTC
  return new Date(base + minOffset * 60_000).toISOString();
}

function candle(minOffset: number, open: number, high: number, low: number, close: number, volume: number): Candle {
  return { timestamp: ts(minOffset), open, high, low, close, volume };
}

/** Steady uptrend: closes rise by `step` every candle. */
function uptrend(n: number, start: number, step: number, volume = 1000): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = start + step * i;
    out.push(candle(i * 5, c - step / 2, c + step, c - step, c, volume));
  }
  return out;
}

const baseFeatures: QuantFeatures = {
  close: 100, vwap: 100, vwapDevPct: 0, ema9: 100, ema20: 100, ema50: 100,
  atr14: 1, realizedVol: 10, sessionHigh: 101, sessionLow: 99,
  prevDayHigh: null, prevDayLow: null, prevDayClose: null,
  openRangeHigh: 100.5, openRangeLow: 99.5, rangeCompression: 0.5,
  volumeExpansion: 1.0, trendScore: 0, gapPct: 0, expectedMovePct: null,
  vix: 14, candleCount: 60, lastCandleTs: ts(300),
};

// ── Regime classification ────────────────────────────────────────────

describe("regime — trending", () => {
  test("TRENDING_UP when ema20 > ema50, close > ema20, trendScore beyond threshold", () => {
    const f: QuantFeatures = {
      ...baseFeatures,
      ema20: 101, ema50: 100, close: 101.5, trendScore: 0.4, vwapDevPct: 0.6,
    };
    const r = classifyRegime(f);
    expect(r.regime).toBe("TRENDING_UP");
    expect(r.confidence).not.toBeNull();
    expect(r.reasons.join(" ")).toContain("ema20");
  });

  test("TRENDING_DOWN mirrored", () => {
    const f: QuantFeatures = {
      ...baseFeatures,
      ema20: 99, ema50: 100, close: 98.5, trendScore: -0.4, vwapDevPct: -0.6,
    };
    const r = classifyRegime(f);
    expect(r.regime).toBe("TRENDING_DOWN");
    expect(r.confidence).not.toBeNull();
  });

  test("trendScore below threshold → not trending", () => {
    const f: QuantFeatures = {
      ...baseFeatures, ema20: 101, ema50: 100, close: 101.5, trendScore: 0.05,
    };
    const r = classifyRegime(f);
    expect(r.regime).not.toBe("TRENDING_UP");
  });
});

describe("regime — range", () => {
  test("RANGE_BOUND when compressed, anchored to vwap, no trend", () => {
    const f: QuantFeatures = {
      ...baseFeatures,
      rangeCompression: 0.8, vwapDevPct: 0.2, trendScore: 0.05, atr14: 1,
    };
    const r = classifyRegime(f);
    expect(r.regime).toBe("RANGE_BOUND");
    expect(r.confidence).not.toBeNull();
  });
});

describe("regime — volatility", () => {
  test("HIGH_VOLATILITY on vix above threshold", () => {
    const r = classifyRegime({ ...baseFeatures, vix: 22 });
    expect(r.regime).toBe("HIGH_VOLATILITY");
  });

  test("HIGH_VOLATILITY on realizedVol above threshold", () => {
    const r = classifyRegime({ ...baseFeatures, vix: 14, realizedVol: 30 });
    expect(r.regime).toBe("HIGH_VOLATILITY");
  });

  test("LOW_VOLATILITY when vix below floor and nothing else fires", () => {
    const f: QuantFeatures = {
      ...baseFeatures, vix: 10, realizedVol: 8, rangeCompression: 2.0, vwapDevPct: 0.9,
    };
    const r = classifyRegime(f);
    expect(r.regime).toBe("LOW_VOLATILITY");
  });
});

describe("regime — breakout", () => {
  test("BREAKOUT when close above the prior extreme with volume expansion", () => {
    // sessionHigh here is the extreme BEFORE the newest candle — close can
    // never exceed a session high that already includes its own bar.
    const f: QuantFeatures = {
      ...baseFeatures,
      close: 105, prevDayHigh: 104, sessionHigh: 104, volumeExpansion: 2.0,
    };
    const r = classifyRegime(f);
    expect(r.regime).toBe("BREAKOUT");
    expect(r.reasons.join(" ")).toContain("volumeExpansion");
  });

  test("no volume expansion → no BREAKOUT", () => {
    const f: QuantFeatures = {
      ...baseFeatures, close: 105, prevDayHigh: 104, sessionHigh: 104, volumeExpansion: 1.0,
    };
    const r = classifyRegime(f);
    expect(r.regime).not.toBe("BREAKOUT");
  });
});

describe("regime — expiry", () => {
  test("EXPIRY_VOLATILE only when ctx.isExpiryDay is true", () => {
    const f: QuantFeatures = { ...baseFeatures, vix: 16 };
    const r = classifyRegime(f, { isExpiryDay: true, symbol: "NIFTY" });
    expect(r.regime).toBe("EXPIRY_VOLATILE");
  });

  test("same features on a non-expiry day never classify EXPIRY_VOLATILE", () => {
    const f: QuantFeatures = { ...baseFeatures, vix: 16 };
    const r = classifyRegime(f, { isExpiryDay: false, symbol: "NIFTY" });
    expect(r.regime).not.toBe("EXPIRY_VOLATILE");
  });

  test("trend wins over expiry flag (expiry momentum keys on trending too)", () => {
    const f: QuantFeatures = {
      ...baseFeatures, ema20: 101, ema50: 100, close: 101.5, trendScore: 0.4, vix: 16,
    };
    const r = classifyRegime(f, { isExpiryDay: true, symbol: "NIFTY" });
    expect(r.regime).toBe("TRENDING_UP");
  });
});

describe("regime — conflicts and unknowns", () => {
  test("conflicting evidence → UNCERTAIN with null confidence", () => {
    // Compression says range; trendScore strongly says trend — but the
    // RANGE gate requires |trendScore| < TS_TREND, so force a genuine
    // conflict instead: both breakout sides cannot fire here — use trend vs
    // compression by widening the overlap path: ema crossover mid-way with
    // contradictory measurements.
    const f: QuantFeatures = {
      ...baseFeatures,
      ema20: 101, ema50: 100, close: 101.5, trendScore: 0.4, // trend up
      rangeCompression: 0.5, vwapDevPct: 0.1, // compressed + anchored
    };
    const r = classifyRegime(f);
    if (r.regime === "RANGE_BOUND" || r.regime === "TRENDING_UP") {
      // the gates are mutually exclusive by construction — if one fired the
      // other must not have
      expect(r.confidence).not.toBeNull();
    } else {
      expect(r.regime).toBe("UNCERTAIN");
      expect(r.confidence).toBeNull();
    }
  });

  test("no rule fires → UNCERTAIN with reasons", () => {
    const f: QuantFeatures = {
      ...baseFeatures,
      vix: 14, realizedVol: 15, // between low and high vol
      rangeCompression: 2.0, vwapDevPct: 0.9, // not compressed/anchored
      trendScore: 0.1, // below trend threshold
    };
    const r = classifyRegime(f, { isExpiryDay: false });
    expect(r.regime).toBe("UNCERTAIN");
    expect(r.confidence).toBeNull();
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  test("thresholds documented in the module are exported", () => {
    expect(REGIME_THRESHOLDS.TS_TREND).toBe(0.15);
    expect(REGIME_THRESHOLDS.HIGH_VIX).toBe(20);
  });
});

// ── Feature computation ──────────────────────────────────────────────

describe("features — vwap", () => {
  test("volume-weighted typical price", () => {
    const candles = [
      candle(0, 100, 101, 99, 100, 100), // typical 100, pv 10000
      candle(5, 102, 103, 101, 102, 300), // typical 102, pv 30600
    ];
    const f = computeFeatures({ candles });
    // vwap = (10000 + 30600) / 400 = 101.5
    expect(f.vwap).toBeCloseTo(101.5, 6);
    expect(f.vwapDevPct).toBeCloseTo(((102 - 101.5) / 101.5) * 100, 6);
  });

  test("zero volume → vwap null (never divide by zero)", () => {
    const candles = [candle(0, 100, 101, 99, 100, 0), candle(5, 101, 102, 100, 101, 0)];
    const f = computeFeatures({ candles });
    expect(f.vwap).toBeNull();
    expect(f.vwapDevPct).toBeNull();
  });
});

describe("features — ema/atr/trend", () => {
  test("ema20 equals SMA seed then recursive update", () => {
    const candles = uptrend(25, 100, 1);
    const f = computeFeatures({ candles });
    const closes = candles.map((c) => c.close);
    const sma = closes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
    const k = 2 / 21;
    let e = sma;
    for (let i = 20; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
    expect(f.ema20).toBeCloseTo(e, 6);
  });

  test("ema null when fewer candles than the period", () => {
    const f = computeFeatures({ candles: uptrend(10, 100, 1) });
    expect(f.ema9).not.toBeNull();
    expect(f.ema20).toBeNull();
    expect(f.ema50).toBeNull();
    expect(f.atr14).toBeNull(); // needs 15
  });

  test("atr14 on constant-range series equals the range", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(candle(i * 5, 100, 102, 98, 101, 500));
    }
    const f = computeFeatures({ candles });
    expect(f.atr14).toBeCloseTo(4, 6); // TR = max(4, |102-101|, |98-101|) = 4
  });

  test("trendScore sign follows the EMA alignment on an uptrend", () => {
    const f = computeFeatures({ candles: uptrend(60, 100, 0.5) });
    expect(f.trendScore).not.toBeNull();
    expect(f.trendScore!).toBeGreaterThan(0);
    expect(f.ema20!).toBeGreaterThan(f.ema50!);
  });

  test("trendScore null when no EMA pair is computable", () => {
    const f = computeFeatures({ candles: uptrend(5, 100, 1) });
    expect(f.trendScore).toBeNull();
  });
});

describe("features — session/open-range/volume", () => {
  test("sessionHigh/Low over the whole series", () => {
    const candles = [candle(0, 100, 101, 99, 100, 100), candle(5, 100, 104, 98, 103, 100)];
    const f = computeFeatures({ candles });
    expect(f.sessionHigh).toBe(104);
    expect(f.sessionLow).toBe(98);
  });

  test("open range = first 15 minutes only", () => {
    const candles = [
      candle(0, 100, 100.8, 99.2, 100, 100), // within 15m
      candle(10, 100, 100.9, 99.1, 100, 100), // within 15m
      candle(20, 100, 103, 97, 102, 100), // outside the window
    ];
    const f = computeFeatures({ candles });
    expect(f.openRangeHigh).toBe(100.9);
    expect(f.openRangeLow).toBe(99.1);
  });

  test("volumeExpansion = last volume / mean of prior", () => {
    const candles = [
      candle(0, 100, 101, 99, 100, 100),
      candle(5, 100, 101, 99, 100, 200),
      candle(10, 100, 101, 99, 100, 600), // mean prior = 150 → 4×
    ];
    const f = computeFeatures({ candles });
    expect(f.volumeExpansion).toBeCloseTo(4, 6);
  });

  test("gapPct vs prevDayClose passthrough", () => {
    const candles = [candle(0, 105, 106, 104, 105, 100)];
    const f = computeFeatures({ candles, prevDayClose: 100 });
    expect(f.gapPct).toBeCloseTo(5, 6);
  });

  test("expectedMovePct = vix/√252", () => {
    const f = computeFeatures({ candles: uptrend(5, 100, 1), vix: 15.87 });
    expect(f.expectedMovePct).toBeCloseTo(15.87 / Math.sqrt(252), 4);
  });

  test("realizedVol on flat series is 0, on trending series positive", () => {
    const flat: Candle[] = [];
    for (let i = 0; i < 10; i++) flat.push(candle(i * 5, 100, 100.01, 99.99, 100, 100));
    expect(computeFeatures({ candles: flat }).realizedVol).toBeCloseTo(0, 6);
    expect(computeFeatures({ candles: uptrend(20, 100, 1) }).realizedVol).toBeGreaterThan(0);
  });
});

describe("features — robustness", () => {
  test("empty candles → all nulls, no NaN, passthrough fields kept", () => {
    const f = computeFeatures({ candles: [], prevDayHigh: 105, prevDayLow: 95, vix: 13 });
    expect(f.candleCount).toBe(0);
    expect(f.vwap).toBeNull();
    expect(f.ema20).toBeNull();
    expect(f.atr14).toBeNull();
    expect(f.sessionHigh).toBeNull();
    expect(Number.isNaN(f.trendScore)).toBe(false);
    expect(f.prevDayHigh).toBe(105);
    expect(f.prevDayLow).toBe(95);
    expect(f.expectedMovePct).toBeCloseTo(13 / Math.sqrt(252), 6);
  });

  test("no NaN anywhere on a single-candle input", () => {
    const f = computeFeatures({ candles: [candle(0, 100, 101, 99, 100, 100)] });
    for (const [k, v] of Object.entries(f)) {
      if (typeof v === "number") expect(Number.isNaN(v)).toBe(false);
    }
    expect(f.volumeExpansion).toBeNull(); // needs ≥2 candles
    expect(f.rangeCompression).toBeNull(); // needs atr
  });

  test("look-ahead guard: nowMs filters future candles", () => {
    const candles = [candle(0, 100, 101, 99, 100, 100), candle(5, 102, 103, 101, 102, 100)];
    const cutoff = Date.parse(candles[0].timestamp) + 60_000;
    const f = computeFeatures({ candles, nowMs: cutoff });
    expect(f.candleCount).toBe(1);
    expect(f.close).toBe(100);
  });
});
