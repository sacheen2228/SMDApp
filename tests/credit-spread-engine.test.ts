/// <reference types="bun-types" />
// TDD for credit-spread auto-suggest engine: live chain → ranked vertical
// spreads / iron condors with margin, max/min profit & loss per lot.

import { describe, test, expect } from "bun:test";
import {
  suggestSpreads,
  lotsForCapital,
  type ChainRow,
} from "@/lib/credit-spread-engine";

// Synthetic NIFTY-like chain: spot 25000, step 50, healthy premiums.
function makeChain(): ChainRow[] {
  const rows: ChainRow[] = [];
  const spot = 25000;
  for (let k = 24400; k <= 25600; k += 50) {
    const dist = (k - spot) / 100; // 100pts ~ 1 premium point OTM-ish
    const ceLtp = Math.max(2, 120 - dist * 18);
    const peLtp = Math.max(2, 120 + dist * 18);
    const moneyness = Math.abs(k - spot) / spot;
    const ceDelta = Math.max(0.02, Math.min(0.98, 0.5 - (k - spot) / 900));
    const peDelta = -(Math.max(0.02, Math.min(0.98, 0.5 - (spot - k) / 900)));
    rows.push({
      strike: k,
      ce: {
        ltp: +ceLtp.toFixed(2), oi: 500000 - moneyness * 1e7, oiChg: 10000,
        volume: 100000, iv: 14, delta: +ceDelta.toFixed(3), gamma: 0.001,
        theta: -8, bid: ceLtp - 0.5, ask: ceLtp + 0.5,
      },
      pe: {
        ltp: +peLtp.toFixed(2), oi: 500000 - moneyness * 1e7, oiChg: 12000,
        volume: 100000, iv: 14.5, delta: +peDelta.toFixed(3), gamma: 0.001,
        theta: -8, bid: peLtp - 0.5, ask: peLtp + 0.5,
      },
    });
  }
  return rows;
}

describe("suggestSpreads", () => {
  test("finds bull put and bear call credit spreads", () => {
    const out = suggestSpreads({ chain: makeChain(), spot: 25000, lotSize: 65 });
    const strategies = new Set(out.map((s) => s.strategy));
    expect(strategies.has("BULL_PUT_SPREAD")).toBe(true);
    expect(strategies.has("BEAR_CALL_SPREAD")).toBe(true);
  });

  test("every credit spread has positive credit < width and full metrics", () => {
    const out = suggestSpreads({ chain: makeChain(), spot: 25000, lotSize: 65 });
    for (const s of out.filter((x) => x.direction === "CREDIT")) {
      expect(s.netCredit).toBeGreaterThan(0);
      expect(s.netCredit).toBeLessThan(s.width);
      expect(s.marginPerLot).toBeGreaterThan(0);
      expect(s.maxProfitPerLot).toBeCloseTo(s.netCredit * 65, 5);
      expect(s.maxLossPerLot).toBeCloseTo((s.width - s.netCredit) * 65, 5);
      expect(s.minProfitPerLot).toBeGreaterThan(0);
      expect(s.minLossPerLot).toBeGreaterThan(0);
      expect(s.minProfitPerLot).toBeLessThan(s.maxProfitPerLot);
      expect(s.winProb).toBeGreaterThan(0);
      expect(s.winProb).toBeLessThanOrEqual(100);
      if (s.strategy === "IRON_CONDOR") {
        expect(s.legs).toHaveLength(4);
      } else {
        expect(s.legs).toHaveLength(2);
        expect(s.legs[0].action).toBe("SELL");
        expect(s.legs[1].action).toBe("BUY");
      }
    }
  });

  test("short legs are OTM (put below spot, call above spot)", () => {
    const spot = 25000;
    const out = suggestSpreads({ chain: makeChain(), spot, lotSize: 65 });
    for (const s of out) {
      const short = s.legs[0];
      if (s.strategy === "BULL_PUT_SPREAD") expect(short.strike).toBeLessThan(spot);
      if (s.strategy === "BEAR_CALL_SPREAD") expect(short.strike).toBeGreaterThan(spot);
    }
  });

  test("iron condor combines both sides with two breakevens", () => {
    const out = suggestSpreads({ chain: makeChain(), spot: 25000, lotSize: 65 });
    const condor = out.find((s) => s.strategy === "IRON_CONDOR");
    expect(condor).toBeDefined();
    expect(condor!.legs).toHaveLength(4);
    expect(condor!.breakeven).toHaveLength(2);
    expect(condor!.netCredit).toBeGreaterThan(0);
  });

  test("respects capital budget for lot sizing", () => {
    const out = suggestSpreads({
      chain: makeChain(), spot: 25000, lotSize: 65, capital: 50000,
    });
    for (const s of out) {
      expect(s.affordableLots).toBeGreaterThanOrEqual(1);
      expect(s.marginPerLot * s.affordableLots).toBeLessThanOrEqual(50000 + 1e-6);
    }
  });

  test("skips garbage: zero/negative premiums and credit >= width", () => {
    const chain = makeChain().map((r) => ({
      ...r,
      ce: r.ce ? { ...r.ce, ltp: 0 } : null,
    }));
    const out = suggestSpreads({ chain, spot: 25000, lotSize: 65 });
    // No bear call spreads possible (all CE premiums are 0)
    expect(out.some((s) => s.strategy === "BEAR_CALL_SPREAD")).toBe(false);
  });

  test("empty chain returns []", () => {
    expect(suggestSpreads({ chain: [], spot: 25000, lotSize: 65 })).toEqual([]);
  });
});

describe("lotsForCapital", () => {
  test("floors lots by margin", () => {
    expect(lotsForCapital(100000, 25000)).toBe(4);
    expect(lotsForCapital(24000, 25000)).toBe(0);
    expect(lotsForCapital(25000, 25000)).toBe(1);
  });
});
