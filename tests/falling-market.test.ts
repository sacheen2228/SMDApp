// ═══════════════════════════════════════════════════════════════════════════
// isFallingMarket() — PE regime gate detector (TDD)
//
// Bearish trades (PE) fire only when price is DEMONSTRABLY falling:
//   L1 VWAP:       spot < session VWAP
//   L2 Structure:  analyzeMarketStructure trend === DOWN
//   L3 Momentum:   last close vs 5-bars-ago close dropped ≥ minDropPct
//                  AND ≥2 of last 5 candles red
// falling = at least 2 of 3 layers true (single noisy check is not a trend).
// Relative thresholds so NIFTY (~25k) and SENSEX (~80k) behave identically.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "bun:test";
import { isFallingMarket } from "../src/lib/technical-analysis";

type C = { open: number; high: number; low: number; close: number; volume?: number };

function mkCandles(spec: Array<[number, number, number, number]>): C[] {
  return spec.map(([open, high, low, close]) => ({ open, high, low, close, volume: 1000 }));
}

describe("isFallingMarket", () => {
  it("returns false for null/empty/short candles", () => {
    expect(isFallingMarket(null, 25000).falling).toBe(false);
    expect(isFallingMarket([], 25000).falling).toBe(false);
    expect(isFallingMarket(mkCandles([[100, 101, 99, 100]]), 25000).falling).toBe(false);
    expect(isFallingMarket(undefined, 25000).falling).toBe(false);
  });

  it("returns false for non-positive spot", () => {
    const c = mkCandles([[100, 101, 99, 98], [99, 100, 97, 97], [98, 99, 96, 96],
                         [97, 98, 95, 95], [96, 97, 94, 94], [95, 96, 93, 93]]);
    expect(isFallingMarket(c, 0).falling).toBe(false);
    expect(isFallingMarket(c, -1).falling).toBe(false);
  });

  it("CLEAN FALL: below VWAP + DOWN structure + momentum → falling (all 3 layers)", () => {
    // Selloff 25040 → 24730 over 12 candles with small green retracements
    // (bounces form the swings the structure engine needs)
    const candles = mkCandles([
      [25040, 25060, 24990, 25000],
      [25000, 25020, 24950, 24960],
      [24960, 25000, 24950, 24990], // green retracement (swing high)
      [24990, 25000, 24920, 24930],
      [24930, 24950, 24870, 24880],
      [24880, 24920, 24870, 24910], // green retracement
      [24910, 24920, 24840, 24850],
      [24850, 24870, 24790, 24800],
      [24800, 24840, 24790, 24830], // green retracement
      [24830, 24840, 24760, 24770],
      [24770, 24790, 24720, 24730],
      [24730, 24750, 24700, 24710],
    ]);
    const r = isFallingMarket(candles, 24710);
    expect(r.falling).toBe(true);
    expect(r.layers.vwap).toBe(true);
    expect(r.layers.momentum).toBe(true);
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("BULL RUN: above VWAP + UP structure + rising closes → NOT falling", () => {
    const candles = mkCandles([
      [25000, 25030, 24990, 25020],
      [25020, 25060, 25010, 25050],
      [25050, 25090, 25040, 25080],
      [25080, 25120, 25070, 25110],
      [25110, 25150, 25100, 25140],
      [25140, 25180, 25130, 25170],
      [25170, 25210, 25160, 25200],
      [25200, 25240, 25190, 25230],
    ]);
    const r = isFallingMarket(candles, 25230);
    expect(r.falling).toBe(false);
  });

  it("DISTRIBUTION: below VWAP but structure UP and momentum UP → NOT falling (1 layer only)", () => {
    // Rises overall, but last spot dips under VWAP — distribution, not a fall
    const candles = mkCandles([
      [25000, 25040, 24990, 25030],
      [25030, 25080, 25020, 25070],
      [25070, 25120, 25060, 25110],
      [25110, 25160, 25100, 25150],
      [25150, 25200, 25140, 25190],
      [25190, 25240, 25180, 25230],
      [25230, 25270, 25220, 25260],
      [25260, 25280, 25050, 25060], // last candle dips below VWAP
    ]);
    const r = isFallingMarket(candles, 25060);
    expect(r.falling).toBe(false);
  });

  it("SIDEWAYS chop with 1 red spike → NOT falling", () => {
    const candles = mkCandles([
      [25000, 25030, 24980, 25010],
      [25010, 25040, 24990, 25000],
      [25000, 25030, 24980, 25020],
      [25020, 25050, 25000, 25010],
      [25010, 25040, 24990, 25020],
      [25020, 25050, 25000, 25015],
      [25015, 25040, 24990, 25010],
      [25010, 25020, 24850, 24870], // single red spike
    ]);
    const r = isFallingMarket(candles, 24870);
    expect(r.falling).toBe(false);
  });

  it("works for SENSEX-scale prices (relative thresholds)", () => {
    // −0.5% selloff on ~82000 — same shape as the NIFTY clean-fall case
    const base = 82000;
    const step = 50;
    const candles: C[] = [];
    let p = base;
    for (let i = 0; i < 8; i++) {
      const open = p;
      const close = p - step;
      candles.push({ open, high: open + 20, low: close - 20, close, volume: 1000 });
      p = close;
    }
    const r = isFallingMarket(candles, p);
    expect(r.falling).toBe(true);
  });

  it("tolerates missing volume fields (VWAP falls back to close-weighting)", () => {
    const candles: C[] = [
      { open: 25000, high: 25020, low: 24960, close: 24970 },
      { open: 24970, high: 24990, low: 24920, close: 24930 },
      { open: 24930, high: 24950, low: 24880, close: 24890 },
      { open: 24890, high: 24910, low: 24840, close: 24850 },
      { open: 24850, high: 24870, low: 24800, close: 24810 },
      { open: 24810, high: 24830, low: 24760, close: 24770 },
      { open: 24770, high: 24790, low: 24730, close: 24740 },
      { open: 24740, high: 24760, low: 24720, close: 24730 },
    ];
    const r = isFallingMarket(candles, 24730);
    expect(r.falling).toBe(true);
  });
});
