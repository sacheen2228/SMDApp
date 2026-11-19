// EMA 9/21/50 market-structure engine.
//
// Coherent read of the three EMAs:
//   EMA9   — short-term momentum and immediate price reaction.
//   EMA21  — intraday trend direction, pullback zone, dynamic support/resistance.
//   EMA50  — broader trend filter, structural direction and trend stability.
//
// Pure, offline, client-safe. Reuses the canonical calculations from tech-read.ts
// (emaSeries, atrSeries, adxSeries, vwapSeries, closedOnly, structure,
// liquidityPools, detectSweeps). No look-ahead: everything is computed from
// closed candles only. Nothing here is an entry trigger — setups are
// classified, not executed.

import {
  emaSeries,
  atrSeries,
  adxSeries,
  vwapSeries,
  closedOnly,
  structure as techStructure,
  liquidityPools,
  detectSweeps,
  swings,
  type Candle as TechCandle,
  type Structure as TechStructure,
  type Sweep,
  type Pool,
} from "./tech-read";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EmaCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type EmaAlignment = "BULLISH" | "BEARISH" | "TRANSITIONAL" | "MIXED";

export type EmaSetupType =
  | "EMA9_21_PULLBACK"
  | "EMA21_PULLBACK"
  | "EMA50_RETEST"
  | "BULLISH_BREAKOUT_RETEST"
  | "BEARISH_BREAKDOWN_RETEST"
  | "EMA21_50_REJECTION"
  | "SR_REJECTION"
  | "FAILED_BREAKOUT"
  | "LIQUIDITY_SWEEP_RECLAIM"
  | "GAP_FAILURE"
  | "GAP_CONTINUATION"
  | "TREND_REVERSAL";

export interface EmaVolumeConfirmation {
  confirmed: boolean;
  ratio: number | null;
  reason: string;
}

export interface EmaSetup {
  type: EmaSetupType;
  direction: "BULLISH" | "BEARISH";
  emaContext: {
    alignment: EmaAlignment;
    ema9: number | null;
    ema21: number | null;
    ema50: number | null;
    slope21: number | null;
    slope50: number | null;
  };
  referenceLevel: number;
  confirmationCandle: EmaCandle | null;
  volumeConfirmation: EmaVolumeConfirmation;
  invalidation: number;
  followThroughRequired: string;
  timestamp: number;
  dataQuality: "LIVE" | "FRESH" | "STALE" | "INSUFFICIENT";
  /** A classification alone is never an entry trigger. */
  confirmed: boolean;
}

export interface EmaStructure {
  alignment: EmaAlignment;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  slope9: number | null;
  slope21: number | null;
  slope50: number | null;
  separation9_21Atr: number | null;
  separation21_50Atr: number | null;
  compression: boolean;
  compressionBars: number;
  chop: boolean;
  crossesLast30: number;
  adx: number | null;
  plusDI: number | null;
  minusDI: number | null;
  atr: number | null;
  vwap: number | null;
  vsVwap: "ABOVE" | "BELOW" | "NA";
  rvol: number | null;
  structure: TechStructure;
  pools: Pool[];
  sweeps: Sweep[];
  setups: EmaSetup[];
  dataQuality: "LIVE" | "FRESH" | "STALE" | "INSUFFICIENT";
  bars: number;
  lastCandleTime: number | null;
}

export const EMA_STRUCTURE_CONFIG = {
  fast: 9,
  mid: 21,
  slow: 50,
  atrPeriod: 14,
  adxPeriod: 14,
  slopeLookback: 3,
  crossLookback: 30,
  chopCrosses: 3,
  compressionAtr: 0.8,
  compressionLookback: 20,
  rvolPeriod: 20,
  rvolMin: 1.2,
  pullbackWindow: 3,
  retestBars: 3,
  gapPct: 0.3,
  zoneAtr: 0.5,
  stopBufAtr: 0.25,
  invalidationAtr: 0.5,
  minBars: 60,
  maxEventBarsAgo: 3,
  sweepBarsAgo: 2,
} as const;

// ─── Classification helpers ──────────────────────────────────────────────────

export function classifyAlignment(
  ema9: number,
  ema21: number,
  ema50: number,
): EmaAlignment {
  if (!Number.isFinite(ema9) || !Number.isFinite(ema21) || !Number.isFinite(ema50)) {
    return "MIXED";
  }
  if (ema9 > ema21 && ema21 > ema50) return "BULLISH";
  if (ema9 < ema21 && ema21 < ema50) return "BEARISH";
  return "TRANSITIONAL";
}

function classifyDirection(
  alignment: EmaAlignment,
  slope21: number | null,
): "BULLISH" | "BEARISH" | "NEUTRAL" {
  if (alignment === "BULLISH" && slope21 != null && slope21 > 0) return "BULLISH";
  if (alignment === "BEARISH" && slope21 != null && slope21 < 0) return "BEARISH";
  return "NEUTRAL";
}

function isFiniteOrNull(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ─── Candle conversion ───────────────────────────────────────────────────────

function toTech(c: EmaCandle): TechCandle {
  return { t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume };
}

// ─── Core engine ─────────────────────────────────────────────────────────────

export function analyzeEmaStructure(
  candles: EmaCandle[],
  opts: {
    symbol?: string;
    nowMs?: number;
    config?: Partial<typeof EMA_STRUCTURE_CONFIG>;
  } = {},
): EmaStructure {
  const cfg = { ...EMA_STRUCTURE_CONFIG, ...(opts.config ?? {}) };
  const nowMs = opts.nowMs ?? Date.now();
  const symbol = opts.symbol ?? "UNKNOWN";

  const closedTech = closedOnly(candles.map(toTech), nowMs);
  const closed: EmaCandle[] = closedTech.map((c) => ({
    time: c.t,
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c,
    volume: c.v ?? 0,
  }));

  const n = closed.length - 1;
  const insufficient = n < cfg.minBars;

  const result: Omit<EmaStructure, never> = {
    alignment: "MIXED",
    direction: "NEUTRAL",
    ema9: null,
    ema21: null,
    ema50: null,
    slope9: null,
    slope21: null,
    slope50: null,
    separation9_21Atr: null,
    separation21_50Atr: null,
    compression: false,
    compressionBars: 0,
    chop: false,
    crossesLast30: 0,
    adx: null,
    plusDI: null,
    minusDI: null,
    atr: null,
    vwap: null,
    vsVwap: "NA",
    rvol: null,
    structure: { trend: "RANGE" },
    pools: [],
    sweeps: [],
    setups: [],
    dataQuality: insufficient ? "INSUFFICIENT" : qualityOf(closed[n]?.time ?? 0, nowMs, closed),
    bars: closed.length,
    lastCandleTime: closed[n]?.time ?? null,
  };

  if (insufficient) {
    return result as EmaStructure;
  }

  const closes = closed.map((c) => c.close);
  const e9s = emaSeries(closes, cfg.fast);
  const e21s = emaSeries(closes, cfg.mid);
  const e50s = emaSeries(closes, cfg.slow);
  const atrS = atrSeries(closed.map(toTech), cfg.atrPeriod);
  const adxR = adxSeries(closed.map(toTech), cfg.adxPeriod);
  const vwS = vwapSeries(closed.map(toTech));
  const lastIdx = closed.length - 1;

  const ema9 = isFiniteOrNull(e9s[lastIdx]);
  const ema21 = isFiniteOrNull(e21s[lastIdx]);
  const ema50 = isFiniteOrNull(e50s[lastIdx]);
  const atrNow = isFiniteOrNull(atrS[lastIdx]);
  const adxNow = isFiniteOrNull(adxR.adx[lastIdx]);
  const plusDI = isFiniteOrNull(adxR.pdi[lastIdx]);
  const minusDI = isFiniteOrNull(adxR.mdi[lastIdx]);
  const vwapNow = isFiniteOrNull(vwS[lastIdx]);

  const alignment = classifyAlignment(ema9 ?? 0, ema21 ?? 0, ema50 ?? 0);

  // Slope: change over slopeLookback bars, normalised by ATR.
  const slopeOf = (series: (number | undefined)[], lookback: number): number | null => {
    const now = series[lastIdx];
    const then = series[lastIdx - lookback];
    const a = atrNow;
    if (now == null || then == null || a == null || a <= 0) return null;
    return (now - then) / a;
  };
  const slope9 = slopeOf(e9s, cfg.slopeLookback);
  const slope21 = slopeOf(e21s, cfg.slopeLookback);
  const slope50 = slopeOf(e50s, cfg.slopeLookback);

  const sep9_21 =
    ema9 != null && ema21 != null && atrNow != null && atrNow > 0
      ? Math.abs(ema9 - ema21) / atrNow
      : null;
  const sep21_50 =
    ema21 != null && ema50 != null && atrNow != null && atrNow > 0
      ? Math.abs(ema21 - ema50) / atrNow
      : null;

  // Compression: three EMAs banded tightly relative to ATR.
  const compressionBars = countCompression(closes, e9s, e21s, e50s, atrS, cfg);
  const compression =
    ema9 != null && ema21 != null && ema50 != null && atrNow != null && atrNow > 0
      ? Math.max(ema9, ema21, ema50) - Math.min(ema9, ema21, ema50) < cfg.compressionAtr * atrNow
      : false;

  // Chop: repeated EMA9/EMA21 false crosses, or a collapsed spread.
  const crossesLast30 = countCrossesLastN(e9s, e21s, cfg.crossLookback);
  const chop =
    crossesLast30 >= cfg.chopCrosses ||
    (sep9_21 != null && sep9_21 < cfg.compressionAtr * 0.3);

  const direction = classifyDirection(alignment, slope21);
  const vsVwap =
    vwapNow != null && vwapNow > 0 && closed[lastIdx].close > 0
      ? closed[lastIdx].close >= vwapNow
        ? "ABOVE"
        : "BELOW"
      : "NA";

  // Relative volume of the last closed bar.
  const rvol = rvolOf(closed, lastIdx, cfg.rvolPeriod);

  const str = techStructure(closed.map(toTech), 2, cfg.maxEventBarsAgo + 2);
  const pools =
    atrNow != null && atrNow > 0 ? liquidityPools(closed.map(toTech), symbol, atrNow, 2) : [];
  const sweeps =
    atrNow != null && atrNow > 0 ? detectSweeps(closed.map(toTech), pools, atrNow, cfg.sweepBarsAgo) : [];

  const setups = detectSetups({
    closed,
    n: lastIdx,
    ema9, ema21, ema50,
    slope21, slope50,
    atr: atrNow,
    alignment,
    structure: str,
    pools,
    sweeps,
    rvol,
    dataQuality: result.dataQuality,
    cfg,
    closed: closed,
  });

  return {
    alignment,
    direction,
    ema9,
    ema21,
    ema50,
    slope9,
    slope21,
    slope50,
    separation9_21Atr: sep9_21,
    separation21_50Atr: sep21_50,
    compression,
    compressionBars,
    chop,
    crossesLast30,
    adx: adxNow,
    plusDI,
    minusDI,
    atr: atrNow,
    vwap: vwapNow,
    vsVwap,
    rvol,
    structure: str,
    pools,
    sweeps,
    setups,
    dataQuality: result.dataQuality,
    bars: closed.length,
    lastCandleTime: closed[lastIdx]?.time ?? null,
  };
}

function countCompression(
  closes: number[],
  e9s: (number | undefined)[],
  e21s: (number | undefined)[],
  e50s: (number | undefined)[],
  atrS: (number | undefined)[],
  cfg: typeof EMA_STRUCTURE_CONFIG,
): number {
  const n = closes.length - 1;
  let bars = 0;
  const start = Math.max(0, n - cfg.compressionLookback + 1);
  for (let i = start; i <= n; i++) {
    const e9 = e9s[i], e21 = e21s[i], e50 = e50s[i], a = atrS[i];
    if (e9 == null || e21 == null || e50 == null || a == null || a <= 0) continue;
    const band = Math.max(e9, e21, e50) - Math.min(e9, e21, e50);
    if (band < cfg.compressionAtr * a) bars += 1;
  }
  return bars;
}

function countCrossesLastN(
  e9s: (number | undefined)[],
  e21s: (number | undefined)[],
  lookback: number,
): number {
  const n = e9s.length - 1;
  const start = Math.max(1, n - lookback + 1);
  let crosses = 0;
  for (let i = start; i <= n; i++) {
    const a = e9s[i], b = e21s[i], pa = e9s[i - 1], pb = e21s[i - 1];
    if (a == null || b == null || pa == null || pb == null) continue;
    const aboveNow = a > b;
    const abovePrev = pa > pb;
    if (aboveNow !== abovePrev) crosses += 1;
  }
  return crosses;
}

function rvolOf(candles: EmaCandle[], idx: number, period: number): number | null {
  const n = candles.length;
  const start = Math.max(0, idx - period);
  const hist = candles.slice(start, idx).map((c) => c.volume).filter((v) => Number.isFinite(v) && v > 0);
  const cur = candles[idx].volume;
  if (!Number.isFinite(cur) || cur <= 0 || hist.length === 0) return null;
  const avg = hist.reduce((s, v) => s + v, 0) / hist.length;
  return avg > 0 ? cur / avg : null;
}

function qualityOf(
  lastTime: number | null,
  nowMs: number,
  closed: EmaCandle[],
): "LIVE" | "FRESH" | "STALE" | "INSUFFICIENT" {
  if (lastTime == null) return "INSUFFICIENT";
  const spacing = medianSpacing(closed);
  const age = nowMs - lastTime;
  if (spacing > 0 && age <= spacing * 2) return "LIVE";
  if (spacing > 0 && age <= spacing * 10) return "FRESH";
  return "STALE";
}

function medianSpacing(candles: EmaCandle[]): number {
  if (candles.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    gaps.push(candles[i].time - candles[i - 1].time);
  }
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

// ─── Setup detection ─────────────────────────────────────────────────────────

type SetupCtx = {
  closed: EmaCandle[];
  n: number;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  slope21: number | null;
  slope50: number | null;
  atr: number | null;
  alignment: EmaAlignment;
  structure: TechStructure;
  pools: Pool[];
  sweeps: Sweep[];
  rvol: number | null;
  dataQuality: EmaSetup["dataQuality"];
  cfg: typeof EMA_STRUCTURE_CONFIG;
};

function detectSetups(ctx: SetupCtx): EmaSetup[] {
  const { closed, n, atr } = ctx;
  const cfg = ctx.cfg ?? EMA_STRUCTURE_CONFIG;
  const out: EmaSetup[] = [];
  if (n < cfg.pullbackWindow) return out;
  const close = closed[n].close;
  const open = closed[n].open;
  const high = closed[n].high;
  const low = closed[n].low;

  const v = (i: number) => closed[i];

  const windowLow = (lookback: number): number => {
    let m = Infinity;
    const start = Math.max(0, n - lookback);
    for (let i = start; i <= n - 1; i++) m = Math.min(m, v(i).low);
    return m === Infinity ? 0 : m;
  };
  const windowHigh = (lookback: number): number => {
    let m = -Infinity;
    const start = Math.max(0, n - lookback);
    for (let i = start; i <= n - 1; i++) m = Math.max(m, v(i).high);
    return m === -Infinity ? 0 : m;
  };

  const confirmVol = () => {
    const ratio = ctx.rvol;
    const confirmed = ratio != null && ratio >= ctx.cfg.rvolMin;
    return {
      confirmed,
      ratio,
      reason: confirmed
        ? `volume confirmed (rvol ${ratio!.toFixed(2)}x)`
        : `volume below threshold (rvol ${ratio == null ? "n/a" : ratio.toFixed(2)}x)`,
    };
  };

  const put = (
    type: EmaSetup["type"],
    direction: EmaSetup["direction"],
    referenceLevel: number,
    invalidation: number,
    confirmation: EmaCandle | null,
    reason: string,
  ) => {
    const vol = confirmVol();
    const confirmed = vol.confirmed && confirmation != null;
    out.push({
      type,
      direction,
      emaContext: {
        alignment: ctx.alignment,
        ema9: ctx.ema9,
        ema21: ctx.ema21,
        ema50: ctx.ema50,
        slope21: ctx.slope21,
        slope50: ctx.slope50,
      },
      referenceLevel,
      confirmationCandle: confirmation,
      volumeConfirmation: vol,
      invalidation,
      followThroughRequired: reason,
      timestamp: confirmation ? confirmation.time : closed[n].time,
      dataQuality: ctx.alignment === "MIXED" ? "INSUFFICIENT" : (ctx as any).dataQuality ?? "LIVE",
      confirmed,
    });
  };

  const zoneUp = (level: number) => level + (ctx.cfg.zoneAtr * (atr ?? 0));
  const zoneDown = (level: number) => level - (ctx.cfg.zoneAtr * (atr ?? 0));

  // ── 1. EMA9/21 pullback ──
  if (atr != null && ctx.ema9 != null && ctx.ema21 != null) {
    const wl = windowLow(ctx.cfg.pullbackWindow);
    const wh = windowHigh(ctx.cfg.pullbackWindow);
    // Bullish pullback into the EMA9/EMA21 zone, then hold.
    if (ctx.alignment === "BULLISH" && wl <= zoneUp(ctx.ema21) && close > ctx.ema21 && close > open) {
      put("EMA21_PULLBACK", "BULLISH", ctx.ema21, wl - ctx.cfg.stopBufAtr * atr, closed[n],
        "close holds above EMA21 for 2 closed bars");
    }
    // Bearish pullback into the EMA9/EMA21 zone, then hold.
    if (ctx.alignment === "BEARISH" && wh >= zoneDown(ctx.ema21) && close < ctx.ema21 && close < open) {
      put("EMA21_PULLBACK", "BEARISH", ctx.ema21, wh + ctx.cfg.stopBufAtr * atr, closed[n],
        "close holds below EMA21 for 2 closed bars");
    }
  }

  // ── 2. EMA50 retest ──
  if (atr != null && ctx.ema21 != null && ctx.ema50 != null) {
    // Bullish retest of EMA50 within an EMA21 > EMA50 context.
    if (
      ctx.ema21 > ctx.ema50 &&
      low <= ctx.ema50 + ctx.cfg.retestBars * atr &&
      close > ctx.ema50 &&
      close > open
    ) {
      put("EMA50_RETEST", "BULLISH", ctx.ema50, windowLow(ctx.cfg.pullbackWindow) - ctx.cfg.stopBufAtr * atr, closed[n],
        "close holds above EMA50 for 2 closed bars");
    }
    // Bearish retest of EMA50 within an EMA21 < EMA50 context.
    if (
      ctx.ema21 < ctx.ema50 &&
      high >= ctx.ema50 - ctx.cfg.retestBars * atr &&
      close < ctx.ema50 &&
      close < open
    ) {
      put("EMA50_RETEST", "BEARISH", ctx.ema50, windowHigh(ctx.cfg.pullbackWindow) + ctx.cfg.stopBufAtr * atr, closed[n],
        "close holds below EMA50 for 2 closed bars");
    }
  }

  // ── 3. EMA21/50 rejection ──
  if (atr != null && ctx.ema21 != null && ctx.ema50 != null) {
    // Price poked above EMA21 (bearish context) and rejected back below it.
    if (ctx.alignment === "BEARISH" && high >= ctx.ema21 && close < ctx.ema21 && open < ctx.ema21) {
      put("EMA21_50_REJECTION", "BEARISH", ctx.ema21, ctx.ema21 + ctx.cfg.stopBufAtr * atr, closed[n],
        "close below EMA21 for 2 closed bars");
    }
    // Price poked below EMA21 (bullish context) and rejected back above it.
    if (ctx.alignment === "BULLISH" && low <= ctx.ema21 && close > ctx.ema21 && open > ctx.ema21) {
      put("EMA21_50_REJECTION", "BULLISH", ctx.ema21, ctx.ema21 - ctx.cfg.stopBufAtr * atr, closed[n],
        "close above EMA21 for 2 closed bars");
    }
  }

  // ── 4. Breakout / breakdown retest ──
  const event = ctx.structure.event;
  const eventBarsAgo = ctx.structure.eventBarsAgo ?? 0;
  if (event != null && eventBarsAgo != null && eventBarsAgo <= ctx.cfg.maxEventBarsAgo && atr != null) {
    const retestZone = (ref: number) =>
      windowLow(ctx.cfg.pullbackWindow) <= ref + ctx.cfg.zoneAtr * atr;
    if (event === "BOS_UP") {
      const ref = ctx.structure.lastHigh?.price ?? windowHigh(ctx.cfg.retestBars);
      if (ref > 0 && close > ref && retestZone(ref)) {
        put("BULLISH_BREAKOUT_RETEST", "BULLISH", ref, ref - ctx.cfg.stopBufAtr * atr, closed[n],
          "close holds above the broken level for 2 closed bars");
      }
    } else if (event === "BOS_DOWN") {
      const ref = ctx.structure.lastLow?.price ?? windowLow(ctx.cfg.retestBars);
      if (ref > 0 && close < ref && windowHigh(ctx.cfg.pullbackWindow) >= ref - ctx.cfg.zoneAtr * atr) {
        put("BEARISH_BREAKDOWN_RETEST", "BEARISH", ref, ref + ctx.cfg.stopBufAtr * atr, closed[n],
          "close holds below the broken level for 2 closed bars");
      }
    }
  }

  // ── 5. Failed breakout / breakdown ──
  const refHigh = windowHigh(ctx.cfg.pullbackWindow + 20);
  const refLow = windowLow(ctx.cfg.pullbackWindow + 20);
  if (high > refHigh && close < refHigh && refHigh > 0 && Number.isFinite(refHigh)) {
    put("FAILED_BREAKOUT", "BEARISH", refHigh, refHigh + ctx.cfg.stopBufAtr * (atr ?? 0), closed[n],
      "close below the broken high for 2 closed bars");
  }
  if (low < refLow && close > refLow && refLow > 0 && Number.isFinite(refLow)) {
    put("FAILED_BREAKOUT", "BULLISH", refLow, refLow - ctx.cfg.stopBufAtr * (atr ?? 0), closed[n],
      "close above the broken low for 2 closed bars");
  }

  // ── 6. Liquidity sweep + reclaim ──
  for (const sw of ctx.sweeps) {
    if (sw.barsAgo != null && sw.barsAgo <= ctx.cfg.sweepBarsAgo) {
      if (sw.bias === "BULLISH") {
        put("LIQUIDITY_SWEEP_RECLAIM", "BULLISH", sw.level, sw.level - ctx.cfg.stopBufAtr * (atr ?? 0), closed[n],
          "close holds above the swept level for 2 closed bars");
      } else {
        put("LIQUIDITY_SWEEP_RECLAIM", "BEARISH", sw.level, sw.level + ctx.cfg.stopBufAtr * (atr ?? 0), closed[n],
          "close holds below the swept level for 2 closed bars");
      }
    }
  }

  // ── 7. Gap failure / continuation ──
  const prev = closed[n - 1];
  const gapPct = ctx.cfg.gapPct / 100;
  if (atr != null) {
    const gappedUp = open > prev.close * (1 + gapPct);
    const gappedDown = open < prev.close * (1 - gapPct);
    if (gappedUp && close < prev.close) {
      put("GAP_FAILURE", "BEARISH", prev.close, prev.close + ctx.cfg.stopBufAtr * atr, closed[n],
        "close below the prior close for 2 closed bars");
    }
    if (gappedUp && close > prev.close && close > prev.high) {
      put("GAP_CONTINUATION", "BULLISH", prev.high, prev.high - ctx.cfg.stopBufAtr * atr, closed[n],
        "close holds above the prior high for 2 closed bars");
    }
    if (gappedDown && close > prev.close) {
      put("GAP_FAILURE", "BULLISH", prev.close, prev.close - ctx.cfg.stopBufAtr * atr, closed[n],
        "close above the prior close for 2 closed bars");
    }
    if (gappedDown && close < prev.close && close < prev.low) {
      put("GAP_CONTINUATION", "BEARISH", prev.low, prev.low + ctx.cfg.stopBufAtr * atr, closed[n],
        "close holds below the prior low for 2 closed bars");
    }
  }

  // ── 8. Trend reversal after EMA21/50 structural change ──
  if (atr != null && ctx.ema21 != null && ctx.ema50 != null && n >= 3) {
    const prevEma21 = ctx.slope21 != null ? ctx.ema21 - ctx.slope21 * (atr / ctx.cfg.slopeLookback) : null;
    const prevEma50 = ctx.slope50 != null ? ctx.ema50 - ctx.slope50 * (atr / ctx.cfg.slopeLookback) : null;
    // EMA21 crossed EMA50 within the last slopeLookback bars (structural change).
    if (
      prevEma21 != null &&
      prevEma50 != null &&
      prevEma21 <= prevEma50 &&
      ctx.ema21 > ctx.ema50 &&
      ctx.structure.event === "CHOCH_UP" &&
      ctx.structure.eventBarsAgo != null &&
      ctx.structure.eventBarsAgo <= ctx.cfg.maxEventBarsAgo
    ) {
      put("TREND_REVERSAL", "BULLISH", ctx.ema50, windowLow(ctx.cfg.pullbackWindow) - ctx.cfg.stopBufAtr * atr, closed[n],
        "structure CHoCH confirmed and close holds above EMA50 for 2 closed bars");
    }
    if (
      prevEma21 != null &&
      prevEma50 != null &&
      prevEma21 >= prevEma50 &&
      ctx.ema21 < ctx.ema50 &&
      ctx.structure.event === "CHOCH_DOWN" &&
      ctx.structure.eventBarsAgo != null &&
      ctx.structure.eventBarsAgo <= ctx.cfg.maxEventBarsAgo
    ) {
      put("TREND_REVERSAL", "BEARISH", ctx.ema50, windowHigh(ctx.cfg.pullbackWindow) + ctx.cfg.stopBufAtr * atr, closed[n],
        "structure CHoCH confirmed and close holds below EMA50 for 2 closed bars");
    }
  }

  return out;
}

export function hasConfirmedSetup(s: EmaStructure): boolean {
  return s.setups.some((x) => x.confirmed && x.dataQuality !== "STALE" && x.dataQuality !== "INSUFFICIENT");
}
