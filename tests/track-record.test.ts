/// <reference types="bun-types" />
// TDD for the Track Record panel (TheTradeCartel integration — embed into
// Backtest tab). Tests the cost-summary helper: fee totals, gross-vs-net,
// and honest handling of partial/incomplete trade lists.

import { describe, it, expect } from "bun:test";
import { costSummary } from "@/components/backtest/TrackRecordPanel";

describe("costSummary", () => {
  it("sums fees over closed trades only", () => {
    const s = costSummary([
      { status: "closed", fees: 45.5, netPnl: 100 },
      { status: "closed", fees: 62.25, netPnl: -50 },
      { status: "open", fees: 30, netPnl: null },
    ]);
    expect(s.closedCount).toBe(2);
    expect(s.totalFees).toBeCloseTo(107.75, 2);
    expect(s.netPnl).toBeCloseTo(50, 2);
  });

  it("gross = net + fees (fees are what separates them)", () => {
    const s = costSummary([
      { status: "closed", fees: 40, netPnl: 160 },
      { status: "closed", fees: 40, netPnl: -60 },
    ]);
    expect(s.grossPnl).toBeCloseTo(180, 2); // 100 net + 80 fees
  });

  it("handles an empty list with zeros (no NaN)", () => {
    const s = costSummary([]);
    expect(s.closedCount).toBe(0);
    expect(s.totalFees).toBe(0);
    expect(s.netPnl).toBe(0);
    expect(s.grossPnl).toBe(0);
    expect(s.costDragPct).toBe(0);
  });

  it("costDragPct = fees / |gross| × 100, 0 when gross is 0", () => {
    const s = costSummary([{ status: "closed", fees: 10, netPnl: 90 }]);
    expect(s.costDragPct).toBeCloseTo(10, 2); // 10 / 100 × 100
    const zero = costSummary([{ status: "closed", fees: 10, netPnl: -10 }]);
    expect(zero.costDragPct).toBe(0);
  });

  it("treats missing fees/netPnl as 0, never NaN", () => {
    const s = costSummary([{ status: "closed" }, { status: "closed", fees: undefined, netPnl: undefined }]);
    expect(Number.isNaN(s.totalFees)).toBe(false);
    expect(s.totalFees).toBe(0);
    expect(s.netPnl).toBe(0);
  });

  it("marks completeness when fetched count reaches total", () => {
    const s = costSummary([{ status: "closed", fees: 1, netPnl: 1 }], { fetched: 1, total: 1 });
    expect(s.complete).toBe(true);
    const partial = costSummary([{ status: "closed", fees: 1, netPnl: 1 }], { fetched: 1, total: 5 });
    expect(partial.complete).toBe(false);
  });
});
