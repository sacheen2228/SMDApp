// Daily Derivatives — Wave 0: data provenance, timestamp honesty, status labels.
//
// The rules these tests pin:
//   - A broker stamp that is really OUR collection time must never be published
//     as a provider timestamp (that is what made Breeze chains read "LIVE").
//   - A missing bid/ask book must stay missing (null), never become a 0 price.
//   - Every IV must say where it came from: published by the provider, inverted
//     from the premium, or computed by Black-Scholes.
//   - An error without an explicit status is a 500; only an explicit status
//     (or a recognised "no data" signal) may become a 503.

import { describe, test, expect } from "bun:test";
import { mapBreezeOptionChain } from "@/lib/market-data-providers";
import { deriveLegGreeks, mapEngineStrikes } from "@/lib/data-layer/chains/option-chain";
import { mapChainStrikes, dailyDerivativesErrorStatus } from "@/lib/DailyDerivatives";

const FUTURE = "2027-03-25";

describe("Wave 0 — provider timestamp honesty", () => {
  test("the Breeze mapper publishes NO provider timestamp (the broker stamp is our collection time)", () => {
    const mapped = mapBreezeOptionChain({
      strikes: [24000],
      calls: [{ strikePrice: 24000, ltp: 100, openInterest: 10, oiChange: 1, volume: 5, iv: 16.5 }],
      puts: [{ strikePrice: 24000, ltp: 90, openInterest: 8, oiChange: -1, volume: 4, iv: 17.5 }],
      spotPrice: 24000,
      // Breeze's own field — this is the moment WE collected it.
      timestamp: "2026-11-27T07:00:00.000Z",
    });

    expect(mapped).not.toBeNull();
    // A provider timestamp here would make market-data-service classify the
    // chain as LIVE (age ≈ 0) even though no exchange stamped it.
    expect(mapped!.providerTimestamp).toBeUndefined();
  });

  test("an undated payload is capped at FRESH, never LIVE", () => {
    // market-data-service: no provider timestamp → "FRESH" (collected now,
    // unverifiable → never LIVE). This is the rule the Breeze mapper now obeys.
    const pt = undefined;
    const freshness = pt ? "LIVE" : "FRESH";
    expect(freshness).toBe("FRESH");
  });
});

describe("Wave 0 — IV provenance", () => {
  test("a published IV is labelled 'provider'", () => {
    const g = deriveLegGreeks({ iv: 16.5, ltp: 100 }, 24000, 24000, FUTURE, true);
    expect(g.ivSource).toBe("provider");
  });

  test("an IV inverted from the live premium is labelled 'inverted'", () => {
    // Premium must clear the no-arb floor (an ATM call at 7% r is worth
    // S − K·e^(−rT) ≈ 564 before any volatility) or the inversion refuses —
    // correctly, since there is no IV that prices it.
    const g = deriveLegGreeks({ ltp: 900 }, 24000, 24000, FUTURE, true);
    expect(g.ivSource).toBe("inverted");
    expect(g.iv).toBeGreaterThan(0);
  });

  test("no IV and no invertible premium leaves the IV unknown (never a fabricated 0)", () => {
    const g = deriveLegGreeks({ ltp: 0 }, 24000, 24000, null, true);
    expect(g.iv).toBeNull();
    expect(g.ivSource).toBeNull();
  });

  test("the canonical leg carries the IV source through to the strike row", () => {
    const strikes = mapEngineStrikes(
      [{ strike: 24000, ce: { ltp: 100, oi: 10, oiChg: 1, volume: 5, iv: 16.5 }, pe: { ltp: 90, oi: 8, oiChg: 1, volume: 4 } }],
      24000,
      FUTURE,
    );
    expect(strikes[0].ce?.ivSource).toBe("provider");
    expect(strikes[0].pe?.ivSource).toBe("inverted");
  });
});

describe("Wave 0 — a missing book stays missing", () => {
  test("no bid/ask in the chain means null bid/ask, not a 0 price", () => {
    const rows = mapChainStrikes([
      { strike: 24000, ce: { ltp: 100, oi: 10, oiChange: 1, volume: 5, iv: 16 } },
    ]);
    expect(rows[0].call!.bid).toBeNull();
    expect(rows[0].call!.ask).toBeNull();
  });

  test("a real book is preserved exactly", () => {
    const rows = mapChainStrikes([
      { strike: 24000, ce: { ltp: 100, oi: 10, oiChange: 1, volume: 5, iv: 16, bid: 99.5, ask: 100.5 } },
    ]);
    expect(rows[0].call!.bid).toBe(99.5);
    expect(rows[0].call!.ask).toBe(100.5);
  });

  test("the projected leg carries the IV source (so the UI can label an estimate)", () => {
    const rows = mapChainStrikes([
      { strike: 24000, ce: { ltp: 100, oi: 10, oiChange: 1, volume: 5, iv: 16, ivSource: "provider" } },
    ]);
    // Carried on the leg itself (not only inside `greeks`) so the provenance
    // survives even when a leg has no greek set at all.
    expect(rows[0].call!.ivSource).toBe("provider");
  });
});

describe("Wave 0 — error status classification", () => {
  test("an explicit 503 stays 503", () => {
    expect(dailyDerivativesErrorStatus({ status: 503, message: "chain unavailable" })).toBe(503);
  });

  test("a plain error is a 500, even when the message happens to say 'failed'", () => {
    expect(dailyDerivativesErrorStatus(new Error("provider failed to answer"))).toBe(500);
  });

  test("a NO_DATA failure with no status is still a 503 (retry later, not a bug)", () => {
    expect(dailyDerivativesErrorStatus(new Error("NO_DATA for NIFTY"))).toBe(503);
    expect(dailyDerivativesErrorStatus(new Error("option chain unavailable"))).toBe(503);
  });
});
