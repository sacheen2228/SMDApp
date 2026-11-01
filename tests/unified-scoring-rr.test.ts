// unified-scoring-rr.test.ts — D-2 remainder: signed R:R for both letters
//
// The old Math.abs(entry - stop) masked wrong-side stops (mirrored PE: stop
// ABOVE entry) into positive risk, yielding a plausible 2.0 R:R. With the
// long-option geometry (R1), a wrong-side stop must report rr 0 (or negative
// to flag the error) so the gate trips. Signed: risk = entry - stop (>0 for
// valid long plans). Reward = target1 - entry (>0 for valid long plans).
import { describe, test, expect } from "bun:test";
import { scoreTrade } from "@/lib/unified-scoring-engine";

describe("unified-scoring-engine: signed R:R (no Math.abs masking)", () => {
  const baseInput = {
    symbol: "NIFTY",
    strategy: "EQUITY_SWING" as const,
    direction: "BULLISH" as const,
    spot: 24000,
    vix: 15,
  };

  test("valid LONG plan (CE): entry > stop, target > entry → positive rr", () => {
    const out = scoreTrade({
      ...baseInput,
      entryPrice: 100,
      stopLoss: 95,    // below entry
      target1: 110,    // above entry
    });
    expect(out.riskReward).toBeGreaterThan(0);
    expect(out.riskReward).toBeCloseTo(2.0, 1); // (110-100)/(100-95) = 10/5 = 2
  });

  test("valid LONG plan (PE): entry > stop, target > entry → same geometry", () => {
    const out = scoreTrade({
      ...baseInput,
      direction: "BEARISH",
      entryPrice: 100,
      stopLoss: 95,    // BELOW entry (long-option geometry)
      target1: 110,    // ABOVE entry
    });
    expect(out.riskReward).toBeGreaterThan(0);
    expect(out.riskReward).toBeCloseTo(2.0, 1);
  });

  test("wrong-side stop (mirrored legacy): stop ABOVE entry → rr === 0 (not masked to 2.0)", () => {
    const out = scoreTrade({
      ...baseInput,
      direction: "BEARISH",
      entryPrice: 100,
      stopLoss: 105,   // ABOVE entry = mirrored / SHORT geometry
      target1: 90,     // BELOW entry
    });
    // Signed: risk = 100-105 = -5, reward = 90-100 = -10 → rr = (-10)/(-5) = 2 but risk <= 0 → 0
    expect(out.riskReward).toBe(0);
  });

  test("incoherent plan: stop BELOW entry, target ALSO BELOW entry → rr === 0", () => {
    const out = scoreTrade({
      ...baseInput,
      entryPrice: 100,
      stopLoss: 95,    // below
      target1: 90,     // also below = incoherent
    });
    // risk = 5 > 0, reward = -10 ≤ 0 → rr = 0
    expect(out.riskReward).toBe(0);
  });

  test("incoherent plan: stop ABOVE entry, target ABOVE entry → rr === 0", () => {
    const out = scoreTrade({
      ...baseInput,
      entryPrice: 100,
      stopLoss: 105,   // above
      target1: 110,    // above = incoherent (both same side)
    });
    // risk = -5 ≤ 0 → rr = 0
    expect(out.riskReward).toBe(0);
  });
});