// ═══════════════════════════════════════════════════════════════════════════
// Technical Snapshot (Phase 4) — computes AgentContext['technical'] from
// REAL OHLCV candles. This is an EVIDENCE layer only: it never generates
// trades, never touches engines/validator/locks, and never fabricates data.
//
// RULES
//  - Missing/insufficient data → null / NO_DATA — never bullish/bearish.
//  - Incomplete (forming) candle is excluded from confirmed signals
//    (patterns, structure, BOS/CHoCH, FVG, OB, crossovers); it may only
//    supply observed day high/low extremes.
//  - Timeframes are only derived UPWARD from valid lower-TF candles
//    (session-anchored OHLC merge, exact). 1m/3m cannot be derived from
//    5m → honestly recorded unavailable.
//
// REUSE (no duplicate engines): ml-engine (RSI/EMA/SMA/MACD/BB/VWAP),
// signal-engine ATR, supertrend-engine, mtf-indicator-engine,
// volume-analysis (POC/VAH/VAL), market-structure (swings/BOS/CHoCH),
// mss-engine (MSS), market/canonical (FVG/OB), candle-patterns.
// ═══════════════════════════════════════════════════════════════════════════

import type { CandleData } from '@/types/sdm';
import type { AgentContext, TechnicalTimeframeInfo } from '@/lib/agents/agent-contract';
import {
  calculateRSI, calculateEMA, calculateSMA, calculateMACD,
  calculateBollingerBands, calculateVWAP,
} from '@/lib/ml-engine';
import { calculateATR } from '@/lib/signal-engine';
import { computeIndicatorsForTimeframe } from '@/lib/mtf-indicator-engine';
import { DEFAULT_INDICATOR_PARAMS } from '@/lib/mtf-config';
import { analyzeVolume } from '@/lib/volume-analysis';
import { detectSwingPoints, detectStructureEvents } from '@/lib/market-structure';
import { detectFVG, detectOrderBlocks } from '@/lib/market/canonical';
import { analyzeMSS } from '@/lib/mss-engine';
import { analyzeCandlePatterns, scanCandlePatterns } from '@/lib/candle-patterns';
import { getHistoricalCandles } from '@/lib/historical-data';

export type TechnicalSnapshot = NonNullable<AgentContext['technical']>;

// Supported timeframes (§2). Order = coarse bookkeeping only.
export const SUPPORTED_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '1d'] as const;

const TF_MINUTES: Record<string, number> = {
  '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '1d': 1440,
};

const MIN_INDICATOR_CANDLES = 20; // matches mtf-indicator-engine default
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const SESSION_OPEN_MS = 9 * 60 * 60 * 1000 + 15 * 60 * 1000; // 09:15 IST
const FETCH_TIMEOUT_MS = 12_000;

// ─── Candle hygiene ───────────────────────────────────────────────
// Sort ascending, drop duplicates (keep last), drop invalid OHLC rows.
// Never reorders or invents values — only removes unusable records.

export function normalizeCandles(candles: CandleData[] | undefined | null): CandleData[] {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const byTime = new Map<number, CandleData>();
  for (const c of candles) {
    if (!c || !Number.isFinite(c.time) || !Number.isFinite(c.open) ||
        !Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close)) continue;
    if (c.high < c.low || c.open <= 0 || c.close <= 0) continue;
    byTime.set(c.time, { ...c, volume: Number.isFinite(c.volume) ? c.volume : 0 });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function isCandleComplete(c: CandleData, timeframe: string, now: number): boolean {
  const ms = (TF_MINUTES[timeframe] ?? 5) * 60_000;
  return c.time + ms <= now;
}

// Last completed candle series (§21) — for confirmed signals only.
function completedOnly(candles: CandleData[], timeframe: string, now: number): CandleData[] {
  if (candles.length === 0) return candles;
  const last = candles[candles.length - 1];
  return isCandleComplete(last, timeframe, now) ? candles : candles.slice(0, -1);
}

// ─── Safe upward timeframe derivation (§2) ────────────────────────
// Session-anchored buckets (09:15 IST) so 5m→15m/30m/1h bars align with
// the Indian session. Exact OHLC merge: open=first, close=last, high=max,
// low=min, volume=sum. Only used for HIGHER timeframes (exact by math).

function sessionBucket(time: number, bucketMs: number): number {
  const ist = time + IST_OFFSET_MS;
  const istDay = Math.floor(ist / 86_400_000) * 86_400_000;
  const sessionOpen = istDay + SESSION_OPEN_MS - IST_OFFSET_MS;
  return Math.floor((time - sessionOpen) / bucketMs);
}

export function aggregateCandles(candles: CandleData[], targetTimeframe: string): CandleData[] {
  const minutes = TF_MINUTES[targetTimeframe];
  if (!minutes || minutes <= 5) return normalizeCandles(candles);
  const bucketMs = minutes * 60_000;
  const groups = new Map<number, CandleData>();
  for (const c of candles) {
    const key = sessionBucket(c.time, bucketMs);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      g.high = Math.max(g.high, c.high);
      g.low = Math.min(g.low, c.low);
      g.close = c.close;
      g.volume += c.volume;
    }
  }
  return [...groups.values()].sort((a, b) => a.time - b.time);
}

// ─── Provider fetch (best-effort, real data only) ─────────────────
// 5m + 15m intraday + 1d daily, parallel. Failure → omitted key (the
// snapshot reports it as missing — never simulated).

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('candle_fetch_timeout')), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchTechnicalCandles(symbol: string): Promise<Record<string, CandleData[]>> {
  const specs: [string, number][] = [['5m', 300], ['15m', 200], ['1d', 60]];
  const results = await Promise.allSettled(
    specs.map(([tf, limit]) => withTimeout(getHistoricalCandles(symbol, tf, limit), FETCH_TIMEOUT_MS))
  );
  const out: Record<string, CandleData[]> = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const norm = normalizeCandles(r.value as CandleData[]);
      if (norm.length > 0) out[specs[i][0]] = norm;
    }
  });
  return out;
}

// ─── Inputs ───────────────────────────────────────────────────────

export interface TechnicalSnapshotInput {
  candlesByTF: Record<string, CandleData[]>;
  spot?: number;
  prevClose?: number;
  pdh?: number;
  pdl?: number;
  iv?: number | null;
  ivHistory?: number[] | null; // real historical IV only → else null rank/percentile
  oiSupportLevels?: number[];
  oiResistanceLevels?: number[];
  fetchedAtIso?: string;
  now?: number;
  // test seam — normally Date.now()
}

// ─── Per-timeframe info ───────────────────────────────────────────

function buildTimeframeInfo(tf: string, rawInput: CandleData[] | undefined, now: number): TechnicalTimeframeInfo {
  const raw = normalizeCandles(rawInput);
  if (raw.length === 0) {
    return {
      available: false, reason: 'no_candles', candleCount: 0, latestCandle: null,
      latestTimestamp: 0, ageSeconds: 0, isFresh: false, isComplete: false, indicators: null,
    };
  }
  const latest = raw[raw.length - 1];
  const done = completedOnly(raw, tf, now);
  const barMs = (TF_MINUTES[tf] ?? 5) * 60_000;
  const ageSeconds = Math.max(0, Math.round((now - latest.time) / 1000));
  const enough = done.length >= MIN_INDICATOR_CANDLES;

  let indicators: TechnicalTimeframeInfo['indicators'] = null;
  let reason: string | undefined;
  if (enough) {
    try {
      indicators = computeIndicatorsForTimeframe(done, tf, DEFAULT_INDICATOR_PARAMS, MIN_INDICATOR_CANDLES);
    } catch {
      indicators = null;
      reason = 'indicator_error';
    }
  } else {
    reason = `insufficient_${done.length}_of_${MIN_INDICATOR_CANDLES}`;
  }

  return {
    available: true,
    reason,
    candleCount: raw.length,
    latestCandle: latest,
    latestTimestamp: latest.time,
    ageSeconds,
    isFresh: ageSeconds <= barMs / 1000 * 2.5,
    isComplete: isCandleComplete(latest, tf, now),
    indicators,
  };
}

// ─── Trend per timeframe (never forced) ───────────────────────────
// UPTREND + SuperTrend UP → BULLISH; DOWNTREND + ST DOWN → BEARISH;
// RANGING → RANGING; ST/structure disagreement → NEUTRAL; no data → NO_DATA.

type DirTrend = 'BULLISH' | 'BEARISH' | 'RANGING' | 'NEUTRAL' | 'NO_DATA';

function tfTrend(info: TechnicalTimeframeInfo | undefined): DirTrend {
  if (!info || !info.available || !info.indicators) return 'NO_DATA';
  const st = info.indicators.supertrend?.direction;
  const struct = info.indicators.structure.trend;
  if (struct === 'RANGING') return 'RANGING';
  if (struct === 'UPTREND' && st === 'UP') return 'BULLISH';
  if (struct === 'DOWNTREND' && st === 'DOWN') return 'BEARISH';
  return 'NEUTRAL';
}

function tfRank(tf: string): number {
  return SUPPORTED_TIMEFRAMES.indexOf(tf as any);
}

// ─── Moving averages ──────────────────────────────────────────────

function buildMovingAverages(closes: number[], lastClose: number): TechnicalSnapshot['movingAverages'] {
  const emaOf = (p: number) => (closes.length >= p ? Math.round(calculateEMA(closes, p)[closes.length - 1] * 100) / 100 : 0);
  const ema9 = emaOf(9), ema20 = emaOf(20), ema50 = emaOf(50), ema200 = emaOf(200);
  const sma20 = closes.length >= 20 ? Math.round(calculateSMA(closes, 20) * 100) / 100 : 0;
  const sma50 = closes.length >= 50 ? Math.round(calculateSMA(closes, 50) * 100) / 100 : 0;
  const sma200 = closes.length >= 200 ? Math.round(calculateSMA(closes, 200) * 100) / 100 : 0;

  let emaTrend: TechnicalSnapshot['movingAverages']['emaTrend'] = 'NO_DATA';
  if (ema20 > 0 && ema50 > 0 && lastClose > 0) {
    if (lastClose > ema20 && ema20 > ema50) emaTrend = 'BULLISH';
    else if (lastClose < ema20 && ema20 < ema50) emaTrend = 'BEARISH';
    else emaTrend = 'NEUTRAL';
  }

  let emaAlignment: TechnicalSnapshot['movingAverages']['emaAlignment'] = 'NO_DATA';
  if (ema50 > 0) {
    const chain = ema200 > 0 ? [ema9, ema20, ema50, ema200] : [ema9, ema20, ema50];
    // Bullish stack: shorter EMA ABOVE longer (9 > 20 > 50 > 200).
    const desc = chain.every((v, i) => i === 0 || v < chain[i - 1]);
    const asc = chain.every((v, i) => i === 0 || v > chain[i - 1]);
    emaAlignment = desc ? 'BULLISH' : asc ? 'BEARISH' : 'MIXED';
  }

  return { ema9, ema20, ema50, ema200, sma20, sma50, sma200, emaTrend, emaAlignment };
}

// ─── Momentum (RSI + MACD) ────────────────────────────────────────

function buildMomentum(candles: CandleData[]): TechnicalSnapshot['momentum'] {
  const closes = candles.map(c => c.close);
  const out: TechnicalSnapshot['momentum'] = {
    rsi: 0, rsiState: 'NO_DATA', rsiSlope: 'NO_DATA',
    macd: 0, signal: 0, histogram: 0, histogramSlope: 'NO_DATA', macdState: 'NO_DATA',
    roc: null,
  };
  // 5-bar ROC from real closes (null until enough bars exist)
  if (closes.length >= 6) {
    const base = closes[closes.length - 6];
    if (base > 0) out.roc = Math.round(((closes[closes.length - 1] / base - 1) * 100) * 100) / 100;
  }
  if (closes.length < 15) return out; // ml-engine RSI would return a fake 50

  const rsi = calculateRSI(candles, 14);
  out.rsi = Math.round(rsi * 10) / 10;
  out.rsiState = rsi >= 70 ? 'OVERBOUGHT' : rsi <= 30 ? 'OVERSOLD'
    : rsi > 50 ? 'BULLISH' : rsi < 50 ? 'BEARISH' : 'NEUTRAL';

  if (closes.length >= 16) {
    const prevRsi = calculateRSI(candles.slice(0, -1), 14);
    const diff = rsi - prevRsi;
    out.rsiSlope = diff > 1 ? 'UP' : diff < -1 ? 'DOWN' : 'FLAT';
  }

  const m = calculateMACD(closes);
  if (m.valid) {
    out.macd = Math.round(m.macd * 100) / 100;
    out.signal = Math.round(m.signal * 100) / 100;
    out.histogram = Math.round(m.histogram * 100) / 100;
    out.histogramSlope = m.histogram > m.prevHistogram ? 'UP' : m.histogram < m.prevHistogram ? 'DOWN' : 'FLAT';
    out.macdState = m.macd > m.signal ? 'BULLISH' : m.macd < m.signal ? 'BEARISH' : 'NEUTRAL';
  }
  return out;
}

// ─── Bollinger (series → squeeze quartiles) ───────────────────────

function buildBollinger(closes: number[]): TechnicalSnapshot['volatility']['bollinger'] {
  if (closes.length < 20) return null;
  const last = calculateBollingerBands(closes, 20, 2);
  const close = closes[closes.length - 1];
  const bandwidths: number[] = [];
  for (let i = 19; i < closes.length; i++) {
    const bb = calculateBollingerBands(closes.slice(0, i + 1), 20, 2);
    bandwidths.push(bb.bandwidth);
  }
  bandwidths.sort((a, b) => a - b);
  const q = (p: number) => bandwidths[Math.min(bandwidths.length - 1, Math.floor(p * bandwidths.length))];
  const squeezeState: 'SQUEEZE' | 'EXPANSION' | 'NORMAL' | 'NO_DATA' =
    last.bandwidth <= q(0.25) ? 'SQUEEZE'
    : last.bandwidth >= q(0.75) ? 'EXPANSION'
    : 'NORMAL';
  const span = last.upper - last.lower;
  return {
    upper: Math.round(last.upper * 100) / 100,
    middle: Math.round(last.middle * 100) / 100,
    lower: Math.round(last.lower * 100) / 100,
    bandwidth: Math.round(last.bandwidth * 100) / 100,
    percentB: span > 0 ? Math.round(((close - last.lower) / span) * 1000) / 1000 : 0.5,
    squeezeState,
  };
}

// ─── Volume (bar-level, completed candles) ────────────────────────

function buildVolume(done: CandleData[], profile: { poc: number | null; vah: number | null; val: number | null; ok: boolean }) {
  const out = {
    relativeVolume: 0,
    volumeSpike: false,
    volumeTrend: 'NO_DATA' as TechnicalSnapshot['volume']['volumeTrend'],
    poc: profile.poc,
    vah: profile.vah,
    val: profile.val,
    volumeProfileAvailable: profile.ok,
  };
  if (done.length < 6) return out;

  const cur = done[done.length - 1].volume;
  const prior = done.slice(-21, -1);
  const avg = prior.reduce((s, c) => s + c.volume, 0) / Math.max(1, prior.length);
  if (avg > 0) {
    out.relativeVolume = Math.round((cur / avg) * 100) / 100;
    out.volumeSpike = out.relativeVolume >= 2;
  }

  if (done.length >= 20) {
    const last5 = done.slice(-5).reduce((s, c) => s + c.volume, 0) / 5;
    const prior15 = done.slice(-20, -5).reduce((s, c) => s + c.volume, 0) / 15;
    if (prior15 > 0) {
      const ratio = last5 / prior15;
      out.volumeTrend = ratio > 1.15 ? 'INCREASING' : ratio < 0.85 ? 'DECREASING' : 'STABLE';
    }
  }
  return out;
}

// ─── Price action ─────────────────────────────────────────────────

function istDayKey(t: number): number {
  return Math.floor((t + IST_OFFSET_MS) / 86_400_000);
}

function buildPriceAction(
  primTf: string,
  primRaw: CandleData[],
  primDone: CandleData[],
  intradayRaw: CandleData[],
  dailyRaw: CandleData[],
  input: TechnicalSnapshotInput,
  patterns: ReturnType<typeof analyzeCandlePatterns>,
  hasPatternsData: boolean,
): TechnicalSnapshot['priceAction'] {
  const out: TechnicalSnapshot['priceAction'] = {
    higherHigh: false, higherLow: false, lowerHigh: false, lowerLow: false,
    swingHigh: 0, swingLow: 0, dayHigh: 0, dayLow: 0,
    pdh: input.pdh && input.pdh > 0 ? input.pdh : 0,
    pdl: input.pdl && input.pdl > 0 ? input.pdl : 0,
    openingRangeHigh: 0, openingRangeLow: 0,
    gapUp: false, gapDown: false,
    momentumCandle: hasPatternsData ? 'NEUTRAL' : 'NO_DATA',
    reversalCandle: hasPatternsData ? 'NEUTRAL' : 'NO_DATA',
  };

  // Swings on completed primary candles
  const swings = detectSwingPoints(primDone, 3);
  const highs = swings.filter(s => s.type === 'HIGH');
  const lows = swings.filter(s => s.type === 'LOW');
  if (highs.length >= 2) {
    out.swingHigh = highs[highs.length - 1].price;
    out.higherHigh = highs[highs.length - 1].price > highs[highs.length - 2].price;
    out.lowerHigh = highs[highs.length - 1].price < highs[highs.length - 2].price;
  } else if (highs.length === 1) {
    out.swingHigh = highs[0].price;
  }
  if (lows.length >= 2) {
    out.swingLow = lows[lows.length - 1].price;
    out.higherLow = lows[lows.length - 1].price > lows[lows.length - 2].price;
    out.lowerLow = lows[lows.length - 1].price < lows[lows.length - 2].price;
  } else if (lows.length === 1) {
    out.swingLow = lows[0].price;
  }

  // Day range from today's session bars (observed extremes incl. forming bar)
  const daySource = intradayRaw.length > 0 ? intradayRaw : primRaw;
  if (daySource.length > 0) {
    const today = istDayKey(daySource[daySource.length - 1].time);
    const todays = daySource.filter(c => istDayKey(c.time) === today);
    if (todays.length > 0) {
      out.dayHigh = Math.max(...todays.map(c => c.high));
      out.dayLow = Math.min(...todays.map(c => c.low));

      // Opening range = first 15 minutes of the session (09:15 IST anchored)
      const barMs = (TF_MINUTES[primTf] ?? 5) * 60_000;
      const orBars = Math.max(1, Math.min(todays.length, Math.ceil((15 * 60_000) / barMs)));
      const first = todays.slice(0, orBars);
      out.openingRangeHigh = Math.max(...first.map(c => c.high));
      out.openingRangeLow = Math.min(...first.map(c => c.low));
    }
  }

  // PDH/PDL fallback: previous completed daily candle (real data only)
  if (out.pdh <= 0 && dailyRaw.length >= 2) {
    out.pdh = dailyRaw[dailyRaw.length - 2].high;
    out.pdl = dailyRaw[dailyRaw.length - 2].low;
  }

  // Gap: session open vs previous close (both must be real)
  if (daySource.length > 0 && input.prevClose && input.prevClose > 0) {
    const today = istDayKey(daySource[daySource.length - 1].time);
    const todays = daySource.filter(c => istDayKey(c.time) === today);
    const dayOpen = todays.length > 0 ? todays[0].open : 0;
    if (dayOpen > 0) {
      out.gapUp = dayOpen > input.prevClose;
      out.gapDown = dayOpen < input.prevClose;
    }
  }

  // Momentum / reversal candles from the pattern engine (completed only)
  if (hasPatternsData) {
    if (patterns.strongBullish) out.momentumCandle = 'BULLISH';
    else if (patterns.strongBearish) out.momentumCandle = 'BEARISH';
    if (patterns.hammer) out.reversalCandle = 'BULLISH';
    else if (patterns.shootingStar) out.reversalCandle = 'BEARISH';
  }

  return out;
}

// ─── Support / Resistance with provenance (§13) ───────────────────

interface SRDraft { level: number; type: 'SUPPORT' | 'RESISTANCE'; strength: number; touchCount: number; source: TechnicalSnapshot['supportResistance']['levels'][0]['source']; }

function buildSupportResistance(
  primDone: CandleData[],
  pa: TechnicalSnapshot['priceAction'],
  vp: TechnicalSnapshot['volumeProfile'],
  input: TechnicalSnapshotInput,
  spot: number,
  tf: string,
): TechnicalSnapshot['supportResistance'] {
  const drafts: SRDraft[] = [];
  const swings = detectSwingPoints(primDone, 3);
  for (const s of swings.filter(x => x.type === 'HIGH')) drafts.push({ level: s.price, type: 'RESISTANCE', strength: 45, touchCount: 1, source: 'SWING' });
  for (const s of swings.filter(x => x.type === 'LOW')) drafts.push({ level: s.price, type: 'SUPPORT', strength: 45, touchCount: 1, source: 'SWING' });

  if (pa.pdh > 0) drafts.push({ level: pa.pdh, type: 'RESISTANCE', strength: 60, touchCount: 1, source: 'PDH_PDL' });
  if (pa.pdl > 0) drafts.push({ level: pa.pdl, type: 'SUPPORT', strength: 60, touchCount: 1, source: 'PDH_PDL' });
  if (pa.dayHigh > 0) drafts.push({ level: pa.dayHigh, type: 'RESISTANCE', strength: 45, touchCount: 1, source: 'DAY_HIGH_LOW' });
  if (pa.dayLow > 0) drafts.push({ level: pa.dayLow, type: 'SUPPORT', strength: 45, touchCount: 1, source: 'DAY_HIGH_LOW' });

  if (vp.profileAvailable && spot > 0) {
    if (vp.poc) drafts.push({ level: vp.poc, type: spot > vp.poc ? 'SUPPORT' : 'RESISTANCE', strength: 55, touchCount: 1, source: 'VOLUME_PROFILE' });
    if (vp.vah && spot < vp.vah) drafts.push({ level: vp.vah, type: 'RESISTANCE', strength: 50, touchCount: 1, source: 'VOLUME_PROFILE' });
    if (vp.val && spot > vp.val) drafts.push({ level: vp.val, type: 'SUPPORT', strength: 50, touchCount: 1, source: 'VOLUME_PROFILE' });
  }

  for (const l of input.oiSupportLevels ?? []) if (l > 0) drafts.push({ level: l, type: 'SUPPORT', strength: 65, touchCount: 1, source: 'OI_WALL' });
  for (const l of input.oiResistanceLevels ?? []) if (l > 0) drafts.push({ level: l, type: 'RESISTANCE', strength: 65, touchCount: 1, source: 'OI_WALL' });

  if (drafts.length === 0) return { available: false, levels: [] };

  // Cluster levels within 0.15% of each other (zones, not a blind merge)
  drafts.sort((a, b) => a.level - b.level);
  const ref = spot > 0 ? spot : drafts[Math.floor(drafts.length / 2)].level;
  const tol = ref * 0.0015;
  const clusters: SRDraft[][] = [];
  for (const d of drafts) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(d.level - last[last.length - 1].level) <= tol) last.push(d);
    else clusters.push([d]);
  }

  const levels = clusters.map(group => {
    const primary = group.reduce((best, g) => (g.strength > best.strength ? g : best), group[0]);
    return {
      level: Math.round((group.reduce((s, g) => s + g.level, 0) / group.length) * 100) / 100,
      type: primary.type,
      strength: Math.min(100, primary.strength + 8 * (group.length - 1)),
      touchCount: group.length,
      source: primary.source,
      timeframe: tf,
    };
  });

  levels.sort((a, b) => b.strength - a.strength);
  const top = levels.slice(0, 6).sort((a, b) => a.level - b.level);
  return { available: top.length > 0, levels: top };
}

// ─── SMC evidence (§15-§19) ───────────────────────────────────────

function buildSMC(primDone: CandleData[], spot: number): TechnicalSnapshot['smc'] {
  const out: TechnicalSnapshot['smc'] = {
    bos: null, choch: null, mss: null, fvg: null, orderBlock: null,
    liquidity: null, premiumDiscount: null,
  };
  if (primDone.length < 5) return out;

  // BOS / CHoCH / liquidity grab from real swing breaks
  try {
    const swings = detectSwingPoints(primDone, 3);
    const events = detectStructureEvents(primDone, swings);
    for (const e of events) {
      if (e.type === 'BOS' && !out.bos) out.bos = { direction: e.direction, timestamp: e.time };
      else if (e.type === 'CHoCH' && !out.choch) out.choch = { direction: e.direction, timestamp: e.time };
      else if (e.type === 'LIQUIDITY_GRAB' && !out.liquidity) {
        out.liquidity = {
          levelType: e.swingHigh !== undefined ? 'HIGH' : 'LOW',
          price: e.price,
          time: e.time,
          swept: true,      // wick traded beyond the swing level
          reclaimed: true,  // close back inside → the grab failed to hold
        };
      }
    }
  } catch { /* keep nulls */ }

  // MSS — sweep-gated structure shift (mss-engine), needs a real series
  if (primDone.length >= 20) {
    try {
      const mss = analyzeMSS(primDone);
      const sig = mss.lastSignal;
      if (sig) out.mss = { direction: sig.direction, timestamp: sig.time, displacement: sig.displacement, sweepGated: sig.sweepGated };
    } catch { /* keep null */ }
  }

  // FVG — latest gap + real fill tracking against later candles (§16)
  try {
    const fvgs = detectFVG(primDone as any);
    if (fvgs.length > 0) {
      const last = fvgs[fvgs.length - 1];
      const d = last.details as any;
      const upper = Number(d.top), lower = Number(d.bottom);
      const time = Number(d.time) || 0;
      if (Number.isFinite(upper) && Number.isFinite(lower) && upper > lower) {
        const after = time > 0 ? primDone.filter(c => c.time > time) : [];
        let fill: number;
        if (last.direction === 'BULLISH') {
          const minLow = after.length ? Math.min(...after.map(c => c.low)) : upper;
          fill = Math.max(0, Math.min(1, (upper - minLow) / (upper - lower)));
        } else {
          const maxHigh = after.length ? Math.max(...after.map(c => c.high)) : lower;
          fill = Math.max(0, Math.min(1, (maxHigh - lower) / (upper - lower)));
        }
        out.fvg = {
          direction: last.direction as 'BULLISH' | 'BEARISH',
          upper, lower, timestamp: time,
          status: fill >= 1 ? 'FILLED' : fill > 0 ? 'PARTIAL' : 'OPEN',
          filledPercent: Math.round(fill * 1000) / 1000,
        };
      }
    }
  } catch { /* keep null */ }

  // Order block — displacement-based (canonical) + mitigation + ATR strength
  try {
    const obs = detectOrderBlocks(primDone as any);
    if (obs.length > 0) {
      const last = obs[obs.length - 1];
      const d = last.details as any;
      const high = Number(d.top), low = Number(d.bottom);
      const time = Number(d.time) || 0;
      if (Number.isFinite(high) && Number.isFinite(low) && high > low) {
        const after = time > 0 ? primDone.filter(c => c.time > time) : [];
        const mitigated = last.direction === 'BULLISH'
          ? after.some(c => c.low <= high)
          : after.some(c => c.high >= low);
        let strength: number | null = null;
        const obCandle = time > 0 ? primDone.find(c => c.time === time) : undefined;
        const atr = calculateATR(primDone, 14);
        if (obCandle && atr > 0) strength = Math.round((Math.abs(obCandle.close - obCandle.open) / atr) * 100) / 100;
        out.orderBlock = {
          direction: last.direction as 'BULLISH' | 'BEARISH',
          high, low, timestamp: time, mitigated, strength,
        };
      }
    }
  } catch { /* keep null */ }

  // Premium / discount — dealing range = last confirmed swing high/low (§19)
  const swings = detectSwingPoints(primDone, 3);
  const sh = swings.filter(s => s.type === 'HIGH').pop();
  const sl = swings.filter(s => s.type === 'LOW').pop();
  if (sh && sl && sh.price > sl.price && spot > 0) {
    const equilibrium = (sh.price + sl.price) / 2;
    const band = equilibrium * 0.001;
    out.premiumDiscount = {
      rangeHigh: sh.price,
      rangeLow: sl.price,
      equilibrium: Math.round(equilibrium * 100) / 100,
      currentZone: Math.abs(spot - equilibrium) <= band ? 'EQUILIBRIUM'
        : spot > equilibrium ? 'PREMIUM' : 'DISCOUNT',
    };
  }

  return out;
}

// ─── MTF consensus (§20) ──────────────────────────────────────────

function buildMTF(tfInfo: Record<string, TechnicalTimeframeInfo>): TechnicalSnapshot['mtf'] {
  const t = (tf: string): DirTrend => tfTrend(tfInfo[tf]);
  const trend3m = t('3m'), trend5m = t('5m'), trend15m = t('15m'),
        trend30m = t('30m'), trend1h = t('1h'), trendDaily = t('1d');

  // Higher/lower TF relative to the primary (largest above / smallest below)
  const primaryTf = pickPrimaryTf(tfInfo);
  const primaryRank = tfRank(primaryTf);
  const above = SUPPORTED_TIMEFRAMES.filter(tf => tfRank(tf) > primaryRank && tfInfo[tf]?.indicators);
  const below = SUPPORTED_TIMEFRAMES.filter(tf => tfRank(tf) < primaryRank && tfInfo[tf]?.indicators).reverse();
  const higherTFTrend = above.length ? tfTrend(tfInfo[above[above.length - 1]]) : 'NO_DATA';
  const lowerTFTrend = below.length ? tfTrend(tfInfo[below[0]]) : 'NO_DATA';

  const all = [trend3m, trend5m, trend15m, trend30m, trend1h, trendDaily];
  const usable = all.filter(x => x !== 'NO_DATA');
  const bull = usable.filter(x => x === 'BULLISH').length;
  const bear = usable.filter(x => x === 'BEARISH').length;

  let mtfConsensus: DirTrend = 'NO_DATA';
  let mtfConflict = false;
  if (usable.length > 0) {
    if (bull > 0 && bear > 0) { mtfConsensus = 'NEUTRAL'; mtfConflict = true; }
    else if (bull > 0) mtfConsensus = 'BULLISH';
    else if (bear > 0) mtfConsensus = 'BEARISH';
    else mtfConsensus = 'RANGING';
  }

  return { trend3m, trend5m, trend15m, trend30m, trend1h, trendDaily, higherTFTrend, lowerTFTrend, mtfConsensus, mtfConflict };
}

function pickPrimaryTf(tfInfo: Record<string, TechnicalTimeframeInfo>): string {
  for (const tf of ['15m', '5m', '30m', '1h', '1d']) {
    if (tfInfo[tf]?.available) return tf;
  }
  for (const tf of SUPPORTED_TIMEFRAMES) if (tfInfo[tf]?.available) return tf;
  return '15m';
}

// ─── Main builder ─────────────────────────────────────────────────

export function buildTechnicalSnapshot(input: TechnicalSnapshotInput): TechnicalSnapshot {
  const now = input.now ?? Date.now();
  const spot = input.spot && input.spot > 0 ? input.spot : 0;

  // Normalize + derive safe higher timeframes (5m→30m/1h only from 15m/5m real bars)
  const normalized: Record<string, CandleData[]> = {};
  for (const [tf, list] of Object.entries(input.candlesByTF)) normalized[tf] = normalizeCandles(list);
  if (normalized['15m']?.length && !normalized['30m']?.length) {
    normalized['30m'] = aggregateCandles(normalized['15m'], '30m');
  }
  if (normalized['15m']?.length && !normalized['1h']?.length) {
    normalized['1h'] = aggregateCandles(normalized['15m'], '1h');
  } else if (!normalized['1h']?.length && normalized['5m']?.length) {
    normalized['1h'] = aggregateCandles(normalized['5m'], '1h');
  }

  const timeframes: Record<string, TechnicalTimeframeInfo> = {};
  for (const tf of SUPPORTED_TIMEFRAMES) {
    timeframes[tf] = buildTimeframeInfo(tf, normalized[tf], now);
  }

  const primTf = pickPrimaryTf(timeframes);
  const primRaw = normalized[primTf] ?? [];
  const primDone = completedOnly(primRaw, primTf, now);
  const closes = primDone.map(c => c.close);
  const lastClose = closes.length ? closes[closes.length - 1] : 0;
  const primInfo = timeframes[primTf];

  // Trend (primary TF)
  const trend: DirTrend = tfTrend(primInfo);

  // Moving averages + momentum on completed primary closes
  const movingAverages = buildMovingAverages(closes, lastClose);
  const momentum = buildMomentum(primDone);

  // Volatility: ATR (signal-engine, real) + IV + Bollinger
  let atr = 0, atrPercent = 0;
  let atrRegime: TechnicalSnapshot['volatility']['atrRegime'] = 'NO_DATA';
  if (primDone.length >= 15) {
    atr = Math.round(calculateATR(primDone, 14) * 100) / 100;
    const base = spot > 0 ? spot : lastClose;
    if (atr > 0 && base > 0) {
      atrPercent = Math.round((atr / base) * 10000) / 100;
      atrRegime = atrPercent > 2 ? 'HIGH' : atrPercent < 0.5 ? 'LOW' : 'NORMAL';
    }
  }
  const iv = input.iv && input.iv > 0 ? input.iv : 0;
  const hist = (input.ivHistory ?? []).filter(v => Number.isFinite(v) && v > 0);
  let ivRank: number | null = null;
  let ivPercentile: number | null = null;
  if (iv > 0 && hist.length >= 20) {
    ivRank = Math.round((hist.filter(v => v < iv).length / hist.length) * 1000) / 10;
    ivPercentile = Math.round((hist.filter(v => v <= iv).length / hist.length) * 1000) / 10;
  }
  const volatility: TechnicalSnapshot['volatility'] = {
    atr, atrPercent, atrRegime, iv, ivRank, ivPercentile,
    bollinger: buildBollinger(closes),
  };

  // SuperTrend (primary TF from the indicator engine)
  const st = primInfo?.indicators?.supertrend;
  const supertrend: TechnicalSnapshot['supertrend'] =
    st && st.value > 0
      ? { value: st.value, direction: st.direction, distance: st.distancePercent }
      : null;

  // Volume profile from REAL candles (analyzeVolume) — 0 defaults never
  // masquerade as valid POC/VAH/VAL (§11)
  let vp: TechnicalSnapshot['volumeProfile'] = {
    poc: null, vah: null, val: null, valueAreaLow: null, valueAreaHigh: null,
    valueAreaWidth: null, profileAvailable: false,
  };
  if (primDone.length >= MIN_INDICATOR_CANDLES) {
    try {
      const va = analyzeVolume(primDone);
      if (va.status === 'OK' && va.poc > 0 && va.vah > 0 && va.val > 0) {
        vp = {
          poc: va.poc, vah: va.vah, val: va.val,
          valueAreaLow: va.val, valueAreaHigh: va.vah,
          valueAreaWidth: Math.round((va.vah - va.val) * 100) / 100,
          profileAvailable: true,
        };
      }
    } catch { /* stay unavailable */ }
  }

  const volume = buildVolume(primDone, { poc: vp.poc, vah: vp.vah, val: vp.val, ok: vp.profileAvailable });

  // Candle patterns — completed candles only (§14, §21)
  const hasPatternsData = primDone.length >= 2;
  const patternMap = hasPatternsData ? analyzeCandlePatterns(primDone) : null;
  const candlePatterns = hasPatternsData ? scanCandlePatterns(primDone, 50) : [];

  const intradayRaw = (normalized['5m']?.length ? normalized['5m'] : normalized['15m'] ?? []);
  const priceAction = buildPriceAction(
    primTf, primRaw, primDone, intradayRaw, normalized['1d'] ?? [],
    input, patternMap ?? analyzeCandlePatterns([]), hasPatternsData,
  );

  const supportResistance = buildSupportResistance(primDone, priceAction, vp, input, spot, primTf);
  const smc = buildSMC(primDone, spot);
  const mtf = buildMTF(timeframes);

  // Data quality (§27) — honest freshness + explicit gap list
  const allLatest = Object.values(timeframes).filter(t => t.latestTimestamp > 0);
  const latestTs = allLatest.length ? Math.max(...allLatest.map(t => t.latestTimestamp)) : 0;
  const ageSeconds = latestTs > 0 ? Math.round((now - latestTs) / 1000) : 0;
  const primBarSec = (TF_MINUTES[primTf] ?? 5) * 60;
  const missingData: string[] = [];
  for (const tf of SUPPORTED_TIMEFRAMES) {
    const info = timeframes[tf];
    if (!info.available) missingData.push(tf === '3m' || tf === '1m' ? `${tf}: provider_unavailable` : `${tf}: no_candles`);
    else if (!info.indicators) missingData.push(`${tf}: ${info.reason ?? 'insufficient'}`);
  }
  if (momentum.rsiState === 'NO_DATA') missingData.push('RSI');
  if (momentum.macdState === 'NO_DATA') missingData.push('MACD');
  if (atrRegime === 'NO_DATA') missingData.push('ATR');
  if (!vp.profileAvailable) missingData.push('VOLUME_PROFILE');
  if (iv <= 0) missingData.push('IV');
  if (ivRank === null) missingData.push('IV_RANK');

  const dataQuality: TechnicalSnapshot['dataQuality'] = {
    fetchedAt: input.fetchedAtIso ?? new Date(now).toISOString(),
    latestCandleAt: latestTs > 0 ? new Date(latestTs).toISOString() : '',
    ageSeconds,
    dataFresh: latestTs === 0 ? 'MISSING' : ageSeconds <= Math.max(900, primBarSec * 2.5) ? 'FRESH' : 'STALE',
    candleCount: primRaw.length,
    missingData,
    incompleteCandle: primRaw.length > 0 ? !isCandleComplete(primRaw[primRaw.length - 1], primTf, now) : false,
  };

  return {
    timeframes, trend, movingAverages, momentum, volatility, supertrend,
    volume, priceAction, volumeProfile: vp, supportResistance,
    candlePatterns, smc, mtf, dataQuality,
  };
}
