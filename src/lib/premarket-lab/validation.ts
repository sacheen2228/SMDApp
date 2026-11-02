// Chronological validation, walk-forward, and CM vs F&O vs combined comparison.
// No random shuffles — time order preserved to prevent leakage.

import type { LabeledSample, ModelMetrics } from "./types";
import {
  toDesignMatrix, fitLogistic, predictLogistic, fitRandomForest, predictForest,
  fitGradientBoosting, predictGradientBoosting, fitRidge, predictRidge,
  computeMetrics, type DesignMatrix,
} from "./models";

export type FeatureSetId = "cm_only" | "fno_only" | "cm_fno" | "cm_fno_options" | "full";

export const FEATURE_SETS: Record<FeatureSetId, string[]> = {
  cm_only: ["cm_gap_pct", "cm_pchange", "normalized_imbalance"],
  fno_only: ["fno_gap_pct", "fno_pchange", "futures_basis", "basis_pct", "futures_opening_strength", "spot_futures_divergence"],
  cm_fno: [
    "cm_gap_pct", "cm_pchange", "normalized_imbalance",
    "fno_gap_pct", "fno_pchange", "futures_basis", "basis_pct",
    "futures_opening_strength", "spot_futures_divergence",
  ],
  cm_fno_options: [
    "cm_gap_pct", "cm_pchange", "normalized_imbalance",
    "fno_gap_pct", "fno_pchange", "futures_basis", "basis_pct",
    "futures_opening_strength", "spot_futures_divergence",
    // Phase 11: MOAPI/options keys when present (null → row excluded)
    "options_pcr", "options_oi_imbalance", "options_confirm_pct",
  ],
  full: [
    "cm_gap_pct", "fno_gap_pct", "normalized_imbalance", "ieq_relative_strength",
    "futures_basis", "basis_zscore", "basis_pct", "spot_futures_divergence",
    "index_weighted_breadth", "sector_strength", "relative_volume",
    "gap_atr_ratio", "vix_percentile", "opening_range_strength",
    "futures_opening_strength", "concentration_top5", "imbalance_vs_final_vol",
    "cm_pchange", "fno_pchange",
    // research inputs (null-safe)
    "options_pcr", "options_oi_imbalance", "options_confirm_pct",
    "fii_net", "breadth_net", "vix_level",
  ],
};

export interface Split {
  train: LabeledSample[];
  test: LabeledSample[];
}

/** Chronological 70/30 split by tradeDate (stable sort). */
export function chronologicalSplit(samples: LabeledSample[], trainRatio = 0.7): Split {
  const sorted = [...samples].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.symbol.localeCompare(b.symbol));
  const cut = Math.floor(sorted.length * trainRatio);
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}

/** Walk-forward: expanding window, nSplits folds. */
export function walkForwardSplits(samples: LabeledSample[], nSplits = 4, minTrainRatio = 0.4): Split[] {
  const sorted = [...samples].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const n = sorted.length;
  const splits: Split[] = [];
  const minTrain = Math.floor(n * minTrainRatio);
  for (let i = 1; i <= nSplits; i++) {
    const trainEnd = minTrain + Math.floor(((n - minTrain) * i) / (nSplits + 1));
    const testEnd = Math.floor((n * (i + 1)) / (nSplits + 1));
    if (trainEnd <= 0 || testEnd <= trainEnd) continue;
    splits.push({ train: sorted.slice(0, trainEnd), test: sorted.slice(trainEnd, testEnd) });
  }
  return splits;
}

export type ModelName = "logistic" | "forest" | "gbt" | "ridge";

export function fitModel(name: ModelName, train: LabeledSample[], featureKeys: string[]): { predict: (f: Record<string, number | null>) => number | null } | null {
  const dm = toDesignMatrix(train, featureKeys);
  if (dm.X.length < 10) return null;
  switch (name) {
    case "logistic": {
      const m = fitLogistic(dm);
      return m ? { predict: (f) => predictLogistic(m, f) } : null;
    }
    case "forest": {
      const m = fitRandomForest(dm, { seed: 42 });
      return m ? { predict: (f) => predictForest(m, f) } : null;
    }
    case "gbt": {
      const m = fitGradientBoosting(dm);
      return m ? { predict: (f) => predictGradientBoosting(m, f) } : null;
    }
    case "ridge": {
      const m = fitRidge(dm);
      return m ? { predict: (f) => { const v = predictRidge(m, f); return v == null ? null : 1 / (1 + Math.exp(-v)); } } : null;
    }
  }
}

export function evaluateOn(
  model: { predict: (f: Record<string, number | null>) => number | null },
  test: LabeledSample[],
): { metrics: ModelMetrics; skipped: number } {
  const yTrue: number[] = [];
  const yProb: number[] = [];
  let skipped = 0;
  for (const s of test) {
    const p = model.predict(s.features);
    if (p == null) { skipped++; continue; }
    yTrue.push(s.label);
    yProb.push(p);
  }
  return { metrics: computeMetrics(yTrue, yProb), skipped };
}

export interface SourceComparison {
  featureSet: FeatureSetId;
  target: string;
  model: ModelName;
  metrics: ModelMetrics | null;
  skipped: number;
  nTrain: number;
  nTest: number;
}

/** Compare CM-only, F&O-only, CM+F&O, full — chronological OOS. */
export function compareFeatureSets(
  samples: LabeledSample[],
  target: string,
  model: ModelName = "logistic",
  trainRatio = 0.7,
): SourceComparison[] {
  const forTarget = samples.filter((s) => s.target === target && s.label != null);
  const sets: FeatureSetId[] = ["cm_only", "fno_only", "cm_fno", "full"];
  const out: SourceComparison[] = [];
  for (const fs of sets) {
    const keys = FEATURE_SETS[fs];
    const usable = forTarget.filter((s) => keys.every((k) => s.features[k] != null && Number.isFinite(s.features[k])));
    const { train, test } = chronologicalSplit(usable, trainRatio);
    const fitted = fitModel(model, train, keys);
    if (!fitted) {
      out.push({ featureSet: fs, target, model, metrics: null, skipped: test.length, nTrain: train.length, nTest: test.length });
      continue;
    }
    const { metrics, skipped } = evaluateOn(fitted, test);
    out.push({ featureSet: fs, target, model, metrics, skipped, nTrain: train.length, nTest: test.length });
  }
  return out;
}

export function meanMetrics(runs: ModelMetrics[]): ModelMetrics | null {
  if (runs.length === 0) return null;
  const avg = (sel: (m: ModelMetrics) => number | null): number | null => {
    const xs = runs.map(sel).filter((x): x is number => x != null);
    if (xs.length === 0) return null;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  const conf = runs.reduce(
    (acc, m) => ({
      tp: acc.tp + m.confusion.tp, fp: acc.fp + m.confusion.fp,
      tn: acc.tn + m.confusion.tn, fn: acc.fn + m.confusion.fn,
    }),
    { tp: 0, fp: 0, tn: 0, fn: 0 },
  );
  return {
    n: runs.reduce((a, m) => a + m.n, 0),
    precision: avg((m) => m.precision),
    recall: avg((m) => m.recall),
    f1: avg((m) => m.f1),
    rocAuc: avg((m) => m.rocAuc),
    brier: avg((m) => m.brier),
    accuracy: avg((m) => m.accuracy),
    confusion: conf,
  };
}

export function walkForwardAverage(
  samples: LabeledSample[],
  target: string,
  model: ModelName,
  featureSet: FeatureSetId,
  nSplits = 4,
): { mean: ModelMetrics | null; folds: ModelMetrics[] } {
  const keys = FEATURE_SETS[featureSet];
  const usable = samples.filter((s) => s.target === target && keys.every((k) => s.features[k] != null));
  const folds: ModelMetrics[] = [];
  for (const split of walkForwardSplits(usable, nSplits)) {
    const fitted = fitModel(model, split.train, keys);
    if (!fitted) continue;
    const { metrics } = evaluateOn(fitted, split.test);
    if (metrics.n > 0) folds.push(metrics);
  }
  return { mean: meanMetrics(folds), folds };
}
