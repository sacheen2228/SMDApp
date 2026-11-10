import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  normalizeCategory,
  type DataCategory,
  type ProviderName,
} from "@/lib/market-data-types";
import {
  validateCanonicalChain,
  compareChains,
  type CanonicalChain,
} from "@/lib/market-data-race";
import { mapBreezeOptionChain } from "@/lib/market-data-providers";
import { mapBreezeOptionChain } from "@/lib/market-data-providers";

const ALL_CATEGORIES: DataCategory[] = [
  "quotes", "option-chain", "candles", "greeks", "oi-pcr", "max-pain", "spot",
  "index-quote", "fii-dii", "news", "vix", "market-status", "bhavcopy", "pre-open", "default",
];

const LIVE_CATEGORIES: DataCategory[] = [
  "quotes", "option-chain", "candles", "greeks", "oi-pcr", "max-pain", "spot", "index-quote",
];

describe("market-data engine — category normalization", () => {
  test("camelCase aliases map to the canonical kebab-case names", () => {
    expect(normalizeCategory("optionChain")).toBe("option-chain");
    expect(normalizeCategory("oiPcr")).toBe("oi-pcr");
    expect(normalizeCategory("maxPain")).toBe("max-pain");
    expect(normalizeCategory("indexQuote")).toBe("index-quote");
  });

  test("canonical names are unchanged", () => {
    for (const c of ALL_CATEGORIES) expect(normalizeCategory(c)).toBe(c);
    expect(normalizeCategory("fii-dii")).toBe("fii-dii");
  });

  test("unknown/empty category falls back to default", () => {
    expect(normalizeCategory("")).toBe("default");
    expect(normalizeCategory(undefined)).toBe("default");
  });
});

describe("market-data engine — config tables", () => {
  test("every category has its own priority list and cache TTL (no silent default fallback)", () => {
    for (const c of ALL_CATEGORIES) {
      expect(DEFAULT_CONFIG.priorities[c]).toBeDefined();
      expect(Array.isArray(DEFAULT_CONFIG.priorities[c])).toBe(true);
      expect(DEFAULT_CONFIG.priorities[c].length).toBeGreaterThan(0);
      expect(DEFAULT_CONFIG.cacheTtl[c]).toBeDefined();
    }
  });

  test("the old camelCase config keys are gone (they never matched the type)", () => {
    const keys = Object.keys(DEFAULT_CONFIG.priorities);
    expect(keys).not.toContain("optionChain");
    expect(keys).not.toContain("oiPcr");
    expect(keys).not.toContain("maxPain");
    expect(keys).not.toContain("indexQuote");
  });

  test("live categories put ICICI Breeze first, then Motilal Oswal", () => {
    for (const c of LIVE_CATEGORIES) {
      const order = DEFAULT_CONFIG.priorities[c];
      expect(order[0]).toBe("icici-breeze");
      expect(order[1]).toBe("motilal-api");
    }
  });

  test("pre-open and bhavcopy use exchange archives only (no broker feed)", () => {
    for (const c of ["pre-open", "bhavcopy"] as DataCategory[]) {
      const order = DEFAULT_CONFIG.priorities[c];
      expect(order).not.toContain("icici-breeze");
      expect(order).not.toContain("motilal-api");
      expect(order[0]).toBe("nse-api");
    }
  });

  test("no Yahoo Finance anywhere in the priorities", () => {
    const all: ProviderName[] = Object.values(DEFAULT_CONFIG.priorities).flat();
    expect(all.some((p) => /yahoo/i.test(p))).toBe(false);
  });
});

const goodChain: CanonicalChain = {
  symbol: "NIFTY",
  exchange: "NSE",
  strikes: [
    { strike: 24500, ce: { ltp: 120, oi: 500, oiChg: 50, volume: 10, iv: 14 }, pe: { ltp: 110, oi: 400, oiChg: -20, volume: 8, iv: 15 } },
    { strike: 24600, ce: { ltp: 90, oi: 300, oiChg: 10, volume: 5, iv: 14 }, pe: { ltp: 140, oi: 600, oiChg: 30, volume: 12, iv: 15 } },
    { strike: 24400, ce: { ltp: 150, oi: 700, oiChg: -10, volume: 4, iv: 14 }, pe: { ltp: 90, oi: 350, oiChg: 5, volume: 6, iv: 15 } },
  ],
  spotPrice: 24500,
  expiry: "2026-11-12",
  providerTimestamp: "2026-11-09T10:00:00.000Z",
  source: "nse-api",
  fetchedAt: "2026-11-09T10:05:00.000Z",
};

describe("market-data engine — canonical chain validation", () => {
  test("accepts a complete chain with both legs", () => {
    expect(validateCanonicalChain(goodChain, { symbol: "NIFTY" })).toEqual(goodChain);
  });

  test("rejects null / empty / insufficient coverage", () => {
    expect(validateCanonicalChain(null, { symbol: "NIFTY" })).toBeNull();
    expect(validateCanonicalChain({ strikes: [], spotPrice: 24500 } as any, { symbol: "NIFTY" })).toBeNull();
    expect(
      validateCanonicalChain({ strikes: [{ strike: 1, ce: null, pe: null }], spotPrice: 24500 } as any, { symbol: "NIFTY" }),
    ).toBeNull();
  });

  test("rejects missing spot price", () => {
    expect(validateCanonicalChain({ ...goodChain, spotPrice: 0 }, { symbol: "NIFTY" })).toBeNull();
  });

  test("rejects a chain with no both-leg strike", () => {
    const onlyCalls = { ...goodChain, strikes: goodChain.strikes.map((s: any) => ({ ...s, pe: null })) };
    expect(validateCanonicalChain(onlyCalls, { symbol: "NIFTY" })).toBeNull();
  });

  test("rejects negative or malformed leg fields", () => {
    const bad = { ...goodChain, strikes: [{ ...goodChain.strikes[0], ce: { ...goodChain.strikes[0].ce, ltp: -5 } }] };
    expect(validateCanonicalChain(bad, { symbol: "NIFTY" })).toBeNull();
  });

  test("rejects expiry mismatch when requested", () => {
    expect(validateCanonicalChain(goodChain, { symbol: "NIFTY", expiry: "2026-11-13" })).toBeNull();
    expect(validateCanonicalChain(goodChain, { symbol: "NIFTY", expiry: "2026-11-12" })).toEqual(goodChain);
  });
});

describe("market-data engine — shadow parity comparison", () => {
  test("identical chains report full parity", () => {
    const p = compareChains(goodChain, { ...goodChain });
    expect(p.sameProvider).toBe(true);
    expect(p.sameStrikeCount).toBe(true);
    expect(p.sameSpot).toBe(true);
    expect(p.sameExpiry).toBe(true);
    expect(p.strikeCountDiff).toBe(0);
    expect(p.perStrikeDiffs.every((d) => d.ceLtpDiff === 0 && d.peLtpDiff === 0)).toBe(true);
  });

  test("different provider / spot / strike count are flagged", () => {
    const other = { ...goodChain, source: "icici-breeze" as const, spotPrice: 24510, strikes: goodChain.strikes.slice(0, 2) };
    const p = compareChains(goodChain, other);
    expect(p.sameProvider).toBe(false);
    expect(p.sameSpot).toBe(false);
    expect(p.strikeCountDiff).toBe(-1);
    expect(p.perStrikeDiffs.length).toBe(3);
  });
});

describe("market-data engine — Breeze option-chain mapping", () => {
  test("flat calls/puts become one row per strike", () => {
    const mapped = mapBreezeOptionChain({
      symbol: "NIFTY",
      expiryDate: "25-Nov-2026",
      spotPrice: 24500,
      timestamp: "2026-11-09T10:00:00.000Z",
      strikes: [24500, 24600],
      calls: [{ strikePrice: 24500, ltp: 120, openInterest: 500, oiChange: 50, volume: 10, iv: 14.2 }],
      puts: [{ strikePrice: 24500, ltp: 110, openInterest: 400, oiChange: -20, volume: 8, iv: 15.1 }],
    });
    expect(mapped).not.toBeNull();
    expect(mapped!.strikes.length).toBe(2);
    expect(mapped!.strikes[0].strike).toBe(24500);
    expect(mapped!.strikes[0].ce?.ltp).toBe(120);
    expect(mapped!.strikes[0].ce?.oi).toBe(500);
    expect(mapped!.strikes[0].pe?.ltp).toBe(110);
    expect(mapped!.strikes[0].pe?.oiChg).toBe(-20);
    expect(mapped!.spotPrice).toBe(24500);
    expect(mapped!.expiry).toBe("25-Nov-2026");
  });

  test("an empty chain maps to null (never a valid empty answer)", () => {
    expect(mapBreezeOptionChain(null)).toBeNull();
    expect(mapBreezeOptionChain({ strikes: [], calls: [], puts: [] })).toBeNull();
  });
});
