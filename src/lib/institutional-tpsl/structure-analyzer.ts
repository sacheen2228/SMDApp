// ═══════════════════════════════════════════════════════════════════
// MODULE 1 — STRUCTURE ANALYZER
// Detects market structure from underlying OHLC candles:
//   Swing Highs / Lows, Order Blocks, Fair Value Gaps, Liquidity
//   Sweeps, BOS / CHoCH / MSS. Produces a single StructureReport that
//   the orchestrator consumes to (a) decide direction/bias, (b) locate
//   the primary structure-based stop, and (c) feed liquidity zones to
//   the TP engine.
//
// No single factor is trusted: clarity requires confluence of at least
// one structural element (OB / FVG) AND a directional break (BOS/MSS)
// aligned with the trade side.
// ═══════════════════════════════════════════════════════════════════

import { Bias, Candle, OptionType, StructureClarity } from './types';

export interface Swing {
  index: number;
  time: number;
  price: number;
  kind: 'HIGH' | 'LOW';
}

export interface OrderBlock {
  index: number;
  time: number;
  top: number;
  bottom: number;
  kind: 'BULLISH' | 'BEARISH';
  strength: number; // 0..1 — size of the impulse that followed
}

export interface FVG {
  index: number;
  time: number;
  top: number;
  bottom: number;
  kind: 'BULLISH' | 'BEARISH';
}

export interface LiquiditySweep {
  index: number;
  time: number;
  sweptLevel: number;
  kind: 'HIGH' | 'LOW';
}

export interface StructureBreak {
  kind: 'BOS' | 'CHoCH' | 'MSS';
  index: number;
  time: number;
  level: number;
  direction: 'UP' | 'DOWN';
}

export interface StructureReport {
  bias: Bias;
  clarity: StructureClarity;
  reason: string;
  swingHighs: Swing[];
  swingLows: Swing[];
  lastSwingHigh: Swing | null;
  lastSwingLow: Swing | null;
  orderBlocks: OrderBlock[];
  fvgs: FVG[];
  liquiditySweeps: LiquiditySweep[];
  breaks: StructureBreak[];
  bos: StructureBreak | null;
  choc: StructureBreak | null;
  mss: StructureBreak | null;
  /** Primary structure stop in INDEX price space (null if unclear). */
  structureStopLevel: number | null;
  nearestOB: OrderBlock | null;
  nearestFVG: FVG | null;
  alignedWithTrade: boolean;
}

// ─── Swing detection (pivot highs/lows) ───────────────────────────
export function findSwings(candles: Candle[], left = 2, right = 2): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = [];
  const lows: Swing[] = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, time: candles[i].time, price: candles[i].high, kind: 'HIGH' });
    if (isLow) lows.push({ index: i, time: candles[i].time, price: candles[i].low, kind: 'LOW' });
  }
  return { highs, lows };
}

// ─── Order Blocks ────────────────────────────────────────────────
// Bullish OB: a bearish (down) candle immediately preceding a strong up-impulse
// (next candle closes above this candle's high). Zone = that candle's range.
// Bearish OB is the mirror.
export function findOrderBlocks(candles: Candle[], impulseThreshold = 0.0008): OrderBlock[] {
  const obs: OrderBlock[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const c = candles[i];
    const next = candles[i + 1];
    const body = Math.abs(c.close - c.open) / (c.open || 1);
    if (c.close < c.open) {
      // potential bullish OB: up-impulse follows
      const move = (next.close - c.high) / (c.high || 1);
      if (next.close > c.high && move > impulseThreshold) {
        obs.push({
          index: i, time: c.time, top: c.high, bottom: c.low,
          kind: 'BULLISH', strength: Math.min(1, move / 0.02),
        });
      }
    } else if (c.close > c.open) {
      // potential bearish OB: down-impulse follows
      const move = (c.low - next.close) / (c.low || 1);
      if (next.close < c.low && move > impulseThreshold) {
        obs.push({
          index: i, time: c.time, top: c.high, bottom: c.low,
          kind: 'BEARISH', strength: Math.min(1, move / 0.02),
        });
      }
    }
  }
  return obs;
}

// ─── Fair Value Gaps ─────────────────────────────────────────────
// Bullish FVG: candles[i+1].low > candles[i-1].high → gap between them.
// Bearish FVG: candles[i+1].high < candles[i-1].low.
export function findFVGs(candles: Candle[], minGapPct = 0.0005): FVG[] {
  const fvgs: FVG[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const nxt = candles[i + 1];
    if (nxt.low > prev.high) {
      const gap = nxt.low - prev.high;
      if (gap / (prev.high || 1) > minGapPct) {
        fvgs.push({ index: i, time: candles[i].time, top: nxt.low, bottom: prev.high, kind: 'BULLISH' });
      }
    } else if (nxt.high < prev.low) {
      const gap = prev.low - nxt.high;
      if (gap / (prev.low || 1) > minGapPct) {
        fvgs.push({ index: i, time: candles[i].time, top: prev.low, bottom: nxt.high, kind: 'BEARISH' });
      }
    }
  }
  return fvgs;
}

// ─── Liquidity Sweeps ────────────────────────────────────────────
// A wick that pierces a prior swing high/low then closes back inside →
// stops harvested, often precedes reversal/continuation.
export function findLiquiditySweeps(candles: Candle[], swings: { highs: Swing[]; lows: Swing[] }): LiquiditySweep[] {
  const sweeps: LiquiditySweep[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    for (const s of swings.highs) {
      if (s.index >= i) break;
      if (c.high > s.price && c.close < s.price) {
        sweeps.push({ index: i, time: c.time, sweptLevel: s.price, kind: 'HIGH' });
        break;
      }
    }
    for (const s of swings.lows) {
      if (s.index >= i) break;
      if (c.low < s.price && c.close > s.price) {
        sweeps.push({ index: i, time: c.time, sweptLevel: s.price, kind: 'LOW' });
        break;
      }
    }
  }
  return sweeps;
}

// ─── BOS / CHoCH / MSS ──────────────────────────────────────────
// MSS: first break of a prior swing that establishes a new impulse.
// BOS: continuation break of the most-recent swing in trend direction.
// CHoCH: break against the established trend (character change).
export function findBreaks(candles: Candle[], swings: { highs: Swing[]; lows: Swing[] }): StructureBreak[] {
  const breaks: StructureBreak[] = [];
  const { highs, lows } = swings;
  if (highs.length === 0 || lows.length === 0) return breaks;

  // MSS = earliest break of either extreme
  let mss: StructureBreak | null = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    for (const h of highs) {
      if (h.index >= i) break;
      if (c.close > h.price) { mss = { kind: 'MSS', index: i, time: c.time, level: h.price, direction: 'UP' }; break; }
    }
    if (mss) break;
    for (const l of lows) {
      if (l.index >= i) break;
      if (c.close < l.price) { mss = { kind: 'MSS', index: i, time: c.time, level: l.price, direction: 'DOWN' }; break; }
    }
    if (mss) break;
  }
  if (mss) breaks.push(mss);

  // Trend from sequence of last two swings of each side
  const lastH = highs[highs.length - 1];
  const prevH = highs[highs.length - 2];
  const lastL = lows[lows.length - 1];
  const prevL = lows[lows.length - 2];
  let trend: 'UP' | 'DOWN' | null = null;
  if (lastH && prevH && lastH.price > prevH.price && lastL && prevL && lastL.price > prevL.price) trend = 'UP';
  else if (lastH && prevH && lastH.price < prevH.price && lastL && prevL && lastL.price < prevL.price) trend = 'DOWN';

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (trend === 'UP') {
      if (c.close > lastH.price) { breaks.push({ kind: 'BOS', index: i, time: c.time, level: lastH.price, direction: 'UP' }); break; }
      if (c.close < lastL.price) { breaks.push({ kind: 'CHoCH', index: i, time: c.time, level: lastL.price, direction: 'DOWN' }); break; }
    } else if (trend === 'DOWN') {
      if (c.close < lastL.price) { breaks.push({ kind: 'BOS', index: i, time: c.time, level: lastL.price, direction: 'DOWN' }); break; }
      if (c.close > lastH.price) { breaks.push({ kind: 'CHoCH', index: i, time: c.time, level: lastH.price, direction: 'UP' }); break; }
    }
  }
  return breaks;
}

// ─── Orchestrate structure analysis ──────────────────────────────
export function analyzeStructure(candles: Candle[], spot: number, type: OptionType): StructureReport {
  const empty: StructureReport = {
    bias: 'NEUTRAL', clarity: 'UNCLEAR', reason: 'insufficient candle data',
    swingHighs: [], swingLows: [], lastSwingHigh: null, lastSwingLow: null,
    orderBlocks: [], fvgs: [], liquiditySweeps: [], breaks: [],
    bos: null, choc: null, mss: null, structureStopLevel: null,
    nearestOB: null, nearestFVG: null, alignedWithTrade: false,
  };
  if (!candles || candles.length < 12) return empty;

  const swings = findSwings(candles);
  const { highs, lows } = swings;
  const orderBlocks = findOrderBlocks(candles);
  const fvgs = findFVGs(candles);
  const liquiditySweeps = findLiquiditySweeps(candles, swings);
  const breaks = findBreaks(candles, swings);

  const lastSwingHigh = highs.length ? highs[highs.length - 1] : null;
  const lastSwingLow = lows.length ? lows[lows.length - 1] : null;
  const bos = breaks.find(b => b.kind === 'BOS') ?? null;
  const choc = breaks.find(b => b.kind === 'CHoCH') ?? null;
  const mss = breaks.find(b => b.kind === 'MSS') ?? null;

  // Bias from breaks (most recent decisive break wins)
  let bias: Bias = 'NEUTRAL';
  if (bos?.direction === 'UP' || mss?.direction === 'UP') bias = 'BULLISH';
  else if (bos?.direction === 'DOWN' || mss?.direction === 'DOWN') bias = 'BEARISH';
  else if (lastSwingHigh && lastSwingLow) {
    const hh = highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price;
    const hl = lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price;
    if (hh && hl) bias = 'BULLISH';
    else if (!hh && !hl) bias = 'BEARISH';
  }

  // Alignment with trade side
  const bullishStruct = bias !== 'BEARISH' && (bos?.direction === 'UP' || mss?.direction === 'UP' || orderBlocks.some(o => o.kind === 'BULLISH') || fvgs.some(f => f.kind === 'BULLISH'));
  const bearishStruct = bias !== 'BULLISH' && (bos?.direction === 'DOWN' || mss?.direction === 'DOWN' || orderBlocks.some(o => o.kind === 'BEARISH') || fvgs.some(f => f.kind === 'BEARISH'));
  const alignedWithTrade = type === 'CE' ? bullishStruct : bearishStruct;

  // Clarity: need both a structural element AND a directional break aligned.
  const hasElement = orderBlocks.length > 0 || fvgs.length > 0;
  const hasBreak = !!bos || !!mss;
  const clarity: StructureClarity = alignedWithTrade && hasElement && hasBreak ? 'CLEAR' : 'UNCLEAR';

  // Primary structure stop (index space)
  let structureStopLevel: number | null = null;
  let nearestOB: OrderBlock | null = null;
  let nearestFVG: FVG | null = null;
  if (type === 'CE') {
    // support below spot: max of (lastSwingLow, bullish OB bottom, bullish FVG bottom) below spot
    const supports: number[] = [];
    if (lastSwingLow && lastSwingLow.price < spot) supports.push(lastSwingLow.price);
    for (const o of orderBlocks) if (o.kind === 'BULLISH' && o.bottom < spot) { supports.push(o.bottom); if (!nearestOB || o.bottom > nearestOB.bottom) nearestOB = o; }
    for (const f of fvgs) if (f.kind === 'BULLISH' && f.bottom < spot) { supports.push(f.bottom); if (!nearestFVG || f.bottom > nearestFVG.bottom) nearestFVG = f; }
    structureStopLevel = supports.length ? Math.max(...supports) : null;
  } else {
    const resists: number[] = [];
    if (lastSwingHigh && lastSwingHigh.price > spot) resists.push(lastSwingHigh.price);
    for (const o of orderBlocks) if (o.kind === 'BEARISH' && o.top > spot) { resists.push(o.top); if (!nearestOB || o.top < nearestOB.top) nearestOB = o; }
    for (const f of fvgs) if (f.kind === 'BEARISH' && f.top > spot) { resists.push(f.top); if (!nearestFVG || f.top < nearestFVG.top) nearestFVG = f; }
    structureStopLevel = resists.length ? Math.min(...resists) : null;
  }

  return {
    bias, clarity,
    reason: clarity === 'CLEAR'
      ? `${type} structure CLEAR (${bias}, ${orderBlocks.length} OB, ${fvgs.length} FVG, ${bos ? 'BOS' : mss ? 'MSS' : 'no-break'})`
      : `${type} structure UNCLEAR (aligned=${alignedWithTrade}, elements=${hasElement}, break=${hasBreak})`,
    swingHighs: highs, swingLows: lows, lastSwingHigh, lastSwingLow,
    orderBlocks, fvgs, liquiditySweeps, breaks, bos, choc, mss,
    structureStopLevel, nearestOB, nearestFVG, alignedWithTrade,
  };
}
