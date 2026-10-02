/// <reference types="bun-types" />
// Challenge premium sizing — option setups must be priced/sized in PREMIUM
// space (playbook: stop lives on the underlying, repriced to premium via
// Black-Scholes — never as a flat guess), sized with real lot sizes, and
// ranked options-first for small challenge capital.

import { describe, it, expect } from "bun:test";
import { bsPrice, impliedVolFromPremium } from "@/lib/greeks";
import {
  convertOptionToPremiumTerms,
  sizeOpportunity,
  rankOpportunitiesForCapital,
} from "@/lib/challenge/challenge-engine";
import { DEFAULT_CAPITAL_CONFIG } from "@/lib/challenge/capital-manager";
import type { ChallengeOpportunity } from "@/lib/challenge/challenge-engine";

// Fixed "now" so expiry → time-to-expiry is deterministic.
const NOW = new Date("2026-10-02T10:00:00+05:30"); // expiry 27-Oct-2026 = 25 days
const EXPIRY = "27-Oct-2026";
const TTE = 25 / 365;

function optOpp(over: Partial<ChallengeOpportunity> = {}): ChallengeOpportunity {
  return {
    rank: 1,
    symbol: "NIFTY",
    name: "NIFTY",
    instrument: "CALL",
    strategy: "STOCK_BUY_CE",
    score: 80,
    confidence: 80,
    direction: "BUY_CE",
    entry: 25100, // spot until converted
    stopLoss: 24950, // spot SL until converted
    target1: 25300,
    target2: 25400,
    riskReward: 1.33,
    volume: 0,
    relativeVolume: 1,
    sector: "Index",
    near52WHigh: false,
    near52WLow: false,
    reasoning: [],
    factors: {},
    position: { quantity: 0, lotSize: 1, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false },
    data: { ltp: 25100, changePct: 0, weekHigh52: 0, weekLow52: 0 },
    strike: 25100,
    premium: bsPrice(25100, 25100, TTE, 0.14, true),
    expiry: EXPIRY,
    tradeable: true,
    blockedReasons: [],
    dataStamp: "LIVE",
    ...over,
  };
}

function equityOpp(over: Partial<ChallengeOpportunity> = {}): ChallengeOpportunity {
  return optOpp({
    instrument: "EQUITY",
    symbol: "INFY",
    name: "INFY",
    direction: "BUY",
    entry: 1035,
    stopLoss: 993.6,
    target1: 1097.1,
    target2: 1130,
    strike: undefined,
    premium: undefined,
    expiry: undefined,
    data: { ltp: 1035, changePct: 4.1, weekHigh52: 0, weekLow52: 0 },
    ...over,
  });
}

// ── greeks: bsPrice + impliedVol ─────────────────────────────────────────

describe("bsPrice", () => {
  it("ATM call sanity: above intrinsic, below spot", () => {
    const p = bsPrice(25100, 25100, 7 / 365, 0.14, true);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(25100);
  });

  it("put-call parity: C - P = S - K·e^(-rT)", () => {
    const c = bsPrice(178, 177.5, TTE, 0.3, true);
    const p = bsPrice(178, 177.5, TTE, 0.3, false);
    const parity = 178 - 177.5 * Math.exp(-0.07 * TTE);
    expect(c - p).toBeCloseTo(parity, 4);
  });

  it("call price increases as spot increases (monotonic)", () => {
    const a = bsPrice(100, 100, 0.25, 0.2, true);
    const b = bsPrice(103, 100, 0.25, 0.2, true);
    expect(b).toBeGreaterThan(a);
  });

  it("degenerate inputs (zero T or IV) return intrinsic-ish, never NaN", () => {
    const p = bsPrice(105, 100, 0, 0, true);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThanOrEqual(4.99);
  });
});

describe("impliedVolFromPremium", () => {
  it("round-trips an ATM call premium back to the input IV", () => {
    const iv = 0.14;
    const premium = bsPrice(25100, 25100, 7 / 365, iv, true);
    const solved = impliedVolFromPremium(premium, 25100, 25100, 7 / 365, true);
    expect(solved).not.toBeNull();
    expect(solved!).toBeCloseTo(iv, 3);
  });

  it("round-trips an OTM put premium (stock option)", () => {
    const iv = 0.3;
    const premium = bsPrice(178, 177.5, TTE, iv, false);
    const solved = impliedVolFromPremium(premium, 178, 177.5, TTE, false);
    expect(solved).not.toBeNull();
    expect(solved!).toBeCloseTo(iv, 3);
  });

  it("returns null for premium <= 0", () => {
    expect(impliedVolFromPremium(0, 100, 100, 0.1, true)).toBeNull();
    expect(impliedVolFromPremium(-5, 100, 100, 0.1, true)).toBeNull();
  });

  it("returns null for an impossible premium (below intrinsic)", () => {
    expect(impliedVolFromPremium(1, 120, 100, 0.1, true)).toBeNull();
  });
});

// ── convertOptionToPremiumTerms ──────────────────────────────────────────

describe("convertOptionToPremiumTerms", () => {
  it("converts spot levels to premium space using IV from the live premium", () => {
    const opp = optOpp({ direction: "BUY_PE", instrument: "PUT", entry: 178, stopLoss: 182, target1: 172.65, target2: 170, strike: 177.5, data: { ltp: 178, changePct: 0, weekHigh52: 0, weekLow52: 0 } });
    const livePremium = bsPrice(178, 177.5, TTE, 0.3, false);
    opp.premium = livePremium;

    const res = convertOptionToPremiumTerms(opp, NOW);
    expect(res.ok).toBe(true);

    // entry = live premium (never the spot), rounded to the 0.05 tick
    const tick = (x: number) => Math.round(x * 20) / 20;
    expect(opp.entry).toBe(tick(livePremium));
    // premium SL below entry for a PE? NO — PE gains when spot rises past SL... wait:
    // BUY_PE: spot SL 182 (above entry) means invalidation UP → put premium falls.
    expect(opp.stopLoss).toBeLessThan(opp.entry);
    expect(opp.target1).toBeGreaterThan(opp.entry);
    expect(opp.target2).toBeGreaterThan(opp.target1);
    // spot levels preserved for display
    expect(opp.spotEntry).toBe(178);
    expect(opp.spotStopLoss).toBe(182);
    expect(opp.spotTarget1).toBe(172.65);
    // premium SL = BS re-price of the spot SL at the recovered IV, FLOORED at
    // entry×0.90 (rule C: option stop never wider than 10% of premium) —
    // whichever is tighter — rounded to the 0.05 premium tick
    const iv = impliedVolFromPremium(livePremium, 178, 177.5, TTE, false)!;
    const bsSl = Math.round(bsPrice(182, 177.5, TTE, iv, false) * 20) / 20;
    const floor10 = Math.round(opp.entry * 0.9 * 20) / 20;
    expect(opp.stopLoss).toBe(Math.max(bsSl, floor10));
    expect(opp.stopLoss).toBeLessThan(opp.entry);
    // R:R recomputed in premium space (rounded to 1 decimal like the converter)
    expect(opp.riskReward).toBeGreaterThan(0);
    const rawRr = (opp.target1 - opp.entry) / (opp.entry - opp.stopLoss);
    expect(opp.riskReward).toBe(Math.round(rawRr * 10) / 10);
  });

  it("fails cleanly (no fabrication) when chain premium is missing", () => {
    const opp = optOpp({ premium: 0 });
    const res = convertOptionToPremiumTerms(opp, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/premium/i);
    expect(opp.entry).toBe(25100); // unchanged spot
  });

  it("fails cleanly when expiry is missing", () => {
    const opp = optOpp({ expiry: "" });
    const res = convertOptionToPremiumTerms(opp, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/expiry/i);
  });

  it("CALL: premium SL below entry, TP above (spot SL 24950 below spot entry)", () => {
    const opp = optOpp({ instrument: "CALL", direction: "BUY_CE", entry: 25100, stopLoss: 24950, target1: 25300, target2: 25400 });
    const res = convertOptionToPremiumTerms(opp, NOW);
    expect(res.ok).toBe(true);
    expect(opp.stopLoss).toBeLessThan(opp.entry);
    expect(opp.target1).toBeGreaterThan(opp.entry);
  });
});

// ── sizeOpportunity — every setup gets a real position ───────────────────

describe("sizeOpportunity", () => {
  it("sizes a CALL with premium entry using live lot size (NIFTY 65) and 10% risk", () => {
    const opp = optOpp({
      instrument: "CALL",
      entry: 90, // premium
      stopLoss: 70, // premium SL → risk ₹20/unit
      target1: 130,
      premium: 90,
    });
    // capital 15000 × 10% = ₹1500 budget; risk/lot = 20 × 65 = ₹1300 → 1 lot
    // cost = 90 × 65 × 1.05 = ₹6142 ≤ 50% cap (₹7500) → affordable
    sizeOpportunity(opp, 15000, DEFAULT_CAPITAL_CONFIG);
    expect(opp.position.canTrade).toBe(true);
    expect(opp.position.lots).toBe(1);
    expect(opp.position.quantity).toBe(65);
    expect(opp.position.maxLoss).toBe(1300);
    expect(opp.position.instrument).toBe("OPTION");
    expect(opp.tradeable).toBe(true);
  });

  it("blocks with a reason when per-lot risk exceeds the budget (playbook: never risk more)", () => {
    const opp = optOpp({ instrument: "CALL", entry: 120, stopLoss: 95, premium: 120 });
    sizeOpportunity(opp, 15000, DEFAULT_CAPITAL_CONFIG);
    // risk/lot = 25 × 65 = ₹1625 > budget ₹1500 → 0 lots
    expect(opp.position.canTrade).toBe(false);
    expect(opp.position.reason).toBeTruthy();
    expect(opp.tradeable).toBe(false);
    expect(opp.blockedReasons.join(" ")).toMatch(/sizing/i);
  });

  it("blocks when one lot costs more than the position cap", () => {
    const opp = optOpp({ instrument: "CALL", entry: 200, stopLoss: 195, premium: 200 });
    sizeOpportunity(opp, 15000, DEFAULT_CAPITAL_CONFIG);
    // cost = 200 × 65 × 1.05 = ₹13,650 > ₹7,500 cap → 0 lots
    expect(opp.position.canTrade).toBe(false);
    expect(opp.position.reason).toBeTruthy();
  });

  it("sizes equity by risk like before (INFY qty 10 at 10% risk, 75% cap)", () => {
    const opp = equityOpp();
    sizeOpportunity(opp, 15000, DEFAULT_CAPITAL_CONFIG);
    // 10% of 15000 = ₹1500 risk / ₹41.4 per share = 36 → capped by 75% cap: 11250/1035 = 10
    expect(opp.position.canTrade).toBe(true);
    expect(opp.position.quantity).toBe(10);
    expect(opp.position.instrument).toBe("EQUITY");
  });

  it("sizes a mixed list of 10 — no setup left with quantity 0 unless blocked with a reason", () => {
    const list: ChallengeOpportunity[] = [];
    for (let i = 0; i < 5; i++) list.push(equityOpp({ symbol: `STK${i}`, entry: 100 + i, stopLoss: 95 + i, data: { ltp: 100, changePct: 1, weekHigh52: 0, weekLow52: 0 } }));
    for (let i = 0; i < 5; i++) list.push(optOpp({ symbol: i % 2 ? "NIFTY" : "BANKNIFTY", instrument: i % 2 ? "PUT" : "CALL", entry: 60, stopLoss: 45, premium: 60 }));
    for (const opp of list) sizeOpportunity(opp, 15000, DEFAULT_CAPITAL_CONFIG);
    for (const opp of list) {
      if (opp.position.quantity > 0) expect(opp.position.canTrade).toBe(true);
      else expect(opp.position.reason).toBeTruthy(); // blocked — honest reason
    }
    expect(list.filter((o) => o.position.quantity > 0).length).toBeGreaterThanOrEqual(5);
  });
});

// ── rankOpportunitiesForCapital — options first below ₹50K ──────────────

describe("rankOpportunitiesForCapital", () => {
  const eq93 = () => equityOpp({ score: 93, symbol: "INFY" });
  const put83 = () => optOpp({ score: 83, instrument: "PUT", symbol: "TATASTEEL" });
  const call90 = () => optOpp({ score: 90, instrument: "CALL", symbol: "NIFTY" });
  const eq85 = () => equityOpp({ score: 85, symbol: "WIPRO" });

  it("options rank before equity when capital < ₹50K (score order within groups)", () => {
    const out = rankOpportunitiesForCapital([eq93(), put83(), call90(), eq85()], 15000);
    expect(out.map((o) => o.instrument)).toEqual(["CALL", "PUT", "EQUITY", "EQUITY"]);
    expect(out.map((o) => o.score)).toEqual([90, 83, 93, 85]);
  });

  it("pure score order when capital >= ₹50K", () => {
    const out = rankOpportunitiesForCapital([eq93(), put83(), call90(), eq85()], 50000);
    expect(out.map((o) => o.score)).toEqual([93, 90, 85, 83]);
  });

  it("futures keep score order (not hoisted) below ₹50K", () => {
    const fut = optOpp({ instrument: "FUTURES", score: 91, symbol: "SBIN" });
    const out = rankOpportunitiesForCapital([eq93(), fut, call90()], 15000);
    expect(out.map((o) => o.instrument)).toEqual(["CALL", "EQUITY", "FUTURES"]);
  });
});
