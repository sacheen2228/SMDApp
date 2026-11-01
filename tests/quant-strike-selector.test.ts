import { describe, test, expect } from "bun:test";
import { selectContract, expiryCompact, buildTradingsymbol } from "@/lib/quant/quant-strike-selector";
import type { CanonicalOptionChain, OptionLeg, OptionStrike } from "@/lib/data-layer/chains/option-chain";

// ── Synthetic chain fixture (all fixtures live INSIDE the test) ──────

const FUTURE_EXPIRY = (() => {
  const d = new Date(Date.now() + 7 * 86400_000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d.getUTCDate()).padStart(2, "0")}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
})();

function leg(over: Partial<OptionLeg> = {}): OptionLeg {
  return {
    ltp: 150, volume: 5000, oi: 2000, oiChange: 100, iv: 14.0,
    bid: 149.5, ask: 150.5, delta: 0.52, gamma: 0.001, theta: -8, rho: null,
    ...over,
  };
}

function chainFixture(opts: {
  spot?: number | null;
  expiry?: string | null;
  ceLegs?: Record<number, OptionLeg | null>;
  peLegs?: Record<number, OptionLeg | null>;
}): CanonicalOptionChain {
  const spot = opts.spot === undefined ? 25000 : opts.spot;
  const ce = opts.ceLegs ?? {};
  const pe = opts.peLegs ?? {};
  const strikeSet = new Set<number>([...Object.keys(ce).map(Number), ...Object.keys(pe).map(Number), 24900, 24950, 25000, 25050, 25100]);
  const strikes: OptionStrike[] = Array.from(strikeSet).sort((a, b) => a - b).map((strike) => ({
    strike,
    ce: ce[strike] === undefined ? leg() : ce[strike],
    pe: pe[strike] === undefined ? leg({ delta: -0.48, theta: -8 }) : pe[strike],
  }));
  return {
    underlying: "NIFTY",
    spot,
    expiry: opts.expiry === undefined ? FUTURE_EXPIRY : opts.expiry,
    strikes,
    timestamp: new Date().toISOString(),
    source: "NSE",
    fallbackUsed: false,
    freshness: "LIVE",
  };
}

// ── Happy path ───────────────────────────────────────────────────────

describe("selectContract — ATM selection", () => {
  test("selects the ATM strike (delta fit + liquidity + spread objective)", () => {
    const chain = chainFixture({
      ceLegs: {
        24900: leg({ ltp: 60, bid: 59.8, ask: 60.2, delta: null, iv: 14 }), // greeks → BS delta ~0.61 → out of band
        24950: leg({ delta: 0.7 }), // outside band
        25000: leg({ delta: 0.52, oi: 2000 }),
        25050: leg({ delta: 0.62 }), // outside band
        25100: leg({ ltp: 40, bid: 39.6, ask: 40.4, delta: 0.35, oi: 600 }), // in band, weaker
      },
    });
    const sel = selectContract({ symbol: "NIFTY", direction: "BUY_CE", chain });
    expect(sel.rejected).toBeFalsy();
    expect(sel.strike).toBe(25000);
    expect(sel.optionType).toBe("CE");
    expect(sel.lotSize).toBe(65); // NIFTY static lot
    expect(sel.tickSize).toBe(0.05);
    expect(sel.premium).toBe(150);
    expect(sel.delta).toBeCloseTo(0.52, 6);
    expect(sel.spreadPct).toBeCloseTo(1 / 150, 6);
    expect(sel.oi).toBe(2000);
    expect(sel.tradingsymbol).toMatch(/^NIFTY\d{2}[A-Z]{3}\d{2}25000CE$/);
    expect(sel.selectionReasons.join(" ")).toContain("ATM ± 2");
  });

  test("BUY_PE picks the PE leg and encodes PE in the tradingsymbol", () => {
    const chain = chainFixture({
      peLegs: {
        25000: leg({ ltp: 130, bid: 129.6, ask: 130.4, delta: -0.48, oi: 3000 }),
        24950: leg({ delta: -0.7 }),
        25050: leg({ delta: -0.2 }),
      },
    });
    const sel = selectContract({ symbol: "NIFTY", direction: "BUY_PE", chain });
    expect(sel.rejected).toBeFalsy();
    expect(sel.strike).toBe(25000);
    expect(sel.optionType).toBe("PE");
    expect(sel.delta).toBeCloseTo(0.48, 6); // absolute delta
    expect(sel.tradingsymbol!.endsWith("PE")).toBe(true);
  });

  test("delta fallback: leg delta null + chain IV (percent) → BS greeks", () => {
    const chain = chainFixture({
      ceLegs: { 25000: leg({ delta: null, iv: 14 }) },
    });
    const sel = selectContract({ symbol: "NIFTY", direction: "BUY_CE", chain });
    expect(sel.rejected).toBeFalsy();
    expect(sel.delta).toBeGreaterThan(0.3);
    expect(sel.delta).toBeLessThan(0.6);
    expect(sel.iv).not.toBeNull(); // reported in percent
  });

  test("tiebreak: equal scores → nearest ATM, then lower strike", () => {
    const chain = chainFixture({
      ceLegs: {
        24900: leg({ delta: 0.9 }), // out of band
        24950: leg({ delta: 0.45, oi: 2000, bid: 149.5, ask: 150.5 }),
        25000: leg({ oi: 100 }), // ATM rejected: oi below floor
        25050: leg({ delta: 0.45, oi: 2000, bid: 149.5, ask: 150.5 }), // same score as 24950
        25100: leg({ delta: 0.1 }), // out of band
      },
    });
    const sel = selectContract({ symbol: "NIFTY", direction: "BUY_CE", chain });
    expect(sel.rejected).toBeFalsy();
    expect([24950, 25050]).toContain(sel.strike);
    // equidistant from spot 25000 → deterministic lower-strike tiebreak
    expect(sel.strike).toBe(24950);
  });
});

// ── Rejection paths ──────────────────────────────────────────────────

describe("selectContract — rejection paths (fail closed)", () => {
  test("unknown lot size → rejected", () => {
    const sel = selectContract({ symbol: "NOTAREALSYMBOL", direction: "BUY_CE", chain: chainFixture({}) });
    expect(sel.rejected).toBe(true);
    expect(sel.rejectionReason).toContain("unknown lot size");
    expect(sel.strike).toBeNull();
  });

  test("SELL direction is never selected", () => {
    const sel = selectContract({ symbol: "NIFTY", direction: "SELL", chain: chainFixture({}) });
    expect(sel.rejected).toBe(true);
    expect(sel.rejectionReason).toContain("not an option BUY");
  });

  test("wide spread beyond 25% of mid → all legs rejected", () => {
    const bad = leg({ bid: 100, ask: 200 });
    const chain = chainFixture({
      ceLegs: { 24900: bad, 24950: bad, 25000: bad, 25050: bad, 25100: bad },
    });
    const sel = selectContract({ symbol: "NIFTY", direction: "BUY_CE", chain });
    expect(sel.rejected).toBe(true);
    expect(sel.rejectionReason).toContain("spread");
  });

  test("low OI below the liquidity floor → rejected", () => {
    const bad = leg({ oi: 100 });
    const chain = chainFixture({
      ceLegs: { 24900: bad, 24950: bad, 25000: bad, 25050: bad, 25100: bad },
    });
    const sel = selectContract({ symbol: "NIFTY", direction: "BUY_CE", chain });
    expect(sel.rejected).toBe(true);
    expect(sel.rejectionReason).toContain("oi");
  });

  test("missing greeks (no leg delta, no IV, premium unexplainable) → greeks unavailable", () => {
    // Wide-step chain (only 3 strikes near spot) with legs priced below the
    // discounted intrinsic → impliedVolFromPremium returns null, leg has no
    // delta/IV → "greeks unavailable"; the far OTM strike solves a tiny IV
    // whose delta lands outside the band → also rejected. Net: no candidate.
    const bad = leg({ ltp: 8, bid: 7.95, ask: 8.05, delta: null, iv: null, oi: 2000 });
    const chain: CanonicalOptionChain = {
      underlying: "NIFTY", spot: 25000, expiry: FUTURE_EXPIRY,
      strikes: [24500, 25000, 25500].map((strike) => ({ strike, ce: { ...bad }, pe: null })),
      timestamp: new Date().toISOString(), source: "NSE", fallbackUsed: false, freshness: "LIVE",
    };
    const sel = selectContract({ symbol: "NIFTY", direction: "BUY_CE", chain });
    expect(sel.rejected).toBe(true);
    expect(sel.rejectionReason).toContain("greeks unavailable");
  });

  test("premium below the absolute floor (lottery) → rejected", () => {
    const bad = leg({ ltp: 5, bid: 4.95, ask: 5.05, delta: 0.5 });
    const chain = chainFixture({
      ceLegs: { 24900: bad, 24950: bad, 25000: bad, 25050: bad, 25100: bad },
    });
    const sel = selectContract({ symbol: "NIFTY", direction: "BUY_CE", chain });
    expect(sel.rejected).toBe(true);
    expect(sel.rejectionReason).toContain("premium");
  });

  test("bid/ask missing → leg rejected with no bid/ask reason", () => {
    const bad = leg({ bid: null, ask: null });
    const chain = chainFixture({
      ceLegs: { 24900: bad, 24950: bad, 25000: bad, 25050: bad, 25100: bad },
    });
    const sel = selectContract({ symbol: "NIFTY", direction: "BUY_CE", chain });
    expect(sel.rejected).toBe(true);
    expect(sel.rejectionReason).toContain("no bid/ask");
  });

  test("chain spot missing → rejected", () => {
    const sel = selectContract({ symbol: "NIFTY", direction: "BUY_CE", chain: chainFixture({ spot: null }) });
    expect(sel.rejected).toBe(true);
    expect(sel.rejectionReason).toContain("spot");
  });

  test("expired expiry → rejected", () => {
    const sel = selectContract({
      symbol: "NIFTY", direction: "BUY_CE",
      chain: chainFixture({ expiry: "01-Jan-2020" }),
    });
    expect(sel.rejected).toBe(true);
    expect(sel.rejectionReason).toContain("expiry");
  });

  test("no chain at all → rejected", () => {
    const sel = selectContract({ symbol: "NIFTY", direction: "BUY_CE", chain: null });
    expect(sel.rejected).toBe(true);
    expect(sel.rejectionReason).toContain("chain");
  });
});

// ── Tradingsymbol construction ───────────────────────────────────────

describe("tradingsymbol helpers", () => {
  test("expiryCompact parses DD-Mon-YYYY", () => {
    expect(expiryCompact("27-Oct-2026")).toBe("27OCT26");
    expect(expiryCompact("2026-11-05")).toBe("05NOV26");
    expect(expiryCompact("garbage")).toBeNull();
  });

  test("buildTradingsymbol MO/NSE F&O style", () => {
    expect(buildTradingsymbol("NIFTY", "27-Oct-2026", 25000, "CE")).toBe("NIFTY27OCT2625000CE");
    expect(buildTradingsymbol("BANKNIFTY", "2026-11-05", 56500, "PE")).toBe("BANKNIFTY05NOV2656500PE");
    expect(buildTradingsymbol("NIFTY", null, 25000, "CE")).toBeNull();
  });

  test("unparseable expiry in the chain → tradingsymbol null (never guessed)", () => {
    const chain = chainFixture({ expiry: "not-a-date" });
    // expiry invalid → the selector rejects before construction
    const sel = selectContract({ symbol: "NIFTY", direction: "BUY_CE", chain });
    expect(sel.rejected).toBe(true);
  });
});
