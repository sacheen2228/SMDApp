/// <reference types="bun-types" />
// Reliability audit (2026-10-21) — chain field mapping, ATM resolution and
// option-plan executability. Three proven defects, pinned so they cannot
// regress:
//   1. the reader did not know the repo's own `oiChg` field name → the agent's
//      read_option_chain saw NO change-in-OI on a fresh call (the OI layer
//      degraded to UNKNOWN while the exchange's real ΔOI was in the payload);
//   2. `atmStrike: 0` (the route's "unknown" sentinel) is not nullish, so
//      `??` published ATM 0 and the ATM Greek row was null;
//   3. entry-tp-sl-engine guessed `lotSize = 1` and returned 0-lot plans with
//      levels that looked tradable.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { normalizeChain, analyze, CHAIN_CFG } from "@/lib/option-chain-reader";
import { entryTPSLEngine } from "@/lib/zero-hero-ai/entry-tp-sl-engine";
import { getLotSizeStrict } from "@/lib/symbol-config";

// The ACTUAL shape /api/option-chain returns (captured 2026-10-21 23:32 IST):
// data.strikes[].ce = { ltp, oi, oiChg, volume, iv, delta, … } + summary.atmStrike.
const payload = (over: any = {}) => ({
  data: {
    symbol: "NIFTY",
    spotPrice: 22811.35,
    strikes: [
      { strike: 22750, ce: { ltp: 175.4, ltpChange: -3.2, oi: 90000, oiChg: 12000, volume: 400000, iv: 9.6, delta: 0.62 },
        pe: { ltp: 160.2, ltpChange: 4.6, oi: 120000, oiChg: -4000, volume: 500000, iv: 18.9, delta: -0.4 } },
      { strike: 22800, ce: { ltp: 135.95, ltpChange: -8.5, oi: 119673, oiChg: 82793, volume: 1322963, iv: 9.42, delta: 0.56 },
        pe: { ltp: 200.35, ltpChange: 12.4, oi: 79767, oiChg: 13778, volume: 2587660, iv: 19.21, delta: -0.47 } },
      { strike: 22850, ce: { ltp: 102.1, ltpChange: -5.1, oi: 95000, oiChg: 30000, volume: 700000, iv: 9.5, delta: 0.44 },
        pe: { ltp: 240.9, ltpChange: 9.8, oi: 88000, oiChg: 9000, volume: 800000, iv: 19.4, delta: -0.55 } },
    ],
    summary: { pcr: 1.08, maxPain: 22800, atmStrike: 22800, indiaVIX: 13.1 },
    ...over,
  },
});

describe("option-chain-reader — the repo payload's ΔOI is actually read", () => {
  test("normalises `oiChg` (the field /api/option-chain ships)", () => {
    const c = normalizeChain(payload(), "NIFTY");
    expect(c).not.toBeNull();
    expect(c!.rows.map((r) => r.strike)).toEqual([22750, 22800, 22850]);
    expect(c!.rows[1].ce.oiChange).toBe(82793);   // was undefined before the alias
    expect(c!.rows[1].pe.oiChange).toBe(13778);
    expect(c!.rows[1].ce.oi).toBe(119673);
    expect(c!.derivedChange).toBe(false);          // the exchange's own ΔOI, not ours
  });

  test("OI-change classification runs WITHOUT waiting for a snapshot baseline", () => {
    const c = normalizeChain(payload(), "NIFTY")!;
    const a = analyze(c, undefined, 6);
    // ΔOI + Δpremium are both present → the bias layer is no longer UNKNOWN
    expect(a.bias).not.toBe("UNKNOWN");
    expect(a.derivedChange).toBe(false);
    // call OI up + premium context → fresh call writing at/above spot is classified
    expect(a.freshCallWriting.length + a.freshPutWriting.length + a.ceBuying.length + a.peBuying.length)
      .toBeGreaterThan(0);
  });

  test("a summary that says atmStrike: 0 falls back to the nearest strike, not ATM 0", () => {
    const c = normalizeChain(payload({ summary: { pcr: 1.08, atmStrike: 0 } }), "NIFTY")!;
    expect(c.atm).toBe(0); // the sentinel is carried through…
    const a = analyze(c);
    expect(a.atm).toBe(22800);              // …but never published as the ATM
    expect(a.atmGreeks).not.toBeNull();
    expect(a.atmGreeks!.ce.ltp).toBe(135.95);
  });

  test("an unknown summary ATM still resolves by tick (NIFTY 50)", () => {
    const c = normalizeChain(payload({ summary: { atmStrike: 999999 } }), "NIFTY")!;
    const a = analyze(c);
    expect(a.atm).toBe(22800);
  });

  test("strike steps used for ATM rounding are the contract's own", () => {
    expect(CHAIN_CFG.minRelOi).toBeGreaterThan(0); // illiquid strikes stay QUIET
    expect(normalizeChain(payload(), "NIFTY")!.rows.length).toBe(3);
  });
});

describe("entry-tp-sl-engine — lot size is never guessed", () => {
  const base = {
    entryPremium: 150, spot: 22400, strike: 22400, optionType: "PE" as const,
    delta: -0.5, gamma: 0.001, theta: -5, atr: 50, daysToExpiry: 5,
    bias: "BEARISH" as const, expected_move: 300, instrument: "NIFTY",
    expiry_mode: "STANDARD" as const, deployedAmount: 10_000,
  };

  test("resolves the lot size from symbol-config when the caller omits it", () => {
    expect(getLotSizeStrict("NIFTY")).toBe(65);
    const out = entryTPSLEngine(base);
    expect(out.tradable).toBe(true);
    expect(out.lots).toBeGreaterThan(0);
    // 1 lot = ₹150 × 65 = ₹9,750 deployed → risk ₹1,950 over 65 units = 30 pts
    expect(out.deployed).toBeCloseTo(9750, 0);
    expect(out.stopLoss).toBeLessThan(out.entry);
    expect(out.stopLoss).toBeCloseTo(150 - 30, 1);
    expect(out.targets[0]).toBeGreaterThan(out.entry);
    expect(out.deployed).toBeLessThanOrEqual(10_000);

  });

  test("PE plans use LONG-option geometry: stop BELOW entry, targets ABOVE", () => {
    const out = entryTPSLEngine(base);
    expect(out.stopLoss).toBeLessThan(out.entry);
    for (const t of out.targets) expect(t).toBeGreaterThan(out.entry);
    expect(out.riskReward).toBeGreaterThanOrEqual(2);
  });

  test("an unknown contract aborts instead of assuming 1 unit", () => {
    const out = entryTPSLEngine({ ...base, instrument: "NOTAREALSYM" });
    expect(out.tradable).toBe(false);
    expect(out.lots).toBe(0);
    expect(out.deployed).toBe(0);
    expect(out.riskAmount).toBe(0);
    expect(out.entry).toBe(0);
    expect(out.notes).toContain("NO TRADE");
    expect(out.notes).toContain("lot size");
  });

  test("0 lots (contract over the ₹20,000 cap) is an explicit NO TRADE", () => {
    // ₹400 × 65 = ₹26,000 for ONE lot — over the per-trade budget.
    const out = entryTPSLEngine({ ...base, entryPremium: 400 });
    expect(out.tradable).toBe(false);
    expect(out.lots).toBe(0);
    expect(out.deployed).toBe(0);
    expect(out.riskAmount).toBe(0);
    expect(out.notes).toContain("NO TRADE");
  });

  test("an explicit 0-lot request is honoured (no Math.max(1, …))", () => {
    const out = entryTPSLEngine({ ...base, lots: 0 });
    expect(out.tradable).toBe(false);
    expect(out.deployed).toBe(0);
  });
});

describe("api/option-chain — honest fields in the provider mapping", () => {
  const route = readFileSync(join(process.cwd(), "src/app/api/option-chain/route.ts"), "utf8");

  test("the NSE leg ships the exchange's premium change (Δpremium for BUYING/WRITING)", () => {
    expect(route).toContain("ltpChange: numOrNull(row.CE.change)");
    expect(route).toContain("ltpChange: numOrNull(row.PE.change)");
  });

  test("MOAPI never fabricates a ΔOI of 0", () => {
    expect(route).toContain("oiChg: null");
    expect(route).not.toMatch(/oiChg: 0,/);
  });

  test("greeks are not computed (or published as 0) without a spot price", () => {
    expect(route).toContain("if (!(spotPrice > 0)) return null;");
  });

  test("the trade alert gate still demands long-option geometry", () => {
    expect(route).toContain("entryPx > slPx && tp1Px > entryPx");
  });
});
