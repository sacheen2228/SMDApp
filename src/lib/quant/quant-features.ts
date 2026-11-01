// quant-features.ts — deterministic feature computation from real candles.
//
// ISOLATION: pure module — no fetches, no Date.now(), no network. Look-ahead
// guard: when nowMs is provided only candles at or before it are used; when
// absent, the supplied series IS the cutoff (the caller owns the window).
// Every numeric feature is null when its inputs are insufficient — never
// invented, never NaN.
//
// Definitions (documented thresholds live with their consumers):
//   vwap            Σ(typical×vol)/Σ(vol), typical=(h+l+c)/3; null when Σvol=0
//   vwapDevPct      (close−vwap)/vwap×100
//   emaN            standard EMA on close, seeded with the SMA of the first N
//                   candles; null when fewer than N candles
//   atr14           mean of the last 14 true ranges (first bar TR = h−l);
//                   needs ≥15 candles
//   realizedVol     stdev of per-candle close returns × √252 × 100
//                   (annualized %, daily-sampling convention — regime
//                   thresholds are set on this same scale)
//   sessionHigh/Low max high / min low over the supplied series
//   openRange       high/low of candles within the first 15 minutes of the
//                   series (first candle ts = session start proxy)
//   rangeCompression (last-10-candle high−low) ÷ atr14
//   volumeExpansion last volume ÷ mean volume of all PRIOR candles
//   trendScore      signed % — 0.6×(ema20−ema50)/ema50×100 + 0.4×(ema9−ema20)/ema20×100
//                   (single slope alone when only one pair is computable)
//   gapPct          (first open − prevDayClose)/prevDayClose×100
//   expectedMovePct vix/√252 (daily expected move %)

import type { Candle } from "@/lib/market/canonical";
import type { CanonicalOptionChain } from "@/lib/data-layer/chains/option-chain";
import type { QuantFeatures } from "./quant-types";

export interface ComputeFeaturesInput {
  candles: Candle[];
  spot?: number | null;
  prevDayHigh?: number | null;
  prevDayLow?: number | null;
  prevDayClose?: number | null;
  vix?: number | null;
  chain?: CanonicalOptionChain | null; // reserved for chain-derived features (Phase B)
  nowMs?: number | null;
}

const OPEN_RANGE_MINUTES = 15;
const OPEN_RANGE_MS = OPEN_RANGE_MINUTES * 60_000;
const RANGE_COMPRESSION_BARS = 10;

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let e = seed / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export function computeFeatures(input: ComputeFeaturesInput): QuantFeatures {
  const empty: QuantFeatures = {
    close: null, vwap: null, vwapDevPct: null, ema9: null, ema20: null, ema50: null,
    atr14: null, realizedVol: null, sessionHigh: null, sessionLow: null,
    prevDayHigh: null, prevDayLow: null, prevDayClose: null,
    openRangeHigh: null, openRangeLow: null, rangeCompression: null,
    volumeExpansion: null, trendScore: null, gapPct: null, expectedMovePct: null,
    vix: null, candleCount: 0, lastCandleTs: null,
  };

  const all = Array.isArray(input.candles) ? input.candles : [];
  // Look-ahead guard: keep only candles at or before the cutoff when given.
  const candles = finite(input.nowMs)
    ? all.filter((c) => Date.parse(c.timestamp) <= input.nowMs!)
    : all;
  if (candles.length === 0) {
    return {
      ...empty,
      prevDayHigh: finite(input.prevDayHigh) ? input.prevDayHigh! : null,
      prevDayLow: finite(input.prevDayLow) ? input.prevDayLow! : null,
      prevDayClose: finite(input.prevDayClose) ? input.prevDayClose! : null,
      vix: finite(input.vix) ? input.vix! : null,
      expectedMovePct: finite(input.vix) && input.vix! > 0 ? input.vix! / Math.sqrt(252) : null,
    };
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const last = candles[candles.length - 1];
  const close = finite(last.close) ? last.close : finite(input.spot) ? input.spot! : null;

  // VWAP (typical price × volume)
  let pvSum = 0;
  let volSum = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    pvSum += typical * (finite(c.volume) ? c.volume : 0);
    volSum += finite(c.volume) ? c.volume : 0;
  }
  const vwap = volSum > 0 ? pvSum / volSum : null;
  const vwapDevPct = vwap != null && close != null && vwap !== 0 ? ((close - vwap) / vwap) * 100 : null;

  const ema9 = ema(closes, 9);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  // ATR14 — true ranges over the series (first bar TR = high − low)
  let atr14: number | null = null;
  if (candles.length >= 15) {
    const trs: number[] = [];
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const prevClose = i > 0 ? candles[i - 1].close : null;
      const tr = prevClose != null
        ? Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
        : c.high - c.low;
      trs.push(tr);
    }
    const last14 = trs.slice(-14);
    const atr = last14.reduce((a, b) => a + b, 0) / last14.length;
    atr14 = atr > 0 ? atr : null;
  }

  // Realized vol — stdev of close-to-close returns, annualized
  let realizedVol: number | null = null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
  }
  const sd = stdev(rets);
  if (sd != null) realizedVol = sd * Math.sqrt(252) * 100;

  const sessionHigh = Math.max(...highs.filter(finite));
  const sessionLow = Math.min(...lows.filter(finite));
  const hasSession = highs.some(finite) && lows.some(finite);

  // Open range — first 15 minutes from the first candle's timestamp
  let openRangeHigh: number | null = null;
  let openRangeLow: number | null = null;
  const firstTs = Date.parse(candles[0].timestamp);
  if (Number.isFinite(firstTs)) {
    const ors = candles.filter((c) => Date.parse(c.timestamp) - firstTs <= OPEN_RANGE_MS);
    if (ors.length > 0) {
      openRangeHigh = Math.max(...ors.map((c) => c.high));
      openRangeLow = Math.min(...ors.map((c) => c.low));
    }
  }

  // Range compression — last-10 range vs ATR
  let rangeCompression: number | null = null;
  if (atr14 != null && atr14 > 0 && candles.length >= 2) {
    const recent = candles.slice(-RANGE_COMPRESSION_BARS);
    const hi = Math.max(...recent.map((c) => c.high));
    const lo = Math.min(...recent.map((c) => c.low));
    rangeCompression = (hi - lo) / atr14;
  }

  // Volume expansion — last volume vs mean of prior candles
  let volumeExpansion: number | null = null;
  if (candles.length >= 2 && finite(last.volume)) {
    const prior = volumes.slice(0, -1).filter(finite);
    if (prior.length > 0) {
      const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
      if (avg > 0) volumeExpansion = last.volume / avg;
    }
  }

  // Trend score — signed EMA-slope composite (%)
  let trendScore: number | null = null;
  const slope20 = ema20 != null && ema50 != null && ema50 !== 0 ? ((ema20 - ema50) / ema50) * 100 : null;
  const slope9 = ema9 != null && ema20 != null && ema20 !== 0 ? ((ema9 - ema20) / ema20) * 100 : null;
  if (slope20 != null && slope9 != null) trendScore = slope20 * 0.6 + slope9 * 0.4;
  else trendScore = slope20 ?? slope9;

  // Gap vs previous close
  const firstOpen = finite(candles[0].open) ? candles[0].open : null;
  const prevDayClose = finite(input.prevDayClose) ? input.prevDayClose! : null;
  const gapPct = firstOpen != null && prevDayClose != null && prevDayClose > 0
    ? ((firstOpen - prevDayClose) / prevDayClose) * 100
    : null;

  const vix = finite(input.vix) ? input.vix! : null;
  const expectedMovePct = vix != null && vix > 0 ? vix / Math.sqrt(252) : null;

  return {
    close,
    vwap,
    vwapDevPct,
    ema9,
    ema20,
    ema50,
    atr14,
    realizedVol,
    sessionHigh: hasSession ? sessionHigh : null,
    sessionLow: hasSession ? sessionLow : null,
    prevDayHigh: finite(input.prevDayHigh) ? input.prevDayHigh! : null,
    prevDayLow: finite(input.prevDayLow) ? input.prevDayLow! : null,
    prevDayClose,
    openRangeHigh,
    openRangeLow,
    rangeCompression,
    volumeExpansion,
    trendScore,
    gapPct,
    expectedMovePct,
    vix,
    candleCount: candles.length,
    lastCandleTs: last.timestamp ?? null,
  };
}
