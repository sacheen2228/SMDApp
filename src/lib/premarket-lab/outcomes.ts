// Phase 11 outcomes — 5m / 15m / 30m / EOD from REAL candles only.
// No fabrication: missing prints → null labels + note. Pure functions.

import type { ShadowOutcomes, PreopenStudyDay } from "./types";
import { gapContinued, gapReversed, gapPct } from "./analytics";

export interface CandleBar {
  time: number; // epoch ms or seconds — caller normalizes
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface OutcomeInput {
  /** Candles for the trade date, sorted ascending. Interval in ms. */
  candles: CandleBar[];
  /** Interval length in minutes (e.g. 5, 15, 30, 1d). */
  intervalMin: number;
  prevClose: number | null;
  /** Session open — if not in candles, first bar open is used. */
  sessionOpen?: number | null;
}

function toMs(t: number): number {
  // Heuristic: values below 1e12 are seconds
  return t < 1e12 ? t * 1000 : t;
}

/** First bar open of the session (after 09:15 IST when interval is intraday). */
export function sessionOpenFromCandles(candles: CandleBar[]): number | null {
  if (!candles.length) return null;
  const first = candles[0];
  return Number.isFinite(first.open) ? first.open : null;
}

/**
 * Close at approximately `minutesAfterOpen` minutes after the first bar.
 * Uses the bar whose start is the last one with start < open+minutes.
 */
export function closeAtMinutes(candles: CandleBar[], intervalMin: number, minutesAfterOpen: number): number | null {
  if (!candles.length) return null;
  const openMs = toMs(candles[0].time);
  const target = openMs + minutesAfterOpen * 60_000;
  let best: CandleBar | null = null;
  for (const c of candles) {
    const t = toMs(c.time);
    if (t < target) best = c;
    else break;
  }
  // If target falls inside first bar only, still return that bar's close when minutes ≥ interval
  if (!best) {
    if (minutesAfterOpen >= intervalMin) return candles[0].close;
    return null;
  }
  // Prefer a bar that fully covers the horizon when possible
  const covering = candles.filter((c) => toMs(c.time) + intervalMin * 60_000 <= target + intervalMin * 60_000);
  if (covering.length) {
    const lastCovering = covering[covering.length - 1];
    if (toMs(lastCovering.time) <= target) return lastCovering.close;
  }
  return best.close;
}

export function dayHighLow(candles: CandleBar[]): { high: number | null; low: number | null } {
  if (!candles.length) return { high: null, low: null };
  let high = -Infinity;
  let low = Infinity;
  for (const c of candles) {
    if (Number.isFinite(c.high)) high = Math.max(high, c.high);
    if (Number.isFinite(c.low)) low = Math.min(low, c.low);
  }
  return {
    high: Number.isFinite(high) ? high : null,
    low: Number.isFinite(low) ? low : null,
  };
}

function dirLabel(from: number | null, to: number | null): 0 | 1 | null {
  if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (to === from) return null;
  return to > from ? 1 : 0;
}

/**
 * Compute multi-horizon outcomes from real bars.
 * Labels are vs session open (not prev close) for 5/15/30m.
 * EOD gap cont/rev use prevClose when present.
 */
export function computeOutcomes(input: OutcomeInput): ShadowOutcomes {
  const notes: string[] = [];
  const { candles, intervalMin, prevClose } = input;
  if (!candles.length) {
    notes.push("no_candles");
    return emptyOutcomes(notes);
  }

  const open = input.sessionOpen ?? sessionOpenFromCandles(candles);
  if (open == null) notes.push("no_open_print");

  const close5 = closeAtMinutes(candles, intervalMin, 5);
  const close15 = closeAtMinutes(candles, intervalMin, 15);
  const close30 = closeAtMinutes(candles, intervalMin, 30);
  const eod = candles[candles.length - 1]?.close ?? null;
  const { high, low } = dayHighLow(candles);

  if (close5 == null) notes.push("missing_5m");
  if (close15 == null) notes.push("missing_15m");
  if (close30 == null) notes.push("missing_30m");
  if (eod == null) notes.push("missing_eod");

  const gap = prevClose != null && open != null ? gapPct(open, prevClose) : null;
  const cont = gapContinued(gap, open, eod);
  const rev = gapReversed(gap, prevClose, eod);

  return {
    open,
    close5m: close5,
    close15m: close15,
    close30m: close30,
    eodClose: eod,
    dayHigh: high,
    dayLow: low,
    label5m: dirLabel(open, close5),
    label15m: dirLabel(open, close15),
    label30m: dirLabel(open, close30),
    labelEod: dirLabel(open, eod),
    gapContEod: cont == null ? null : cont ? 1 : 0,
    gapRevEod: rev == null ? null : rev ? 1 : 0,
    notes,
  };
}

function emptyOutcomes(notes: string[]): ShadowOutcomes {
  return {
    open: null, close5m: null, close15m: null, close30m: null, eodClose: null,
    dayHigh: null, dayLow: null,
    label5m: null, label15m: null, label30m: null, labelEod: null,
    gapContEod: null, gapRevEod: null,
    notes,
  };
}

/** Derive day open/high/low/close onto a study day (mutates a copy). */
export function attachOutcomesToStudyDay(
  day: PreopenStudyDay,
  outcomes: ShadowOutcomes,
): PreopenStudyDay {
  return {
    ...day,
    open: {
      spotOpen: outcomes.open,
      futuresOpen: day.open?.futuresOpen ?? null,
      dayHigh: outcomes.dayHigh,
      dayLow: outcomes.dayLow,
      dayClose: outcomes.eodClose,
      volume: day.open?.volume ?? null,
    },
  };
}
