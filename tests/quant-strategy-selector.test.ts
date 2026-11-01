import { describe, test, expect } from "bun:test";
import { evaluateStrategies, STRATEGY_THRESHOLDS } from "@/lib/quant/quant-strategy-selector";
import { selectWinner, QUANT_MIN_SIGNAL_SCORE } from "@/lib/quant/quant-signal-engine";
import type { QuantFeatures, QuantRegimeResult } from "@/lib/quant/quant-types";
import type { Regime } from "@/lib/quant/quant-config";

const baseFeatures: QuantFeatures = {
  close: 100, vwap: 100, vwapDevPct: 0, ema9: 100, ema20: 100, ema50: 100,
  atr14: 1, realizedVol: 10, sessionHigh: 101, sessionLow: 99,
  prevDayHigh: 104, prevDayLow: 96, prevDayClose: 100,
  openRangeHigh: 100.5, openRangeLow: 99.5, rangeCompression: 0.5,
  volumeExpansion: 1.0, trendScore: 0.2, gapPct: 0, expectedMovePct: 0.8,
  vix: 14, candleCount: 60, lastCandleTs: "2026-10-26T05:00:00.000+05:30",
};

function regimeOf(regime: Regime, confidence: number | null = 70): QuantRegimeResult {
  return { regime, confidence, measurements: {}, reasons: [regime] };
}

const ctxNonExpiry = { isExpiryDay: false, symbol: "NIFTY" };
const ctxExpiry = { isExpiryDay: true, symbol: "NIFTY" };

// ── TREND_CONTINUATION ───────────────────────────────────────────────

describe("TREND_CONTINUATION", () => {
  test("eligible on TRENDING_UP with confirming trendScore + volume → BUY_CE", () => {
    const f: QuantFeatures = { ...baseFeatures, trendScore: 0.5, volumeExpansion: 1.4 };
    const [s] = evaluateStrategies(f, regimeOf("TRENDING_UP"), ctxNonExpiry);
    expect(s.strategy).toBe("TREND_CONTINUATION");
    expect(s.direction).toBe("BUY_CE");
    expect(s.eligible).toBe(true);
    expect(s.score).toBeGreaterThanOrEqual(QUANT_MIN_SIGNAL_SCORE);
    expect(s.evidence.join(" ")).toContain("TRENDING_UP");
  });

  test("eligible on TRENDING_DOWN → BUY_PE", () => {
    const f: QuantFeatures = { ...baseFeatures, trendScore: -0.5, volumeExpansion: 1.4 };
    const [s] = evaluateStrategies(f, regimeOf("TRENDING_DOWN"), ctxNonExpiry);
    expect(s.eligible).toBe(true);
    expect(s.direction).toBe("BUY_PE");
  });

  test("ineligible when volume contracting", () => {
    const f: QuantFeatures = { ...baseFeatures, trendScore: 0.5, volumeExpansion: 0.5 };
    const [s] = evaluateStrategies(f, regimeOf("TRENDING_UP"), ctxNonExpiry);
    expect(s.eligible).toBe(false);
    expect(s.rejectionReasons.join(" ")).toContain("contracting");
    expect(s.score).toBeNull();
  });

  test("ineligible when regime is not trending", () => {
    const [s] = evaluateStrategies(baseFeatures, regimeOf("RANGE_BOUND"), ctxNonExpiry);
    expect(s.eligible).toBe(false);
    expect(s.rejectionReasons.join(" ")).toContain("not trending");
  });
});

// ── BREAKOUT_RETEST ──────────────────────────────────────────────────

describe("BREAKOUT_RETEST", () => {
  test("eligible on prevDayHigh breakout with expansion + close near level", () => {
    const f: QuantFeatures = {
      ...baseFeatures,
      close: 104.3, prevDayHigh: 104, volumeExpansion: 2.0, atr14: 1, // dist 0.3 ≤ 0.5×ATR
    };
    const [, s] = evaluateStrategies(f, regimeOf("BREAKOUT"), ctxNonExpiry);
    expect(s.strategy).toBe("BREAKOUT_RETEST");
    expect(s.eligible).toBe(true);
    expect(s.direction).toBe("BUY_CE");
    expect(s.score).toBeGreaterThan(QUANT_MIN_SIGNAL_SCORE);
    expect(s.evidence.join(" ")).toContain("104");
  });

  test("eligible on sessionLow breakdown → BUY_PE", () => {
    const f: QuantFeatures = {
      ...baseFeatures,
      close: 98.8, prevDayLow: 96, sessionLow: 99, volumeExpansion: 1.8, atr14: 1,
    };
    const [, s] = evaluateStrategies(f, regimeOf("BREAKOUT"), ctxNonExpiry);
    expect(s.eligible).toBe(true);
    expect(s.direction).toBe("BUY_PE");
  });

  test("ineligible without volume expansion", () => {
    const f: QuantFeatures = {
      ...baseFeatures, close: 104.3, prevDayHigh: 104, volumeExpansion: 1.1,
    };
    const [, s] = evaluateStrategies(f, regimeOf("BREAKOUT"), ctxNonExpiry);
    expect(s.eligible).toBe(false);
    expect(s.rejectionReasons.join(" ")).toContain("volumeExpansion");
  });

  test("ineligible when close extended far beyond the level (no retest zone)", () => {
    const f: QuantFeatures = {
      ...baseFeatures, close: 107, prevDayHigh: 104, volumeExpansion: 2.0, atr14: 1,
    };
    const [, s] = evaluateStrategies(f, regimeOf("BREAKOUT"), ctxNonExpiry);
    expect(s.eligible).toBe(false);
    expect(s.rejectionReasons.join(" ")).toContain("retest");
  });
});

// ── MEAN_REVERSION ───────────────────────────────────────────────────

describe("MEAN_REVERSION", () => {
  test("eligible in RANGE_BOUND with stretch above vwap → BUY_PE", () => {
    const f: QuantFeatures = { ...baseFeatures, vwapDevPct: 1.2, trendScore: 0.05 };
    const [, , s] = evaluateStrategies(f, regimeOf("RANGE_BOUND"), ctxNonExpiry);
    expect(s.strategy).toBe("MEAN_REVERSION");
    expect(s.eligible).toBe(true);
    expect(s.direction).toBe("BUY_PE");
  });

  test("eligible in LOW_VOLATILITY stretched below vwap → BUY_CE", () => {
    const f: QuantFeatures = { ...baseFeatures, vwapDevPct: -1.0, trendScore: 0.0 };
    const [, , s] = evaluateStrategies(f, regimeOf("LOW_VOLATILITY"), ctxNonExpiry);
    expect(s.eligible).toBe(true);
    expect(s.direction).toBe("BUY_CE");
  });

  test("ineligible when not stretched", () => {
    const f: QuantFeatures = { ...baseFeatures, vwapDevPct: 0.3, trendScore: 0.0 };
    const [, , s] = evaluateStrategies(f, regimeOf("RANGE_BOUND"), ctxNonExpiry);
    expect(s.eligible).toBe(false);
    expect(s.rejectionReasons.join(" ")).toContain("stretched");
  });

  test("ineligible on trending regime even when stretched", () => {
    const f: QuantFeatures = { ...baseFeatures, vwapDevPct: 1.2, trendScore: 0.05 };
    const [, , s] = evaluateStrategies(f, regimeOf("TRENDING_UP"), ctxNonExpiry);
    expect(s.eligible).toBe(false);
  });

  test("ineligible when strong trend opposes the reversion", () => {
    const f: QuantFeatures = { ...baseFeatures, vwapDevPct: 1.2, trendScore: 0.8 };
    const [, , s] = evaluateStrategies(f, regimeOf("RANGE_BOUND"), ctxNonExpiry);
    expect(s.eligible).toBe(false);
    expect(s.rejectionReasons.join(" ")).toContain("against");
  });
});

// ── EXPIRY_MOMENTUM ──────────────────────────────────────────────────

describe("EXPIRY_MOMENTUM", () => {
  test("eligible ONLY on expiry day with trending/expiry regime → BUY_CE, notes theta", () => {
    const f: QuantFeatures = { ...baseFeatures, trendScore: 0.5 };
    const [, , , s] = evaluateStrategies(f, regimeOf("TRENDING_UP"), ctxExpiry);
    expect(s.strategy).toBe("EXPIRY_MOMENTUM");
    expect(s.eligible).toBe(true);
    expect(s.direction).toBe("BUY_CE");
    expect(s.evidence.join(" ")).toContain("time-decay");
  });

  test("BLOCKED on a non-expiry day even with a trending regime", () => {
    const f: QuantFeatures = { ...baseFeatures, trendScore: 0.5 };
    const [, , , s] = evaluateStrategies(f, regimeOf("TRENDING_UP"), ctxNonExpiry);
    expect(s.eligible).toBe(false);
    expect(s.rejectionReasons.join(" ")).toContain("not an expiry day");
    expect(s.score).toBeNull();
  });

  test("eligible on EXPIRY_VOLATILE via trendScore direction", () => {
    const f: QuantFeatures = { ...baseFeatures, trendScore: -0.4 };
    const [, , , s] = evaluateStrategies(f, regimeOf("EXPIRY_VOLATILE"), ctxExpiry);
    expect(s.eligible).toBe(true);
    expect(s.direction).toBe("BUY_PE");
  });

  test("ineligible on RANGE_BOUND even on expiry day", () => {
    const [, , , s] = evaluateStrategies(baseFeatures, regimeOf("RANGE_BOUND"), ctxExpiry);
    expect(s.eligible).toBe(false);
    expect(s.rejectionReasons.join(" ")).toContain("not momentum-compatible");
  });
});

// ── Isolation: never option selling ──────────────────────────────────

describe("isolation — BUY-only directions", () => {
  test("every eligible signal across all regime/feature combos is BUY_CE/BUY_PE", () => {
    const regimes: Regime[] = [
      "TRENDING_UP", "TRENDING_DOWN", "RANGE_BOUND", "HIGH_VOLATILITY",
      "LOW_VOLATILITY", "BREAKOUT", "EXPIRY_VOLATILE", "UNCERTAIN",
    ];
    const featureSets: QuantFeatures[] = [
      baseFeatures,
      { ...baseFeatures, trendScore: -0.9, volumeExpansion: 3.0, vwapDevPct: -2.0 },
      { ...baseFeatures, trendScore: 0.9, volumeExpansion: 0.3, vwapDevPct: 2.0 },
    ];
    for (const regime of regimes) {
      for (const f of featureSets) {
        for (const ctx of [ctxNonExpiry, ctxExpiry]) {
          for (const s of evaluateStrategies(f, regimeOf(regime), ctx)) {
            expect(["BUY_CE", "BUY_PE"]).toContain(s.direction);
            expect(s.direction === "SELL" || s.direction === "SELL_CE" || s.direction === "SELL_PE").toBe(false);
          }
        }
      }
    }
  });
});

// ── Winner selection ─────────────────────────────────────────────────

describe("selectWinner", () => {
  test("highest eligible score wins", () => {
    const signals = evaluateStrategies(
      { ...baseFeatures, trendScore: 0.5, volumeExpansion: 1.4 },
      regimeOf("TRENDING_UP"),
      ctxNonExpiry,
    );
    const { winner, conflict } = selectWinner(signals, regimeOf("TRENDING_UP"), baseFeatures);
    expect(conflict).toBeNull();
    expect(winner).not.toBeNull();
    expect(winner!.strategy).toBe("TREND_CONTINUATION");
  });

  test("score below the floor → no winner", () => {
    const signals = evaluateStrategies(baseFeatures, regimeOf("TRENDING_UP"), ctxNonExpiry);
    const weak = signals.map((s) => ({ ...s, eligible: true, score: s.eligible ? 10 : s.score }));
    const { winner } = selectWinner(weak, regimeOf("TRENDING_UP"), baseFeatures);
    expect(winner).toBeNull();
  });

  test("two eligible signals disagreeing on direction → conflict, no winner", () => {
    const signals = evaluateStrategies(
      { ...baseFeatures, vwapDevPct: 1.2, trendScore: 0.05 },
      regimeOf("RANGE_BOUND"),
      ctxNonExpiry,
    );
    // MEAN_REVERSION says BUY_PE; force a second eligible BUY_CE signal.
    const mixed = [
      ...signals,
      { strategy: "EXPIRY_MOMENTUM" as const, direction: "BUY_CE" as const, eligible: true, score: 80, evidence: ["forced"], rejectionReasons: [] },
    ];
    const { winner, conflict } = selectWinner(mixed, regimeOf("RANGE_BOUND"), baseFeatures);
    expect(winner).toBeNull();
    expect(conflict).toContain("disagree");
  });

  test("the floor constant is 55", () => {
    expect(QUANT_MIN_SIGNAL_SCORE).toBe(55);
    expect(STRATEGY_THRESHOLDS.VOL_EXP_BREAKOUT).toBe(1.5);
  });
});
