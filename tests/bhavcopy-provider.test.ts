import { describe, test, expect, afterEach } from "bun:test";
import { bhavcopyProvider, __setBhavcopyLoaderForTests } from "@/lib/data-layer/providers/bhavcopy";

// Relative dates: a hardcoded expiry rots into the past and the provider
// (correctly) refuses to serve a dead contract — see isExpiryExpired.
const futureExpiry = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const pastDate = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);

const row = (over: any) => ({
  date: pastDate, symbol: "SENSEX", strike: 74000, optionType: "CE", expiry: futureExpiry,
  open: 100, high: 120, low: 90, close: 110, underlying: 73852.9, lotSize: 20, volume: 500, oi: 12000,
  ...over,
});

afterEach(() => __setBhavcopyLoaderForTests(null));

describe("bhavcopy provider — EOD chain fallback", () => {
  test("builds CE/PE legs per strike from the exchange file", async () => {
    __setBhavcopyLoaderForTests(async () => ([
      row({ strike: 74000, optionType: "CE", close: 110, oi: 12000 }),
      row({ strike: 74000, optionType: "PE", close: 95, oi: 8000, underlying: 73852.9 }),
      row({ strike: 74100, optionType: "CE", close: 60, oi: 4000 }),
      row({ strike: 74100, optionType: "PE", close: 140, oi: 9000 }),
    ]) as any);
    const res = await bhavcopyProvider.getOptionChain("SENSEX", futureExpiry);
    expect(res.data).not.toBeNull();
    expect(res.source).toBe("BHAVCOPY");
    expect(res.fallbackUsed).toBe(true);
    expect(res.data!.source).toBe("BHAVCOPY");
    expect(res.data!.spot).toBeCloseTo(73852.9, 2);
    expect(res.data!.expiry).toBe(futureExpiry);
    expect(res.data!.strikes.length).toBe(2);
    const atm = res.data!.strikes.find((s) => s.strike === 74000)!;
    expect(atm.ce?.ltp).toBe(110);
    // bhavcopy OpnIntrst is in UNDERLYING UNITS (12,000 = 600 contracts × lot 20)
    // — the chain's canonical unit is CONTRACTS.
    expect(atm.ce?.oi).toBe(600);
    expect(atm.pe?.ltp).toBe(95);
    // the EOD source must never be mistaken for a live chain
    expect(res.data!.freshness).toBe("STALE");
    expect(res.fallbackReason).toMatch(/EOD bhavcopy/);
  });

  test("walks back to the most recent published file", async () => {
    const asked: string[] = [];
    __setBhavcopyLoaderForTests(async (d: string) => {
      asked.push(d);
      return (d === pastDate ? [row({})] : []) as any;
    });
    const res = await bhavcopyProvider.getOptionChain("SENSEX");
    expect(res.data).not.toBeNull();
    expect(asked.length).toBeGreaterThan(1);
  });

  test("returns NO_DATA when the symbol has no bhavcopy rows", async () => {
    __setBhavcopyLoaderForTests(async () => [] as any);
    const res = await bhavcopyProvider.getOptionChain("NOPE");
    expect(res.data).toBeNull();
    expect(res.source).toBe("NO_DATA");
  });
});
