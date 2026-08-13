// Stage 3 — Market Data Analyst Layer
// VWAP + Volume Structure analysis: session VWAP, anchored VWAP, volume
// profile (POC / VAH / VAL), and ATR-based volatility-adjusted stops.
//
// These are computed from the same daily candles the scanner already pulls
// from Yahoo Finance — no new data source required. Where real intraday
// data isn't available we derive a daily-session VWAP from OHLCV and clearly
// label it as such (the desk-analyst read still holds for weekly structure).

import { Candle } from "@/lib/ml-engine";

export interface VolumeStructure {
  // Session VWAP (derived from latest daily bar, or anchored if requested)
  sessionVwap: number;
  vwapPosition: "ABOVE" | "BELOW";
  // Anchored VWAP from a meaningful anchor (swing low of last 60 sessions)
  anchoredVwap: number;
  anchoredVwapPosition: "ABOVE" | "BELOW";
  // Volume profile over the lookback (default 120 sessions)
  poc: number;            // Point of Control — heaviest traded level
  vah: number;            // Value Area High (~70% of volume)
  val: number;            // Value Area Low
  priceInValueArea: boolean;
  // ATR-based risk
  atr14: number;
  atrStopLong: number;    // Entry - 1.5 x ATR
  atrExpansionFlag: boolean; // ATR unusually wide vs 3-month average
  // Desk-note synthesis
  read: string;
}

function typicalPrice(c: Candle): number {
  return (c.high + c.low + c.close) / 3;
}

function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ));
  }
  const n = Math.min(period, trs.length);
  return trs.slice(-n).reduce((s, v) => s + v, 0) / n;
}

function findAnchorIndex(candles: Candle[], lookback: number): number {
  const start = Math.max(0, candles.length - lookback);
  let anchor = start;
  let minLow = Infinity;
  for (let i = start; i < candles.length; i++) {
    if (candles[i].low < minLow) {
      minLow = candles[i].low;
      anchor = i;
    }
  }
  return anchor;
}

// Anchored VWAP from a swing-low anchor within the lookback window.
function anchoredVwap(candles: Candle[], anchorIndex: number): number {
  if (anchorIndex < 0 || anchorIndex >= candles.length) return 0;
  let cumVP = 0;
  let cumV = 0;
  for (let i = anchorIndex; i < candles.length; i++) {
    const c = candles[i];
    if (c.volume <= 0) continue;
    cumVP += typicalPrice(c) * c.volume;
    cumV += c.volume;
  }
  return cumV > 0 ? cumVP / cumV : 0;
}

// Volume profile with ~70% value area. Buckets price into ~40 bins over the
// lookback and finds the heaviest bin (POC), then expands around POC until
// cumulative volume reaches 70% of total.
function volumeProfile(candles: Candle[], lookback = 120) {
  const slice = candles.slice(-lookback).filter(c => c.volume > 0);
  if (!slice.length) return { poc: 0, vah: 0, val: 0, total: 0 };

  const prices = slice.map(c => c.close);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (max <= min) return { poc: min, vah: min, val: min, total: slice.reduce((s, c) => s + c.volume, 0) };

  const BINS = 40;
  const binWidth = (max - min) / BINS;
  const bins = new Array<number>(BINS).fill(0);
  for (const c of slice) {
    const idx = Math.min(BINS - 1, Math.floor((c.close - min) / binWidth));
    bins[idx] += c.volume;
  }

  let pocIdx = 0;
  let maxVol = 0;
  for (let i = 0; i < BINS; i++) {
    if (bins[i] > maxVol) {
      maxVol = bins[i];
      pocIdx = i;
    }
  }
  const poc = min + (pocIdx + 0.5) * binWidth;

  // Expand around POC to 70% of total volume
  const total = bins.reduce((s, v) => s + v, 0);
  const target = total * 0.7;
  let acc = bins[pocIdx];
  let lo = pocIdx;
  let hi = pocIdx;
  while (acc < target && (lo > 0 || hi < BINS - 1)) {
    const below = lo > 0 ? bins[lo - 1] : 0;
    const above = hi < BINS - 1 ? bins[hi + 1] : 0;
    if (below >= above && lo > 0) {
      lo--;
      acc += bins[lo];
    } else if (hi < BINS - 1) {
      hi++;
      acc += bins[hi];
    } else if (lo > 0) {
      lo--;
      acc += bins[lo];
    } else {
      break;
    }
  }
  return {
    poc,
    vah: min + (hi + 1) * binWidth,
    val: min + lo * binWidth,
    total,
  };
}

export function analyzeVolumeStructure(candles: Candle[], lookback = 120): VolumeStructure {
  if (candles.length < 30) {
    return {
      sessionVwap: 0,
      vwapPosition: "BELOW",
      anchoredVwap: 0,
      anchoredVwapPosition: "BELOW",
      poc: 0,
      vah: 0,
      val: 0,
      priceInValueArea: false,
      atr14: 0,
      atrStopLong: 0,
      atrExpansionFlag: false,
      read: "Insufficient data for volume-structure analysis.",
    };
  }

  const price = candles[candles.length - 1].close;
  const atr14 = calcATR(candles, 14);

  // Session VWAP — derived from the latest daily bar (typical price).
  const last = candles[candles.length - 1];
  const sessionVwap = last.volume > 0 ? typicalPrice(last) : 0;

  // Anchored VWAP from the swing low of the last 60 sessions.
  const anchorIdx = findAnchorIndex(candles, 60);
  const aVwap = anchoredVwap(candles, anchorIdx);

  const vp = volumeProfile(candles, lookback);

  const inValueArea = vp.val > 0 && price >= vp.val && price <= vp.vah;

  // ATR expansion vs its own 3-month (60-session) average.
  let atrExpansion = false;
  if (candles.length > 75) {
    const earlier = candles.slice(0, -15);
    const histAtr = calcATR(earlier, 14);
    if (histAtr > 0 && atr14 / histAtr > 1.3) atrExpansion = true;
  }

  const read = buildDeskRead({
    price,
    sessionVwap,
    aVwap,
    poc: vp.poc,
    vah: vp.vah,
    val: vp.val,
    inValueArea,
    atrExpansion,
  });

  return {
    sessionVwap,
    vwapPosition: sessionVwap > 0 && price >= sessionVwap ? "ABOVE" : "BELOW",
    anchoredVwap: aVwap,
    anchoredVwapPosition: aVwap > 0 && price >= aVwap ? "ABOVE" : "BELOW",
    poc: vp.poc,
    vah: vp.vah,
    val: vp.val,
    priceInValueArea: inValueArea,
    atr14,
    atrStopLong: price - 1.5 * atr14,
    atrExpansionFlag: atrExpansion,
    read,
  };
}

interface ReadInput {
  price: number;
  sessionVwap: number;
  aVwap: number;
  poc: number;
  vah: number;
  val: number;
  inValueArea: boolean;
  atrExpansion: boolean;
}

function buildDeskRead(i: ReadInput): string {
  const parts: string[] = [];
  const aboveAnchor = i.aVwap > 0 && i.price >= i.aVwap;
  const abovePoc = i.poc > 0 && i.price >= i.poc;

  if (i.inValueArea) {
    parts.push("inside value area");
  } else if (i.price > i.vah && i.vah > 0) {
    parts.push("above value area (fast zone, low resistance)");
  } else if (i.price < i.val && i.val > 0) {
    parts.push("below value area (weak, sellers in control)");
  }

  if (aboveAnchor) {
    parts.push("holding above anchored VWAP");
  } else if (i.aVwap > 0) {
    parts.push("anchored VWAP overhead = supply zone");
  }

  if (i.price >= i.poc && i.poc > 0) {
    parts.push("above POC (magnet below as support)");
  } else if (i.poc > 0) {
    parts.push("below POC — POC overhead is resistance");
  }

  if (i.atrExpansion) parts.push("ATR wide vs 3-mo avg — event risk, size down");

  if (!parts.length) return "Neutral volume structure.";
  return parts.join("; ").replace(/^./, s => s.toUpperCase()) + ".";
}