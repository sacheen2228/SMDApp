/// <reference types="bun-types" />
// journal-stats — the GET /api/trade-journal stats must only assert win/loss
// on PRICED rows: EXPIRED-with-null-pnl rows used to leak into `losers`
// (null <= 0) and drag avgLoss, and EXPIRED (terminal) was missing from the
// closed set entirely so repaired trades never counted.

import { describe, it, expect } from "bun:test";
import { computeJournalStats, type JournalTradeLike } from "@/lib/journal-stats";

const t = (over: Partial<JournalTradeLike> = {}): JournalTradeLike => ({
  status: "CLOSED",
  pnl: null,
  strategy: "sdm",
  ...over,
});

describe("computeJournalStats — priced rows only for win/loss", () => {
  it("counts winners and losers from priced terminal rows", () => {
    const s = computeJournalStats([
      t({ pnl: 100, strategy: "BTST" }),
      t({ pnl: -50, strategy: "sdm" }),
      t({ status: "SL_HIT", pnl: -20 }),
      t({ status: "EXPIRED", pnl: 40 }),
    ]);
    expect(s.closed).toBe(4);
    expect(s.winners).toBe(2);
    expect(s.losers).toBe(2);
    expect(s.winRate).toBe(50);
    expect(s.totalPnL).toBe(70);
    expect(s.byStrategy).toEqual({ BTST: 100, sdm: -30 });
  });

  it("EXPIRED counts as closed (repaired stale rows belong in stats)", () => {
    const s = computeJournalStats([t({ status: "EXPIRED", pnl: 10 })]);
    expect(s.closed).toBe(1);
    expect(s.winners).toBe(1);
    expect(s.unpriced).toBe(0);
  });

  it("null-pnl terminal rows are reported as unpriced, never as losers", () => {
    const s = computeJournalStats([
      t({ status: "EXPIRED", pnl: null }),
      t({ status: "EXPIRED", pnl: null }),
      t({ pnl: 30 }),
      t({ pnl: -10 }),
    ]);
    expect(s.closed).toBe(4);
    expect(s.priced).toBe(2);
    expect(s.unpriced).toBe(2);
    expect(s.losers).toBe(1); // only the priced -10, NOT the two nulls
    expect(s.winRate).toBe(50);
    expect(s.avgLoss).toBe(-10);
  });

  it("open statuses are not closed", () => {
    const s = computeJournalStats([
      t({ status: "ACTIVE" }),
      t({ status: "OPEN" }),
      t({ status: "TP2_HIT" }),
      t({ pnl: 5 }),
    ]);
    expect(s.open).toBe(3);
    expect(s.closed).toBe(1);
  });

  it("totalPnL sums every row (null -> 0), winRate skips unpriced", () => {
    const s = computeJournalStats([t({ pnl: null }), t({ pnl: 20 })]);
    expect(s.totalPnL).toBe(20);
    expect(s.winRate).toBe(100);
  });

  it("empty input never divides by zero", () => {
    const s = computeJournalStats([]);
    expect(s).toMatchObject({ total: 0, closed: 0, winners: 0, losers: 0, winRate: 0, totalPnL: 0, avgWin: 0, avgLoss: 0 });
  });

  it("byStrategy aggregates priced terminal pnl only", () => {
    const s = computeJournalStats([
      t({ pnl: 100, strategy: "BTST" }),
      t({ pnl: 20, strategy: "BTST" }),
      t({ status: "EXPIRED", pnl: null, strategy: "ZERO_HERO_AI" }),
      t({ status: "ACTIVE", pnl: null, strategy: "sdm" }),
    ]);
    expect(s.byStrategy).toEqual({ BTST: 120 });
  });
});
