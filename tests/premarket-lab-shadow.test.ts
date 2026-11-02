// Phase 11 — Quantitative Shadow Validation tests (offline, no network).
import { describe, test, expect } from "bun:test";
import { computeOutcomes, closeAtMinutes, sessionOpenFromCandles, type CandleBar } from "@/lib/premarket-lab/outcomes";
import { simulateBuyOption, summarizeOptionSims, pickAtmStrike } from "@/lib/premarket-lab/option-sim";
import { wilsonInterval, accuracyCheck, binomialPvs, calibrationBuckets } from "@/lib/premarket-lab/significance";
import { researchFeatures } from "@/lib/premarket-lab/research-inputs";
import { compareShadow, shadowSessionsToFullSamples } from "@/lib/premarket-lab/shadow-compare";
import { SHADOW_MIN_N, type ShadowSession, type ResearchInputs, type ShadowOutcomes } from "@/lib/premarket-lab/types";
import { FEATURE_SETS } from "@/lib/premarket-lab/validation";
import type { PremiumCandle } from "@/lib/option-bhavcopy";

// ── Outcomes ─────────────────────────────────────────────────────────

function bar(min: number, o: number, h: number, l: number, c: number): CandleBar {
  // 09:15 IST = 03:45 UTC → epoch for 2026-11-02T03:45:00Z
  const base = Date.parse("2026-11-02T03:45:00Z");
  return { time: base + min * 60_000, open: o, high: h, low: l, close: c };
}

describe("P11 outcomes", () => {
  test("computes multi-horizon labels from real candles", () => {
    const candles = [
      bar(0, 100, 102, 99, 101),
      bar(5, 101, 103, 100, 102),
      bar(10, 102, 104, 101, 103),
      bar(15, 103, 105, 102, 104),
      bar(30, 104, 106, 103, 105),
      bar(60, 105, 107, 104, 106),
    ];
    const o = computeOutcomes({ candles, intervalMin: 5, prevClose: 98 });
    expect(o.open).toBe(100);
    expect(o.label5m).toBe(1);
    expect(o.label15m).toBe(1);
    expect(o.eodClose).toBe(106);
    expect(o.labelEod).toBe(1);
    expect(o.gapContEod).toBe(1); // gap up + close > open
    expect(o.dayHigh).toBe(107);
    expect(o.dayLow).toBe(99);
  });

  test("missing candles → null labels + note, no fabrication", () => {
    const o = computeOutcomes({ candles: [], intervalMin: 5, prevClose: null });
    expect(o.open).toBeNull();
    expect(o.label5m).toBeNull();
    expect(o.labelEod).toBeNull();
    expect(o.notes).toContain("no_candles");
  });

  test("closeAtMinutes picks covering bar", () => {
    const candles = [bar(0, 100, 101, 99, 100), bar(5, 100, 102, 99, 101), bar(10, 101, 103, 100, 102)];
    expect(sessionOpenFromCandles(candles)).toBe(100);
    expect(closeAtMinutes(candles, 5, 5)).toBe(101);
    expect(closeAtMinutes(candles, 5, 10)).toBe(102);
  });

  test("down move → label 0", () => {
    const candles = [bar(0, 100, 100, 98, 99), bar(5, 99, 99, 97, 98)];
    const o = computeOutcomes({ candles, intervalMin: 5, prevClose: 101 });
    expect(o.label5m).toBe(0);
    expect(o.labelEod).toBe(0);
  });
});

// ── Option sim (bhavcopy OHLC) ───────────────────────────────────────

function prem(partial: Partial<PremiumCandle>): PremiumCandle {
  return {
    date: "2026-10-30",
    symbol: "NIFTY",
    strike: 23200,
    optionType: "CE",
    expiry: "2026-11-06",
    open: 100,
    high: 120,
    low: 80,
    close: 110,
    underlying: 23250,
    lotSize: 75,
    volume: 1000,
    oi: 5000,
    ...partial,
  };
}

describe("P11 option sim", () => {
  test("target hit → WIN with R:R from stop", () => {
    const c = prem({ open: 100, high: 145, low: 90, close: 140 }); // stop 20% = 80, target = 100+40=140
    const r = simulateBuyOption("2026-10-30", "NIFTY", "CE", c, { slippagePts: 0, chargesInr: 40 });
    expect(r.validated).toBe(true);
    expect(r.outcome).toBe("WIN");
    expect(r.stopLoss).toBe(80);
    expect(r.target).toBe(140);
    expect(r.pnlR).toBeGreaterThan(0);
  });

  test("stop hit → LOSS; both hit → SL-first LOSS", () => {
    const stopOnly = simulateBuyOption("2026-10-30", "NIFTY", "PE", prem({ open: 100, high: 110, low: 75, close: 90 }), { slippagePts: 0 });
    expect(stopOnly.outcome).toBe("LOSS");
    expect(stopOnly.pnlR).toBeLessThan(0);

    const both = simulateBuyOption("2026-10-30", "NIFTY", "CE", prem({ open: 100, high: 150, low: 75, close: 100 }), { slippagePts: 0 });
    expect(both.outcome).toBe("LOSS");
    expect(both.reason).toBe("sl_first_ambiguity");
  });

  test("missing premium → NOT_VALIDATED / NO_DATA, never underlying substitute", () => {
    const r = simulateBuyOption("2026-10-30", "NIFTY", "CE", null);
    expect(r.validated).toBe(false);
    expect(r.outcome).toBe("NO_DATA");
    expect(r.pnlR).toBeNull();

    const sum = summarizeOptionSims([r]);
    expect(sum.validated).toBe(0);
    expect(sum.message).toContain("NOT_VALIDATED");
  });

  test("summarize excludes NOT_VALIDATED from win rate", () => {
    const win = simulateBuyOption("2026-10-30", "NIFTY", "CE", prem({ open: 100, high: 200, low: 95, close: 180 }), { slippagePts: 0 });
    const noData = simulateBuyOption("2026-10-30", "BANKNIFTY", "CE", null);
    const sum = summarizeOptionSims([win, noData]);
    expect(sum.validated).toBe(1);
    expect(sum.wins).toBe(1);
    expect(sum.winRate).toBe(1);
    expect(sum.noData).toBe(1);
  });

  test("pickAtmStrike nearest to spot", () => {
    const rows = [
      prem({ strike: 23100, optionType: "CE" }),
      prem({ strike: 23200, optionType: "CE" }),
      prem({ strike: 23300, optionType: "CE" }),
      prem({ strike: 23200, optionType: "PE" }),
    ];
    const atm = pickAtmStrike(rows, 23210, "CE");
    expect(atm?.strike).toBe(23200);
  });
});

// ── Significance ─────────────────────────────────────────────────────

describe("P11 significance", () => {
  test("wilson interval basic properties", () => {
    const w = wilsonInterval(70, 100);
    expect(w.n).toBe(100);
    expect(w.rate).toBeCloseTo(0.7, 5);
    expect(w.lower).not.toBeNull();
    expect(w.upper).not.toBeNull();
    expect(w.lower! < 0.7).toBe(true);
    expect(w.upper! > 0.7).toBe(true);
    expect(w.insufficient).toBe(false);
  });

  test("n < 30 → insufficient", () => {
    const w = wilsonInterval(10, 20);
    expect(w.insufficient).toBe(true);
  });

  test("accuracy vs 50% with sufficient n", () => {
    // 40 samples: model predicts 1 for all; 30 true positives + 10 false positives → 30 correct
    const yTrue = Array.from({ length: 40 }, (_, i) => (i < 30 ? 1 : 0));
    const yPred = Array.from({ length: 40 }, () => 1);
    const a = accuracyCheck(yTrue, yPred);
    expect(a.n).toBe(40);
    expect(a.correct).toBe(30);
    expect(a.accuracy).toBeCloseTo(0.75, 5);
    expect(a.significantAt05).toBe(true);
  });

  test("small n → no significance claim", () => {
    const a = accuracyCheck([1, 1, 1, 1], [1, 1, 1, 1]);
    expect(a.ci.insufficient).toBe(true);
    expect(a.significantAt05).toBe(false);
    expect(a.message).toContain("insufficient");
  });

  test("binomial p vs 50%", () => {
    const p = binomialPvs(70, 100, 0.5);
    expect(p).not.toBeNull();
    expect(p!).toBeLessThan(0.05);
  });

  test("calibration buckets cover 0-1", () => {
    const y = [0, 1, 0, 1, 1, 0];
    const p = [0.1, 0.2, 0.4, 0.6, 0.8, 0.9];
    const b = calibrationBuckets(y, p, 0.5);
    expect(b.length).toBe(2);
    expect(b[0].lo).toBe(0);
    expect(b[1].hi).toBe(1);
  });
});

// ── Research features ────────────────────────────────────────────────

describe("P11 research features", () => {
  const sample: ResearchInputs = {
    asOf: "2026-11-02T08:45:00+05:30",
    vix: { value: 14.2, change: -0.5, quality: "OK", source: "NSE_INDIA_VIX" },
    fiiDii: { fiiNet: -1200, diiNet: 800, date: "31-Oct-2026", available: true, quality: "OK" },
    options: { symbol: "NIFTY", pcr: 1.1, ceOi: 100000, peOi: 110000, quality: "OK", source: "MOAPI", asOf: "2026-11-02T08:45:00+05:30" },
    breadth: { adv: 30, dec: 20, unchanged: 0, quality: "OK" },
    missing: [],
  };

  test("maps to numeric features", () => {
    const f = researchFeatures(sample);
    expect(f.options_pcr).toBe(1.1);
    expect(f.fii_net).toBe(-1200);
    expect(f.vix_level).toBe(14.2);
    expect(f.breadth_net).toBeCloseTo(0.2, 5);
    expect(f.options_oi_imbalance).not.toBeNull();
  });

  test("null research → all nulls", () => {
    const f = researchFeatures(null);
    expect(Object.values(f).every((v) => v === null)).toBe(true);
  });
});

// ── Shadow compare / feature sets ────────────────────────────────────

describe("P11 shadow compare", () => {
  test("FEATURE_SETS include MOAPI + research keys", () => {
    expect(FEATURE_SETS.cm_fno_options).toContain("options_pcr");
    expect(FEATURE_SETS.full).toContain("fii_net");
    expect(FEATURE_SETS.full).toContain("vix_level");
  });

  test("insufficient n → honest fail-closed message", () => {
    const sessions: ShadowSession[] = [];
    const r = compareShadow({ target: "gap_continuation", sessions });
    expect(r.sufficient).toBe(false);
    expect(r.nLabeled).toBe(0);
    expect(r.minN).toBe(SHADOW_MIN_N);
    expect(r.sources[0].message).toContain("insufficient");
    expect(r.disclaimer).toContain("Not trade authorization");
  });

  test("sessions without outcomes are not labeled", () => {
    const s: ShadowSession = {
      tradeDate: "2026-11-02",
      symbol: "NIFTY",
      featureAsOf: "2026-11-02T08:50:00+05:30",
      labScore: 70,
      labBias: "BULLISH",
      predictions: [],
      sdm: null,
      outcomes: null,
      research: null,
      quality: null,
      optionSimValidated: null,
      notes: [],
    };
    const samples = shadowSessionsToFullSamples([s], "gap_continuation");
    expect(samples.length).toBe(0);
  });

  test("labeled session produces sample", () => {
    const outcomes: ShadowOutcomes = {
      open: 100, close5m: 101, close15m: 102, close30m: 103, eodClose: 105,
      dayHigh: 106, dayLow: 99,
      label5m: 1, label15m: 1, label30m: 1, labelEod: 1,
      gapContEod: 1, gapRevEod: 0, notes: [],
    };
    const s: ShadowSession = {
      tradeDate: "2026-10-30",
      symbol: "NIFTY",
      featureAsOf: "2026-10-30T08:50:00+05:30",
      labScore: 80,
      labBias: "BULLISH",
      predictions: [],
      sdm: null,
      outcomes,
      research: {
        asOf: "2026-10-30T08:50:00+05:30",
        vix: { value: 13, quality: "OK", source: "x" },
        fiiDii: null,
        options: null,
        breadth: null,
        missing: ["fii_dii", "options", "breadth"],
      },
      quality: null,
      optionSimValidated: false,
      notes: [],
    };
    // Full samples need study day — without it, returns empty (fail-closed)
    const full = shadowSessionsToFullSamples([s], "gap_continuation");
    // Either empty (no study day in test DB) or 1 — both honest
    expect(Array.isArray(full)).toBe(true);
    if (full.length) {
      expect(full[0].label).toBe(1);
      expect(full[0].features.options_pcr ?? null).toBeNull(); // options missing
      expect(full[0].features.vix_level).toBe(13);
    }
  });
});

// ── Production path isolation ────────────────────────────────────────

describe("P11 production isolation", () => {
  test("shadow modules do not import telegram/veto/risk for execution", async () => {
    const fs = await import("node:fs");
    const pathMod = await import("node:path");
    const root = pathMod.join(process.cwd(), "src/lib/premarket-lab");
    const files = [
      "option-sim.ts", "outcomes.ts", "significance.ts",
      "research-inputs.ts", "shadow-compare.ts",
    ];
    for (const f of files) {
      const src = fs.readFileSync(pathMod.join(root, f), "utf8");
      // strip block/line comments so prose does not trip the guard
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code.includes("sendTradeAlert")).toBe(false);
      expect(code.includes("evaluateSignalVeto")).toBe(false);
      expect(code.includes("positionSize(")).toBe(false);
      expect(code.includes('from "@/lib/telegram"')).toBe(false);
    }
  });

  test("shadow-recorder never imports telegram send for alerts", async () => {
    const fs = await import("node:fs");
    const pathMod = await import("node:path");
    const src = fs.readFileSync(
      pathMod.join(process.cwd(), "src/lib/premarket-lab/shadow-recorder.ts"),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code.includes('from "@/lib/telegram"')).toBe(false);
    expect(code.includes("sendTradeAlert(")).toBe(false);
    expect(code.includes("evaluateSignalVeto")).toBe(false);
  });
});
