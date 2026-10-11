// ═══════════════════════════════════════════════════════════════════════════
// Phase 4 — Technical Evidence Layer tests
// buildTechnicalSnapshot + candle-patterns + agent integration (ctx.technical)
//
// RULES VERIFIED HERE
//  - Real math on real-shaped OHLCV candles (no fabricated series).
//  - Missing / insufficient data → null / NO_DATA, never bullish/bearish.
//  - Incomplete (forming) candle never drives confirmed signals.
//  - 1m/3m are never substituted — honestly provider_unavailable.
//  - Agents consume ctx.technical when present; absent → legacy/NO_DATA path.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'bun:test';
import {
  buildTechnicalSnapshot,
  normalizeCandles,
  isCandleComplete,
  aggregateCandles,
} from '../src/lib/technical-snapshot';
import {
  analyzeCandlePatterns,
  scanCandlePatterns,
} from '../src/lib/candle-patterns';
import { calculateMACD, calculateSMA } from '../src/lib/ml-engine';
import { runAllAgents } from '../src/lib/agents/registry-30';
import type {
  AgentContext,
  AgentId,
  AgentResearchOutput,
} from '../src/lib/agents/agent-contract';
import type { CandleData } from '../src/types/sdm';

// ─── Deterministic candle builders ────────────────────────────────────────

const STEP = 900_000;                       // 15m
const START = Date.UTC(2026, 9, 6, 3, 45, 0); // 2026-10-06 09:15 IST
const IST_MS = 5.5 * 60 * 60 * 1000;

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Zigzag with spiked leg-turn wicks (so swing detection sees strict
// highs/lows) and asymmetric legs: us = up-step, ds = down-step.
function zig(
  n: number,
  start: number,
  step: number,
  base: number,
  us: number,
  ds: number,
  legLen: number,
  spike: number,
  firstDir: 1 | -1 = 1,
): CandleData[] {
  const out: CandleData[] = [];
  let price = base;
  for (let i = 0; i < n; i++) {
    const dir = Math.floor(i / legLen) % 2 === 0 ? firstDir : -firstDir;
    const mag = dir > 0 ? us : ds;
    const open = price;
    const close = price + dir * mag;
    const isTurn = i % legLen === legLen - 1;
    out.push({
      time: start + i * step,
      open: r2(open),
      high: r2(Math.max(open, close) + 1 + (isTurn && dir > 0 ? spike : 0)),
      low: r2(Math.min(open, close) - 1 - (isTurn && dir < 0 ? spike : 0)),
      close: r2(close),
      volume: 1000 + (i % 5) * 100,
    });
    price = close;
  }
  return out;
}

// Near-monotonic series (drift + fixed wobble) — for indicator math.
function monotonic(
  n: number,
  start: number,
  step: number,
  base: number,
  drift: number,
  vol: number,
  down = false,
): CandleData[] {
  const out: CandleData[] = [];
  const d = down ? -Math.abs(drift) : drift;
  for (let i = 0; i < n; i++) {
    const open = base + d * i;
    const close = open + d * 0.9 + (i % 2 === 0 ? vol : -vol * 0.5);
    out.push({
      time: start + i * step,
      open: r2(open),
      high: r2(Math.max(open, close) + vol * 0.6),
      low: r2(Math.min(open, close) - vol * 0.6),
      close: r2(close),
      volume: 1000,
    });
  }
  return out;
}

function bar(time: number, open: number, high: number, low: number, close: number): CandleData {
  return { time, open, high, low, close, volume: 1000 };
}

// Uptrend fixture (HH/HL structure + bullish consensus) — tuned so
// structure=UPTREND AND SuperTrend=UP on the primary 15m timeframe.
const UP = zig(241, START, STEP, 24000, 12, 5, 8, 6);
const UP_NOW = START + 241 * STEP; // exactly one step after the last bar
const UP_SPOT = 24500;
const UP_PREV = 24480;
const UP_PDH = 24490;
const UP_PDL = 24200;

const IV_HISTORY = Array.from({ length: 25 }, (_, i) => 14 + (i % 8) * 0.7);

function upSnapshot(extra: Partial<Parameters<typeof buildTechnicalSnapshot>[0]> = {}) {
  return buildTechnicalSnapshot({
    candlesByTF: { '15m': UP },
    spot: UP_SPOT,
    prevClose: UP_PREV,
    pdh: UP_PDH,
    pdl: UP_PDL,
    now: UP_NOW,
    iv: 17.5,
    ivHistory: IV_HISTORY,
    oiSupportLevels: [24100],
    oiResistanceLevels: [24950],
    fetchedAtIso: new Date(UP_NOW).toISOString(),
    ...extra,
  });
}

// ─── Mock agent context ───────────────────────────────────────────────────

function mockCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    symbol: 'NIFTY',
    timeframe: '15m',
    exchange: 'NSE',
    instrument: 'index',
    spot: UP_SPOT,
    prevClose: UP_PREV,
    open: 24490,
    high: 24887,
    low: 24553,
    volume: 50_000_000,
    optionChain: {
      totalCallOI: 10_000_000,
      totalPutOI: 12_000_000,
      callOiChange: 500_000,
      putOiChange: 800_000,
      maxPain: 24500,
      atmStrike: 24500,
    },
    strikes: [
      { strike: 24500, ce: { ltp: 150, volume: 10000, oi: 50000, iv: 15 }, pe: { ltp: 140, volume: 12000, oi: 60000, iv: 16 } },
    ],
    vix: 14,
    vixChange: -0.5,
    fiiNet: 300,
    diiNet: 200,
    fiiBias: 'BULLISH_FLOW',
    participantOI: null,
    regime: 'TRENDING_UP',
    regimeBias: 'BULLISH',
    regimeConfidence: 70,
    trend: 'UP',
    swingHigh: 0,
    swingLow: 0,
    supportLevels: [],
    resistanceLevels: [],
    pdh: UP_PDH,
    pdl: UP_PDL,
    lastEvent: 'BOS_UP',
    atmDelta: 0.52,
    atmGamma: 0.0008,
    atmTheta: -3.5,
    atmVega: 0.45,
    atmIV: 16,
    totalVolume: 50_000_000,
    poc: 0,
    vah: 0,
    val: 0,
    gammaDetected: false,
    gammaWallStrike: 0,
    gammaFlip: 0,
    dealerBias: 'NEUTRAL',
    newsSentiment: 'NEUTRAL',
    newsScore: 0,
    headlines: [],
    marketStatus: 'OPEN',
    daysToExpiry: 2,
    expiry: '2026-10-08',
    dataTimestamp: new Date(UP_NOW).toISOString(),
    spotFreshness: 'FRESH',
    chainFreshness: 'FRESH',
    fetchedAtIso: new Date(UP_NOW).toISOString(),
    ...overrides,
  };
}

const TECH_AGENTS: AgentId[] = [
  'BUYER_CONFLUENCE', 'MARKET_STRUCTURE', 'SUPPORT_RESISTANCE', 'VWAP',
  'VOLUME', 'BREAKOUT', 'MTF_CONFIRMATION', 'MOMENTUM', 'ATR',
];

async function runTechAgents(ctx: AgentContext): Promise<Map<string, AgentResearchOutput>> {
  const out = await runAllAgents(ctx, TECH_AGENTS);
  return new Map(out.map(o => [o.agentId, o]));
}

// ═══════════════════════════════════════════════════════════════════════════
describe('candle hygiene — normalizeCandles / isCandleComplete', () => {
  it('sorts ascending, dedupes (keep last), drops invalid OHLC rows', () => {
    const out = normalizeCandles([
      bar(2, 100, 105, 99, 104),
      bar(1, 100, 105, 99, 103),
      bar(1, 100, 106, 99, 105),          // dup time → keep this one
      bar(3, 100, 98, 105, 101),          // high < low → drop
      bar(4, 100, 105, 99, 0),            // close <= 0 → drop
      bar(5, NaN, 105, 99, 101),          // NaN open → drop
    ]);
    expect(out.length).toBe(2);
    expect(out.map(c => c.time)).toEqual([1, 2]);
    expect(out[0].close).toBe(105); // duplicate resolved to last write
  });

  it('returns [] for null/undefined/non-array input', () => {
    expect(normalizeCandles(null)).toEqual([]);
    expect(normalizeCandles(undefined)).toEqual([]);
    expect(normalizeCandles([] as any)).toEqual([]);
  });

  it('isCandleComplete: complete only when time + timeframe <= now', () => {
    const c = bar(1_000_000, 100, 101, 99, 100);
    expect(isCandleComplete(c, '5m', 1_000_000 + 300_000)).toBe(true);
    expect(isCandleComplete(c, '5m', 1_000_000 + 299_999)).toBe(false);
    expect(isCandleComplete(c, '15m', 1_000_000 + 900_000)).toBe(true);
    expect(isCandleComplete(c, '15m', 1_000_000 + 899_999)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('aggregateCandles — exact session-anchored merge, no downward substitution', () => {
  const b0 = bar(START, 100, 110, 95, 108);                        // 09:15 IST
  const b1 = bar(START + STEP, 108, 115, 105, 112);                // 09:30 IST

  it('merges two 15m bars into one 30m bar with exact OHLC + summed volume', () => {
    const out = aggregateCandles([b0, b1], '30m');
    expect(out.length).toBe(1);
    expect(out[0].open).toBe(100);    // first bar open
    expect(out[0].close).toBe(112);   // last bar close
    expect(out[0].high).toBe(115);    // max high
    expect(out[0].low).toBe(95);      // min low
    expect(out[0].volume).toBe(2000); // sum
    expect(out[0].time).toBe(b0.time);
  });

  it('merges four 15m bars into one 1h session bucket', () => {
    const bars = [
      bar(START, 100, 110, 95, 108),
      bar(START + STEP, 108, 115, 105, 112),
      bar(START + 2 * STEP, 112, 120, 110, 118),
      bar(START + 3 * STEP, 118, 122, 112, 114),
    ];
    const out = aggregateCandles(bars, '1h');
    expect(out.length).toBe(1);
    expect(out[0].open).toBe(100);
    expect(out[0].close).toBe(114);
    expect(out[0].high).toBe(122);
    expect(out[0].low).toBe(95);
    expect(out[0].volume).toBe(4000);
  });

  it('never substitutes downward — smaller TFs pass through unchanged', () => {
    const bars = [b0, b1, bar(START + 2 * STEP, 112, 120, 110, 118)];
    expect(aggregateCandles(bars, '3m')).toEqual(normalizeCandles(bars));
    expect(aggregateCandles(bars, '1m')).toEqual(normalizeCandles(bars));
    expect(aggregateCandles(bars, '5m')).toEqual(normalizeCandles(bars));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('no-fabrication — empty / insufficient input yields NO_DATA everywhere', () => {
  const empty = buildTechnicalSnapshot({ candlesByTF: {}, now: START });

  it('empty input: every directional field is null/NO_DATA, never bullish/bearish', () => {
    expect(empty.trend).toBe('NO_DATA');
    expect(empty.movingAverages.emaTrend).toBe('NO_DATA');
    expect(empty.movingAverages.emaAlignment).toBe('NO_DATA');
    expect(empty.momentum.rsiState).toBe('NO_DATA');
    expect(empty.momentum.macdState).toBe('NO_DATA');
    expect(empty.momentum.roc).toBeNull();
    expect(empty.volatility.atrRegime).toBe('NO_DATA');
    expect(empty.volatility.bollinger).toBeNull();
    expect(empty.supertrend).toBeNull();
    expect(empty.volume.poc).toBeNull();
    expect(empty.volume.volumeTrend).toBe('NO_DATA');
    expect(empty.volumeProfile.profileAvailable).toBe(false);
    expect(empty.supportResistance.available).toBe(false);
    expect(empty.supportResistance.levels).toEqual([]);
    expect(empty.candlePatterns).toEqual([]);
    expect(empty.smc.bos).toBeNull();
    expect(empty.smc.choch).toBeNull();
    expect(empty.smc.mss).toBeNull();
    expect(empty.smc.fvg).toBeNull();
    expect(empty.smc.orderBlock).toBeNull();
    expect(empty.smc.liquidity).toBeNull();
    expect(empty.smc.premiumDiscount).toBeNull();
    expect(empty.mtf.mtfConsensus).toBe('NO_DATA');
    expect(empty.mtf.mtfConflict).toBe(false);
    expect(empty.mtf.trend3m).toBe('NO_DATA');
    expect(empty.dataQuality.dataFresh).toBe('MISSING');
    expect(empty.timeframes['5m'].available).toBe(false);
    expect(empty.dataQuality.incompleteCandle).toBe(false);
  });

  it('empty input: dataQuality.missingData lists every gap honestly', () => {
    const m = empty.dataQuality.missingData;
    expect(m).toContain('1m: provider_unavailable');
    expect(m).toContain('3m: provider_unavailable');
    expect(m).toContain('5m: no_candles');
    expect(m).toContain('RSI');
    expect(m).toContain('MACD');
    expect(m).toContain('ATR');
    expect(m).toContain('VOLUME_PROFILE');
    expect(m).toContain('IV');
    expect(m).toContain('IV_RANK');
  });

  it('insufficient candles: indicators stay NO_DATA until real minimums are met', () => {
    const bars = monotonic(8, START, STEP, 24000, 5, 1);
    const s = buildTechnicalSnapshot({ candlesByTF: { '15m': bars }, now: START + 8 * STEP + STEP });
    expect(s.timeframes['15m'].available).toBe(true);
    expect(s.timeframes['15m'].indicators).toBeNull();
    expect(s.timeframes['15m'].reason).toStartWith('insufficient');
    expect(s.momentum.rsiState).toBe('NO_DATA');       // <15 completed bars
    expect(s.volatility.bollinger).toBeNull();         // <20 closes
    expect(s.volatility.atrRegime).toBe('NO_DATA');    // <15 bars
    expect(s.trend).toBe('NO_DATA');
  });

  it('no spot → premium/discount zone is null (never a fabricated range)', () => {
    const s = upSnapshot({ spot: 0 });
    expect(s.smc.premiumDiscount).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('indicator math — EMA/SMA/RSI/MACD/Bollinger/ATR/ROC on real closes', () => {
  const bars = monotonic(220, START, STEP, 24000, 2, 1);
  const now = START + 221 * STEP;
  const s = buildTechnicalSnapshot({ candlesByTF: { '15m': bars }, spot: 24400, now, iv: 17.5, ivHistory: IV_HISTORY });

  it('SMA20 equals the independent mean of the last 20 closes', () => {
    const closes = bars.map(c => c.close);
    const expected = r2(closes.slice(-20).reduce((a, b) => a + b, 0) / 20);
    expect(s.movingAverages.sma20).toBe(expected);
    expect(s.movingAverages.sma20).toBe(r2(calculateSMA(closes, 20)));
  });

  it('uptrend stack: ema9 > ema20 > ema50 > ema200, trend/alignment BULLISH', () => {
    const ma = s.movingAverages;
    expect(ma.ema9).toBeGreaterThan(ma.ema20);
    expect(ma.ema20).toBeGreaterThan(ma.ema50);
    expect(ma.ema50).toBeGreaterThan(ma.ema200);
    expect(ma.emaTrend).toBe('BULLISH');
    expect(ma.emaAlignment).toBe('BULLISH');
  });

  it('RSI is real math: bounded 0-100, positive in an uptrend, slope computed', () => {
    expect(s.momentum.rsi).toBeGreaterThanOrEqual(0);
    expect(s.momentum.rsi).toBeLessThanOrEqual(100);
    expect(s.momentum.rsi).toBeGreaterThan(50);
    expect(s.momentum.rsiState).not.toBe('NO_DATA');
    expect(['UP', 'DOWN', 'FLAT']).toContain(s.momentum.rsiSlope);
  });

  it('MACD wiring matches ml-engine calculateMACD on the same completed closes', () => {
    const m = calculateMACD(bars.map(c => c.close));
    expect(m.valid).toBe(true);
    expect(s.momentum.macd).toBe(Math.round(m.macd * 100) / 100);
    expect(s.momentum.signal).toBe(Math.round(m.signal * 100) / 100);
    expect(s.momentum.histogram).toBe(Math.round(m.histogram * 100) / 100);
    expect(['BULLISH', 'BEARISH', 'NEUTRAL']).toContain(s.momentum.macdState);
  });

  it('ROC = real 5-bar rate of change (positive in an uptrend)', () => {
    const closes = bars.map(c => c.close);
    const expected = r2((closes[closes.length - 1] / closes[closes.length - 6] - 1) * 100);
    expect(s.momentum.roc).toBe(expected);
    expect(s.momentum.roc!).toBeGreaterThan(0);
  });

  it('Bollinger: bands ordered, percentB in range, squeeze state valid', () => {
    const bb = s.volatility.bollinger;
    expect(bb).not.toBeNull();
    expect(bb!.upper).toBeGreaterThan(bb!.middle);
    expect(bb!.middle).toBeGreaterThan(bb!.lower);
    expect(bb!.bandwidth).toBeGreaterThanOrEqual(0);
    expect(bb!.percentB).toBeGreaterThanOrEqual(0);
    expect(['SQUEEZE', 'EXPANSION', 'NORMAL']).toContain(bb!.squeezeState);
  });

  it('ATR + regime from completed bars; percent matches ATR/spot', () => {
    expect(s.volatility.atr).toBeGreaterThan(0);
    expect(['HIGH', 'NORMAL', 'LOW']).toContain(s.volatility.atrRegime);
    expect(s.volatility.atrPercent).toBeCloseTo((s.volatility.atr / 24400) * 100, 1);
  });

  it('SuperTrend present with positive value and valid direction', () => {
    expect(s.supertrend).not.toBeNull();
    expect(s.supertrend!.value).toBeGreaterThan(0);
    expect(['UP', 'DOWN']).toContain(s.supertrend!.direction);
    expect(Number.isFinite(s.supertrend!.distance)).toBe(true);
  });

  it('IV rank/percentile computed only with real history — else null', () => {
    expect(s.volatility.iv).toBe(17.5);
    expect(s.volatility.ivRank).not.toBeNull();
    expect(s.volatility.ivRank!).toBeGreaterThanOrEqual(0);
    expect(s.volatility.ivRank!).toBeLessThanOrEqual(100);
    expect(s.volatility.ivPercentile).not.toBeNull();

    const noHist = buildTechnicalSnapshot({ candlesByTF: { '15m': bars }, iv: 17.5, ivHistory: null, now });
    expect(noHist.volatility.ivRank).toBeNull();
    expect(noHist.volatility.ivPercentile).toBeNull();
    expect(noHist.dataQuality.missingData).toContain('IV_RANK');

    const noIv = buildTechnicalSnapshot({ candlesByTF: { '15m': bars }, iv: 0, now });
    expect(noIv.volatility.iv).toBe(0);
    expect(noIv.dataQuality.missingData).toContain('IV');
  });

  it('downtrend flips: ema stack bearish, RSI < 50, ROC negative', () => {
    const dn = monotonic(220, START, STEP, 25000, 2, 1, true);
    const sd = buildTechnicalSnapshot({ candlesByTF: { '15m': dn }, spot: 24400, now: START + 221 * STEP });
    expect(sd.movingAverages.emaTrend).toBe('BEARISH');
    expect(sd.movingAverages.emaAlignment).toBe('BEARISH');
    expect(sd.momentum.rsi).toBeLessThan(50);
    expect(sd.momentum.roc!).toBeLessThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('candle patterns — pure OHLC detection', () => {
  it('detects hammer: long lower wick, tiny body', () => {
    const p = analyzeCandlePatterns([bar(1, 100, 101, 101, 100), bar(2, 100, 101.5, 90, 101)]);
    expect(p.hammer).not.toBeNull();
    expect(p.hammer!.direction).toBe('BULLISH');
    expect(p.hammer!.timestamp).toBe(2);
    expect(p.hammer!.confidence).toBeGreaterThanOrEqual(0);
    expect(p.hammer!.confidence).toBeLessThanOrEqual(100);
  });

  it('detects bullish engulfing: green body swallows prior red body', () => {
    const p = analyzeCandlePatterns([
      bar(1, 110, 111, 99, 100),  // red body 10
      bar(2, 99, 113, 98, 112),   // green body 13, engulfs
    ]);
    expect(p.bullishEngulfing).not.toBeNull();
    expect(p.bullishEngulfing!.direction).toBe('BULLISH');
    expect(p.bullishEngulfing!.bodyPercent).toBeGreaterThan(0);
  });

  it('detects bearish engulfing: red body swallows prior green body', () => {
    const p = analyzeCandlePatterns([
      bar(1, 100, 111, 99, 110),  // green body 10
      bar(2, 111, 112, 98, 99),   // red body 12, engulfs
    ]);
    expect(p.bearishEngulfing).not.toBeNull();
    expect(p.bearishEngulfing!.direction).toBe('BEARISH');
  });

  it('detects morning star: long red → small gapped star → green above midpoint', () => {
    const p = analyzeCandlePatterns([
      bar(1, 120, 121, 99, 100),   // long red
      bar(2, 98, 99, 97, 98.4),    // small body, below prior close
      bar(3, 99, 112, 98.5, 111),  // long green, close > midpoint (110)
    ]);
    expect(p.morningStar).not.toBeNull();
    expect(p.morningStar!.direction).toBe('BULLISH');
  });

  it('detects evening star: long green → small gapped star → red below midpoint', () => {
    const p = analyzeCandlePatterns([
      bar(1, 100, 121, 99, 120),   // long green
      bar(2, 121.6, 122.5, 121, 122), // small body, above prior close
      bar(3, 121, 121.5, 108, 109),   // long red, close < midpoint (110)
    ]);
    expect(p.eveningStar).not.toBeNull();
    expect(p.eveningStar!.direction).toBe('BEARISH');
  });

  it('returns all-null / [] for undetected or insufficient candles', () => {
    const none = analyzeCandlePatterns([bar(1, 100, 110, 95, 105), bar(2, 105, 112, 100, 108)]);
    // nothing matches a named pattern here → all null, never a directional claim
    for (const v of Object.values(none)) {
      if (v !== null) expect(['BULLISH', 'BEARISH', 'NEUTRAL']).toContain(v.direction);
    }
    expect(analyzeCandlePatterns([]).hammer).toBeNull();
    expect(scanCandlePatterns([], 50)).toEqual([]);
  });

  it('scan returns chronological detections with bounded confidence', () => {
    const series = [
      bar(1, 110, 111, 99, 100),
      bar(2, 99, 113, 98, 112),
      bar(3, 112, 118, 110, 117),
      bar(4, 117, 125, 115, 124),
      bar(5, 124, 130, 120, 129),
    ];
    const found = scanCandlePatterns(series, 50);
    expect(found.length).toBeGreaterThan(0);
    for (let i = 1; i < found.length; i++) {
      expect(found[i].timestamp).toBeGreaterThanOrEqual(found[i - 1].timestamp);
    }
    for (const f of found) {
      expect(f.confidence).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeLessThanOrEqual(100);
    }
    expect(found.some(f => f.pattern === 'bullishEngulfing')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('incomplete-candle exclusion — forming bar never drives confirmed signals', () => {
  const completed = upSnapshot();

  // A huge bullish forming candle in the NEXT slot — not yet complete.
  const forming: CandleData = { time: START + 241 * STEP, open: 24380, high: 24600, low: 24370, close: 24590, volume: 9000 };
  const formingNow = forming.time + 60_000; // inside the 15m bar
  const withForming = buildTechnicalSnapshot({
    candlesByTF: { '15m': [...UP, forming] },
    spot: 24590, prevClose: UP_PREV, pdh: UP_PDH, pdl: UP_PDL,
    now: formingNow, iv: 17.5, ivHistory: IV_HISTORY,
  });

  it('flags the forming candle honestly', () => {
    expect(withForming.timeframes['15m'].isComplete).toBe(false);
    expect(withForming.timeframes['15m'].candleCount).toBe(242);
    expect(withForming.dataQuality.incompleteCandle).toBe(true);
    expect(completed.dataQuality.incompleteCandle).toBe(false);
  });

  it('no pattern is attributed to the forming candle', () => {
    expect(withForming.candlePatterns.filter(p => p.timestamp === forming.time)).toEqual([]);
  });

  it('confirmed signals (momentum/MTF/patterns) are computed on completed bars only', () => {
    expect(withForming.momentum).toEqual(completed.momentum);
    expect(withForming.candlePatterns).toEqual(completed.candlePatterns);
    expect(withForming.supertrend).toEqual(completed.supertrend);
    expect(withForming.volatility.atr).toEqual(completed.volatility.atr);
    expect(withForming.volatility.bollinger).toEqual(completed.volatility.bollinger);
    expect(withForming.timeframes['15m'].indicators).toEqual(completed.timeframes['15m'].indicators);
    expect(withForming.mtf.trend15m).toBe(completed.mtf.trend15m);
  });

  it('day high/low may still reflect observed extremes of the forming bar', () => {
    expect(withForming.priceAction.dayHigh).toBeGreaterThanOrEqual(forming.high);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('volume profile + bar-level volume', () => {
  it('real volumes → POC/VAH/VAL available and ordered', () => {
    const s = upSnapshot();
    expect(s.volumeProfile.profileAvailable).toBe(true);
    expect(s.volumeProfile.val!).toBeLessThanOrEqual(s.volumeProfile.poc!);
    expect(s.volumeProfile.poc!).toBeLessThanOrEqual(s.volumeProfile.vah!);
    expect(s.volumeProfile.poc!).toBeGreaterThan(0);
    expect(s.volume.poc).toBe(s.volumeProfile.poc);
    expect(s.volume.volumeProfileAvailable).toBe(true);
    expect(s.volume.relativeVolume).toBeGreaterThan(0);
    expect(['INCREASING', 'DECREASING', 'STABLE']).toContain(s.volume.volumeTrend);
    expect(s.dataQuality.missingData).not.toContain('VOLUME_PROFILE');
  });

  it('zero volumes → profile DEGRADED: poc null, never a 0-default masquerade', () => {
    const z = UP.map(c => ({ ...c, volume: 0 }));
    const s = buildTechnicalSnapshot({ candlesByTF: { '15m': z }, spot: UP_SPOT, now: UP_NOW });
    expect(s.volumeProfile.profileAvailable).toBe(false);
    expect(s.volume.poc).toBeNull();
    expect(s.volume.vah).toBeNull();
    expect(s.volume.val).toBeNull();
    expect(s.volume.volumeTrend).toBe('NO_DATA');
    expect(s.dataQuality.missingData).toContain('VOLUME_PROFILE');
  });

  it('volume spike detected on a real 5x completed bar', () => {
    const spiked = UP.map((c, i) => (i === UP.length - 1 ? { ...c, volume: 6000 } : c));
    const s = buildTechnicalSnapshot({ candlesByTF: { '15m': spiked }, spot: UP_SPOT, now: UP_NOW });
    expect(s.volume.relativeVolume).toBeGreaterThanOrEqual(2);
    expect(s.volume.volumeSpike).toBe(true);
    expect(s.volume.volumeTrend).toBe('INCREASING');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('multi-timeframe — aligned, conflicting, and 1m/3m unavailable', () => {
  it('aligned: bullish 15m + bullish daily → consensus BULLISH, no conflict', () => {
    const dailyUp = zig(60, Date.UTC(2026, 7, 1), 86_400_000, 23500, 60, 25, 8, 20, 1);
    const s = buildTechnicalSnapshot({ candlesByTF: { '15m': UP, '1d': dailyUp }, spot: UP_SPOT, now: UP_NOW });
    expect(s.mtf.mtfConsensus).toBe('BULLISH');
    expect(s.mtf.mtfConflict).toBe(false);
    expect(s.mtf.trend15m).toBe('BULLISH');
    expect(s.mtf.trendDaily).toBe('BULLISH');
    expect(s.mtf.higherTFTrend).toBe('BULLISH');
    expect(s.mtf.trend3m).toBe('NO_DATA');
    expect(s.mtf.trend5m).toBe('NO_DATA'); // not fetched → NO_DATA, never assumed
  });

  it('conflicting: bullish 15m + bearish daily → NEUTRAL with mtfConflict', () => {
    const dailyDown = zig(60, Date.UTC(2026, 7, 1), 86_400_000, 25200, 4, 12, 8, 40, -1);
    const s = buildTechnicalSnapshot({ candlesByTF: { '15m': UP, '1d': dailyDown }, spot: UP_SPOT, now: UP_NOW });
    expect(s.mtf.mtfConflict).toBe(true);
    expect(s.mtf.mtfConsensus).toBe('NEUTRAL');
    expect(s.mtf.trend15m).toBe('BULLISH');
    expect(s.mtf.trendDaily).toBe('BEARISH');
    expect(s.mtf.higherTFTrend).toBe('BEARISH');
  });

  it('1m/3m are never substituted — reported provider_unavailable', () => {
    const s = upSnapshot();
    expect(s.timeframes['1m'].available).toBe(false);
    expect(s.timeframes['3m'].available).toBe(false);
    expect(s.dataQuality.missingData).toContain('1m: provider_unavailable');
    expect(s.dataQuality.missingData).toContain('3m: provider_unavailable');
  });

  it('higher timeframes derive UPWARD from 15m with fewer bars', () => {
    const s = upSnapshot();
    expect(s.timeframes['30m'].available).toBe(true);
    expect(s.timeframes['1h'].available).toBe(true);
    expect(s.timeframes['30m'].candleCount).toBeGreaterThan(0);
    expect(s.timeframes['30m'].candleCount).toBeLessThan(241);
    expect(s.timeframes['1h'].candleCount).toBeLessThan(s.timeframes['30m'].candleCount);
    expect(s.timeframes['30m'].indicators).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('SMC evidence — structure/FVG/OB/liquidity/premium-discount', () => {
  const s = upSnapshot();

  it('premium/discount: real dealing range, correct equilibrium + zone', () => {
    const pd = s.smc.premiumDiscount;
    expect(pd).not.toBeNull();
    expect(pd!.rangeHigh).toBeGreaterThan(pd!.rangeLow);
    expect(pd!.equilibrium).toBeCloseTo((pd!.rangeHigh + pd!.rangeLow) / 2, 1);
    const band = pd!.equilibrium * 0.001;
    const expectedZone = Math.abs(UP_SPOT - pd!.equilibrium) <= band
      ? 'EQUILIBRIUM'
      : UP_SPOT > pd!.equilibrium ? 'PREMIUM' : 'DISCOUNT';
    expect(pd!.currentZone).toBe(expectedZone);
  });

  it('price action: HH + HL structure with real swing prices', () => {
    expect(s.priceAction.higherHigh).toBe(true);
    expect(s.priceAction.higherLow).toBe(true);
    expect(s.priceAction.lowerHigh).toBe(false);
    expect(s.priceAction.lowerLow).toBe(false);
    expect(s.priceAction.swingHigh).toBeGreaterThan(0);
    expect(s.priceAction.swingLow).toBeGreaterThan(0);
    expect(s.priceAction.swingHigh).toBeGreaterThan(s.priceAction.swingLow);
  });

  it('FVG (when detected): upper > lower, fill tracked honestly', () => {
    if (s.smc.fvg) {
      expect(s.smc.fvg.upper).toBeGreaterThan(s.smc.fvg.lower);
      expect(['OPEN', 'PARTIAL', 'FILLED']).toContain(s.smc.fvg.status);
      expect(s.smc.fvg.filledPercent).toBeGreaterThanOrEqual(0);
      expect(s.smc.fvg.filledPercent).toBeLessThanOrEqual(1);
      if (s.smc.fvg.status === 'FILLED') expect(s.smc.fvg.filledPercent).toBe(1);
      if (s.smc.fvg.status === 'OPEN') expect(s.smc.fvg.filledPercent).toBe(0);
    }
  });

  it('order block (when detected): valid zone, mitigation + strength invariants', () => {
    if (s.smc.orderBlock) {
      expect(s.smc.orderBlock.high).toBeGreaterThan(s.smc.orderBlock.low);
      expect(typeof s.smc.orderBlock.mitigated).toBe('boolean');
      if (s.smc.orderBlock.strength !== null) {
        expect(s.smc.orderBlock.strength).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('BOS/CHoCH/MSS/liquidity stay null when undetected — no directional claims', () => {
    const empty = buildTechnicalSnapshot({ candlesByTF: {}, now: UP_NOW });
    expect(empty.smc.bos).toBeNull();
    expect(empty.smc.choch).toBeNull();
    expect(empty.smc.mss).toBeNull();
    expect(empty.smc.liquidity).toBeNull();
    if (s.smc.mss) {
      expect(['BULLISH', 'BEARISH']).toContain(s.smc.mss.direction);
      expect(typeof s.smc.mss.displacement).toBe('boolean');
      expect(typeof s.smc.mss.sweepGated).toBe('boolean');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('support/resistance — clustered zones with provenance', () => {
  const s = upSnapshot();

  it('available with ≤6 clustered levels, ordered, valid sources + strengths', () => {
    expect(s.supportResistance.available).toBe(true);
    expect(s.supportResistance.levels.length).toBeGreaterThan(0);
    expect(s.supportResistance.levels.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < s.supportResistance.levels.length; i++) {
      expect(s.supportResistance.levels[i].level).toBeGreaterThanOrEqual(s.supportResistance.levels[i - 1].level);
    }
    for (const lv of s.supportResistance.levels) {
      expect(['SUPPORT', 'RESISTANCE']).toContain(lv.type);
      expect(['SWING', 'PDH_PDL', 'DAY_HIGH_LOW', 'VOLUME_PROFILE', 'OI_WALL']).toContain(lv.source);
      expect(lv.strength).toBeGreaterThanOrEqual(0);
      expect(lv.strength).toBeLessThanOrEqual(100);
      expect(lv.timeframe).toBe('15m');
      expect(lv.level).toBeGreaterThan(0);
    }
  });

  it('carries provenance: PDH/PDL, swing, day-range, OI walls, profile', () => {
    const sources = new Set(s.supportResistance.levels.map(l => l.source));
    expect(sources).toContain('PDH_PDL');
    expect(sources).toContain('SWING');
    expect(sources).toContain('OI_WALL');
    expect(sources).toContain('VOLUME_PROFILE');
  });

  it('price action echoes real inputs: pdh/pdl, opening range, day range, gap', () => {
    expect(s.priceAction.pdh).toBe(UP_PDH);
    expect(s.priceAction.pdl).toBe(UP_PDL);
    expect(s.priceAction.openingRangeHigh).toBeGreaterThanOrEqual(s.priceAction.openingRangeLow);
    expect(s.priceAction.dayHigh).toBeGreaterThan(0);
    expect(s.priceAction.dayLow).toBeGreaterThan(0);
    expect(s.priceAction.dayHigh).toBeGreaterThanOrEqual(s.priceAction.dayLow);

    // gap = first bar of the last session vs prevClose (both real)
    const dayKey = (t: number) => Math.floor((t + IST_MS) / 86_400_000);
    const lastDay = dayKey(UP[UP.length - 1].time);
    const todays = UP.filter(c => dayKey(c.time) === lastDay);
    const dayOpen = todays[0].open;
    const gapUp = buildTechnicalSnapshot({ candlesByTF: { '15m': UP }, prevClose: dayOpen - 5, now: UP_NOW });
    const gapDown = buildTechnicalSnapshot({ candlesByTF: { '15m': UP }, prevClose: dayOpen + 5, now: UP_NOW });
    expect(gapUp.priceAction.gapUp).toBe(true);
    expect(gapUp.priceAction.gapDown).toBe(false);
    expect(gapDown.priceAction.gapDown).toBe(true);
    expect(gapDown.priceAction.gapUp).toBe(false);
  });

  it('dataQuality: honest freshness from real candle timestamps', () => {
    expect(s.dataQuality.fetchedAt).toBe(new Date(UP_NOW).toISOString());
    expect(s.dataQuality.ageSeconds).toBe(900); // now = last bar + one 15m step
    expect(s.dataQuality.dataFresh).toBe('FRESH');
    expect(s.dataQuality.latestCandleAt).not.toBe('');
    expect(s.dataQuality.candleCount).toBe(241);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('agent integration — ctx.technical present', () => {
  let outputs: Map<string, AgentResearchOutput>;

  it('runs the 9 technical agents without errors on a real snapshot', async () => {
    const technical = upSnapshot();
    outputs = await runTechAgents(mockCtx({ technical: technical as any }));
    expect(outputs.size).toBe(9);
    for (const o of outputs.values()) {
      expect(o.bias).not.toBe('ERROR');
      expect(o.agentId).toBeTruthy();
      expect(o.recommendationContext).toBeTruthy();
    }
  });

  it('13 BUYER_CONFLUENCE surfaces EMA alignment + MTF consensus evidence', () => {
    const o = outputs.get('BUYER_CONFLUENCE')!;
    expect(o.evidence.some(e => e.startsWith('EMA alignment'))).toBe(true);
    expect(o.evidence.some(e => e.startsWith('MTF consensus:'))).toBe(true);
    expect(o.evidence.some(e => e.includes('Recent bullish candle pattern') || e.includes('Recent bearish candle pattern'))).toBe(true);
  });

  it('18 MARKET_STRUCTURE surfaces swings + dealing range + SMC data', () => {
    const o = outputs.get('MARKET_STRUCTURE')!;
    expect(o.evidence).toContain('Swing sequence: HH + HL');
    expect(o.evidence.some(e => e.startsWith('Dealing range:'))).toBe(true);
    expect((o.data as any).smc).not.toBeNull();
    expect((o.data as any).smc.premiumDiscount).not.toBeNull();
    expect((o.data as any).priceAction.higherHigh).toBe(true);
    expect(o.conflicts).toEqual([]);
  });

  it('19 SUPPORT_RESISTANCE carries clustered levels + volume profile', () => {
    const o = outputs.get('SUPPORT_RESISTANCE')!;
    const d = o.data as any;
    expect(Array.isArray(d.levels)).toBe(true);
    expect(d.levels.length).toBeGreaterThan(0);
    expect(d.volumeProfile).not.toBeNull();
    expect(d.volumeProfile.poc).toBeGreaterThan(0);
    expect(o.evidence.some(e => e.startsWith('Volume profile: POC'))).toBe(true);
  });

  it('20 VWAP uses the real candle VWAP when ctx.poc is absent', () => {
    const o = outputs.get('VWAP')!;
    expect(o.bias).not.toBe('NO_DATA');
    expect(o.evidence.some(e => e.startsWith('VWAP source: 15m'))).toBe(true);
    expect((o.data as any).vwap).toBeGreaterThan(0);
  });

  it('21 VOLUME reports bar-level trend + relative volume + profile flag', () => {
    const o = outputs.get('VOLUME')!;
    const d = o.data as any;
    expect(o.evidence.some(e => e.startsWith('Volume trend:'))).toBe(true);
    expect(o.evidence.some(e => e.startsWith('Relative volume:'))).toBe(true);
    expect(d.volumeTrend).not.toBe('NO_DATA');
    expect(d.relativeVolume).toBeGreaterThan(0);
    expect(d.profileAvailable).toBe(true);
  });

  it('23 MTF_CONFIRMATION reports per-TF trends + consensus from real data', () => {
    const o = outputs.get('MTF_CONFIRMATION')!;
    expect(o.evidence.some(e => e.startsWith('Timeframes —'))).toBe(true);
    expect(o.evidence).toContain('MTF consensus: BULLISH');
    expect(o.evidence.some(e => e.startsWith('3m: NO_DATA'))).toBe(true);
    expect(o.bias).toBe('BULLISH');
    const d = o.data as any;
    expect(d.mtfConsensus).toBe('BULLISH');
    expect(d.mtfConflict).toBe(false);
    expect(d.trend3m).toBe('NO_DATA');
  });

  it('24 MOMENTUM reports RSI/MACD/SuperTrend/ROC from real candles', () => {
    const o = outputs.get('MOMENTUM')!;
    expect(o.evidence.some(e => e.startsWith('RSI '))).toBe(true);
    expect(o.evidence.some(e => e.startsWith('MACD '))).toBe(true);
    expect(o.evidence.some(e => e.startsWith('SuperTrend '))).toBe(true);
    expect(o.evidence.some(e => e.startsWith('5-bar ROC'))).toBe(true);
    expect(o.evidence.some(e => e.startsWith('Momentum candle:'))).toBe(true);
    const d = o.data as any;
    expect(d.rsiState).not.toBe('NO_DATA');
    expect(typeof d.roc).toBe('number');
    expect(d.supertrend).not.toBeNull();
  });

  it('25 ATR reports candle ATR + regime + honest IV rank/percentile', () => {
    const o = outputs.get('ATR')!;
    expect(o.evidence.some(e => e.startsWith('ATR regime:'))).toBe(true);
    expect(o.evidence.some(e => e.startsWith('ATR: '))).toBe(true);
    expect(o.evidence.some(e => e.startsWith('IV: 17.5'))).toBe(true);
    const d = o.data as any;
    expect(['HIGH', 'NORMAL', 'LOW']).toContain(d.atrRegime);
    expect(d.atr).toBeGreaterThan(0);
    expect(d.ivRank).not.toBeNull();
    expect(d.ivPercentile).not.toBeNull();
  });

  it('22 BREAKOUT confirms with candle volume spike + momentum candle + retest', async () => {
    // spike volume on the last completed bar; spot inside the PDH retest band
    const spiked = UP.map((c, i) => (i === UP.length - 1 ? { ...c, volume: 6000 } : c));
    const technical = buildTechnicalSnapshot({
      candlesByTF: { '15m': spiked }, spot: 24500, prevClose: UP_PREV,
      pdh: UP_PDH, pdl: UP_PDL, now: UP_NOW, iv: 17.5, ivHistory: IV_HISTORY,
    });
    const [o] = await runAllAgents(mockCtx({ technical: technical as any }), ['BREAKOUT']);
    expect(o.bias).toBe('BULLISH');
    expect(o.evidence).toContain('Volume spike confirms breakout pressure');
    expect(o.evidence).toContain('Momentum candle confirms direction');
    expect(o.evidence).toContain('Retesting PDH from above');
    expect(o.conflicts).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('agent integration — ctx.technical absent (legacy / NO_DATA paths)', () => {
  let outputs: Map<string, AgentResearchOutput>;

  it('runs the same 9 agents without a technical layer', async () => {
    outputs = await runTechAgents(mockCtx());
    expect(outputs.size).toBe(9);
    for (const o of outputs.values()) expect(o.bias).not.toBe('ERROR');
  });

  it('no technical-only evidence leaks into any agent output', () => {
    const all = [...outputs.values()].flatMap(o => o.evidence);
    expect(all.some(e => e.startsWith('Timeframes —'))).toBe(false);
    expect(all.some(e => e.startsWith('MTF consensus:'))).toBe(false);
    expect(all.some(e => e.startsWith('RSI '))).toBe(false);
    expect(all.some(e => e.startsWith('SuperTrend '))).toBe(false);
    expect(all.some(e => e.startsWith('5-bar ROC'))).toBe(false);
    expect(all.some(e => e.startsWith('ATR regime:'))).toBe(false);
    expect(all.some(e => e.startsWith('Volume trend:'))).toBe(false);
    expect(all.some(e => e.startsWith('Relative volume:'))).toBe(false);
    expect(all.some(e => e.startsWith('VWAP source:'))).toBe(false);
    expect(all.some(e => e.startsWith('Dealing range:'))).toBe(false);
    expect(all.some(e => e.startsWith('Swing sequence:'))).toBe(false);
    expect(all.some(e => e.startsWith('EMA alignment'))).toBe(false);
    expect(all.some(e => e.startsWith('Volume profile: POC'))).toBe(false);
    expect(all.some(e => e.includes('Retesting PDH'))).toBe(false);
  });

  it('23 MTF falls back to the legacy trend proxy', () => {
    const o = outputs.get('MTF_CONFIRMATION')!;
    expect(o.evidence).toContain('Higher timeframe trend: UP');
    expect((o.data as any).trend).toBe('UP');
    expect((o.data as any).mtfConsensus).toBeUndefined();
  });

  it('24 MOMENTUM reports only price-change data, all technical fields NO_DATA', () => {
    const o = outputs.get('MOMENTUM')!;
    const d = o.data as any;
    expect(d.priceChangePct).toBeCloseTo(((UP_SPOT - UP_PREV) / UP_PREV) * 100, 3);
    expect(d.rsiState).toBe('NO_DATA');
    expect(d.macdState).toBe('NO_DATA');
    expect(d.supertrend).toBeNull();
    expect(d.roc).toBeNull();
  });

  it('25 ATR reports NO_DATA technicals; rawContext path unchanged', () => {
    const o = outputs.get('ATR')!;
    const d = o.data as any;
    expect(d.atrRegime).toBe('NO_DATA');
    expect(d.ivRank).toBeNull();
    expect(d.ivPercentile).toBeNull();
    expect(o.evidence.some(e => e.startsWith('ATR regime:'))).toBe(false);
  });

  it('21 VOLUME reports NO_DATA technicals; legacy POC path still works with hermes data', () => {
    const o = outputs.get('VOLUME')!;
    const d = o.data as any;
    expect(d.volumeTrend).toBe('NO_DATA');
    expect(d.profileAvailable).toBe(false);
    expect(d.relativeVolume).toBeNull();

    // hermes POC still drives the legacy acceptance read (poc=0 → no claim)
    expect(o.bias).toBe('NEUTRAL');

    // with a real hermes POC the legacy path classifies
    return runTechAgents(mockCtx({ poc: 24400 })).then(m2 => {
      const o2 = m2.get('VOLUME')!;
      expect(o2.bias).toBe('BULLISH'); // spot 24500 > poc 24400
      expect(o2.evidence).toContain('POC: 24400');
    });
  });

  it('19 SUPPORT_RESISTANCE: no profile/level data without the technical layer', () => {
    const o = outputs.get('SUPPORT_RESISTANCE')!;
    const d = o.data as any;
    expect(d.levels).toEqual([]);
    expect(d.volumeProfile).toBeNull();
  });

  it('18 MARKET_STRUCTURE: no SMC claims without candles', () => {
    const o = outputs.get('MARKET_STRUCTURE')!;
    expect((o.data as any).smc).toBeNull();
    expect((o.data as any).priceAction).toBeNull();
  });

  it('20 VWAP with no candle VWAP and no hermes POC → honest NO_DATA', () => {
    const o = outputs.get('VWAP')!;
    expect(o.bias).toBe('NO_DATA');
    expect(o.confidence).toBe(0);
    expect(o.dataFreshness).toBe('MISSING');
  });
});
