/// <reference types="bun-types" />
// FII/DII finality honesty — NSE and MrChartist figures are never labelled
// FINAL or PROVISIONAL because neither source confirms finality.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  fetchFiiDiiData,
  _resetFiiDiiCacheForTests,
  type FiiDiiResult,
} from "@/lib/fii-dii";

const REAL_FETCH = globalThis.fetch;

function mockFetch(handler: (url: string) => Response | null): void {
  globalThis.fetch = (async (input: any) => {
    const url = String(typeof input === "string" ? input : input?.url || "");
    const r = handler(url);
    return r ?? new Response(null, { status: 404 });
  }) as any;
}

const nseRows = [
  { category: "FII", buyValue: "100000", sellValue: "90000", netValue: "10000", date: "27-Nov-2026" },
  { category: "DII", buyValue: "80000", sellValue: "90000", netValue: "-10000", date: "27-Nov-2026" },
];

beforeEach(() => {
  _resetFiiDiiCacheForTests();
  globalThis.fetch = REAL_FETCH;
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  _resetFiiDiiCacheForTests();
});

describe("fetchFiiDiiData finality", () => {
  test("NSE live feed → finality UNVERIFIED (source never confirms it)", async () => {
    mockFetch((url) => {
      if (url.includes("nseindia.in/api/fiidiiTradeReact")) return Response.json(nseRows);
      if (url.includes("nseindia.in/")) return new Response("", { status: 200, headers: { "set-cookie": "ns_cookie=stub" } });
      return null;
    });
    const result: FiiDiiResult = await fetchFiiDiiData();
    expect(result.available).toBe(true);
    expect(result.latest.source).toBe("nse");
    expect(result.latest.finality).toBe("UNVERIFIED");
    expect(result.latest.fiiNet).toBe(10000);
    expect(result.latest.diiNet).toBe(-10000);
  });

  test("MrChartist only (NSE down) → finality UNVERIFIED", async () => {
    mockFetch((url) => {
      if (url.includes("nseindia.in/api/fiidiiTradeReact")) return new Response(null, { status: 503 });
      if (url.includes("nseindia.in/")) return new Response(null, { status: 503 });
      if (url.includes("fii-diidata.mrchartist.com/api/data")) {
        return Response.json({ fii_net: 5000, dii_net: -3000, fii_buy: 60000, fii_sell: 55000, dii_buy: 40000, dii_sell: 43000, date: "27-Nov-2026" });
      }
      return null;
    });
    const result: FiiDiiResult = await fetchFiiDiiData();
    expect(result.available).toBe(true);
    expect(result.latest.source).toBe("mrchartist");
    expect(result.latest.finality).toBe("UNVERIFIED");
    expect(result.latest.fiiNet).toBe(5000);
  });

  test("all providers down → available false, finality UNVERIFIED on the empty snapshot", async () => {
    mockFetch(() => new Response(null, { status: 503 }));
    const result: FiiDiiResult = await fetchFiiDiiData();
    expect(result.available).toBe(false);
    expect(result.latest.finality).toBe("UNVERIFIED");
    expect(result.latest.fiiNet).toBe(0);
  });
});
