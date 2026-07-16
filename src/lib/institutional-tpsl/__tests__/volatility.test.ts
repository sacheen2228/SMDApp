// Unit tests for Module 2 — Volatility Engine
// Run: bun run src/lib/institutional-tpsl/__tests__/volatility.test.ts

import { analyzeVolatility, computeATR, classifyIVRegime } from '../volatility-engine';
import { Candle } from '../types';

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log('  ✓', msg); }
  else { failed++; console.error('  ✗ FAIL:', msg); }
}

console.log('\n=== Module 2: Volatility Engine ===');

// ── Test A: provided ATR + VIX regime ──
{
  const r = analyzeVolatility({ spot: 24000, dte: 1, iv: 15, vix: 13, atr: 240 });
  assert(Math.abs(r.atr - 240) < 1e-9, 'A: uses provided ATR');
  assert(r.source === 'provided', 'A: source=provided');
  assert(Math.abs(r.expectedIndexMove - 240 * Math.sqrt(1)) < 1e-6, 'A: expectedIndexMove = ATR·√dte (dte=1)');
  assert(r.ivRegime === 'NORMAL', `A: VIX 13 → NORMAL (got ${r.ivRegime})`);
  assert(r.atrPct > 0.009 && r.atrPct < 0.011, `A: atrPct ~1% (got ${r.atrPct.toFixed(4)})`);
  console.log('  → A expectedMove:', r.expectedIndexMove.toFixed(1), 'regime:', r.ivRegime);
}

// ── Test B: ATR from candles ──
{
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 30; i++) {
    const hi = price + 2, lo = price - 2;
    candles.push({ time: i, open: price, high: hi, low: lo, close: price, volume: 1e6 });
    price += (i % 3 - 1) * 0.5;
  }
  const r = analyzeVolatility({ spot: 100, dte: 5, iv: 16, underlyingDaily: candles.map(c => ({ high: c.high, low: c.low, close: c.close })) });
  assert(r.source === 'candles', 'B: source=candles');
  assert(r.atr > 0, 'B: ATR computed from candles');
  assert(Math.abs(r.expectedIndexMove - r.atr * Math.sqrt(5)) < 1e-6, 'B: expectedMove scales with √dte');
}

// ── Test C: IV-regime boundaries ──
{
  assert(classifyIVRegime(15, 10) === 'LOW', 'C: VIX 10 → LOW');
  assert(classifyIVRegime(15, 16) === 'NORMAL', 'C: VIX 16 → NORMAL');
  assert(classifyIVRegime(15, 20) === 'HIGH', 'C: VIX 20 → HIGH');
  assert(classifyIVRegime(15, 30) === 'EXTREME', 'C: VIX 30 → EXTREME');
}

// ── Test D: computeATR known value ──
{
  // Constant range of 10 → TR always 10 → ATR = 10
  const cs = Array.from({ length: 20 }, (_, i) => ({ high: 110, low: 100, close: 105 }));
  assert(Math.abs(computeATR(cs, 14) - 10) < 1e-9, 'D: constant-range ATR = range');
}

// ── Test E: ATR never equals a premium/target — it is index-space only ──
{
  const spot = 24000;
  const r = analyzeVolatility({ spot, dte: 1, iv: 15, vix: 13, atr: 240 });
  // expectedIndexMove is in index points, NOT a premium target
  assert(r.expectedIndexMove < spot, 'E: expected index move < spot (index-space, not premium)');
  assert(r.ivRegime === 'NORMAL', 'E: regime computed');
}

console.log(`\nModule 2 result: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
