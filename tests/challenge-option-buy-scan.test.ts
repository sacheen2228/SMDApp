/// <reference types="bun-types" />
// Challenge option-buy scan — ₹15K challenge scans NIFTY/SENSEX + stock
// options and surfaces ONLY CE BUY / PE BUY setups that fit capital + risk
// (no option selling, no futures, no equity rows in the top list).

import { describe, it, expect } from "bun:test";
import {
  isBuyOptionDirection,
  affordableOptionCandidates,
  selectFitOptionBuys,
  resolveOrderAction,
  mapIndexFuturesToOptionBuy,
  buildStockOptionUniverse,
  DEFAULT_AFFORDABLE_LOT_CAP,
  type ChallengeOpportunity,
} from "@/lib/challenge/challenge-engine";
import { setLiveLotSizes, calculateFOPosition, DEFAULT_CAPITAL_CONFIG } from "@/lib/challenge/capital-manager";
import {
  convertOptionToPremiumTerms,
} from "@/lib/challenge/challenge-engine";

const NOW = new Date("2026-10-02T10:00:00+05:30"); // expiry 27-Oct-2026 = 25 days out
const EXPIRY = "27-Oct-2026";

describe("convertOptionToPremiumTerms — 10% premium stop cap (rule set C)", () => {
  it("caps a wide engine stop at 10% of premium", () => {
    // Engine's wide ATR spot stop: −4% spot on a ₹300 ATM premium reprices
    // far below entry — must be floored at entry×0.90
    const o = opp({
      instrument: "CALL", symbol: "NIFTY", premium: 300, strike: 25000, expiry: EXPIRY,
      entry: 25000, stopLoss: 24000, target1: 25600, target2: 26200,
      data: { ltp: 25000, changePct: 0, weekHigh52: 0, weekLow52: 0 },
    });
    const res = convertOptionToPremiumTerms(o, NOW);
    expect(res.ok).toBe(true);
    expect(o.entry).toBe(300);
    expect(o.stopLoss).toBe(270); // entry × 0.90, tick-rounded
    expect(o.target1).toBeGreaterThan(300);
    expect(o.riskReward).toBeGreaterThan(0);
  });

  it("keeps a stop already tighter than 10%", () => {
    // PUT: engine stop sits ABOVE spot (rise invalidates the put); +20 pts
    // on spot reprices premium only slightly → stop stays engine's own
    const o = opp({
      instrument: "PUT", symbol: "SENSEX", premium: 200, strike: 76000, expiry: EXPIRY,
      entry: 76000, stopLoss: 76020, target1: 75500, target2: 75000,
      data: { ltp: 76000, changePct: 0, weekHigh52: 0, weekLow52: 0 },
    });
    const res = convertOptionToPremiumTerms(o, NOW);
    expect(res.ok).toBe(true);
    expect(o.stopLoss).toBeGreaterThan(180); // NOT floored at 180 (entry×0.90)
    expect(o.stopLoss).toBeLessThan(200);
  });
});

describe("sizing rules C — 75% position cap", () => {
  it("powergrid-class lot fits: cost ≤ ₹11,250 and 10% stop risk ≤ ₹1,500", () => {
    setLiveLotSizes({ POWERGRID: 1900 });
    const r = calculateFOPosition(15000, 4.7, 4.7 * 0.9, "POWERGRID", true, DEFAULT_CAPITAL_CONFIG);
    expect(DEFAULT_CAPITAL_CONFIG.maxPositionPct).toBe(75);
    expect(r.canTrade).toBe(true);
    expect(r.totalCost).toBe(Math.round(4.7 * 1900 * 1.05)); // 9377 ≤ 11250
    expect(r.maxLoss).toBeLessThanOrEqual(1500);
  });

  it("grasim-class lot still blocked by cost (₹14,438 > ₹11,250)", () => {
    setLiveLotSizes({ GRASIM: 250 });
    const r = calculateFOPosition(15000, 55, 55 * 0.9, "GRASIM", true, DEFAULT_CAPITAL_CONFIG);
    expect(r.canTrade).toBe(false);
    expect(r.reason).toMatch(/lot cost/i);
    expect(r.reason).not.toMatch(/risk budget/i); // risk fits now — cost is the binder
  });
});


describe("calculateFOPosition — truthful failure reasons", () => {
  it("reports stop risk when the risk budget is the binder", () => {
    setLiveLotSizes({ RISKY: 1000 });
    // risk/lot = 40 × 1000 = 40,000 ≫ ₹1,500; cost also fails → both reported
    const r = calculateFOPosition(15000, 100, 60, "RISKY", true, DEFAULT_CAPITAL_CONFIG);
    expect(r.canTrade).toBe(false);
    expect(r.reason).toMatch(/risk budget/i);
    expect(r.reason).toMatch(/lot cost/i);
  });

  it("reports lot cost only when capital is the binder (risk fits)", () => {
    setLiveLotSizes({ RICH: 1000 });
    // risk/lot = 0.5 × 1000 = 500 ≤ 1500 ✓; cost = 12×1000×1.05 = 12,600 > 11,250 ✗
    const r = calculateFOPosition(15000, 12, 11.5, "RICH", true, DEFAULT_CAPITAL_CONFIG);
    expect(r.canTrade).toBe(false);
    expect(r.reason).toMatch(/lot cost/i);
    expect(r.reason).not.toMatch(/risk budget/i);
  });

  it("reports risk only when budget is the binder (cost fits)", () => {
    setLiveLotSizes({ TIGHT: 1000 });
    // cost = 6×1000×1.05 = 6,300 ≤ 7,500 ✓; risk/lot = 3×1000 = 3,000 > 1,500 ✗
    const r = calculateFOPosition(15000, 6, 3, "TIGHT", true, DEFAULT_CAPITAL_CONFIG);
    expect(r.canTrade).toBe(false);
    expect(r.reason).toMatch(/risk budget/i);
    expect(r.reason).not.toMatch(/lot cost/i);
  });

  it("trades when both fit", () => {
    setLiveLotSizes({ FITS: 1000 });
    // cost = 5.4×1000×1.05 = 5,670 ≤ 11,250 but 2 lots would exceed it → 1 lot;
    // risk/lot = 0.5×1000 = 500 ≤ 1,500 ✓
    const r = calculateFOPosition(15000, 5.4, 4.9, "FITS", true, DEFAULT_CAPITAL_CONFIG);
    expect(r.canTrade).toBe(true);
    expect(r.lots).toBe(1);
    expect(r.totalCost).toBe(5670);
  });
});


function opp(over: Partial<ChallengeOpportunity>): ChallengeOpportunity {
  return {
    rank: 0,
    symbol: "NIFTY",
    name: "NIFTY",
    instrument: "CALL",
    strategy: "TEST",
    score: 70,
    confidence: 70,
    direction: "CALL",
    entry: 100,
    stopLoss: 90,
    target1: 120,
    target2: 130,
    riskReward: 2,
    volume: 0,
    relativeVolume: 1,
    sector: "Index",
    near52WHigh: false,
    near52WLow: false,
    reasoning: [],
    factors: {},
    position: { canTrade: true },
    data: { ltp: 100, changePct: 0, weekHigh52: 0, weekLow52: 0 },
    tradeable: true,
    blockedReasons: [],
    dataStamp: "LIVE",
    ...over,
  };
}

describe("isBuyOptionDirection", () => {
  it("accepts CE/PE buy directions", () => {
    expect(isBuyOptionDirection("CALL")).toBe(true);
    expect(isBuyOptionDirection("PUT")).toBe(true);
    expect(isBuyOptionDirection("BUY_CE")).toBe(true);
    expect(isBuyOptionDirection("BUY_PE")).toBe(true);
  });

  it("rejects futures/short/no-trade directions", () => {
    expect(isBuyOptionDirection("LONG")).toBe(false);
    expect(isBuyOptionDirection("SHORT")).toBe(false);
    expect(isBuyOptionDirection("NO_TRADE")).toBe(false);
    expect(isBuyOptionDirection("")).toBe(false);
  });
});

describe("affordableOptionCandidates", () => {
  it("keeps lot-cost-affordable F&O stocks with their lot, drops the rest", () => {
    setLiveLotSizes({ AFFORD: 500, OVER: 500, BOUNDARY: 500 });
    const quotes = [
      { symbol: "AFFORD", price: 400 }, // 400×500 = 200,000 ≤ 715k ✓
      { symbol: "OVER", price: 1500 },  // 1500×500 = 750,000 > 715k ✗
      { symbol: "BOUNDARY", price: DEFAULT_AFFORDABLE_LOT_CAP / 500 }, // exactly the cap ✓
      { symbol: "ZZZFAKE", price: 100 }, // unknown lot (=1, non-F&O) ✗
      { symbol: "AFFORD", price: 0 },    // no price ✗
    ];
    const out = affordableOptionCandidates(quotes);
    expect(out.map((q) => q.symbol)).toEqual(["AFFORD", "BOUNDARY"]);
    expect(out[0].lot).toBe(500);
    expect(out[1].lot).toBe(500);
  });

  it("respects a custom cap", () => {
    setLiveLotSizes({ SBIN: 750 });
    expect(affordableOptionCandidates([{ symbol: "SBIN", price: 275 }], 200000)).toEqual([]); // 206k > 200k
    expect(affordableOptionCandidates([{ symbol: "SBIN", price: 275 }], 300000)).toHaveLength(1);
  });
});

describe("selectFitOptionBuys", () => {
  it("keeps only sizeable CALL/PUT setups, counts sized-out options as unfit", () => {
    const fitCall = opp({ instrument: "CALL", symbol: "NIFTY", position: { canTrade: true } });
    const unfitPut = opp({ instrument: "PUT", symbol: "SENSEX", position: { canTrade: false, reason: "Min lot cost exceeds capital" } });
    const equity = opp({ instrument: "EQUITY", symbol: "RELIANCE", position: { canTrade: true } });
    const futures = opp({ instrument: "FUTURES", symbol: "BANKNIFTY", position: { canTrade: false } });

    const { fit, unfitCount } = selectFitOptionBuys([fitCall, unfitPut, equity, futures]);

    expect(fit.map((o) => o.symbol)).toEqual(["NIFTY"]); // equity/futures excluded, order preserved
    expect(unfitCount).toBe(1); // only the sized-out option counts
  });

  it("does not count non-option setups as unfit", () => {
    const { fit, unfitCount } = selectFitOptionBuys([
      opp({ instrument: "EQUITY", position: { canTrade: false } }),
      opp({ instrument: "FUTURES", position: { canTrade: false } }),
    ]);
    expect(fit).toEqual([]);
    expect(unfitCount).toBe(0);
  });

  it("preserves rank order across multiple fit options", () => {
    const a = opp({ symbol: "AAA", instrument: "CALL", position: { canTrade: true } });
    const b = opp({ symbol: "BBB", instrument: "PUT", position: { canTrade: true } });
    const { fit, unfitCount } = selectFitOptionBuys([a, b]);
    expect(fit.map((o) => o.symbol)).toEqual(["AAA", "BBB"]);
    expect(unfitCount).toBe(0);
  });
});

describe("mapIndexFuturesToOptionBuy", () => {
  const chain = { atmStrike: 25000, atmCePremium: 180, atmPePremium: 175 };

  it("maps LONG (futures shape) → CALL with live ATM strike/premium", () => {
    const sig: any = { symbol: "NIFTY", direction: "LONG", strike: 0, premium: 0, entry: 25120, recommendedInstrument: "NIFTY Futures" };
    mapIndexFuturesToOptionBuy(sig, chain);
    expect(sig.direction).toBe("CALL");
    expect(sig.strike).toBe(25000);
    expect(sig.premium).toBe(180);
    expect(sig.recommendedInstrument).toContain("CE");
  });

  it("maps SHORT → PUT with live ATM put premium", () => {
    const sig: any = { symbol: "SENSEX", direction: "SHORT", strike: 0, premium: 0, entry: 76000, recommendedInstrument: "SENSEX Short Futures" };
    mapIndexFuturesToOptionBuy(sig, chain);
    expect(sig.direction).toBe("PUT");
    expect(sig.strike).toBe(25000);
    expect(sig.premium).toBe(175);
    expect(sig.recommendedInstrument).toContain("PE");
  });

  it("leaves CALL/PUT/NO_TRADE untouched", () => {
    const sig: any = { symbol: "NIFTY", direction: "CALL", strike: 25000, premium: 180 };
    mapIndexFuturesToOptionBuy(sig, chain);
    expect(sig.direction).toBe("CALL");
    expect(sig.premium).toBe(180);
  });

  it("falls back to entry strike and premium 0 when chain missing (fails honestly later)", () => {
    const sig: any = { symbol: "BANKNIFTY", direction: "LONG", strike: 0, premium: 0, entry: 57000 };
    mapIndexFuturesToOptionBuy(sig, null);
    expect(sig.direction).toBe("CALL");
    expect(sig.strike).toBe(57000);
    expect(sig.premium).toBe(0);
  });
});

describe("buildStockOptionUniverse", () => {
  it("merges scanner + NIFTY500 quotes (scanner wins), keeps affordable lots, sorts by activity", () => {
    setLiveLotSizes({ AAA: 500, BBB: 100, CCC: 300, DDD: 250, EEE: 750, FFF: 1000, GGG: 400 });
    const scanner = [
      { symbol: "AAA", price: 500, changePercent: 2.0, rvol: 3 },  // scanner entry (richer) wins over batch below
      { symbol: "EEE", price: 100, changePercent: 9.9, rvol: 4 },  // active + affordable (75k)
    ];
    const batch = [
      { symbol: "AAA", price: 999, changePercent: 1.0 },           // overridden by scanner
      { symbol: "BBB", price: 300, changePercent: 4.5 },           // affordable (30k) ✓
      { symbol: "CCC", price: 800, changePercent: -3.0 },          // 240k ≤ 250k ✓
      { symbol: "DDD", price: 2962, changePercent: 5.0 },          // 740k > 250k ✗
      { symbol: "FFF", price: 10, changePercent: 8.0 },            // price < 20 ✗
      { symbol: "GGG", price: 500, changePercent: 1.5 },           // 200k ✓
    ];
    const out = buildStockOptionUniverse(scanner, batch, 3);
    // limit 3 → half=2 cheapest lots (BBB 30k, EEE 75k), then active fill (CCC)
    expect(out.map((q) => q.symbol)).toEqual(["BBB", "EEE", "CCC"]);
    expect((out.find((q) => q.symbol === "BBB") as any).rvol).toBeUndefined(); // batch entry, no rvol
    expect(buildStockOptionUniverse(scanner, batch, 10).find((q) => q.symbol === "AAA")!.price).toBe(500); // scanner wins
  });

  it("respects the limit", () => {
    setLiveLotSizes({ X: 100, Y: 100, Z: 100 });
    const q = (s: string, c: number) => ({ symbol: s, price: 500, changePercent: c });
    expect(buildStockOptionUniverse([q("X", 1), q("Y", 2), q("Z", 3)], [], 2)).toHaveLength(2);
  });
});

describe("resolveOrderAction — never sell option premium", () => {
  it("forces BUY for CALL/PUT regardless of direction text", () => {
    expect(resolveOrderAction({ instrument: "CALL", direction: "CALL" })).toBe("BUY");
    expect(resolveOrderAction({ instrument: "PUT", direction: "PUT" })).toBe("BUY");
    expect(resolveOrderAction({ instrument: "PUT", direction: "BUY_PE" })).toBe("BUY");
    expect(resolveOrderAction({ instrument: "CALL", direction: "SHORT" })).toBe("BUY");
  });

  it("maps futures direction LONG→BUY, SHORT→SELL", () => {
    expect(resolveOrderAction({ instrument: "FUTURES", direction: "LONG" })).toBe("BUY");
    expect(resolveOrderAction({ instrument: "FUTURES", direction: "SHORT" })).toBe("SELL");
  });

  it("keeps equity BUY/SELL passthrough", () => {
    expect(resolveOrderAction({ instrument: "EQUITY", direction: "BUY" })).toBe("BUY");
    expect(resolveOrderAction({ instrument: "EQUITY", direction: "SELL" })).toBe("SELL");
  });
});
