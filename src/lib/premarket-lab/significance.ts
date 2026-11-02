// Phase 11 significance helpers — Wilson score intervals + accuracy vs 50%.
// Fail-closed: n < 30 → insufficient (do not claim statistical significance).

import type { WilsonInterval, ModelMetrics } from "./types";
import { SHADOW_MIN_N } from "./types";
import { wilsonInterval } from "./storage";

export { wilsonInterval, SHADOW_MIN_N };

export interface AccuracyCheck {
  n: number;
  correct: number;
  accuracy: number | null;
  ci: WilsonInterval;
  /** Two-sided binomial p vs 0.5 (normal approx — research only). */
  pVs50: number | null;
  significantAt05: boolean;
  message: string;
}

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Binomial two-sided p-value vs p0 using normal approximation with continuity correction. */
export function binomialPvs(successes: number, n: number, p0 = 0.5): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = successes / n;
  const denom = Math.sqrt((p0 * (1 - p0)) / n);
  if (denom === 0) return null;
  const z = (p - p0) / denom;
  // two-sided
  const p2 = 2 * (1 - normalCdf(Math.abs(z)));
  return Math.max(0, Math.min(1, p2));
}

export function accuracyCheck(yTrue: number[], yPred: number[]): AccuracyCheck {
  const n = Math.min(yTrue.length, yPred.length);
  if (n === 0) {
    return {
      n: 0, correct: 0, accuracy: null,
      ci: wilsonInterval(0, 0), pVs50: null, significantAt05: false,
      message: "no labeled predictions",
    };
  }
  let correct = 0;
  for (let i = 0; i < n; i++) if (yTrue[i] === yPred[i]) correct++;
  const ci = wilsonInterval(correct, n);
  const p = binomialPvs(correct, n, 0.5);
  const significant = !ci.insufficient && p != null && p < 0.05 && (ci.lower ?? 0) > 0.5;
  return {
    n,
    correct,
    accuracy: correct / n,
    ci,
    pVs50: p,
    significantAt05: significant,
    message: ci.insufficient
      ? `insufficient n=${n} < ${SHADOW_MIN_N} — accuracy reported without significance claim`
      : significant
        ? `accuracy CI lower bound > 0.5 (p=${p?.toFixed(4)})`
        : `accuracy not distinguishable from 50% at 0.05 (p=${p?.toFixed(4) ?? "n/a"})`,
  };
}

export interface CalibrationBucket {
  lo: number;
  hi: number;
  n: number;
  meanProb: number | null;
  hitRate: number | null;
}

/** Reliability diagram buckets (equal-width 0.1). */
export function calibrationBuckets(yTrue: number[], yProb: number[], bucketSize = 0.1): CalibrationBucket[] {
  const n = Math.min(yTrue.length, yProb.length);
  const buckets: CalibrationBucket[] = [];
  for (let lo = 0; lo < 1 - 1e-9; lo += bucketSize) {
    const hi = Math.min(1, lo + bucketSize);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = yProb[i];
      if (p >= lo && (hi >= 1 ? p <= 1 : p < hi)) idx.push(i);
    }
    const meanProb = idx.length ? idx.reduce((a, i) => a + yProb[i], 0) / idx.length : null;
    const hitRate = idx.length ? idx.reduce((a, i) => a + yTrue[i], 0) / idx.length : null;
    buckets.push({
      lo: Number(lo.toFixed(2)),
      hi: Number(hi.toFixed(2)),
      n: idx.length,
      meanProb: meanProb != null ? Number(meanProb.toFixed(4)) : null,
      hitRate: hitRate != null ? Number(hitRate.toFixed(4)) : null,
    });
  }
  return buckets;
}

/** Brier + accuracy from ModelMetrics-shaped confusion when only counts available. */
export function metricsAccuracy(m: ModelMetrics): number | null {
  if (!m || !m.n) return null;
  return m.accuracy;
}
