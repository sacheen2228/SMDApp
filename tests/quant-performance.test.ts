// tests/quant-performance.test.ts — pure computePerformance math on synthetic
// rows: exact winRate/PF/expectancy, a known equity curve for maxDrawdown,
// grouping, the small-sample caveat, and the n=0 null-safe path. No DB, no
// network, no clock.

import { describe, test, expect } from "bun:test";
import { computePerformance, type QuantPerfRow } from "@/lib/quant/quant-performance";

function row(over: Partial<QuantPerfRow> = {}): QuantPerfRow {
  return {
    status: "CLOSED_TP",
    strategy: "TREND_CONTINUATION",
    regime: "TRENDING_UP",
    mode: "PAPER",
    realizedPnl: 0,
    estCosts: 0,
    entryTime: null,
    exitTime: null,
    stopLoss: null,
    tp1: null,
    tp2: null,
    tp3: null,
    tp4: null,
    tpHitLevel: null,
    lots: null,
    quantity: null,
    entryPrice: null,
    exitPrice: null,
    ...over,
  };
}

const t = (iso: string) => new Date(iso);

describe("computePerformance — core math", () => {
  const rows: QuantPerfRow[] = [
    // +1950 net (2000 − 50), TP1 partial booked, 30 min hold
    row({
      realizedPnl: 2000, estCosts: 50, tpHitLevel: "TP1",
      entryTime: t("2026-10-26T10:00:00+05:30"), exitTime: t("2026-10-26T10:30:00+05:30"),
    }),
    // −1040 net (−1000 − 40), stopped, 45 min hold
    row({
      status: "CLOSED_SL", strategy: "BREAKOUT_RETEST", regime: "BREAKOUT",
      realizedPnl: -1000, estCosts: 40, tpHitLevel: null,
      entryTime: t("2026-10-26T10:45:00+05:30"), exitTime: t("2026-10-26T11:30:00+05:30"),
    }),
    // +500 net, TP2 terminal, SHADOW mode, 60 min hold
    row({
      strategy: "MEAN_REVERSION", regime: "RANGE_BOUND", mode: "SHADOW",
      realizedPnl: 500, estCosts: 0, tpHitLevel: "TP2",
      entryTime: t("2026-10-26T11:00:00+05:30"), exitTime: t("2026-10-26T12:00:00+05:30"),
    }),
  ];

  const perf = computePerformance(rows);

  test("counts, win rate, expectancy", () => {
    expect(perf.n).toBe(3);
    expect(perf.wins).toBe(2);
    expect(perf.losses).toBe(1);
    expect(perf.winRate).toBeCloseTo(66.67, 2);
    expect(perf.netPnl).toBe(1410); // 1950 − 1040 + 500
    expect(perf.expectancy).toBe(470); // 1410 / 3
  });

  test("avg win/loss and profit factor (grossLoss = positive magnitude)", () => {
    expect(perf.avgWin).toBe(1225); // (1950 + 500) / 2
    expect(perf.avgLoss).toBe(-1040);
    expect(perf.profitFactor).toBeCloseTo(2450 / 1040, 3);
  });

  test("max drawdown from the known equity curve (+1950 → +910 → +1410)", () => {
    expect(perf.maxDrawdown).toBe(1040); // peak 1950 → trough 910
  });

  test("holding minutes, stop rate, tp distribution, partial rate", () => {
    expect(perf.avgHoldingMinutes).toBe(45); // (30 + 45 + 60) / 3
    expect(perf.slHitRate).toBeCloseTo(33.33, 2); // one CLOSED_SL
    expect(perf.tpHitRates["TP1"]).toBeCloseTo(33.33, 2);
    expect(perf.tpHitRates["TP2"]).toBeCloseTo(33.33, 2);
    expect(perf.tpHitRates["TP3"]).toBe(0);
    expect(perf.tpHitRates["TP4"]).toBe(0);
    expect(perf.partialExitRate).toBeCloseTo(33.33, 2); // tpHitLevel TP1
  });

  test("grouping by strategy / regime / mode", () => {
    expect(perf.byStrategy["TREND_CONTINUATION"].n).toBe(1);
    expect(perf.byStrategy["TREND_CONTINUATION"].netPnl).toBe(1950);
    expect(perf.byStrategy["BREAKOUT_RETEST"].netPnl).toBe(-1040);
    expect(perf.byStrategy["BREAKOUT_RETEST"].profitFactor).toBeNull(); // loss only → no grossWin to divide
    expect(perf.byStrategy["MEAN_REVERSION"].winRate).toBe(100);
    expect(perf.byRegime["TRENDING_UP"].n).toBe(1);
    expect(perf.byRegime["RANGE_BOUND"].netPnl).toBe(500);
    expect(perf.byMode["PAPER"].n).toBe(2);
    expect(perf.byMode["PAPER"].netPnl).toBe(910);
    expect(perf.byMode["SHADOW"].netPnl).toBe(500);
  });

  test("small-sample caveat fires under n=30", () => {
    expect(perf.sampleSizeCaveat).toBe("Sample size n=3 is small — metrics are not statistically significant");
  });

  test("non-CLOSED rows are ignored", () => {
    const withOpen = computePerformance([...rows, row({ status: "OPEN", realizedPnl: 9999 })]);
    expect(withOpen.n).toBe(3);
    expect(withOpen.netPnl).toBe(1410);
  });
});

describe("computePerformance — no-loss / no-win edges", () => {
  test("all winners → profitFactor 0 per spec (grossLoss ≤ 0, grossWin > 0)", () => {
    const perf = computePerformance([
      row({ realizedPnl: 300, estCosts: 10 }),
      row({ realizedPnl: 700, estCosts: 20 }),
    ]);
    expect(perf.losses).toBe(0);
    expect(perf.profitFactor).toBe(0);
    expect(perf.maxDrawdown).toBe(0); // never under water
    expect(perf.avgLoss).toBeNull();
  });

  test("all losers → profitFactor null (nothing to divide), drawdown = full loss", () => {
    const perf = computePerformance([
      row({ status: "CLOSED_SL", realizedPnl: -500, estCosts: 30, exitTime: t("2026-10-26T11:00:00+05:30") }),
      row({ status: "CLOSED_SL", realizedPnl: -200, estCosts: 20, exitTime: t("2026-10-26T12:00:00+05:30") }),
    ]);
    expect(perf.wins).toBe(0);
    expect(perf.winRate).toBe(0);
    expect(perf.profitFactor).toBeNull();
    expect(perf.maxDrawdown).toBe(750); // monotonic decline: 0 → −530 → −750
    expect(perf.avgLoss).toBe(-375);
  });

  test("estCosts reduce net P&L; null realizedPnl counts as 0", () => {
    const perf = computePerformance([
      row({ realizedPnl: null, estCosts: 40, status: "CLOSED_MANUAL" }),
      row({ realizedPnl: 100, estCosts: null }),
    ]);
    expect(perf.netPnl).toBe(60); // (0 − 40) + (100 − 0)
    expect(perf.wins).toBe(1);
    expect(perf.losses).toBe(1);
  });
});

describe("computePerformance — null safety", () => {
  test("n = 0 → nulls/zeroes, caveat for n=0", () => {
    const perf = computePerformance([]);
    expect(perf.n).toBe(0);
    expect(perf.winRate).toBeNull();
    expect(perf.expectancy).toBeNull();
    expect(perf.profitFactor).toBeNull();
    expect(perf.netPnl).toBe(0);
    expect(perf.maxDrawdown).toBe(0);
    expect(perf.avgHoldingMinutes).toBeNull();
    expect(perf.slHitRate).toBeNull();
    expect(perf.partialExitRate).toBeNull();
    expect(perf.tpHitRates["TP1"]).toBe(0);
    expect(perf.sampleSizeCaveat).toBe("Sample size n=0 is small — metrics are not statistically significant");
    expect(Object.keys(perf.byStrategy)).toHaveLength(0);
  });

  test("rows without exitTime sort last for the drawdown curve (no crash)", () => {
    const perf = computePerformance([
      row({ realizedPnl: 100, exitTime: null }),
      row({ realizedPnl: -300, exitTime: t("2026-10-26T10:00:00+05:30") }),
    ]);
    // ordered: −300 first, then +100 → curve −300 → −200 → drawdown 300
    expect(perf.maxDrawdown).toBe(300);
    expect(perf.netPnl).toBe(-200);
  });

  test("n ≥ 30 → caveat cleared", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row({ realizedPnl: i % 2 === 0 ? 100 : -50 }));
    const perf = computePerformance(rows);
    expect(perf.n).toBe(30);
    expect(perf.sampleSizeCaveat).toBeNull();
  });
});
