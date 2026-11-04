// DTR (Daily Trading Range) Module — Phase B of Unified Intraday Intelligence Engine
//
// DTR = Today's High − Today's Low
//
// Calculates:
//   • DTR (intraday range)
//   • DTR utilization (where price sits within today's range: 0 = low, 1 = high)
//   • Historical range comparison (today's DTR vs average historical DTR)
//   • Opening gap (today's open vs previous close)
//   • Range expansion/contraction (today's DTR vs ATR-based expectation)
//
// Reuses existing validated modules:
//   • src/indicators/atr.ts — computeATR, computeATRPercent, classifyATRRegime
//   • src/types/engine.ts — Candle interface
//
// No network calls. Pure function of candle data. Missing/stale data → null,
// never fabricated.

import { computeATR, computeATRPercent, classifyATRRegime } from "@/indicators/atr";
import type { Candle } from "@/types/engine";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type DtrRegime = "COMPRESSED" | "NORMAL" | "EXPANDED";

export interface DtrResult {
  /** Today's high − today's low */
  dtr: number | null;
  /** DTR utilization: (close − low) / (high − low), 0–1. null when DTR is 0. */
  dtrUtilization: number | null;
  /** Average historical DTR over the lookback window */
  avgHistoricalDtr: number | null;
  /** Today's DTR vs average historical DTR (ratio). >1 = expanded, <1 = compressed. */
  dtrVsAverage: number | null;
  /** Opening gap: today's open − previous close */
  openingGap: number | null;
  /** Opening gap as % of previous close */
  openingGapPct: number | null;
  /** ATR(14) from recent candles */
  atr14: number | null;
  /** ATR(14) as % of price */
  atr14Pct: number | null;
  /** ATR regime classification */
  atrRegime: 'low' | 'normal' | 'high' | 'extreme' | null;
  /** Range regime vs historical average */
  rangeRegime: DtrRegime | null;
  /** Remaining range estimate (DTR − distance already traveled), null when uncomputable */
  remainingRange: number | null;
  /** Remaining range as % of DTR */
  remainingRangePct: number | null;
  /** Whether data is sufficient for a reliable DTR read */
  sufficientData: boolean;
  /** Reason when data is insufficient */
  insufficientReason: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// DTR calculation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute the Daily Trading Range and related metrics from today's candles
 * plus a historical lookback.
 *
 * @param todayCandles — today's candles, oldest → newest. Must contain at
 *   least one candle with high/low/close.
 * @param historicalCandles — prior sessions' candles, oldest → newest, used
 *   for average DTR comparison. Minimum 10 for a meaningful average.
 * @param currentPrice — the current/live price (for utilization). Defaults
 *   to the last candle's close when not provided.
 * @param lookback — number of historical sessions for average DTR (default 20).
 */
export function calculateDTR(
  todayCandles: Candle[],
  historicalCandles: Candle[],
  currentPrice?: number,
  lookback = 20,
): DtrResult {
  const insufficient = (reason: string): DtrResult => ({
    dtr: null,
    dtrUtilization: null,
    avgHistoricalDtr: null,
    dtrVsAverage: null,
    openingGap: null,
    openingGapPct: null,
    atr14: null,
    atr14Pct: null,
    atrRegime: null,
    rangeRegime: null,
    remainingRange: null,
    remainingRangePct: null,
    sufficientData: false,
    insufficientReason: reason,
  });

  // ── Validate today's candles ──
  if (!todayCandles || todayCandles.length === 0) {
    return insufficient("no today candles");
  }

  const lastToday = todayCandles[todayCandles.length - 1];
  const firstToday = todayCandles[0];

  const todayHigh = Math.max(...todayCandles.map((c) => c.high));
  const todayLow = Math.min(...todayCandles.map((c) => c.low));
  const dtr = todayHigh - todayLow;

  if (!Number.isFinite(dtr) || dtr <= 0) {
    return insufficient("invalid DTR (high ≤ low or non-finite)");
  }

  // ── Current price ──
  const price =
    currentPrice != null && Number.isFinite(currentPrice) && currentPrice > 0
      ? currentPrice
      : lastToday.close;

  // ── DTR utilization ──
  const dtrUtilization = dtr > 0 ? (price - todayLow) / dtr : null;

  // ── Opening gap ──
  const prevClose = lastToday.close; // last candle close = previous close for gap calc
  const todayOpen = firstToday.open;
  const openingGap = todayOpen - prevClose;
  const openingGapPct = prevClose > 0 ? (openingGap / prevClose) * 100 : null;

  // ── Historical average DTR ──
  const histDtrs: number[] = [];
  if (historicalCandles && historicalCandles.length >= 2) {
    // Group historical candles by session (simple: every N candles = one day,
    // or use date boundaries when timestamps available). Here we compute
    // per-candle-range pairs as a conservative proxy when no date boundary.
    // A more robust caller can pre-group by session.
    const sessionSize = Math.max(1, Math.floor(historicalCandles.length / lookback));
    for (let i = 0; i + sessionSize <= historicalCandles.length; i += sessionSize) {
      const session = historicalCandles.slice(i, i + sessionSize);
      const sHigh = Math.max(...session.map((c) => c.high));
      const sLow = Math.min(...session.map((c) => c.low));
      const sDtr = sHigh - sLow;
      if (sDtr > 0) histDtrs.push(sDtr);
    }
  }

  const avgHistoricalDtr =
    histDtrs.length > 0
      ? histDtrs.reduce((s, v) => s + v, 0) / histDtrs.length
      : null;

  const dtrVsAverage =
    avgHistoricalDtr != null && avgHistoricalDtr > 0 ? dtr / avgHistoricalDtr : null;

  // ── Range regime ──
  let rangeRegime: DtrRegime | null = null;
  if (dtrVsAverage != null) {
    if (dtrVsAverage < 0.7) rangeRegime = "COMPRESSED";
    else if (dtrVsAverage > 1.4) rangeRegime = "EXPANDED";
    else rangeRegime = "NORMAL";
  }

  // ── ATR(14) ──
  const atr14 = computeATR([...todayCandles, ...(historicalCandles ?? [])], 14);
  const atr14Pct =
    price > 0 && atr14 > 0 ? computeATRPercent(atr14, price) : null;
  const atrRegime = atr14Pct != null ? classifyATRRegime(atr14Pct) : null;

  // ── Remaining range ──
  const distanceTraveled = Math.abs(price - todayLow);
  const remainingRangeVal = dtr > 0 ? Math.max(0, dtr - distanceTraveled) : null;
  const remainingRangePct = remainingRangeVal != null && dtr > 0 ? (remainingRangeVal / dtr) * 100 : null;

  // ── Sufficiency ──
  const sufficientData =
    todayCandles.length >= 5 &&
    histDtrs.length >= 5 &&
    Number.isFinite(price);

  return {
    dtr,
    dtrUtilization,
    avgHistoricalDtr,
    dtrVsAverage,
    openingGap,
    openingGapPct,
    atr14,
    atr14Pct,
    atrRegime,
    rangeRegime,
    remainingRange: remainingRangeVal,
    remainingRangePct,
    sufficientData,
    insufficientReason: sufficientData ? null : "insufficient candle history",
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Convenience: single-session DTR (today only, no historical comparison)
// ────────────────────────────────────────────────────────────────────────────

/** Lightweight DTR for a single session — no historical average, no ATR regime. */
export function calculateSessionDTR(
  todayCandles: Candle[],
  currentPrice?: number,
): Pick<DtrResult, "dtr" | "dtrUtilization" | "openingGap" | "openingGapPct" | "remainingRange" | "remainingRangePct"> {
  if (!todayCandles || todayCandles.length === 0) {
    return { dtr: null, dtrUtilization: null, openingGap: null, openingGapPct: null, remainingRange: null, remainingRangePct: null };
  }

  const lastToday = todayCandles[todayCandles.length - 1];
  const firstToday = todayCandles[0];
  const todayHigh = Math.max(...todayCandles.map((c) => c.high));
  const todayLow = Math.min(...todayCandles.map((c) => c.low));
  const dtr = todayHigh - todayLow;

  const price =
    currentPrice != null && Number.isFinite(currentPrice) && currentPrice > 0
      ? currentPrice
      : lastToday.close;

  return {
    dtr: Number.isFinite(dtr) && dtr > 0 ? dtr : null,
    dtrUtilization: dtr > 0 ? (price - todayLow) / dtr : null,
    openingGap: firstToday.open - lastToday.close,
    openingGapPct: lastToday.close > 0 ? ((firstToday.open - lastToday.close) / lastToday.close) * 100 : null,
    remainingRange: dtr > 0 ? Math.max(0, dtr - Math.abs(price - todayLow)) : null,
    remainingRangePct: dtr > 0 ? (Math.max(0, dtr - Math.abs(price - todayLow)) / dtr) * 100 : null,
  };
}
