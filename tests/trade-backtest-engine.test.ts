/// <reference types="bun-types" />
// fetchAllClosedTrades — paging + test-strategy exclusion for the real
// trade backtest. The sidecar caps pageSize at 500, so "all trades" must
// walk pages; e2e-test/prod-verify junk must never enter a backtest.
// Injected fetchPage → no network.

import { describe, it, expect } from "bun:test";
import { fetchAllClosedTrades } from "@/lib/trade-backtest-engine";
import type { TradeRecord, TradesPage } from "@/lib/trade-audit-client";

function makeTrade(id: string, strategyId: string, page?: number): TradeRecord {
  return {
    id,
    strategyId,
    symbol: "NIFTY",
    status: "closed",
    createdAtIst: "2026-07-15T10:00:00+05:30",
    entryTime: "2026-07-15T10:00:00+05:30",
    exitTime: "2026-07-15T15:00:00+05:30",
    entryPrice: 100,
    netPnl: 10,
    ...(page ? { page } : {}),
  } as unknown as TradeRecord;
}

function pager(pages: Record<number, TradeRecord[]>, total: number) {
  const calls: number[] = [];
  const fetchPage = async (page: number, pageSize: number): Promise<TradesPage> => {
    calls.push(page);
    const items = pages[page] || [];
    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  };
  return { fetchPage, calls };
}

describe("fetchAllClosedTrades — paging", () => {
  it("returns one page without extra calls when under pageSize", async () => {
    const trades = [makeTrade("t1", "BTST"), makeTrade("t2", "BTST")];
    const { fetchPage, calls } = pager({ 1: trades }, 2);
    const out = await fetchAllClosedTrades(fetchPage, { maxTrades: 100 });
    expect(out.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(calls).toEqual([1]);
  });

  it("walks pages until maxTrades is collected", async () => {
    const p1 = Array.from({ length: 5 }, (_, i) => makeTrade(`p1-${i}`, "BTST"));
    const p2 = Array.from({ length: 5 }, (_, i) => makeTrade(`p2-${i}`, "BTST"));
    const p3 = Array.from({ length: 5 }, (_, i) => makeTrade(`p3-${i}`, "BTST"));
    const { fetchPage, calls } = pager({ 1: p1, 2: p2, 3: p3 }, 15);
    const out = await fetchAllClosedTrades(fetchPage, { maxTrades: 12, pageSize: 5 });
    expect(out.length).toBe(12);
    expect(out[11].id).toBe("p3-1");
    expect(calls).toEqual([1, 2, 3]);
  });

  it("stops at totalPages even if maxTrades not reached", async () => {
    const { fetchPage, calls } = pager({ 1: [makeTrade("only", "BTST")] }, 1);
    const out = await fetchAllClosedTrades(fetchPage, { maxTrades: 500 });
    expect(out.length).toBe(1);
    expect(calls).toEqual([1]);
  });

  it("stops when a page comes back empty (defensive)", async () => {
    const { fetchPage, calls } = pager({ 1: [] }, 100);
    const out = await fetchAllClosedTrades(fetchPage, { maxTrades: 100 });
    expect(out.length).toBe(0);
    expect(calls).toEqual([1]);
  });

  it("caps collected trades at maxTrades across pages", async () => {
    const p1 = Array.from({ length: 4 }, (_, i) => makeTrade(`a${i}`, "SMC"));
    const p2 = Array.from({ length: 4 }, (_, i) => makeTrade(`b${i}`, "SMC"));
    const { fetchPage } = pager({ 1: p1, 2: p2 }, 8);
    const out = await fetchAllClosedTrades(fetchPage, { maxTrades: 6, pageSize: 4 });
    expect(out.length).toBe(6);
    expect(out[5].id).toBe("b1");
  });
});

describe("fetchAllClosedTrades — test-strategy exclusion", () => {
  it("drops e2e-test and prod-verify by default", async () => {
    const p1 = [
      makeTrade("real1", "BTST"),
      makeTrade("junk1", "e2e-test"),
      makeTrade("junk2", "prod-verify"),
      makeTrade("real2", "ZERO_HERO_AI"),
    ];
    const { fetchPage } = pager({ 1: p1 }, 4);
    const out = await fetchAllClosedTrades(fetchPage, { maxTrades: 100 });
    expect(out.map((t) => t.strategyId)).toEqual(["BTST", "ZERO_HERO_AI"]);
  });

  it("exclusion does not consume the maxTrades budget", async () => {
    const junk = Array.from({ length: 5 }, (_, i) => makeTrade(`j${i}`, "e2e-test"));
    const real = [makeTrade("r1", "BTST"), makeTrade("r2", "BTST")];
    const { fetchPage, calls } = pager({ 1: junk, 2: real }, 7);
    const out = await fetchAllClosedTrades(fetchPage, { maxTrades: 2, pageSize: 5 });
    expect(out.map((t) => t.id)).toEqual(["r1", "r2"]);
    expect(calls).toEqual([1, 2]);
  });

  it("includeTestStrategies keeps junk when explicitly requested", async () => {
    const p1 = [makeTrade("junk1", "e2e-test"), makeTrade("real1", "BTST")];
    const { fetchPage } = pager({ 1: p1 }, 2);
    const out = await fetchAllClosedTrades(fetchPage, { maxTrades: 10, includeTestStrategies: true });
    expect(out.length).toBe(2);
  });

  it("custom excludeStrategies replaces the default list", async () => {
    const p1 = [makeTrade("junk1", "e2e-test"), makeTrade("real1", "BTST")];
    const { fetchPage } = pager({ 1: p1 }, 2);
    const out = await fetchAllClosedTrades(fetchPage, { maxTrades: 10, excludeStrategies: ["BTST"] });
    expect(out.map((t) => t.strategyId)).toEqual(["e2e-test"]);
  });
});
