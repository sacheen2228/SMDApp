// Candle Pattern Engine — pure OHLC detection (Phase 4 §14).
// Evidence only: patterns NEVER trigger trades; they feed the existing
// Momentum / Breakout / Market Structure agents through ctx.technical.
//
// Detection runs on COMPLETED candles only — callers must strip the
// forming candle first (incomplete-candle protection, §21).

import type { CandleData } from '@/types/sdm';

export interface CandlePatternResult {
  pattern: keyof CandlePatterns;
  timestamp: number;
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: number; // 0-100, deterministic from body/wick proportions
  bodyPercent: number;
  upperWickPercent: number;
  lowerWickPercent: number;
}

export interface CandlePatterns {
  doji: CandlePatternResult | null;
  hammer: CandlePatternResult | null;
  shootingStar: CandlePatternResult | null;
  bullishEngulfing: CandlePatternResult | null;
  bearishEngulfing: CandlePatternResult | null;
  morningStar: CandlePatternResult | null;
  eveningStar: CandlePatternResult | null;
  insideBar: CandlePatternResult | null;
  outsideBar: CandlePatternResult | null;
  strongBullish: CandlePatternResult | null;
  strongBearish: CandlePatternResult | null;
  longUpperWick: CandlePatternResult | null;
  longLowerWick: CandlePatternResult | null;
}

interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  range: number;
  body: number;
  bodyPct: number;
  upperPct: number;
  lowerPct: number;
  isGreen: boolean;
  isRed: boolean;
}

function toBar(c: CandleData): Bar | null {
  const range = c.high - c.low;
  if (!(range > 0)) return null;
  const body = Math.abs(c.close - c.open);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  return {
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    range,
    body,
    bodyPct: body / range,
    upperPct: upper / range,
    lowerPct: lower / range,
    isGreen: c.close > c.open,
    isRed: c.close < c.open,
  };
}

function result(
  pattern: keyof CandlePatterns,
  b: Bar,
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
  confidence: number
): CandlePatternResult {
  return {
    pattern,
    timestamp: b.time,
    direction,
    confidence: Math.max(0, Math.min(100, Math.round(confidence))),
    bodyPercent: Math.round(b.bodyPct * 1000) / 1000,
    upperWickPercent: Math.round(b.upperPct * 1000) / 1000,
    lowerWickPercent: Math.round(b.lowerPct * 1000) / 1000,
  };
}

const conf = (base: number, b: Bar) => base + Math.round(b.bodyPct * 30);

// ─── Single-bar patterns ──────────────────────────────────────────

function singleBarPatterns(b: Bar): Partial<CandlePatterns> {
  const out: Partial<CandlePatterns> = {};

  if (b.bodyPct < 0.1) out.doji = result('doji', b, 'NEUTRAL', 50 + Math.round((0.1 - b.bodyPct) * 400));

  if (b.lowerPct >= 0.6 && b.bodyPct <= 0.35 && b.upperPct <= 0.25) {
    out.hammer = result('hammer', b, 'BULLISH', conf(60, b));
  }
  if (b.upperPct >= 0.6 && b.bodyPct <= 0.35 && b.lowerPct <= 0.25) {
    out.shootingStar = result('shootingStar', b, 'BEARISH', conf(60, b));
  }
  if (b.isGreen && b.bodyPct >= 0.6 && b.upperPct <= 0.25) {
    out.strongBullish = result('strongBullish', b, 'BULLISH', conf(60, b));
  }
  if (b.isRed && b.bodyPct >= 0.6 && b.lowerPct <= 0.25) {
    out.strongBearish = result('strongBearish', b, 'BEARISH', conf(60, b));
  }
  if (b.upperPct >= 0.5 && b.bodyPct <= 0.35 && !out.shootingStar) {
    out.longUpperWick = result('longUpperWick', b, 'NEUTRAL', 55);
  }
  if (b.lowerPct >= 0.5 && b.bodyPct <= 0.35 && !out.hammer) {
    out.longLowerWick = result('longLowerWick', b, 'NEUTRAL', 55);
  }
  return out;
}

// ─── Two-bar patterns (prev = i-1, cur = i) ──────────────────────

function twoBarPatterns(prev: Bar, cur: Bar): Partial<CandlePatterns> {
  const out: Partial<CandlePatterns> = {};

  if (prev.isRed && cur.isGreen && cur.open <= prev.close && cur.close >= prev.open && cur.body > prev.body) {
    out.bullishEngulfing = result('bullishEngulfing', cur, 'BULLISH', Math.min(95, 55 + Math.round((cur.body / cur.range) * 40)));
  }
  if (prev.isGreen && cur.isRed && cur.open >= prev.close && cur.close <= prev.open && cur.body > prev.body) {
    out.bearishEngulfing = result('bearishEngulfing', cur, 'BEARISH', Math.min(95, 55 + Math.round((cur.body / cur.range) * 40)));
  }
  if (cur.high <= prev.high && cur.low >= prev.low && cur.range < prev.range) {
    out.insideBar = result('insideBar', cur, 'NEUTRAL', 60);
  }
  if (cur.high > prev.high && cur.low < prev.low && cur.range > prev.range) {
    out.outsideBar = result('outsideBar', cur, 'NEUTRAL', 60);
  }
  return out;
}

// ─── Three-bar patterns (a = i-2, star = i-1, c = i) ─────────────

function threeBarPatterns(a: Bar, star: Bar, c: Bar): Partial<CandlePatterns> {
  const out: Partial<CandlePatterns> = {};
  const starSmall = star.bodyPct <= 0.35;

  // Morning star: long red → small body gapped down → long green above midpoint
  if (
    a.isRed && a.bodyPct >= 0.5 &&
    starSmall && Math.max(star.open, star.close) < a.close &&
    c.isGreen && c.bodyPct >= 0.4 &&
    c.close > (a.open + a.close) / 2
  ) {
    out.morningStar = result('morningStar', c, 'BULLISH', Math.min(95, 60 + Math.round(c.bodyPct * 30)));
  }

  // Evening star: long green → small body gapped up → long red below midpoint
  if (
    a.isGreen && a.bodyPct >= 0.5 &&
    starSmall && Math.min(star.open, star.close) > a.close &&
    c.isRed && c.bodyPct >= 0.4 &&
    c.close < (a.open + a.close) / 2
  ) {
    out.eveningStar = result('eveningStar', c, 'BEARISH', Math.min(95, 60 + Math.round(c.bodyPct * 30)));
  }
  return out;
}

// ─── Public API ───────────────────────────────────────────────────

// Patterns detected on the LAST candle only (single + 2-bar + 3-bar).
// Returns nulls for undetected patterns — never directional claims.
export function analyzeCandlePatterns(candles: CandleData[]): CandlePatterns {
  const empty: CandlePatterns = {
    doji: null, hammer: null, shootingStar: null, bullishEngulfing: null,
    bearishEngulfing: null, morningStar: null, eveningStar: null,
    insideBar: null, outsideBar: null, strongBullish: null, strongBearish: null,
    longUpperWick: null, longLowerWick: null,
  };
  if (!candles || candles.length < 2) return empty;

  const bars = candles.map(toBar);
  const cur = bars[bars.length - 1];
  if (!cur) return empty;

  const out: CandlePatterns = { ...empty, ...singleBarPatterns(cur) };
  const prev = bars[bars.length - 2];
  if (prev) Object.assign(out, twoBarPatterns(prev, cur));
  const a = candles.length >= 3 ? bars[bars.length - 3] : null;
  if (a && prev) Object.assign(out, threeBarPatterns(a, prev, cur));
  return out;
}

// Scan across the trailing `lookback` completed candles — returns every
// detection (chronological). Empty array = none detected (not "missing").
export function scanCandlePatterns(candles: CandleData[], lookback = 50): CandlePatternResult[] {
  const out: CandlePatternResult[] = [];
  if (!candles || candles.length < 2) return out;

  const start = Math.max(1, candles.length - lookback);
  for (let i = start; i < candles.length; i++) {
    const cur = toBar(candles[i]);
    if (!cur) continue;
    for (const v of Object.values(singleBarPatterns(cur))) out.push(v as CandlePatternResult);

    const prev = toBar(candles[i - 1]);
    if (prev) for (const v of Object.values(twoBarPatterns(prev, cur))) out.push(v as CandlePatternResult);

    if (i >= 2) {
      const a = toBar(candles[i - 2]);
      if (a && prev) for (const v of Object.values(threeBarPatterns(a, prev, cur))) out.push(v as CandlePatternResult);
    }
  }
  out.sort((x, y) => x.timestamp - y.timestamp);
  return out;
}
