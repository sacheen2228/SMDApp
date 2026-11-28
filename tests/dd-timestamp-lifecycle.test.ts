/// <reference types="bun-types" />
// Option-chain timestamp lifecycle — provider quote time vs collection time
// vs cache time. The four stamps must stay distinct; collection time must
// never be substituted for the provider's own quote time.
import { describe, test, expect, beforeEach } from "bun:test";
import {
  providerAsOf,
  normalizeOptionChain,
  __clearLiveChainMemoForTests,
  __primeLiveChainMemoForTests,
  type CanonicalOptionChain,
} from "@/lib/data-layer/chains/option-chain";

function nseLeg(over: any = {}) {
  return {
    lastPrice: 120,
    openInterest: 500_000,
    changeinOpenInterest: 120_000,
    totalTradedVolume: 90_000,
    impliedVolatility: 14.5,
    greeks: { delta: 0.5, gamma: 0.001, theta: -12, vega: 6 },
    ...over,
  };
}

function nseRaw(ts: string | null = "2026-11-27T10:00:00Z"): any {
  return {
    records: {
      timestamp: ts,
      underlying: "NIFTY",
      underlyingValue: 25460,
      expiryDates: ["04-Dec-2026"],
      data: [
        {
          strikePrice: 25450,
          expiryDates: "04-Dec-2026",
          CE: nseLeg({ lastPrice: 150 }),
          PE: nseLeg({ lastPrice: 118, openInterest: 600_000, changeinOpenInterest: -40_000 }),
        },
      ],
    },
  };
}

function bseRaw(ts: string | null = "27 Nov 2026 | 10:00"): any {
  return {
    ASON: { DT_TM: ts },
    Table: [
      {
        SYMBOL: "SENSEX",
        EXPIRY_DT: "04-Dec-2026",
        STRIKE_PRICE: 78000,
        OPTION_TYPE: "CE",
        OPEN_INTEREST: 50000,
        CHANGE_IN_OI: 12000,
        TOTAL_TRADED_QUANTITY: 90000,
        IV: 14.5,
        LTP: 150,
      },
    ],
  };
}

describe("providerAsOf — exchange's own quote time", () => {
  test("extracts the NSE records.timestamp", () => {
    expect(providerAsOf(nseRaw("2026-11-27T10:00:00Z"))).toBe("2026-11-27T10:00:00.000Z");
  });

  test("extracts the BSE ASON.DT_TM", () => {
    expect(providerAsOf(bseRaw("27 Nov 2026 | 10:00"))).toBeTruthy();
  });

  test("returns null for an undated payload — never substitutes now", () => {
    expect(providerAsOf({ records: { underlying: "NIFTY", data: [] } })).toBeNull();
    expect(providerAsOf(null)).toBeNull();
    expect(providerAsOf({})).toBeNull();
  });
});

describe("normalizeOptionChain — four timestamp stamps", () => {
  beforeEach(() => __clearLiveChainMemoForTests());

  test("NSE: providerQuoteTime from the exchange, collectedAt distinct, cacheCreatedAt null", () => {
    const r = normalizeOptionChain(nseRaw("2026-11-27T10:00:00Z"));
    expect(r.data).not.toBeNull();
    const d = r.data! as CanonicalOptionChain;
    expect(d.providerQuoteTime).toBe("2026-11-27T10:00:00.000Z");
    expect(d.collectedAt).toBeTruthy();
    expect(new Date(d.collectedAt).getTime()).not.toBe(new Date(d.providerQuoteTime!).getTime());
    expect(d.cacheCreatedAt).toBeNull();
    expect(d.isEod).toBe(false);
  });

  test("NSE undated: providerQuoteTime null, never falls back to collectedAt", () => {
    const r = normalizeOptionChain(nseRaw(null));
    expect(r.data).not.toBeNull();
    const d = r.data! as CanonicalOptionChain;
    expect(d.providerQuoteTime).toBeNull();
    expect(d.collectedAt).toBeTruthy();
    expect(d.cacheCreatedAt).toBeNull();
  });

  test("BSE: providerQuoteTime null (BSE publishes no quote timestamp)", () => {
    const r = normalizeOptionChain(bseRaw());
    expect(r.data).not.toBeNull();
    const d = r.data! as CanonicalOptionChain;
    expect(d.providerQuoteTime).toBeNull();
    expect(d.collectedAt).toBeTruthy();
    expect(d.cacheCreatedAt).toBeNull();
  });
});

describe("liveChainMemo cache — cacheCreatedAt distinct, source timestamps preserved", () => {
  beforeEach(() => __clearLiveChainMemoForTests());

  test("cache entry receives a NEW cacheCreatedAt distinct from providerQuoteTime and collectedAt", () => {
    const r = normalizeOptionChain(nseRaw("2026-11-27T10:00:00Z"));
    expect(r.data).not.toBeNull();
    const d = r.data! as CanonicalOptionChain;
    const pq = d.providerQuoteTime!;
    const ca = d.collectedAt;

    // Simulate what getOptionChain does when memoizing: set cacheCreatedAt
    // (new) while preserving providerQuoteTime and collectedAt.
    const memoData: CanonicalOptionChain = {
      ...d,
      // cacheCreatedAt is stamped later than collectedAt (real gap between
      // collection and memoization).
      cacheCreatedAt: new Date(Date.parse(ca) + 5_000).toISOString(),
    };
    __primeLiveChainMemoForTests("NIFTY", memoData, "NSE", Date.parse(ca));

    // cacheCreatedAt distinct from both source timestamps
    expect(memoData.cacheCreatedAt).toBeTruthy();
    expect(new Date(memoData.cacheCreatedAt!).getTime()).not.toBe(new Date(pq).getTime());
    expect(new Date(memoData.cacheCreatedAt!).getTime()).not.toBe(new Date(ca).getTime());
    // Original source timestamps preserved
    expect(memoData.providerQuoteTime).toBe(pq);
    expect(memoData.collectedAt).toBe(ca);
  });

  test("cache hit retains original providerQuoteTime and collectedAt (not replaced by now)", () => {
    const r = normalizeOptionChain(nseRaw("2026-11-27T10:00:00Z"));
    expect(r.data).not.toBeNull();
    const d = r.data! as CanonicalOptionChain;
    const pq = d.providerQuoteTime!;

    // Prime with an OLD collectedAt to simulate a cached snapshot, plus a
    // cacheCreatedAt at prime time.
    const oldData: CanonicalOptionChain = {
      ...d,
      collectedAt: "2026-11-27T09:00:00.000Z",
      cacheCreatedAt: new Date().toISOString(),
    };
    __primeLiveChainMemoForTests("NIFTY", oldData, "NSE", Date.parse("2026-11-27T09:00:00.000Z"));

    // The memoized entry keeps its original collectedAt and providerQuoteTime;
    // cacheCreatedAt is the prime time.
    expect(oldData.providerQuoteTime).toBe(pq);
    expect(oldData.collectedAt).toBe("2026-11-27T09:00:00.000Z");
    expect(oldData.cacheCreatedAt).toBeTruthy();
    expect(new Date(oldData.cacheCreatedAt!).getTime()).not.toBe(new Date(pq).getTime());
    expect(new Date(oldData.cacheCreatedAt!).getTime()).not.toBe(new Date(oldData.collectedAt).getTime());
  });
});

describe("route-level timestamp separation — providerResponseTime !== fetchedAt", () => {
  test("CanonicalOptionChain exposes providerQuoteTime, collectedAt, cacheCreatedAt as separate fields", () => {
    const r = normalizeOptionChain(nseRaw("2026-11-27T10:00:00Z"));
    expect(r.data).not.toBeNull();
    const d = r.data! as CanonicalOptionChain;
    // All four fields present on the type
    expect("providerQuoteTime" in d).toBe(true);
    expect("collectedAt" in d).toBe(true);
    expect("cacheCreatedAt" in d).toBe(true);
    // providerQuoteTime (exchange stamp) != collectedAt (our collection time)
    expect(d.providerQuoteTime).not.toBe(d.collectedAt);
    // cacheCreatedAt null until memoized
    expect(d.cacheCreatedAt).toBeNull();
  });

  test("BSE never fabricates a providerQuoteTime", () => {
    const r = normalizeOptionChain(bseRaw("27 Nov 2026 | 10:00"));
    expect(r.data).not.toBeNull();
    const d = r.data! as CanonicalOptionChain;
    expect(d.providerQuoteTime).toBeNull();
    expect(d.collectedAt).toBeTruthy();
    expect(d.cacheCreatedAt).toBeNull();
  });
});

