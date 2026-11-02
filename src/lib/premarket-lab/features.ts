// Feature engineering — timestamp-aware, no future leakage.
// FEATURES are computed only from data with asOf ≤ feature cutoff.

import type { FeatureRow, SourceId, PreopenStudyDay } from "./types";
import {
  gapPct, zScore, percentileRank, computeImbalance, basis as basisFn, basisPct as basisPctFn,
  spotFuturesDivergence, computeBreadth, atrPct, realizedVolPct, expectedMovePct, relativeVolume,
  futuresOpeningStrength, idxStkFuturesConfirmation, concentrationTopN,
} from "./analytics";

export const FEATURE_CALC_VERSION = "pm-lab-fv1";

/** Canonical feature keys (documented for dashboards + models). */
export const FEATURE_KEYS = [
  "cm_gap_pct",
  "fno_gap_pct",
  "normalized_imbalance",
  "ieq_relative_strength",
  "futures_basis",
  "basis_zscore",
  "spot_futures_divergence",
  "index_weighted_breadth",
  "sector_strength",
  "relative_volume",
  "gap_atr_ratio",
  "vix_percentile",
  "opening_range_strength",
  "futures_opening_strength",
  "idx_stk_confirmation",
  "concentration_top5",
  "imbalance_vs_final_vol",
  "basis_pct",
  "cm_pchange",
  "fno_pchange",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface FeatureContext {
  day: PreopenStudyDay;
  /** Historical series for z/percentile — only PRIOR trading days (no same-day future). */
  history?: {
    cmGaps?: number[];
    fnoGaps?: number[];
    basisPcts?: number[];
    vix?: number[];
    atrsPct?: number[];
  };
  /** Opening candles (after 09:15) when available for opening_range / relative volume. */
  openCandles?: Array<{ high: number; low: number; close: number; volume: number; time: number }>;
  priorAvgVolume?: number | null;
  sectorStrengthPct?: number | null;
  breadthWeights?: Array<{ symbol: string; pChange: number | null; weightPct?: number }>;
  /** Cutoff — features must only use data at or before this ISO time. */
  asOf: string;
}

function num(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

/**
 * Build one feature vector for a study day.
 * Look-ahead guard: caller supplies asOf; optional history must already be prior-only.
 */
export function buildFeatures(ctx: FeatureContext): FeatureRow {
  const { day, asOf } = ctx;
  const f: Record<string, number | null> = {};
  const sources: SourceId[] = [];

  // CM gap
  const cmGap = day.cm ? gapPct(day.cm.iep ?? day.cm.finalPrice, day.cm.previousClose) : null;
  f.cm_gap_pct = num(cmGap);
  if (day.cm) sources.push("NSE_CM_PREOPEN");

  // F&O gap
  const fnoGap = day.futures ? gapPct(day.futures.iep ?? day.futures.finalPrice, day.futures.previousClose) : null;
  f.fno_gap_pct = num(fnoGap);
  if (day.futures) sources.push("NSE_FNO_PREOPEN");

  // Imbalance
  if (day.cm) {
    const imb = computeImbalance(day.cm);
    f.normalized_imbalance = num(imb.normalized);
    f.imbalance_vs_final_vol = num(imb.vsFinalVolume);
  }

  // IEQ relative strength vs turnover (proxy when no cross-section)
  if (day.cm && day.cm.finalQuantity != null && day.cm.totalTurnover != null && day.cm.totalTurnover > 0) {
    // units per rupee — higher means more quantity for value (cheap accumulation)
    f.ieq_relative_strength = num(day.cm.finalQuantity / (day.cm.totalTurnover / 1e5));
  } else {
    f.ieq_relative_strength = null;
  }

  // Basis
  if (day.futures && day.cm) {
    const spot = day.cm.iep ?? day.cm.finalPrice;
    const fut = day.futures.iep ?? day.futures.finalPrice;
    f.futures_basis = num(basisFn(fut, spot));
    f.basis_pct = num(basisPctFn(fut, spot));
  } else if (day.futures) {
    f.futures_basis = num(day.futures.basis);
    f.basis_pct = num(day.futures.basisPct);
  }

  // Basis z-score vs history
  if (f.basis_pct != null && ctx.history?.basisPcts?.length) {
    f.basis_zscore = num(zScore(f.basis_pct, ctx.history.basisPcts));
  } else {
    f.basis_zscore = null;
  }

  // Spot/futures divergence
  f.spot_futures_divergence = num(spotFuturesDivergence(day.cm?.pChange ?? null, day.futures?.pChange ?? null));

  // Breadth
  const breadthRows = ctx.breadthWeights ?? [];
  if (breadthRows.length > 0) {
    const b = computeBreadth(breadthRows);
    f.index_weighted_breadth = num(b.indexWeighted);
  } else if (day.cm) {
    // fallback: single-name not breadth
    f.index_weighted_breadth = num(day.cm.pChange);
  }

  f.sector_strength = num(ctx.sectorStrengthPct);

  // Relative volume
  if (ctx.openCandles && ctx.openCandles.length > 0) {
    const vol = ctx.openCandles.reduce((a, c) => a + (c.volume || 0), 0);
    f.relative_volume = num(relativeVolume(vol, ctx.priorAvgVolume ?? null));
    // Opening range strength: (close − OR low) / (OR high − OR low) — 0..1-ish
    const highs = ctx.openCandles.map((c) => c.high);
    const lows = ctx.openCandles.map((c) => c.low);
    const orH = Math.max(...highs);
    const orL = Math.min(...lows);
    const last = ctx.openCandles[ctx.openCandles.length - 1].close;
    if (orH > orL) f.opening_range_strength = num((last - orL) / (orH - orL));
    else f.opening_range_strength = null;
  } else {
    f.relative_volume = null;
    f.opening_range_strength = null;
  }

  // Gap vs ATR
  const atr = ctx.history?.atrsPct?.length ? ctx.history.atrsPct[ctx.history.atrsPct.length - 1] : atrPctSafe(day);
  const gapAbs = cmGap != null ? Math.abs(cmGap) : null;
  f.gap_atr_ratio = gapAbs != null && atr != null && atr !== 0 ? gapAbs / atr : null;

  // VIX percentile
  if (day.vix != null && ctx.history?.vix?.length) {
    f.vix_percentile = num(percentileRank(day.vix, ctx.history.vix));
  } else {
    f.vix_percentile = null;
  }

  // Futures opening strength
  if (day.futures) {
    f.futures_opening_strength = num(
      futuresOpeningStrength({ iep: day.futures.iep, previousClose: day.futures.previousClose, pChange: day.futures.pChange }),
    );
  }

  // IDX vs STK confirmation (needs external avg stock fut strength — optional)
  // Leave null unless caller enriches day via sectorStrengthPct-like side channel
  f.idx_stk_confirmation = null;

  f.concentration_top5 = breadthRows.length > 0 ? concentrationTopN(breadthRows, 5) : null;

  f.cm_pchange = num(day.cm?.pChange);
  f.fno_pchange = num(day.futures?.pChange);

  // Dedupe sources
  const uniq = Array.from(new Set(sources));

  return {
    tradeDate: day.tradeDate,
    symbol: day.symbol,
    asOf,
    features: f,
    source: uniq,
    calcVersion: FEATURE_CALC_VERSION,
  };
}

function atrPctSafe(day: PreopenStudyDay): number | null {
  // No candles in study day alone — null unless history provided
  return null;
}

/**
 * Attach outcome labels AFTER the session (never used as features).
 * gap_continuation: gap day closed beyond open in gap direction
 * gap_reversal: close crossed prevClose against gap
 * opening_breakout: day range broke opening range with close confirmation (simplified)
 * trend_day: |close-open| / (high-low) high and range > median
 * vol_expansion: |gap|/atr or realized vol above baseline
 */
export function labelOutcomes(
  day: PreopenStudyDay,
  prior: { medianRangePct?: number | null; baselineVol?: number | null } = {},
): Record<string, 0 | 1 | null> {
  const open = day.open?.spotOpen;
  const close = day.open?.dayClose;
  const high = day.open?.dayHigh;
  const low = day.open?.dayLow;
  const prev = day.cm?.previousClose ?? null;
  const gap = day.cm ? gapPct(day.cm.iep ?? day.cm.finalPrice, prev) : null;

  let gapCont: 0 | 1 | null = null;
  let gapRev: 0 | 1 | null = null;
  if (gap != null && open != null && close != null && prev != null && Math.abs(gap) >= 0.05) {
    gapCont = gap > 0 ? (close > open ? 1 : 0) : close < open ? 1 : 0;
    gapRev = gap > 0 ? (close < prev ? 1 : 0) : close > prev ? 1 : 0;
  }

  let breakout: 0 | 1 | null = null;
  let trendDay: 0 | 1 | null = null;
  if (open != null && close != null && high != null && low != null && high > low) {
    const range = high - low;
    const body = Math.abs(close - open);
    const rangePct = (range / (prev || open)) * 100;
    if (prior.medianRangePct != null) trendDay = rangePct > prior.medianRangePct && body / range > 0.6 ? 1 : 0;
    // breakout proxy: close near extreme in direction of gap
    if (gap != null && Math.abs(gap) >= 0.05) {
      if (gap > 0) breakout = close >= high - range * 0.1 ? 1 : 0;
      else breakout = close <= low + range * 0.1 ? 1 : 0;
    }
  }

  let volExp: 0 | 1 | null = null;
  if (gap != null && prior.baselineVol != null) {
    const atr = atrPctSafe(day);
    const gatr = atr && atr !== 0 ? Math.abs(gap) / atr : null;
    if (gatr != null) volExp = gatr > 1 ? 1 : 0;
  }

  return {
    gap_continuation: gapCont,
    gap_reversal: gapRev,
    opening_breakout: breakout,
    trend_day: trendDay,
    volatility_expansion: volExp,
  };
}
