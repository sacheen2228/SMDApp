/// <reference types="bun-types" />
// Daily Derivatives — Wave 1: the book and the provider greeks.
//
// Audit (docs/daily-derivatives-phase1-audit.md §3.2 / §7): every provider
// PUBLISHES a bid/ask book and NSE publishes its own greeks, but the adapters
// dropped both on the floor:
//
//   - `ChainLeg` had no depth fields and no greek fields, so the DD's
//     MAX_SPREAD_PCT gate was dead code and every card's liquidity badge
//     read "UNVERIFIED";
//   - the canonical layer therefore ALWAYS recomputed Black-Scholes greeks
//     and reported deltaSource "bs", even when the exchange published its own.
//
// These tests pin the plumbing (provider adapter → race → canonical leg) and
// the honest labelling: a provider greek set is "provider", our own BS
// numbers are "bs", and a missing book stays null — NEVER 0.

import { describe, test, expect } from "bun:test";
import {
  mapBreezeOptionChain,
  mapNseOptionChainStrikes,
  mapBseOptionChainStrikes,
} from "@/lib/market-data-providers";
import { toCanonical } from "@/lib/market-data-race";
import { mapEngineStrikes } from "@/lib/data-layer/chains/option-chain";

const FUTURE = "2027-03-25"; // a live expiry — the BS fallback needs T > 0
const SPOT = 24000;

// ── Breeze ────────────────────────────────────────────────────────────────
// The Breeze payload is the broker's own book: best_bid_price /
// best_offer_price + best_bid_qty / best_offer_qty.

function breezeChain(over: any = {}) {
  return {
    symbol: "NIFTY",
    expiryDate: "25-Nov-2026",
    spotPrice: SPOT,
    strikes: [SPOT],
    calls: [
      {
        strikePrice: SPOT,
        ltp: 120,
        openInterest: 500,
        oiChange: 50,
        volume: 10,
        iv: 14.2,
        bid: 119.5,
        ask: 120.5,
        bidQty: 320,
        askQty: 180,
      },
    ],
    puts: [
      { strikePrice: SPOT, ltp: 110, openInterest: 400, oiChange: -20, volume: 8, iv: 15.1 },
    ],
    ...over,
  };
}

describe("mapBreezeOptionChain — the broker's book survives the adapter", () => {
  test("bid/ask and the top-of-book depth are copied into the mapped leg", () => {
    const mapped = mapBreezeOptionChain(breezeChain())!;
    expect(mapped).not.toBeNull();
    const ce = mapped.strikes[0].ce!;
    expect(ce.bid).toBe(119.5);
    expect(ce.ask).toBe(120.5);
    expect(ce.bidQty).toBe(320);
    expect(ce.askQty).toBe(180);
  });

  test("a leg without a book keeps nulls — never a 0 price or a 0 depth", () => {
    const mapped = mapBreezeOptionChain(breezeChain())!;
    const pe = mapped.strikes[0].pe!;
    expect(pe.bid ?? null).toBeNull();
    expect(pe.ask ?? null).toBeNull();
    expect(pe.bidQty ?? null).toBeNull();
    expect(pe.askQty ?? null).toBeNull();
    expect(pe.bid).not.toBe(0);
    expect(pe.askQty).not.toBe(0);
  });

  test("Breeze's locally computed greeks are NOT passed off as provider greeks", () => {
    // `processOption` fills delta/gamma/theta/vega with OUR Black-Scholes
    // numbers (Breeze publishes no greeks). Forwarding them would make the
    // canonical layer label them deltaSource "provider" — a false provenance
    // claim. The canonical layer recomputes and labels them "bs".
    const base = breezeChain();
    const mapped = mapBreezeOptionChain(
      breezeChain({
        calls: [{ ...base.calls[0], delta: 0.55, gamma: 0.001, theta: -12, vega: 6 }],
      }),
    )!;
    const ce = mapped.strikes[0].ce!;
    expect(ce.delta ?? null).toBeNull();
    expect(ce.gamma ?? null).toBeNull();
    expect(ce.theta ?? null).toBeNull();
    expect(ce.vega ?? null).toBeNull();
  });
});

// ── NSE ───────────────────────────────────────────────────────────────────
// The NSE option-chain-v3 field names are buyPrice1 / sellPrice1 /
// buyQuantity1 / sellQuantity1 (live-verified 2026-11-27).

function nseRow(over: any = {}) {
  return {
    strikePrice: 24500,
    CE: {
      lastPrice: 120,
      openInterest: 500,
      changeinOpenInterest: 50,
      totalTradedVolume: 10,
      impliedVolatility: 14.2,
      buyPrice1: 119.5,
      sellPrice1: 120.5,
      buyQuantity1: 320,
      sellQuantity1: 180,
      greeks: { delta: 0.52, gamma: 0.0011, theta: -12.4, vega: 6.02 },
    },
    PE: {
      lastPrice: 110,
      openInterest: 400,
      changeinOpenInterest: -20,
      totalTradedVolume: 8,
      impliedVolatility: 15.1,
      buyPrice1: 109.5,
      sellPrice1: 110.5,
      buyQuantity1: 90,
      sellQuantity1: 140,
      greeks: { delta: -0.48, gamma: 0.0011, theta: -11.9, vega: 6.02 },
    },
    ...over,
  };
}

describe("mapNseOptionChainStrikes — the NSE v3 book + published greeks", () => {
  test("buyPrice1 / sellPrice1 / buyQuantity1 / sellQuantity1 survive", () => {
    const [row] = mapNseOptionChainStrikes([nseRow()]);
    expect(row.strike).toBe(24500);
    expect(row.ce.bid).toBe(119.5);
    expect(row.ce.ask).toBe(120.5);
    expect(row.ce.bidQty).toBe(320);
    expect(row.ce.askQty).toBe(180);
    expect(row.pe.bid).toBe(109.5);
    expect(row.pe.ask).toBe(110.5);
    expect(row.pe.bidQty).toBe(90);
    expect(row.pe.askQty).toBe(140);
  });

  test("the exchange's own greeks survive (they are the provider's numbers)", () => {
    const [row] = mapNseOptionChainStrikes([nseRow()]);
    expect(row.ce.delta).toBe(0.52);
    expect(row.ce.gamma).toBe(0.0011);
    expect(row.ce.theta).toBe(-12.4);
    expect(row.ce.vega).toBe(6.02);
    expect(row.pe.delta).toBe(-0.48);
    expect(row.pe.vega).toBe(6.02);
  });

  test("a row without a book or greeks keeps nulls — never 0", () => {
    const [row] = mapNseOptionChainStrikes([
      {
        strikePrice: 24500,
        CE: {
          lastPrice: 120,
          openInterest: 500,
          changeinOpenInterest: 0,
          totalTradedVolume: 1,
          impliedVolatility: 14.2,
        },
        PE: null,
      },
    ]);
    expect(row.ce.bid ?? null).toBeNull();
    expect(row.ce.ask ?? null).toBeNull();
    expect(row.ce.bidQty ?? null).toBeNull();
    expect(row.ce.askQty ?? null).toBeNull();
    expect(row.ce.delta ?? null).toBeNull();
    expect(row.ce.bid).not.toBe(0);
    expect(row.ce.bidQty).not.toBe(0);
  });
});

// ── BSE ───────────────────────────────────────────────────────────────────
// `bse-api.ts` already parses BidPrice / OfferPrice (puts) and C_BidPrice /
// C_OfferPrice (calls) — the adapter used to rebuild the leg without them.

describe("mapBseOptionChainStrikes — the BSE book survives", () => {
  test("the bid/ask bse-api.ts already parsed are carried through", () => {
    const [row] = mapBseOptionChainStrikes([
      {
        strike: 24500,
        ce: { ltp: 120, oi: 500, oiChg: 50, volume: 10, iv: 14.2, bid: 119.5, ask: 120.5 },
        pe: { ltp: 110, oi: 400, oiChg: -20, volume: 8, iv: 15.1, bid: 109.5, ask: 110.5 },
      },
    ]);
    expect(row.strike).toBe(24500);
    expect(row.ce.bid).toBe(119.5);
    expect(row.ce.ask).toBe(120.5);
    expect(row.pe.bid).toBe(109.5);
    expect(row.pe.ask).toBe(110.5);
  });

  test("a leg without a book keeps nulls — never 0", () => {
    const [row] = mapBseOptionChainStrikes([
      { strike: 24500, ce: { ltp: 120, oi: 500, oiChg: 50, volume: 10, iv: 14.2 }, pe: null },
    ]);
    expect(row.ce.bid ?? null).toBeNull();
    expect(row.ce.ask ?? null).toBeNull();
    expect(row.ce.bid).not.toBe(0);
  });
});

// ── The race's canonical normaliser ──────────────────────────────────────

describe("toCanonical — the race keeps the book and the greeks", () => {
  const envelope = {
    data: {
      strikes: [
        {
          strike: 24500,
          ce: {
            ltp: 120, oi: 500, oiChg: 50, volume: 10, iv: 14.2,
            bid: 119.5, ask: 120.5, bidQty: 320, askQty: 180,
            delta: 0.52, gamma: 0.0011, theta: -12.4, vega: 6.02,
          },
          pe: null,
        },
        {
          strike: 24600,
          ce: { ltp: 90, oi: 300, oiChg: 10, volume: 5, iv: 14 },
          pe: null,
        },
      ],
      spotPrice: SPOT,
      expiryDates: [FUTURE],
      selectedExpiry: FUTURE,
    },
    providerTimestamp: "2026-11-27T10:00:00.000Z",
  };

  test("bid / ask / depth and the four greeks survive the canonical shape", () => {
    const c = toCanonical(envelope, "nse-api")!;
    expect(c).not.toBeNull();
    const ce = c.strikes[0].ce!;
    expect(ce.bid).toBe(119.5);
    expect(ce.ask).toBe(120.5);
    expect(ce.bidQty).toBe(320);
    expect(ce.askQty).toBe(180);
    expect(ce.delta).toBe(0.52);
    expect(ce.gamma).toBe(0.0011);
    expect(ce.theta).toBe(-12.4);
    expect(ce.vega).toBe(6.02);
  });

  test("a leg with no book keeps nulls — never zeros", () => {
    const c = toCanonical(envelope, "nse-api")!;
    const ce = c.strikes[1].ce!;
    expect(ce.bid ?? null).toBeNull();
    expect(ce.ask ?? null).toBeNull();
    expect(ce.bidQty ?? null).toBeNull();
    expect(ce.askQty ?? null).toBeNull();
    expect(ce.bid).not.toBe(0);
    expect(ce.bidQty).not.toBe(0);
    expect(ce.delta ?? null).toBeNull();
  });
});

// ── The canonical layer's greek provenance ────────────────────────────────

describe("the canonical layer — honest greek provenance", () => {
  test("a provider greek set is labelled 'provider' and keeps the book", () => {
    const [row] = mapEngineStrikes(
      [
        {
          strike: SPOT,
          ce: {
            ltp: 120, oi: 500, oiChg: 50, volume: 10, iv: 14.2,
            bid: 119.5, ask: 120.5, bidQty: 320, askQty: 180,
            delta: 0.52, gamma: 0.0011, theta: -12.4, vega: 6.02,
          },
          pe: null,
        },
      ],
      SPOT,
      FUTURE,
    );
    expect(row.ce!.deltaSource).toBe("provider");
    expect(row.ce!.ivSource).toBe("provider");
    expect(row.ce!.delta).toBe(0.52);
    expect(row.ce!.bid).toBe(119.5);
    expect(row.ce!.askQty).toBe(180);
  });

  test("no provider greeks → Black-Scholes, labelled 'bs'", () => {
    const [row] = mapEngineStrikes(
      [{ strike: SPOT, ce: { ltp: 120, oi: 500, oiChg: 50, volume: 10, iv: 14.2 }, pe: null }],
      SPOT,
      FUTURE,
    );
    expect(row.ce!.deltaSource).toBe("bs");
    expect(row.ce!.delta).not.toBeNull();
    expect(row.ce!.ivSource).toBe("provider");
  });

  test("an all-zero provider greek set is the 'unknown' sentinel → BS, never 'provider'", () => {
    const [row] = mapEngineStrikes(
      [
        {
          strike: SPOT,
          ce: { ltp: 120, oi: 500, oiChg: 50, volume: 10, iv: 14.2, delta: 0, gamma: 0, theta: 0, vega: 0 },
          pe: null,
        },
      ],
      SPOT,
      FUTURE,
    );
    expect(row.ce!.deltaSource).toBe("bs");
  });
});

// ── The whole path: provider → race → canonical ──────────────────────────

describe("provider → race → canonical — the book path end to end", () => {
  test("an NSE chain keeps its book and reports deltaSource 'provider'", () => {
    const strikes = mapNseOptionChainStrikes([nseRow()]);
    const c = toCanonical(
      {
        data: { strikes, spotPrice: SPOT, expiryDates: [FUTURE], selectedExpiry: FUTURE },
        providerTimestamp: "2026-11-27T10:00:00.000Z",
      },
      "nse-api",
    )!;
    const [row] = mapEngineStrikes(c.strikes as any, SPOT, FUTURE);
    expect(row.ce!.bid).toBe(119.5);
    expect(row.ce!.ask).toBe(120.5);
    expect(row.ce!.bidQty).toBe(320);
    expect(row.ce!.askQty).toBe(180);
    expect(row.ce!.deltaSource).toBe("provider");
    expect(row.ce!.ivSource).toBe("provider");
  });

  test("a Breeze chain keeps its book and reports deltaSource 'bs' (no provider greeks)", () => {
    const mapped = mapBreezeOptionChain(breezeChain())!;
    const c = toCanonical(
      {
        data: {
          strikes: mapped.strikes,
          spotPrice: mapped.spotPrice,
          expiryDates: [FUTURE],
          selectedExpiry: FUTURE,
        },
        providerTimestamp: undefined,
      },
      "icici-breeze",
    )!;
    const [row] = mapEngineStrikes(c.strikes as any, SPOT, FUTURE);
    expect(row.ce!.bid).toBe(119.5);
    expect(row.ce!.askQty).toBe(180);
    expect(row.ce!.deltaSource).toBe("bs");
    expect(row.ce!.ivSource).toBe("provider");
    // the put has no book → null, never 0
    expect(row.pe!.bid ?? null).toBeNull();
    expect(row.pe!.bidQty ?? null).toBeNull();
  });
});
