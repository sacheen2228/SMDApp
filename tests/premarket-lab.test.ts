// Pre-Market Data Science Lab — unit tests (offline, no network).
import { describe, test, expect } from "bun:test";
import {
  normalizeCmPayload, normalizeFuturesPayload, selectNearestFutures,
  imbalanceQty, normalizedImbalance,
} from "@/lib/premarket-lab/normalize";
import {
  gapPct, mean, stdev, zScore, percentileRank, gapContinued, gapReversed,
  basis, basisPct, computeImbalance, computeBreadth, expectedMovePct, atrPct,
} from "@/lib/premarket-lab/analytics";
import { buildQualityReport, canProduceResearchScore, findDuplicates } from "@/lib/premarket-lab/quality";
import { buildFeatures, labelOutcomes, FEATURE_KEYS } from "@/lib/premarket-lab/features";
import {
  toDesignMatrix, fitLogistic, predictLogistic, fitRandomForest, predictForest,
  computeMetrics, fitRidge, predictRidge,
} from "@/lib/premarket-lab/models";
import {
  chronologicalSplit, walkForwardSplits, compareFeatureSets, FEATURE_SETS,
} from "@/lib/premarket-lab/validation";
import { computeCombinedScore, optionsSetupHint } from "@/lib/premarket-lab/score";
import { parseNseDateToIso, isTradingDay, istDateISO } from "@/lib/premarket-lab/calendar";
import type { PreopenStudyDay, LabeledSample } from "@/lib/premarket-lab/types";

const cmRaw = {
  timestamp: "02-Nov-2026 09:09:31",
  data: [
    {
      metadata: {
        symbol: "RELIANCE", previousClose: 2500, lastPrice: 2520, change: 20, pChange: 0.8,
        finalQuantity: 1000, totalTurnover: 25200000, iep: 2520,
      },
      detail: {
        preOpenMarket: {
          preopen: [
            { price: 2515, buyQty: 500, sellQty: 0 },
            { price: 2525, buyQty: 0, sellQty: 300 },
          ],
          totalBuyQuantity: 8000, totalSellQuantity: 6000, IEP: 2520, finalPrice: 2520, finalQuantity: 1000,
          Change: 20, perChange: 0.8, prevClose: 2500,
        },
      },
    },
  ],
};

const fnoRaw = {
  maxtimestamp: "02-Nov-2026 09:09:31",
  data: [
    {
      metadata: {
        symbol: "NIFTY", identifier: "FUTIDXNIFTY23-11-2026", instrumentType: "FUTIDX",
        expiryDate: "23-Nov-2026", lastPrice: 23245, change: 146.1, pChange: 0.63,
        previousClose: 23098.9, finalQuantity: 117, totalTurnover: 176778225, iep: 23245,
      },
      detail: {
        preOpenMarket: {
          preopen: [{ price: 23245, buyQty: 0, sellQty: 325, iep: true }],
          totalBuyQuantity: 76245, totalSellQuantity: 70265, IEP: 23245, finalPrice: 23245,
          finalQuantity: 117, Change: 146.1, perChange: 0.63, prevClose: 23098.9,
        },
      },
    },
    {
      metadata: {
        symbol: "NIFTY", identifier: "FUTIDXNIFTY24-12-2026", instrumentType: "FUTIDX",
        expiryDate: "24-Dec-2026", lastPrice: 23300, change: 200, pChange: 0.87,
        previousClose: 23100, finalQuantity: 50, totalTurnover: 1000000, iep: 23300,
      },
      detail: { preOpenMarket: { totalBuyQuantity: 100, totalSellQuantity: 50, IEP: 23300, finalPrice: 23300, finalQuantity: 50, prevClose: 23100 } },
    },
    {
      metadata: {
        symbol: "RELIANCE", identifier: "FUTSTKRELIANCE23-11-2026", instrumentType: "FUTSTK",
        expiryDate: "23-Nov-2026", lastPrice: 2530, change: 30, pChange: 1.2,
        previousClose: 2500, finalQuantity: 200, totalTurnover: 506000, iep: 2530,
      },
      detail: { preOpenMarket: { totalBuyQuantity: 400, totalSellQuantity: 200, IEP: 2530, finalPrice: 2530, finalQuantity: 200, prevClose: 2500 } },
    },
  ],
};

function sampleDay(overrides: Partial<PreopenStudyDay> = {}): PreopenStudyDay {
  return {
    tradeDate: "2026-11-02",
    symbol: "NIFTY",
    provenance: { source: "NSE_CM_PREOPEN", fetchedAt: new Date().toISOString(), schemaVersion: 1 },
    quality: buildQualityReport({ NSE_CM_PREOPEN: { present: true, ageMs: 0, nowInSession: true } }),
    cm: {
      previousClose: 23000, iep: 23150, finalPrice: 23150, pChange: 0.65,
      finalQuantity: 1000, totalTurnover: 1e9, imbalanceQty: 5000,
      bestBid: 23148, bestAsk: 23152,
    },
    futures: {
      instrumentType: "FUTIDX", expiryDate: "23-Nov-2026",
      previousClose: 23010, iep: 23245, finalPrice: 23245, pChange: 1.02,
      finalQuantity: 117, totalTurnover: 1.7e8, imbalanceQty: 6000,
      basis: 95, basisPct: 0.41,
    },
    open: null,
    vix: 14,
    fiiNet: 500,
    diiNet: -200,
    ...overrides,
  };
}

describe("normalize", () => {
  test("cm payload normalizes", () => {
    const { rows, timestamp } = normalizeCmPayload(cmRaw);
    expect(rows.length).toBe(1);
    expect(rows[0].symbol).toBe("RELIANCE");
    expect(rows[0].iep).toBe(2520);
    expect(rows[0].bestBid).toBe(2515);
    expect(rows[0].bestAsk).toBe(2525);
    expect(timestamp).toContain("02-Nov-2026");
  });

  test("futures payload normalizes FUTIDX and FUTSTK only", () => {
    const { rows } = normalizeFuturesPayload(fnoRaw);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.instrumentType === "FUTIDX" || r.instrumentType === "FUTSTK")).toBe(true);
    expect(rows.every((r) => r.expiryDate.length > 0)).toBe(true);
  });

  test("selectNearestFutures picks current month over next", () => {
    const { rows } = normalizeFuturesPayload(fnoRaw);
    const pick = selectNearestFutures(rows, "NIFTY", "2026-11-02");
    expect(pick?.expiryDate).toBe("23-Nov-2026");
  });

  test("selectNearestFutures never returns expired contract", () => {
    const { rows } = normalizeFuturesPayload(fnoRaw);
    const pick = selectNearestFutures(rows, "NIFTY", "2027-01-15");
    // both Nov and Dec 2026 expired by Jan 2027
    expect(pick).toBeNull();
  });

  test("imbalance helpers", () => {
    expect(imbalanceQty(100, 40)).toBe(60);
    expect(normalizedImbalance(100, 40)).toBeCloseTo(60 / 140, 6);
    expect(normalizedImbalance(null, 40)).toBeNull();
    expect(normalizedImbalance(0, 0)).toBeNull();
  });

  test("duplicate detection", () => {
    const dups = findDuplicates([{ s: "A" }, { s: "B" }, { s: "A" }], (r) => r.s);
    expect(dups).toEqual(["A"]);
  });
});

describe("analytics", () => {
  test("gap percentage", () => {
    expect(gapPct(105, 100)).toBeCloseTo(5, 6);
    expect(gapPct(null, 100)).toBeNull();
    expect(gapPct(100, 0)).toBeNull();
  });

  test("mean stdev z percentile", () => {
    const xs = [1, 2, 3, 4, 5];
    expect(mean(xs)).toBe(3);
    expect(stdev(xs)).toBeGreaterThan(0);
    expect(zScore(3, xs)).toBeCloseTo(0, 6);
    expect(percentileRank(3, xs)).toBeCloseTo(40, 6); // 2 of 5 below
  });

  test("gap continuation and reversal", () => {
    expect(gapContinued(1, 100, 105)).toBe(true);
    expect(gapContinued(1, 100, 99)).toBe(false);
    expect(gapContinued(0.01, 100, 105)).toBeNull(); // flat
    expect(gapReversed(1, 100, 99)).toBe(true);
    expect(gapReversed(-1, 100, 101)).toBe(true);
    expect(gapReversed(1, 100, 102)).toBe(false);
  });

  test("basis", () => {
    expect(basis(102, 100)).toBe(2);
    expect(basisPct(102, 100)).toBeCloseTo(2, 6);
    expect(basis(null, 100)).toBeNull();
  });

  test("imbalance metrics", () => {
    const m = computeImbalance({ totalBuyQuantity: 100, totalSellQuantity: 50, finalQuantity: 10 });
    expect(m.raw).toBe(50);
    expect(m.normalized).toBeCloseTo(50 / 150, 6);
    expect(m.vsFinalVolume).toBeCloseTo(15, 6);
  });

  test("breadth", () => {
    const b = computeBreadth([
      { symbol: "A", pChange: 2 },
      { symbol: "B", pChange: -1 },
      { symbol: "C", pChange: 0 },
      { symbol: "D", pChange: 3, weightPct: 50 },
    ]);
    expect(b.adv).toBe(2);
    expect(b.dec).toBe(1);
    expect(b.unchanged).toBe(1);
    expect(b.advPct).toBeCloseTo(0.5, 6);
    expect(b.equalWeighted).toBeCloseTo(1, 6);
    expect(b.indexWeighted).not.toBeNull();
  });

  test("expected move from VIX", () => {
    expect(expectedMovePct(252.0)).toBeCloseTo(252 / Math.sqrt(252), 6);
    expect(expectedMovePct(null)).toBeNull();
  });

  test("atr needs enough candles", () => {
    expect(atrPct([], 14)).toBeNull();
    const candles = Array.from({ length: 20 }, (_, i) => ({
      high: 100 + i + 1, low: 100 + i - 1, close: 100 + i,
    }));
    expect(atrPct(candles, 14)).toBeGreaterThan(0);
  });
});

describe("quality fail-closed", () => {
  test("missing required source blocks score", () => {
    const q = buildQualityReport({ NSE_CM_PREOPEN: { present: false } });
    expect(q.overall).toBe("MISSING");
    expect(canProduceResearchScore(q)).toBe(false);
  });

  test("present fresh CM allows score", () => {
    const q = buildQualityReport({ NSE_CM_PREOPEN: { present: true, ageMs: 1000, nowInSession: true } });
    expect(canProduceResearchScore(q)).toBe(true);
  });

  test("stale blocks", () => {
    const q = buildQualityReport({ NSE_CM_PREOPEN: { present: true, ageMs: 48 * 3600_000, nowInSession: false } });
    expect(q.perSource.NSE_CM_PREOPEN.quality).toBe("STALE");
    expect(canProduceResearchScore(q)).toBe(false);
  });
});

describe("features no leakage", () => {
  test("buildFeatures produces canonical keys", () => {
    const row = buildFeatures({ day: sampleDay(), asOf: "2026-11-02T09:10:00+05:30" });
    expect(row.tradeDate).toBe("2026-11-02");
    expect(row.calcVersion).toBeTruthy();
    for (const k of FEATURE_KEYS) {
      expect(k in row.features).toBe(true);
    }
    expect(row.features.cm_gap_pct).toBeCloseTo((23150 - 23000) / 23000 * 100, 6);
    expect(row.features.fno_gap_pct).toBeCloseTo((23245 - 23010) / 23010 * 100, 6);
  });

  test("labels are null when open missing", () => {
    const labels = labelOutcomes(sampleDay());
    expect(labels.gap_continuation).toBeNull();
  });

  test("labels after open", () => {
    const day = sampleDay({
      open: { spotOpen: 23150, futuresOpen: 23245, dayHigh: 23300, dayLow: 23100, dayClose: 23280, volume: 1e6 },
    });
    const labels = labelOutcomes(day);
    expect(labels.gap_continuation).toBe(1); // gap up, close > open
    expect(labels.gap_reversal).toBe(0); // close > prevClose
  });
});

describe("models", () => {
  function synth(n: number): LabeledSample[] {
    const out: LabeledSample[] = [];
    for (let i = 0; i < n; i++) {
      const g = (i % 20) - 10;
      const imb = ((i * 7) % 10) / 10 - 0.5;
      const label: 0 | 1 = g + imb * 5 > 0 ? 1 : 0;
      out.push({
        tradeDate: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`,
        symbol: "NIFTY",
        features: { cm_gap_pct: g, normalized_imbalance: imb, fno_gap_pct: g * 0.8 },
        target: "gap_continuation",
        label,
      });
    }
    return out.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  }

  test("design matrix drops nulls", () => {
    const dm = toDesignMatrix([
      { tradeDate: "a", symbol: "N", features: { x: 1, y: null }, target: "t", label: 1 },
      { tradeDate: "b", symbol: "N", features: { x: 2, y: 3 }, target: "t", label: 0 },
    ], ["x", "y"]);
    expect(dm.X.length).toBe(1);
    expect(dm.y).toEqual([0]);
  });

  test("logistic learns separation", () => {
    const samples = synth(80);
    const dm = toDesignMatrix(samples, ["cm_gap_pct", "normalized_imbalance"]);
    const model = fitLogistic(dm, { epochs: 400 });
    expect(model).not.toBeNull();
    const pPos = predictLogistic(model!, { cm_gap_pct: 8, normalized_imbalance: 0.4 });
    const pNeg = predictLogistic(model!, { cm_gap_pct: -8, normalized_imbalance: -0.4 });
    expect(pPos).not.toBeNull();
    expect(pNeg).not.toBeNull();
    expect(pPos!).toBeGreaterThan(pNeg!);
  });

  test("forest and ridge run", () => {
    const samples = synth(60);
    const dm = toDesignMatrix(samples, ["cm_gap_pct", "normalized_imbalance", "fno_gap_pct"]);
    const forest = fitRandomForest(dm, { nTrees: 10, seed: 1 });
    expect(forest).not.toBeNull();
    const p = predictForest(forest!, { cm_gap_pct: 5, normalized_imbalance: 0.3, fno_gap_pct: 4 });
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThanOrEqual(0);
    expect(p!).toBeLessThanOrEqual(1);

    const ridge = fitRidge(dm);
    expect(ridge).not.toBeNull();
    const r = predictRidge(ridge!, { cm_gap_pct: 5, normalized_imbalance: 0.3, fno_gap_pct: 4 });
    expect(r).not.toBeNull();
  });

  test("metrics formulas", () => {
    const m = computeMetrics([1, 0, 1, 0], [0.9, 0.2, 0.6, 0.4], 0.5);
    expect(m.confusion.tp).toBe(2);
    expect(m.confusion.tn).toBe(2);
    expect(m.accuracy).toBe(1);
    expect(m.rocAuc).toBe(1);
    expect(m.brier).toBeCloseTo((0.01 + 0.04 + 0.16 + 0.16) / 4, 6);
  });

  test("insufficient class returns null model", () => {
    const dm = toDesignMatrix(
      Array.from({ length: 15 }, (_, i) => ({
        tradeDate: `d${i}`, symbol: "N", features: { x: i }, target: "t", label: 1 as 0 | 1,
      })),
      ["x"],
    );
    expect(fitLogistic(dm)).toBeNull();
  });
});

describe("validation splits", () => {
  test("chronological split preserves time order", () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({
      tradeDate: `2026-10-${String(i + 1).padStart(2, "0")}`,
      symbol: "NIFTY",
      features: { cm_gap_pct: i - 10 },
      target: "gap_continuation",
      label: (i % 2) as 0 | 1,
    }));
    const { train, test } = chronologicalSplit(samples, 0.7);
    expect(train.length).toBe(14);
    expect(test.length).toBe(6);
    expect(train[train.length - 1].tradeDate < test[0].tradeDate).toBe(true);
  });

  test("walk-forward non-empty when enough samples", () => {
    const samples = Array.from({ length: 50 }, (_, i) => ({
      tradeDate: `2026-10-${String((i % 28) + 1).padStart(2, "0")}-${String(i).padStart(2, "0")}`,
      symbol: "NIFTY",
      features: { cm_gap_pct: (i % 11) - 5, normalized_imbalance: ((i % 7) - 3) / 5 },
      target: "gap_continuation",
      label: (i % 3 === 0 ? 1 : 0) as 0 | 1,
    }));
    const splits = walkForwardSplits(samples, 3, 0.4);
    expect(splits.length).toBeGreaterThan(0);
    for (const s of splits) {
      expect(s.train.length).toBeGreaterThan(0);
      expect(s.test.length).toBeGreaterThan(0);
      expect(s.train[s.train.length - 1].tradeDate <= s.test[0].tradeDate).toBe(true);
    }
  });

  test("feature sets defined", () => {
    expect(FEATURE_SETS.cm_only.every((k) => k.includes("cm_") || k.includes("imbalance"))).toBe(true);
    expect(FEATURE_SETS.fno_only.length).toBeGreaterThan(0);
    expect(FEATURE_SETS.cm_fno.length).toBeGreaterThan(FEATURE_SETS.cm_only.length);
  });

  test("compareFeatureSets returns four sets", () => {
    const samples: LabeledSample[] = [];
    for (let i = 0; i < 60; i++) {
      const gap = (i % 17) - 8;
      samples.push({
        tradeDate: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
        symbol: "NIFTY",
        features: {
          cm_gap_pct: gap,
          cm_pchange: gap,
          normalized_imbalance: gap / 20,
          fno_gap_pct: gap * 0.9,
          fno_pchange: gap * 0.9,
          futures_basis: 20,
          basis_pct: 0.1,
          futures_opening_strength: gap,
          spot_futures_divergence: 0.1,
          index_weighted_breadth: gap / 2,
          sector_strength: 0,
          relative_volume: 1,
          gap_atr_ratio: 0.5,
          vix_percentile: 50,
          opening_range_strength: 0.5,
          concentration_top5: 0.3,
          imbalance_vs_final_vol: 1,
        },
        target: "gap_continuation",
        label: gap > 0 ? 1 : 0,
      });
    }
    const cmp = compareFeatureSets(samples, "gap_continuation", "logistic", 0.7);
    expect(cmp.length).toBe(4);
    expect(cmp.map((c) => c.featureSet)).toEqual(["cm_only", "fno_only", "cm_fno", "full"]);
  });
});

describe("combined score", () => {
  test("produces 0-100 with contributions and disclaimer", () => {
    const score = computeCombinedScore({
      day: sampleDay(),
      quality: sampleDay().quality,
    });
    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.score).toBeLessThanOrEqual(100);
    expect(score.contributions.length).toBeGreaterThan(0);
    expect(score.disclaimer).toContain("Not a probability of profit");
    expect(["BULLISH", "BEARISH", "NEUTRAL", "MIXED", "WAIT"]).toContain(score.bias);
  });

  test("fail-closed WAIT when quality missing", () => {
    const day = sampleDay({
      quality: buildQualityReport({ NSE_CM_PREOPEN: { present: false } }),
    });
    const score = computeCombinedScore({ day, quality: day.quality });
    expect(score.bias).toBe("WAIT");
  });

  test("options hint never auto-sells", () => {
    const bullish = computeCombinedScore({
      day: sampleDay({
        cm: { previousClose: 23000, iep: 23300, finalPrice: 23300, pChange: 1.3, finalQuantity: 1, totalTurnover: 1, imbalanceQty: 10000, bestBid: null, bestAsk: null },
        futures: { instrumentType: "FUTIDX", expiryDate: "23-Nov-2026", previousClose: 23010, iep: 23400, finalPrice: 23400, pChange: 1.7, finalQuantity: 100, totalTurnover: 1, imbalanceQty: 5000, basis: 100, basisPct: 0.43 },
      }),
      quality: sampleDay().quality,
      stockFutStrengthPct: 1.2,
    });
    const hint = optionsSetupHint(bullish);
    expect(hint.side === "BUY_CE" || hint.side === "BUY_PE" || hint.side === "NONE").toBe(true);
    expect(hint.side.startsWith("BUY_SELL") || hint.side.includes("SELL")).toBe(false);
  });
});

describe("calendar", () => {
  test("parse NSE dates", () => {
    expect(parseNseDateToIso("23-Nov-2026")).toBe("2026-11-23");
    expect(parseNseDateToIso("2026-11-02")).toBe("2026-11-02");
    expect(parseNseDateToIso("not-a-date")).toBeNull();
  });

  test("weekend not trading day", () => {
    expect(isTradingDay("2026-11-01")).toBe(false); // Sunday
    expect(isTradingDay("2026-11-02")).toBe(true); // Monday (unless holiday list says otherwise)
  });

  test("istDateISO format", () => {
    expect(istDateISO(new Date("2026-11-02T04:00:00Z"))).toBe("2026-11-02");
  });
});
