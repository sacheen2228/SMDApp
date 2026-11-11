import { describe, expect, test } from "bun:test";
import {
  runDynamicOptionsEngine,
  type DynamicOptionsInput,
  type LegInput,
} from "@/lib/dynamic-options-engine";

function leg(ltp: number): LegInput {
  return {
    ltp,
    bid: Math.max(0, ltp - 1),
    ask: ltp + 1,
    oi: 10_000,
    oiChg: 100,
    volume: 1_000,
    // Breeze's real chain returns null IV/Greeks; the route maps them to 0.
    iv: 0,
    delta: 0,
    gamma: 0,
    theta: 0,
    vega: 0,
  };
}

const input: DynamicOptionsInput = {
  symbol: "NIFTY",
  spot: 25_383,
  vix: 17.59,
  pcr: 0.9,
  maxPain: 25_400,
  atmStrike: 25_400,
  expiryDate: "2026-11-24",
  totalCallOI: 100_000,
  totalPutOI: 90_000,
  callOiChg: 1_000,
  putOiChg: -500,
  lotSize: 65,
  strikes: [
    { strike: 23_900, ce: leg(1_550), pe: leg(6.95) },
    { strike: 25_000, ce: leg(480), pe: leg(95) },
    { strike: 25_200, ce: leg(300), pe: leg(130) },
    { strike: 25_300, ce: leg(230), pe: leg(170) },
    { strike: 25_400, ce: leg(180), pe: leg(210) },
    { strike: 25_500, ce: leg(140), pe: leg(260) },
    // PE premium ₹5 is impossible: intrinsic alone is ₹617.
    { strike: 26_000, ce: leg(25), pe: leg(5) },
  ],
};

describe("Dynamic Options Engine on a Breeze-shaped chain", () => {
  test("missing IV falls back to India VIX so Greeks/expected move are not zero", () => {
    const result = runDynamicOptionsEngine(input);
    expect(result.tradeDecision.iv).toBeGreaterThan(0);
    expect(result.tradeDecision.delta).not.toBe(0);
    expect(result.tradeDecision.expectedPremiumMove).toBeGreaterThan(0);
    expect(result.tradeDecision.expectedUnderlyingMove).toBeGreaterThan(0);
  });

  test("an impossible sub-intrinsic PE leg is never tradeable", () => {
    const result = runDynamicOptionsEngine(input);
    expect(`${result.tradeDecision.strike}-${result.tradeDecision.optionType}`).not.toBe(
      "26000-PE",
    );
  });

  test("strike comparison uses option-specific moneyness", () => {
    const result = runDynamicOptionsEngine(input);
    expect(result.strikeComparison.itm.type).toBe("ITM");
    expect(result.strikeComparison.atm.type).toBe("ATM");
    expect(result.strikeComparison.otm.type).toBe("OTM");
    expect(result.strikeComparison.itm.strike).toBeLessThan(input.spot!);
    expect(result.strikeComparison.otm.strike).toBeGreaterThan(input.spot!);
  });
});
