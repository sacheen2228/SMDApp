import { describe, test, expect } from "bun:test";
import { evaluateWeeklyGate, type WeeklyGateInput } from "@/lib/weekly-equity-scanner";

function base(over: Partial<WeeklyGateInput> = {}): WeeklyGateInput {
  return {
    price: 1200,
    ema20: 1100,
    ema50: 1050,
    rsi: 76,
    rvol: 0.9,
    adx: 18,
    avgVol: 2_000_000,
    hasEventRisk: false,
    ...over,
  };
}

describe("weekly soft gates — same logic as intraday scanner", () => {
  test("market-typical bull (RSI 76, RVOL 0.9, ADX 18) is NOT hard-rejected", () => {
    // The old hard filters (RSI 45–65, RVOL ≥1.2, ADX ≥20) rejected every
    // stock after price>EMA — median post-trend RSI is ~76. Intraday never
    // hard-rejects these; it scores them.
    const r = evaluateWeeklyGate(base());
    expect(r.pass).toBe(true);
    expect(r.hardReason).toBeUndefined();
  });

  test("hard rejects remain: price band, liquidity, event risk", () => {
    expect(evaluateWeeklyGate(base({ price: 50 })).pass).toBe(false);
    expect(evaluateWeeklyGate(base({ price: 9000 })).pass).toBe(false);
    expect(evaluateWeeklyGate(base({ avgVol: 100_000 })).pass).toBe(false);
    expect(evaluateWeeklyGate(base({ hasEventRisk: true })).pass).toBe(false);
  });

  test("above EMA stack scores higher than below", () => {
    const above = evaluateWeeklyGate(base());
    const below = evaluateWeeklyGate(base({ price: 900, ema20: 1100, ema50: 1050 }));
    expect(above.pass).toBe(true);
    // below EMA still passes hard gates (soft score only) but scores lower
    expect(below.pass).toBe(true);
    expect(above.softScore).toBeGreaterThan(below.softScore);
  });

  test("RSI in intraday sweet band (50–70) scores higher than extreme 85", () => {
    const sweet = evaluateWeeklyGate(base({ rsi: 58 }));
    const hot = evaluateWeeklyGate(base({ rsi: 85 }));
    expect(sweet.softScore).toBeGreaterThan(hot.softScore);
  });

  test("RVOL ≥2 scores higher than dead volume 0.5", () => {
    const active = evaluateWeeklyGate(base({ rvol: 2.2 }));
    const dead = evaluateWeeklyGate(base({ rvol: 0.5 }));
    expect(active.softScore).toBeGreaterThan(dead.softScore);
  });

  test("ADX ≥20 scores higher than chop 12 (soft dampen, not reject)", () => {
    const trending = evaluateWeeklyGate(base({ adx: 30 }));
    const chop = evaluateWeeklyGate(base({ adx: 12 }));
    expect(chop.pass).toBe(true);
    expect(trending.softScore).toBeGreaterThan(chop.softScore);
  });

  test("hardReason names the failed safety filter", () => {
    const r = evaluateWeeklyGate(base({ hasEventRisk: true }));
    expect(r.pass).toBe(false);
    expect(r.hardReason).toMatch(/event|corporate action/i);
  });
});
