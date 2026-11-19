import { describe, it, expect } from "bun:test";
import {
  analyzeEmaStructure,
  classifyAlignment,
  type EmaCandle,
  type EmaSetupType,
} from "@/lib/ema-structure";

const T0 = Date.UTC(2026, 0, 5, 9, 15, 0);
const BAR_MS = 5 * 60_000;

interface Bar {
  o?: number;
  h?: number;
  l?: number;
  c: number;
  v?: number;
}

function mkBars(bars: Bar[]): EmaCandle[] {
  return bars.map((b, i) => {
    const prev = bars[i - 1]?.c;
    const o = b.o ?? prev ?? b.c;
    return {
      time: T0 + i * BAR_MS,
      open: o,
      high: b.h ?? Math.max(o, b.c) + 1,
      low: b.l ?? Math.min(o, b.c) - 1,
      close: b.c,
      volume: b.v ?? 1000,
    };
  });
}

/** Steady ramp: close[i] = start + step*i */
function ramp(n: number, start: number, step: number, vol = 1000): EmaCandle[] {
  return mkBars(
    Array.from({ length: n }, (_, i) => ({
      c: start + step * i,
      v: vol,
    })),
  );
}

/** Oscillating closes around a level — forces repeated EMA9/21 crosses. */
function chopBars(n: number, base = 100, amp = 2, period = 5): EmaCandle[] {
  return mkBars(
    Array.from({ length: n }, (_, i) => {
      const phase = (i % period) / period;
      const c = base + Math.sin(phase * Math.PI * 2) * amp;
      return { c: Math.round(c * 100) / 100, v: 1000 };
    }),
  );
}

describe("classifyAlignment", () => {
  it("classifies a full bullish stack", () => {
    expect(classifyAlignment(110, 105, 100)).toBe("BULLISH");
  });

  it("classifies a full bearish stack", () => {
    expect(classifyAlignment(90, 95, 100)).toBe("BEARISH");
  });

  it("classifies an incomplete stack as transitional", () => {
    // ema9 > ema21 but ema21 < ema50
    expect(classifyAlignment(110, 95, 100)).toBe("TRANSITIONAL");
    // ema9 < ema21 but ema21 > ema50
    expect(classifyAlignment(90, 105, 100)).toBe("TRANSITIONAL");
  });

  it("classifies equal EMAs as transitional", () => {
    expect(classifyAlignment(100, 100, 100)).toBe("TRANSITIONAL");
  });

  it("returns MIXED when an EMA is not finite", () => {
    expect(classifyAlignment(110, NaN, 100)).toBe("MIXED");
  });
});

describe("analyzeEmaStructure — trend read", () => {
  it("reads a rising series as bullish alignment with positive slopes", () => {
    const s = analyzeEmaStructure(ramp(80, 100, 1));
    expect(s.alignment).toBe("BULLISH");
    expect(s.direction).toBe("BULLISH");
    expect(s.ema9!).toBeGreaterThan(s.ema21!);
    expect(s.ema21!).toBeGreaterThan(s.ema50!);
    expect(s.slope9!).toBeGreaterThan(0);
    expect(s.slope21!).toBeGreaterThan(0);
    expect(s.slope50!).toBeGreaterThan(0);
    expect(s.dataQuality).not.toBe("INSUFFICIENT");
    expect(s.bars).toBe(80);
  });

  it("reads a falling series as bearish alignment with negative slopes", () => {
    const s = analyzeEmaStructure(ramp(80, 200, -1));
    expect(s.alignment).toBe("BEARISH");
    expect(s.direction).toBe("BEARISH");
    expect(s.slope21!).toBeLessThan(0);
  });

  it("flags a sideways series as chop", () => {
    const s = analyzeEmaStructure(chopBars(80));
    expect(s.chop).toBe(true);
  });

  it("reports separation between the EMAs in ATR units", () => {
    const s = analyzeEmaStructure(ramp(80, 100, 1));
    expect(s.separation9_21Atr).toBeGreaterThan(0);
    expect(s.separation21_50Atr).toBeGreaterThan(0);
  });

  it("flags compression when the three EMAs are tight", () => {
    const flat = mkBars(
      Array.from({ length: 80 }, () => ({ c: 100, v: 1000 })),
    );
    const s = analyzeEmaStructure(flat);
    expect(s.compression).toBe(true);
  });

  it("is INSUFFICIENT with too few bars for EMA50", () => {
    const s = analyzeEmaStructure(ramp(20, 100, 1));
    expect(s.dataQuality).toBe("INSUFFICIENT");
    expect(s.alignment).toBe("MIXED");
    expect(s.setups).toHaveLength(0);
  });
});

describe("analyzeEmaStructure — completed candles only", () => {
  it("drops the still-forming last candle", () => {
    const bars = ramp(80, 100, 1);
    const nowMs = bars[bars.length - 1].time + 60_000; // 1 min into the last 5m bar
    const s = analyzeEmaStructure(bars, { nowMs });
    expect(s.bars).toBe(79);
  });

  it("keeps the last candle once it has closed", () => {
    const bars = ramp(80, 100, 1);
    const nowMs = bars[bars.length - 1].time + BAR_MS + 1000;
    const s = analyzeEmaStructure(bars, { nowMs });
    expect(s.bars).toBe(80);
  });

  it("never confirms a setup on an unfinished candle", () => {
    const bars = ramp(80, 100, 1);
    // the last bar is still forming
    const nowMs = bars[bars.length - 1].time + 60_000;
    const s = analyzeEmaStructure(bars, { nowMs });
    const lastClosed = bars[bars.length - 2];
    for (const setup of s.setups) {
      if (setup.confirmationCandle) {
        expect(setup.confirmationCandle.time).not.toBe(bars[bars.length - 1].time);
        expect(setup.confirmationCandle.time).toBeLessThanOrEqual(lastClosed.time);
      }
    }
  });
});

describe("analyzeEmaStructure — setups", () => {
  const SETUP_TYPES: EmaSetupType[] = [
    "EMA9_21_PULLBACK",
    "EMA21_PULLBACK",
    "EMA50_RETEST",
    "BULLISH_BREAKOUT_RETEST",
    "BEARISH_BREAKDOWN_RETEST",
    "EMA21_50_REJECTION",
    "SR_REJECTION",
    "FAILED_BREAKOUT",
    "LIQUIDITY_SWEEP_RECLAIM",
    "GAP_FAILURE",
    "GAP_CONTINUATION",
    "TREND_REVERSAL",
  ];

  it("every setup carries the full audit payload", () => {
    // a synthetic series that produces at least one setup
    const bars = mkBars([
      ...Array.from({ length: 70 }, (_, i) => ({ c: 100 + i, v: 1000 })),
      { c: 165, h: 166, l: 164, v: 1400 },
      { c: 160, h: 165, l: 159, v: 900 },
      { c: 161, h: 162, l: 160, v: 1600 },
    ]);
    const s = analyzeEmaStructure(bars);
    expect(s.setups.length).toBeGreaterThan(0);
    for (const setup of s.setups) {
      expect(SETUP_TYPES).toContain(setup.type);
      expect(["BULLISH", "BEARISH"]).toContain(setup.direction);
      expect(Number.isFinite(setup.referenceLevel)).toBe(true);
      expect(Number.isFinite(setup.invalidation)).toBe(true);
      expect(typeof setup.followThroughRequired).toBe("string");
      expect(setup.followThroughRequired.length).toBeGreaterThan(0);
      expect(typeof setup.timestamp).toBe("number");
      expect(setup.dataQuality).toBeDefined();
      expect(setup.volumeConfirmation).toBeDefined();
      expect(typeof setup.volumeConfirmation.confirmed).toBe("boolean");
      expect(setup.emaContext.alignment).toBeDefined();
    }
  });

  it("classifies a bullish EMA21 pullback", () => {
    const bars = mkBars([
      ...Array.from({ length: 70 }, (_, i) => ({ c: 100 + i, v: 1000 })),
      { c: 165, h: 166, l: 164, v: 1400 },
      { c: 160, h: 165, l: 159, v: 900 },
      { c: 161, h: 162, l: 160, v: 1600 },
    ]);
    const s = analyzeEmaStructure(bars);
    const pullback = s.setups.find((x) => x.type === "EMA21_PULLBACK");
    expect(pullback).toBeDefined();
    expect(pullback!.direction).toBe("BULLISH");
    expect(pullback!.referenceLevel).toBeCloseTo(s.ema21!, 4);
    expect(pullback!.invalidation).toBeLessThan(pullback!.referenceLevel);
  });

  it("classifies a bearish EMA21 pullback", () => {
    const bars = mkBars([
      ...Array.from({ length: 70 }, (_, i) => ({ c: 200 - i, v: 1000 })),
      { c: 130, h: 133, l: 129, v: 1400 },
      { c: 132, h: 138, l: 131, v: 900 },
      { c: 131, h: 136, l: 130, v: 1600 },
    ]);
    const s = analyzeEmaStructure(bars);
    const pullback = s.setups.find((x) => x.type === "EMA21_PULLBACK");
    expect(pullback).toBeDefined();
    expect(pullback!.direction).toBe("BEARISH");
  });

  it("classifies a bearish failed breakout", () => {
    const bars = mkBars([
      ...Array.from({ length: 70 }, (_, i) => ({ c: 100 + i * 0.2, v: 1000 })),
      { c: 114.0, h: 114.4, l: 113.6, v: 1200 },
      { c: 114.2, h: 114.6, l: 113.8, v: 1200 },
      { o: 114.2, c: 113.6, h: 115.5, l: 113.4, v: 1800 },
    ]);
    const s = analyzeEmaStructure(bars);
    const fake = s.setups.find((x) => x.type === "FAILED_BREAKOUT");
    expect(fake).toBeDefined();
    expect(fake!.direction).toBe("BEARISH");
  });

  it("classifies a bearish gap failure", () => {
    const bars = mkBars([
      ...Array.from({ length: 70 }, (_, i) => ({ c: 100 + i * 0.2, v: 1000 })),
      { o: 116, c: 112, h: 116.5, l: 111, v: 1500 },
    ]);
    const s = analyzeEmaStructure(bars);
    const gap = s.setups.find((x) => x.type === "GAP_FAILURE");
    expect(gap).toBeDefined();
    expect(gap!.direction).toBe("BEARISH");
  });

  it("classifies a bullish gap continuation", () => {
    const bars = mkBars([
      ...Array.from({ length: 70 }, (_, i) => ({ c: 100 + i * 0.2, v: 1000 })),
      { o: 116, c: 117, h: 117.5, l: 115.5, v: 2000 },
    ]);
    const s = analyzeEmaStructure(bars);
    const gap = s.setups.find((x) => x.type === "GAP_CONTINUATION");
    expect(gap).toBeDefined();
    expect(gap!.direction).toBe("BULLISH");
  });

  it("does not emit a setup when the data is insufficient", () => {
    const s = analyzeEmaStructure(ramp(30, 100, 1));
    expect(s.setups).toHaveLength(0);
  });
});
