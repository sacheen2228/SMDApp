// Unit tests for Module 1 — Structure Analyzer
// Run: bun run src/lib/institutional-tpsl/__tests__/structure.test.ts

import { Candle } from '../types';
import { analyzeStructure, findSwings, findOrderBlocks, findFVGs, findBreaks } from '../structure-analyzer';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log('  ✓', msg); }
  else { failed++; console.error('  ✗ FAIL:', msg); }
}

// Explicit OHLC builder.
function mk(o: number, h: number, l: number, c: number, t = 0, v = 1e6): Candle {
  return { time: t, open: o, high: h, low: l, close: c, volume: v };
}

// A crafted bullish structure: uptrend → peak swing high (104) → pullback
// swing low → bearish OB → gap-up FVG → breakout (BOS/MSS). Spot = 114.
function bullishCandles(): Candle[] {
  return [
    mk(99, 100, 98.5, 100, 1),
    mk(100, 101, 99.5, 100.5, 2),
    mk(100.5, 102, 100, 101.5, 3),
    mk(101.5, 104, 101, 103, 4),     // peak swing high 104
    mk(103, 103.5, 101, 101.5, 5),
    mk(101.5, 102, 99.5, 100, 6),    // swing low 99.5
    mk(100, 100.5, 98, 99, 7),       // bearish OB candle
    mk(99, 104, 103.5, 104, 8),      // up-impulse → bullish OB + start of FVG
    mk(104, 105, 104, 104.5, 9),     // FVG completes (low 104 > prev high 100.5)
    mk(104.5, 112, 104, 111, 10),    // breakout above peak 104 → BOS/MSS
    mk(111, 113, 110, 112, 11),
    mk(112, 114, 111, 113, 12),
    mk(113, 115, 112, 114, 13),      // spot reference
  ];
}

console.log('\n=== Module 1: Structure Analyzer ===');

// ── Test A: clear bullish structure ──
{
  const r = analyzeStructure(bullishCandles(), 114, 'CE');
  assert(r.swingHighs.length > 0, 'A: detected swing highs');
  assert(r.swingLows.length > 0, 'A: detected swing lows');
  assert(r.orderBlocks.some(o => o.kind === 'BULLISH'), 'A: detected bullish order block');
  assert(r.fvgs.some(f => f.kind === 'BULLISH'), 'A: detected bullish FVG');
  assert(!!r.bos || !!r.mss, 'A: detected BOS or MSS');
  assert(r.bias === 'BULLISH', `A: bias BULLISH (got ${r.bias})`);
  assert(r.alignedWithTrade === true, 'A: CE aligned with bullish structure');
  assert(r.clarity === 'CLEAR', `A: clarity CLEAR (got ${r.clarity}: ${r.reason})`);
  assert(r.structureStopLevel !== null && r.structureStopLevel < 114, `A: structure stop below spot (${r.structureStopLevel})`);
  console.log('  → A reason:', r.reason);
}

// ── Test B: insufficient data → UNCLEAR ──
{
  const r = analyzeStructure([mk(100, 101, 99, 100)], 100, 'CE');
  assert(r.clarity === 'UNCLEAR', 'B: <12 candles → UNCLEAR');
  assert(r.structureStopLevel === null, 'B: no stop level without data');
}

// ── Test C: PE alignment on bullish structure → not aligned ──
{
  const r = analyzeStructure(bullishCandles(), 114, 'PE');
  assert(r.alignedWithTrade === false, 'C: PE NOT aligned with bullish structure');
  assert(r.clarity === 'UNCLEAR', 'C: PE clarity UNCLEAR on bullish structure');
}

// ── Test D: chop handled without crash ──
{
  const candles: Candle[] = [];
  for (let i = 0; i < 20; i++) {
    const p = 100 + Math.sin(i / 2) * 0.4;
    candles.push(mk(p, p + 0.2, p - 0.2, p, i));
  }
  const r = analyzeStructure(candles, 100, 'CE');
  assert(Number.isFinite(r.structureStopLevel ?? 0), 'D: stop level numeric/null');
  console.log('  → D clarity:', r.clarity);
}

// ── Test E: component functions isolated ──
{
  const candles = bullishCandles();
  const sw = findSwings(candles);
  assert(sw.highs.length > 0 && sw.lows.length > 0, 'E: findSwings returns both sides');
  const obs = findOrderBlocks(candles);
  assert(obs.some(o => o.kind === 'BULLISH'), 'E: findOrderBlocks finds bullish OB');
  const fvgs = findFVGs(candles);
  assert(fvgs.some(f => f.kind === 'BULLISH'), 'E: findFVGs finds bullish FVG');
  const br = findBreaks(candles, sw);
  assert(br.some(b => b.kind === 'MSS' || b.kind === 'BOS'), 'E: findBreaks finds MSS/BOS');
}

console.log(`\nModule 1 result: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
