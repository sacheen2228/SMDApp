// quant-market-regime.ts — deterministic regime classifier for the quant
// engine. PURE: reads only the supplied features (no fetching, no clock).
//
// Thresholds (all measured on QuantFeatures fields, same units throughout):
//   TS_TREND            0.15  — |trendScore|% needed to call a trend
//   VOL_EXP_BREAKOUT    1.3   — volumeExpansion needed for BREAKOUT
//   HIGH_VIX            20    — India VIX above this = HIGH_VOLATILITY
//   HIGH_RVOL           25    — realizedVol (annualized %) above this = HIGH_VOLATILITY
//   LOW_VIX             12    — India VIX below this = LOW_VOLATILITY
//   LOW_RVOL            10    — realizedVol below this = LOW_VOLATILITY
//   RANGE_COMP_MAX      1.2   — rangeCompression ≤ this = compressed
//   RANGE_VWAP_DEV_MAX  0.5   — |vwapDevPct|% within this = anchored to VWAP
//   EXPIRY_VIX          15    — expiry-day vol floor (vix OR realizedVol OR expectedMove)
//
// Priority (first match wins): BREAKOUT → TRENDING_UP/DOWN → EXPIRY_VOLATILE
// (only when ctx.isExpiryDay === true) → HIGH_VOLATILITY → RANGE_BOUND →
// LOW_VOLATILITY → UNCERTAIN. Conflicting evidence (both breakout sides, or
// trend + compression) returns UNCERTAIN with confidence null.

import type { Regime } from "./quant-config";
import type { QuantFeatures, QuantRegimeResult } from "./quant-types";

export const REGIME_THRESHOLDS = {
  TS_TREND: 0.15,
  VOL_EXP_BREAKOUT: 1.3,
  HIGH_VIX: 20,
  HIGH_RVOL: 25,
  LOW_VIX: 12,
  LOW_RVOL: 10,
  RANGE_COMP_MAX: 1.2,
  RANGE_VWAP_DEV_MAX: 0.5,
  EXPIRY_VIX: 15,
} as const;

export interface RegimeCtx {
  isExpiryDay?: boolean | null;
  symbol?: string;
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function classifyRegime(features: QuantFeatures, ctx: RegimeCtx = {}): QuantRegimeResult {
  const T = REGIME_THRESHOLDS;
  const reasons: string[] = [];
  const f = features;
  const close = f.close;
  const trendScore = finite(f.trendScore) ? f.trendScore! : null;
  const vwapDevPct = finite(f.vwapDevPct) ? f.vwapDevPct! : null;
  const vix = finite(f.vix) ? f.vix! : null;
  const realizedVol = finite(f.realizedVol) ? f.realizedVol! : null;
  const volumeExpansion = finite(f.volumeExpansion) ? f.volumeExpansion! : null;
  const rangeCompression = finite(f.rangeCompression) ? f.rangeCompression! : null;
  const expectedMovePct = finite(f.expectedMovePct) ? f.expectedMovePct! : null;

  const trendUp = !!(
    f.ema20 != null && f.ema50 != null && close != null &&
    f.ema20 > f.ema50 && close > f.ema20 &&
    trendScore != null && trendScore >= T.TS_TREND
  );
  const trendDown = !!(
    f.ema20 != null && f.ema50 != null && close != null &&
    f.ema20 < f.ema50 && close < f.ema20 &&
    trendScore != null && trendScore <= -T.TS_TREND
  );

  // Breakout references EXCLUDE the latest candle (close ≤ sessionHigh always,
  // so the prior high is the honest reference for the newest bar).
  const priorHigh = Math.max(
    ...(finite(f.sessionHigh) ? [f.sessionHigh] : []),
    ...(finite(f.prevDayHigh) ? [f.prevDayHigh] : [-Infinity]),
  );
  const priorLow = Math.min(
    ...(finite(f.sessionLow) ? [f.sessionLow] : []),
    ...(finite(f.prevDayLow) ? [f.prevDayLow] : [Infinity]),
  );
  const hasPriorHigh = Number.isFinite(priorHigh);
  const hasPriorLow = Number.isFinite(priorLow);
  const breakoutUp = !!(
    close != null && hasPriorHigh && close > priorHigh &&
    volumeExpansion != null && volumeExpansion >= T.VOL_EXP_BREAKOUT
  );
  const breakoutDown = !!(
    close != null && hasPriorLow && close < priorLow &&
    volumeExpansion != null && volumeExpansion >= T.VOL_EXP_BREAKOUT
  );

  const compressed = rangeCompression != null && rangeCompression <= T.RANGE_COMP_MAX;
  const anchoredToVwap = vwapDevPct != null && Math.abs(vwapDevPct) <= T.RANGE_VWAP_DEV_MAX;
  const noTrend = trendScore == null || Math.abs(trendScore) < T.TS_TREND;
  const rangeBound = !!(compressed && anchoredToVwap && noTrend);

  const highVol = !!(vix != null && vix > T.HIGH_VIX) || !!(realizedVol != null && realizedVol > T.HIGH_RVOL);
  const lowVol = !!(vix != null && vix < T.LOW_VIX) || !!(realizedVol != null && realizedVol < T.LOW_RVOL);

  const expiryVol = !!(
    ctx.isExpiryDay === true && close != null &&
    ((vix != null && vix >= T.EXPIRY_VIX) ||
      (realizedVol != null && realizedVol >= T.EXPIRY_VIX) ||
      (expectedMovePct != null && expectedMovePct >= 1.0))
  );

  const measurements: Record<string, number | null> = {
    trendScore, vwapDevPct, vix, realizedVol, volumeExpansion, rangeCompression, expectedMovePct,
  };

  // Conflicts → UNCERTAIN (confidence null)
  if (breakoutUp && breakoutDown) {
    return { regime: "UNCERTAIN", confidence: null, measurements, reasons: ["conflict: both breakout sides fired (range spans prior day boundaries)"] };
  }
  if ((trendUp && rangeBound) || (trendDown && rangeBound)) {
    return { regime: "UNCERTAIN", confidence: null, measurements, reasons: ["conflict: trend and range-compression evidence fired together"] };
  }

  if (breakoutUp || breakoutDown) {
    const ref = breakoutUp ? priorHigh : priorLow;
    const distPct = close != null && ref > 0 ? (Math.abs(close - ref) / ref) * 100 : null;
    reasons.push(
      `close ${close} ${breakoutUp ? "above" : "below"} prior extreme ${Number.isFinite(ref) ? ref : "n/a"}`,
      `volumeExpansion ${volumeExpansion} ≥ ${T.VOL_EXP_BREAKOUT}`,
    );
    const confidence = Math.min(100, Math.round(
      50 + 25 * Math.min((volumeExpansion! - T.VOL_EXP_BREAKOUT) / 1.2, 1) +
      (distPct != null ? 25 * Math.min(distPct / 0.5, 1) : 0),
    ));
    return { regime: "BREAKOUT", confidence, measurements, reasons };
  }

  if (trendUp || trendDown) {
    reasons.push(
      `ema20 ${f.ema20} ${trendUp ? ">" : "<"} ema50 ${f.ema50}`,
      `close ${close} ${trendUp ? ">" : "<"} ema20 ${f.ema20}`,
      `trendScore ${trendScore} beyond ±${T.TS_TREND}`,
    );
    const confidence = Math.min(100, Math.round(
      50 + 30 * Math.min(Math.abs(trendScore!) / 0.5, 1) +
      20 * Math.min(Math.abs(vwapDevPct ?? 0) / 1.0, 1),
    ));
    return { regime: trendUp ? "TRENDING_UP" : "TRENDING_DOWN", confidence, measurements, reasons };
  }

  if (expiryVol) {
    reasons.push(
      `expiry day for ${ctx.symbol ?? "symbol"}`,
      `vol measures: vix ${vix}, realizedVol ${realizedVol}, expectedMovePct ${expectedMovePct} (floor ${T.EXPIRY_VIX})`,
    );
    const confidence = Math.min(100, Math.round(
      50 + 25 * Math.min((vix ?? 0) / 25, 1) + 25 * Math.min((realizedVol ?? 0) / 30, 1),
    ));
    return { regime: "EXPIRY_VOLATILE", confidence, measurements, reasons };
  }

  if (highVol) {
    reasons.push(`vix ${vix} > ${T.HIGH_VIX} or realizedVol ${realizedVol} > ${T.HIGH_RVOL}`);
    const confidence = Math.min(100, Math.round(
      50 + 25 * Math.min((vix ?? 0) / 30, 1) + 25 * Math.min((realizedVol ?? 0) / 40, 1),
    ));
    return { regime: "HIGH_VOLATILITY", confidence, measurements, reasons };
  }

  if (rangeBound) {
    reasons.push(
      `rangeCompression ${rangeCompression} ≤ ${T.RANGE_COMP_MAX}`,
      `|vwapDevPct| ${Math.abs(vwapDevPct ?? 0)} ≤ ${T.RANGE_VWAP_DEV_MAX}`,
      `|trendScore| ${trendScore == null ? "n/a" : Math.abs(trendScore)} < ${T.TS_TREND}`,
    );
    const confidence = Math.min(100, Math.round(
      50 + 25 * (1 - Math.min((rangeCompression ?? 2) / T.RANGE_COMP_MAX, 1)) +
      25 * (1 - Math.min(Math.abs(vwapDevPct ?? 1) / T.RANGE_VWAP_DEV_MAX, 1)),
    ));
    return { regime: "RANGE_BOUND", confidence, measurements, reasons };
  }

  if (lowVol && !highVol) {
    reasons.push(`vix ${vix} < ${T.LOW_VIX} or realizedVol ${realizedVol} < ${T.LOW_RVOL}`);
    const confidence = Math.min(100, Math.round(
      50 + 25 * (1 - Math.min((vix ?? 12) / T.LOW_VIX, 1)) + 25 * (1 - Math.min((realizedVol ?? 10) / T.LOW_RVOL, 1)),
    ));
    return { regime: "LOW_VOLATILITY", confidence, measurements, reasons };
  }

  reasons.push(
    `no regime rule fired: trend ${trendScore}, vwapDevPct ${vwapDevPct}, rangeCompression ${rangeCompression}, vix ${vix}, realizedVol ${realizedVol}, volumeExpansion ${volumeExpansion}`,
  );
  return { regime: "UNCERTAIN", confidence: null, measurements, reasons };
}

export type { Regime };
