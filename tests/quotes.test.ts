/// <reference types="bun-types" />
// /api/quotes — arbitrary-symbol quotes for the Watchlist tab (indices via
// yahoo-finance-api v8 chart, equities via nse-stock-data yahoo batch).

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sanitizeQuoteSymbols, fetchStockQuotes } from "@/lib/nse-stock-data";
import { isIndexSymbol } from "@/lib/yahoo-finance-api";

describe("sanitizeQuoteSymbols", () => {
  it("uppercases, trims and dedupes", () => {
    expect(sanitizeQuoteSymbols(["reliance ", "RELIANCE", " tcs"])).toEqual(["RELIANCE", "TCS"]);
  });

  it("rejects junk, traversal and over-long codes", () => {
    expect(sanitizeQuoteSymbols(["", "../etc/passwd", "A/B", "X".repeat(25), "  "])).toEqual([]);
    expect(sanitizeQuoteSymbols(["RELIANCE; DROP", "a.b"]).includes("A.B")).toBe(false);
  });

  it("caps at 40 symbols", () => {
    const many = Array.from({ length: 60 }, (_, i) => `STK${i}`);
    expect(sanitizeQuoteSymbols(many)).toHaveLength(40);
  });
});

describe("isIndexSymbol", () => {
  it("recognizes index codes only", () => {
    expect(isIndexSymbol("NIFTY")).toBe(true);
    expect(isIndexSymbol("SENSEX")).toBe(true);
    expect(isIndexSymbol("RELIANCE")).toBe(false);
  });
});

describe("fetchStockQuotes (stubbed Yahoo)", () => {
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    globalThis.fetch = (async (input: any) => {
      const url = String(typeof input === "string" ? input : input?.url || "");
      if (url.includes("fc.yahoo.com")) {
        const res = new Response("", { status: 200 });
        res.headers.set("set-cookie", "A1=stubcookie; Path=/");
        return res;
      }
      if (url.includes("v1/test/getcrumb")) return new Response("stubcrumb", { status: 200 });
      if (url.includes("v7/finance/quote")) {
        return Response.json({
          quoteResponse: {
            result: [{
              symbol: "RELIANCE.NS", shortName: "Reliance Industries",
              regularMarketPrice: 2900, regularMarketPreviousClose: 2880,
              regularMarketChange: 20, regularMarketChangePercent: 0.694,
              regularMarketVolume: 1000000, regularMarketDayHigh: 2910,
              regularMarketDayLow: 2870, fiftyTwoWeekHigh: 3000,
              fiftyTwoWeekLow: 2400, averageDailyVolume3Month: 5000000,
            }],
          },
        });
      }
      if (url.includes("v8/finance/chart")) {
        return Response.json({
          chart: {
            result: [{
              meta: {
                shortName: "NIFTY 50", regularMarketPrice: 22400,
                chartPreviousClose: 22300, regularMarketDayHigh: 22450,
                regularMarketDayLow: 22280, regularMarketVolume: 100000000,
                fiftyTwoWeekHigh: 22900, fiftyTwoWeekLow: 21800,
              },
            }],
            error: null,
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as any;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("returns index (v8 chart) + equity (v7 batch) quotes", async () => {
    const quotes = await fetchStockQuotes(["NIFTY", "RELIANCE", "bogus/../../etc"]);
    expect(quotes.NIFTY.ltp).toBe(22400);
    expect(quotes.NIFTY.changePct).toBeCloseTo(((22400 - 22300) / 22300) * 100, 1);
    expect(quotes.RELIANCE.ltp).toBe(2900);
    expect(quotes.RELIANCE.change).toBe(20);
    expect(Object.keys(quotes).sort()).toEqual(["NIFTY", "RELIANCE"]);
  }, 20000);
});
