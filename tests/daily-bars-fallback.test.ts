/// <reference types="bun-types" />
// TDD for the daily-bars Breeze fallback.
//
// getDailyBars() read ONLY NSE's GetQuoteApi. When NSE rate-limits that
// endpoint (403 flapping, observed 2026-11-06) every daily-bar consumer dies:
// weekly-scanner answers 503 "no daily bars", and the EMA/VWAP breadth cards
// degrade. Breeze getHistoricalDatav2(interval:'1day', productType:'cash')
// is a real, session-authenticated second source — but it needs ICICI's OWN
// scrip codes (RELIANCE → RELIND) and datetime-shaped rows.
//
// Contract locked here:
//   - NSE hits → Breeze is never called (no wasted auth round-trip).
//   - NSE empty / throws → Breeze called with cash daily + resolved code.
//   - Breeze rows normalize to the same DailyBar semantics as NSE rows
//     (sessionDate "05-Nov-2026", t = parseSessionDate(sessionDate), no vwap
//     field → dailyTechnicals falls back to the local VWAP).
//   - both empty → [] (never fabricated bars).

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

// mock.module() is process-global across test files in one `bun test` run:
// capture the real modules first, spread them into every mock (so other test
// files still find getNSEOptionChain, parseNseScripMaster, …), and restore
// the originals in afterAll so later files see the real modules again.
const realNse = await import("@/lib/nse-api");
const realAuth = await import("@/lib/icici-breeze/auth");
const realScrip = await import("@/lib/icici-scrip-master");

const nseState = { rows: [] as any[], error: null as Error | null };
const breezeState = {
  calls: [] as any[],
  result: { Success: [] as any[] } as { Success: any[] },
};

mock.module("@/lib/nse-api", () => ({
  ...realNse,
  getNSEHistoricalData: async () => {
    if (nseState.error) throw nseState.error;
    return nseState.rows;
  },
}));

mock.module("@/lib/icici-breeze/auth", () => ({
  ...realAuth,
  initSession: async () => true,
  getBreezeClient: () => ({
    getHistoricalDatav2: async (req: any) => {
      breezeState.calls.push(req);
      return breezeState.result;
    },
  }),
}));

mock.module("@/lib/icici-scrip-master", () => ({
  ...realScrip,
  resolveBreezeStockCode: async (symbol: string) =>
    symbol === "RELIANCE" ? "RELIND" : symbol,
}));

afterAll(async () => {
  mock.module("@/lib/nse-api", () => realNse);
  mock.module("@/lib/icici-breeze/auth", () => realAuth);
  mock.module("@/lib/icici-scrip-master", () => realScrip);
});

const { getDailyBars, dailyTechnicals, parseSessionDate } = await import(
  "@/lib/daily-bars"
);

function nseRow(date: string, close: number): any {
  return {
    mtimestamp: date,
    chOpeningPrice: close - 10,
    chTradeHighPrice: close + 5,
    chTradeLowPrice: close - 15,
    chClosingPrice: close,
    chTotTradedQty: 1_000_000,
    vwap: close - 1,
  };
}

function breezeRow(date: string, close: number): any {
  return {
    datetime: `${date} 00:00:00`,
    open: close - 10,
    high: close + 5,
    low: close - 15,
    close,
    volume: 1_000_000,
  };
}

beforeEach(() => {
  nseState.rows = [];
  nseState.error = null;
  breezeState.calls = [];
  breezeState.result = { Success: [] };
});

describe("getDailyBars source fallback", () => {
  test("NSE hit → Breeze is never called", async () => {
    nseState.rows = [nseRow("05-Nov-2026", 24800)];
    const bars = await getDailyBars("INFY");

    expect(bars).toHaveLength(1);
    expect(bars[0].c).toBe(24800);
    expect(bars[0].sessionDate).toBe("05-Nov-2026");
    expect(breezeState.calls).toHaveLength(0);
  });

  test("NSE empty → Breeze daily cash with the resolved ICICI code", async () => {
    nseState.rows = [];
    breezeState.result = {
      Success: [breezeRow("2026-11-05", 24800), breezeRow("2026-11-06", 24900)],
    };

    const bars = await getDailyBars("RELIANCE");

    expect(breezeState.calls).toHaveLength(1);
    const req = breezeState.calls[0];
    expect(req.interval).toBe("1day");
    expect(req.productType).toBe("cash");
    expect(req.stockCode).toBe("RELIND");
    expect(req.exchangeCode).toBe("NSE");
    expect(req.fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(req.toDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect(bars).toHaveLength(2);
    expect(bars.map((b) => b.c)).toEqual([24800, 24900]);
    // Same session semantics as an NSE bar: t from the dd-Mon-yyyy session.
    expect(bars[1].sessionDate).toBe("06-Nov-2026");
    expect(bars[1].t).toBe(parseSessionDate("06-Nov-2026")!);
    // Breeze ships no per-session vwap → stays undefined (local fallback).
    expect(bars[1].vwap).toBeUndefined();
    // Sorted ascending regardless of provider order.
    expect(bars[0].t).toBeLessThan(bars[1].t);
  });

  test("NSE throws → Breeze still attempted (no early bail)", async () => {
    nseState.error = new Error("GetQuoteApi 403");
    breezeState.result = { Success: [breezeRow("2026-11-06", 4500)] };

    const bars = await getDailyBars("WIPRO");

    expect(breezeState.calls).toHaveLength(1);
    expect(bars).toHaveLength(1);
    expect(bars[0].c).toBe(4500);
  });

  test("Breeze rows without a usable close are dropped, not invented", async () => {
    nseState.rows = [];
    breezeState.result = {
      Success: [{ datetime: "2026-11-06 00:00:00" }, breezeRow("2026-11-05", 1200)],
    };

    const bars = await getDailyBars("ODINEA");

    expect(bars).toHaveLength(1);
    expect(bars[0].c).toBe(1200);
  });

  test("both sources empty → [] (never fabricated bars)", async () => {
    nseState.rows = [];
    breezeState.result = { Success: [] };

    const bars = await getDailyBars("TCS");

    expect(bars).toEqual([]);
    expect(breezeState.calls).toHaveLength(1);
  });

  test("breeze-sourced bars still drive dailyTechnicals (local VWAP fallback)", async () => {
    nseState.rows = [];
    breezeState.result = {
      Success: Array.from({ length: 25 }, (_, i) =>
        breezeRow(`2026-10-${String(i + 1).padStart(2, "0")}`, 100 + i)
      ),
    };

    const bars = await getDailyBars("MAHABANK");
    const tech = dailyTechnicals("MAHABANK", bars);

    expect(tech.bars).toBe(25);
    expect(tech.ema20).not.toBeNull();
    expect(tech.vwap).not.toBeNull();
    expect(tech.lastBarAt).not.toBeNull();
  });
});
