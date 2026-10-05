/// <reference types="bun-types" />
// Smart Money tab (ZeroHeroTerminal) passed a PARTIAL MarketDataInput to
// scoreTrade: no marketStructure/swings/S-R/vwap/volume metrics. Those factors
// (structure w=18, volume w=13) returned available=false with weighted=0 while
// the denominator stayed totalWeight=96 → score pinned at ~35 → below the
// candidate filter (score>=50) → "0 candidates" DETERMINISTICALLY, regardless
// of market conditions.
//
// Fix: withCandleContext() derives the missing factor inputs from the candles
// the tab ALREADY receives from /api/option-chain (Breeze 5m → Yahoo daily).
// No thresholds lowered; real data simply reaches the engine.
import { describe, test, expect } from "bun:test";
import {
  scoreTrade,
  withCandleContext,
  type MarketDataInput,
} from "@/lib/unified-scoring-engine";

// ── Mock candles (test env ONLY — 60 bars, clear zigzag swings, real volumes)
function makeCandles(n: number) {
  const out: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> = [];
  let close = 22000;
  for (let i = 0; i < n; i++) {
    // 7-bar up-legs / 6-bar down-legs → HH/HL + LH/LL swings for detectSwings
    const upLeg = Math.floor(i / 7) % 2 === 0;
    const drift = upLeg ? 120 : -95;
    const open = close;
    close = open + drift;
    const month = 1 + Math.floor(i / 28);
    out.push({
      time: `2026-0${month}-${String((i % 28) + 1).padStart(2, "0")} 00:00:00`,
      open,
      high: Math.max(open, close) + 45,
      low: Math.min(open, close) - 40,
      close,
      volume: 120000000 + (i % 7) * 15000000,
    });
  }
  return out;
}

// Exact SmartMoneyTab CE input shape (ZeroHeroTerminal.tsx lines 1772-1789)
const spot = 22555.75;
const chain = [
  { strike: 22500, ltp: 79.5 },
  { strike: 22550, ltp: 55.65 },
];
const optionChain = chain.map((r) => ({
  strike: r.strike,
  ce: { ltp: r.ltp, oi: 100000, oiChg: 5000, volume: 50000, iv: 15, delta: 0.5, theta: 0, gamma: 0, vega: 0 },
  pe: { ltp: 90, oi: 100000, oiChg: 5000, volume: 50000, iv: 15, delta: -0.5, theta: 0, gamma: 0, vega: 0 },
}));

function baseInput(): MarketDataInput {
  return {
    symbol: "NIFTY",
    strategy: "FO",
    direction: "BULLISH",
    spot,
    optionChain,
    pcr: 0.89,
    maxPain: 22600,
    vix: 14.67,
    candles: [] as any[],
    lotSize: 75,
    entryPrice: 79.5,
    stopLoss: 79.5 * 0.7,
    target1: 79.5 * 1.5,
    target2: 79.5 * 2.0,
    historicalWinRate: 0.65,
    historicalRR: 2.0,
  } as MarketDataInput;
}

// SmartMoneyTab candidate filter (ZeroHeroTerminal.tsx lines 1791-1792)
function passesCandidateFilter(entry: number, sl: number, score: number) {
  return entry >= 5 && sl > 0 && sl < entry && score >= 50;
}

describe("withCandleContext — Smart Money root-cause fix", () => {
  test("enriches the missing factor inputs from candles", () => {
    const candles = makeCandles(60);
    const enriched = withCandleContext(baseInput(), candles);
    expect(enriched.marketStructure).toBeDefined();
    expect(["BULLISH", "BEARISH", "NEUTRAL"]).toContain(enriched.marketStructure!);
    expect(enriched.vwap).toBeGreaterThan(0);
    expect(enriched.avgVolume).toBeGreaterThan(0);
    expect(enriched.currentVolume).toBeGreaterThan(0);
    expect(typeof enriched.adx).toBe("number");
    expect(enriched.swingHigh).toBeGreaterThan(0);
    expect(enriched.swingLow).toBeGreaterThan(0);
    expect((enriched.support?.length ?? 0) + (enriched.resistance?.length ?? 0)).toBeGreaterThan(0);
  });

  test("score reaches the candidate filter (>=50) with real candle context", () => {
    const enriched = withCandleContext(baseInput(), makeCandles(60));
    const d = scoreTrade(enriched);
    expect(d.score).toBeGreaterThanOrEqual(50);
    expect(passesCandidateFilter(d.entry, d.stopLoss, d.score)).toBe(true);
    // structure factor must no longer be UNAVAIL
    const structure = d.scoreBreakdown.find((f) => f.factor === "structure");
    expect(structure?.available).toBe(true);
    const volume = d.scoreBreakdown.find((f) => f.factor === "volume");
    expect(volume?.available).toBe(true);
  });

  test("without candles: input unchanged — honest degradation, no fabrication", () => {
    const base = baseInput();
    const enriched = withCandleContext(base, []);
    expect(enriched.marketStructure).toBeUndefined();
    expect(enriched.vwap).toBeUndefined();
    // score stays below the candidate filter (the old deterministic cap)
    const d = scoreTrade(enriched);
    expect(passesCandidateFilter(d.entry, d.stopLoss, d.score)).toBe(false);
  });

  test("explicit caller values are never overwritten", () => {
    const base = { ...baseInput(), marketStructure: "BEARISH" as const, vwap: 22500 };
    const enriched = withCandleContext(base, makeCandles(60));
    expect(enriched.marketStructure).toBe("BEARISH");
    expect(enriched.vwap).toBe(22500);
  });
});
