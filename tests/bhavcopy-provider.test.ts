import { describe, test, expect, afterEach } from "bun:test";
import { bhavcopyProvider, __setBhavcopyLoaderForTests } from "@/lib/data-layer/providers/bhavcopy";

const row = (over: any) => ({
  date: "2026-10-19", symbol: "SENSEX", strike: 74000, optionType: "CE", expiry: "2026-10-22",
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
    const res = await bhavcopyProvider.getOptionChain("SENSEX", "2026-10-22");
    expect(res.data).not.toBeNull();
    expect(res.source).toBe("BHAVCOPY");
    expect(res.fallbackUsed).toBe(true);
    expect(res.data!.source).toBe("BHAVCOPY");
    expect(res.data!.spot).toBeCloseTo(73852.9, 2);
    expect(res.data!.expiry).toBe("2026-10-22");
    expect(res.data!.strikes.length).toBe(2);
    const atm = res.data!.strikes.find((s) => s.strike === 74000)!;
    expect(atm.ce?.ltp).toBe(110);
    expect(atm.ce?.oi).toBe(12000);
    expect(atm.pe?.ltp).toBe(95);
    // the EOD source must never be mistaken for a live chain
    expect(res.data!.freshness).toBe("STALE");
    expect(res.fallbackReason).toMatch(/EOD bhavcopy/);
  });

  test("walks back to the most recent published file", async () => {
    const asked: string[] = [];
    __setBhavcopyLoaderForTests(async (d: string) => {
      asked.push(d);
      return (d === "2026-10-17" ? [row({})] : []) as any;
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
