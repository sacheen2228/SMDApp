/// <reference types="bun-types" />
// Last-live chain memo: a transient provider-race miss while the market is
// open must re-serve the recent LIVE snapshot (≤90s, DELAYED label), never
// EOD bhavcopy, never fabricate. Older than the cap → honest NO_DATA.

import { describe, test, expect, beforeEach, mock } from "bun:test";

mock.module("@/lib/market-session", () => ({
  getCurrentSession: () => ({
    session: "OPEN",
    label: "Market Open",
    description: "",
    isMarketOpen: true,
    isCasActive: true,
    minutesRemaining: 100,
  }),
}));

mock.module("@/lib/market-data-service", () => ({
  fetchMarketData: async () => ({
    available: false,
    data: null,
    provider: "none",
    fallbackReason: "all providers raced and lost",
    freshness: "UNAVAILABLE",
    fallbackUsed: true,
  }),
}));

import {
  getOptionChain,
  __clearLiveChainMemoForTests,
  __primeLiveChainMemoForTests,
} from "@/lib/data-layer/chains/option-chain";

const FAKE_CHAIN: any = {
  underlying: "NIFTY",
  spot: 25700,
  exchange: "NSE",
  strikes: [
    {
      strike: 25700,
      ce: { ltp: 240, oi: 1000, oiChange: 10, volume: 500, bid: 239, ask: 241 },
      pe: { ltp: 230, oi: 1100, oiChange: -20, volume: 400, bid: 229, ask: 231 },
    },
  ],
  expiry: "2026-12-01",
  providerTimestamp: "2026-11-25 13:00:00",
  source: "nse-api",
  fetchedAt: new Date().toISOString(),
  freshness: "LIVE",
};

describe("live-chain memo under market-open race miss", () => {
  beforeEach(() => {
    __clearLiveChainMemoForTests();
  });

  test("empty memo + race miss → honest NO_DATA (never EOD)", async () => {
    const r = await getOptionChain("NIFTY");
    expect(r.data).toBeNull();
    expect(r.source).toBe("NO_DATA");
    expect(r.fallbackReason).toMatch(/market open/);
    expect(r.fallbackReason).toMatch(/EOD bhavcopy not served/);
  });

  test("memo ≤90s old → re-serves the live snapshot as DELAYED, not NO_DATA", async () => {
    __primeLiveChainMemoForTests("NIFTY", FAKE_CHAIN, "NSE", Date.now() - 30_000);
    const r = await getOptionChain("NIFTY");
    expect(r.data).not.toBeNull();
    expect(r.data!.spot).toBe(25700);
    expect(r.data!.strikes).toHaveLength(1);
    expect(r.fallbackUsed).toBe(true);
    expect(r.source).toBe("NSE");
    expect(r.fallbackReason).toMatch(/re-serving last live chain/);
    expect(r.data!.freshness).toBe("DELAYED");
    // Never claims LIVE for a re-serve, never labels it EOD.
    expect(r.fallbackReason).not.toMatch(/bhavcopy|EOD/i);
  });

  test("memo older than 90s → falls through to honest NO_DATA", async () => {
    __primeLiveChainMemoForTests("NIFTY", FAKE_CHAIN, "NSE", Date.now() - 120_000);
    const r = await getOptionChain("NIFTY");
    expect(r.data).toBeNull();
    expect(r.source).toBe("NO_DATA");
    expect(r.fallbackReason).toMatch(/EOD bhavcopy not served/);
  });

  test("memo is per-symbol (SENSEX miss does not serve NIFTY data)", async () => {
    __primeLiveChainMemoForTests("SENSEX", { ...FAKE_CHAIN, underlying: "SENSEX", spot: 82000 }, "BSE");
    const r = await getOptionChain("NIFTY");
    expect(r.data).toBeNull();
    expect(r.source).toBe("NO_DATA");
  });
});
