// Consolidated test for the Institutional Trading Engine v2.
// Run: bun run src/lib/institutional-tpsl/__tests__/engine.test.ts
import { Candle, OptionType, ExpiryKind } from '../types';
import {
  evaluateInstitutionalCandidate, fromRawChain, InstitutionalRequest,
} from '../index';
import { analyzeOption } from '../option-analytics';
import { analyzeLiquidity } from '../liquidity';
import { analyzeOrderFlow } from '../order-flow';
import { computeRisk } from '../risk';
import { computeDynamicSL } from '../sl-engine';
import { computeDynamicTP } from '../tp-engine';
import { computeConfidence } from '../confidence';
import { validateTrade } from '../validator';
import { selectStrike } from '../strike-selection';
import { computeChainStats, finalizeChainStats } from '../chain';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

// ── Synthetic underlying candles (clean uptrend) ──
function makeCandles(n: number, start: number, step: number): Candle[] {
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const down = i % 5 === 0;                  // periodic pullback → forms OB/FVG
    const open = p;
    const close = p + (down ? -step : step);
    const high = Math.max(open, close) + step * 0.4;
    const low = Math.min(open, close) - step * 0.4;
    out.push({ time: i, open, high, low, close, volume: 1000 + i });
    p = close;
  }
  return out;
}

// ── Synthetic option chain with REAL-shaped fields ──
function makeLeg(type: OptionType, strike: number, spot: number): any {
  const itm = type === 'CE' ? spot - strike : strike - spot;
  const delta = type === 'CE' ? Math.max(0.05, Math.min(0.95, 0.5 + itm / (spot * 0.05)))
                               : Math.max(0.05, Math.min(0.95, 0.5 - itm / (spot * 0.05)));
  const ltp = Math.max(2, 50 + Math.abs(itm) * 0.4);
  const mid = ltp;
  return {
    ltp, oi: 500000 + Math.round(Math.abs(itm) * 1000), oiChg: 50000,
    vol: 250000, iv: 16, delta, gamma: 0.005, theta: -8, vega: 12,
    bid: mid - 0.5, ask: mid + 0.5,
    depth: { bidPrice: mid - 0.5, bidQty: 250000, askPrice: mid + 0.5, askQty: 250000, totalBuyQty: 1e6, totalSellQty: 1e6 },
  };
}
function makeChain(spot: number, step = 50): any[] {
  const strikes: number[] = [];
  for (let k = -6; k <= 6; k++) strikes.push(spot + k * step);
  return strikes.map((strike) => ({ strike, ce: makeLeg('CE', strike, spot), pe: makeLeg('PE', strike, spot) }));
}

// Clean uptrend WITH pullbacks that form real Order Blocks + BOS (small price scale)
function makeBullishCandles(n: number): Candle[] {
  const out: Candle[] = [];
  let p = 1000;
  for (let i = 0; i < n; i++) {
    let open: number, close: number, high: number, low: number;
    if (i % 4 === 0) {
      open = p + 10; close = p; high = open; low = close - 5;   // bearish, no upper wick
    } else {
      open = p; close = p + 12; high = close + 5; low = open - 5; // bullish recovery > prior high
    }
    out.push({ time: i, open, high, low, close, volume: 1000 + i });
    p = close;
  }
  return out;
}

// ═══════════════ MODULE UNIT TESTS ═══════════════
console.log('MODULE UNIT TESTS');
{
  const spot = 25000;
  const chain = makeChain(spot);
  const legs = chain.map((s) => ({ strike: s.strike, ce: s.ce, pe: s.pe }));
  const stats = (() => {
    let st = computeChainStats(legs);
    st = finalizeChainStats(st, legs, spot);
    return st;
  })();
  const leg = legs[7].ce; // near ATM CE
  const opt = analyzeOption({ leg, strike: legs[7].strike, spot, dte: 3, vix: 15 });
  ok('OptionAnalytics quality 0..100', opt.quality >= 0 && opt.quality <= 100);
  ok('OptionAnalytics IV regime set', !!opt.ivRegime);
  const liq = analyzeLiquidity({ leg, strike: legs[7].strike, spot, stats });
  ok('Liquidity spread tight', liq.spreadPct < 0.05);
  ok('Liquidity depth captured', liq.depthScore > 0);
  const of = analyzeOrderFlow({ leg, stats, direction: 'BULLISH' });
  ok('OrderFlow score 0..100', of.score >= 0 && of.score <= 100);
}

// ═══════════════ FULL SCAN / ORCHESTRATOR ═══════════════
console.log('FULL ENGINE SCAN');
{
  const candles = makeBullishCandles(52);
  const spot = candles[candles.length - 1].close;
  const rawChain = makeChain(spot, 20);
  const chain = fromRawChain(rawChain, spot);
  const req: InstitutionalRequest = {
    symbol: 'NIFTY', spot, vix: 15, dte: 3, expiryKind: 'WEEKLY' as ExpiryKind,
    dayOfWeek: 3, lotSize: 50, candles, atr: 120, chain,
  };
  const res = evaluateInstitutionalCandidate(req);
  ok('scan returns best', res.best != null, 'best null');
  ok('best is passed or present', res.best != null);
  ok('chain stats ATM set', res.chainStats.atmStrike > 0);
  ok('session active (Wed 12:00)', res.session.isActive);
  if (res.best) {
    const b = res.best;
    console.log(`    best: ${b.type} ${b.strike} grade=${b.confidence.grade} rr=${b.rr.toFixed(2)} sl=${b.slPremium.toFixed(2)} tp1=${b.tp1Premium.toFixed(2)} tp2=${b.tp2Premium.toFixed(2)} passed=${b.passed}`);
    ok('SL < entry < TP1 < TP2 (premium)', b.slPremium < b.entryPremium && b.entryPremium < b.tp1Premium && b.tp1Premium < b.tp2Premium);
    ok('RR >= 1.5 when passed', !b.passed || b.rr >= 1.5);
    ok('lots >= 1', b.risk.suggestedLots >= 1);
    ok('confidence 0..100', b.confidence.score >= 0 && b.confidence.score <= 100);
    if (b && !b.passed) console.log('   checks:', b.validation.checks.map((c) => `${c.name}=${c.ok}`).join(', '), '| struct:', b.structure.clarity, b.structure.reason);
  }
  // direction inference: with uptrend + no forceType, best should be CE (bullish)
  ok('infers bullish CE on uptrend', res.best?.type === 'CE');
  ok('engine CAN pass a valid trade', res.all.some((e) => e.passed));
}

// ═══════════════ VALIDATOR GATE ═══════════════
console.log('VALIDATOR GATE (illiquid rejected)');
{
  const spot = 25000;
  const candles = makeCandles(40, spot - 400, 10);
  const raw = makeChain(spot).map((s) => {
    // make every leg illiquid: huge spread, tiny OI
    const poison = (leg: any) => ({ ...leg, oi: 10, bid: leg.ltp * 0.5, ask: leg.ltp * 1.5, depth: undefined });
    return { strike: s.strike, ce: poison(s.ce), pe: poison(s.pe) };
  });
  const chain = fromRawChain(raw, spot);
  const req: InstitutionalRequest = {
    symbol: 'NIFTY', spot, vix: 15, dte: 3, expiryKind: 'WEEKLY' as ExpiryKind,
    dayOfWeek: 3, lotSize: 50, candles, atr: 120, chain,
  };
  const res = evaluateInstitutionalCandidate(req);
  // either best null or not passed (liquidity gate should reject)
  ok('illiquid chain yields no passed trade', res.best == null || res.best.passed === false);
}

// ═══════════════ STRIKE SELECTION ═══════════════
console.log('STRIKE SELECTION');
{
  const spot = 25000;
  const raw = makeChain(spot);
  const chain = fromRawChain(raw, spot);
  const stats = (() => {
    let st = computeChainStats(chain);
    st = finalizeChainStats(st, chain, spot);
    return st;
  })();
  const sel = selectStrike({ strikes: chain, spot, direction: 'BULLISH', stats, vix: 15, dte: 3 });
  ok('selectStrike picks a strike', sel.selectedStrike != null);
  ok('selected leg exists', sel.selectedLeg != null);
  ok('ranked has entries', sel.ranked.length > 0);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
