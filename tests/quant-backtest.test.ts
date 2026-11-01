// tests/quant-backtest.test.ts — offline harness tests for the Phase C
// quant backtest. No DB, no network, no clock: candles are injected and the
// replay is fully deterministic.
//
// The engineered 300-candle series (ramp → decline → flat) makes
// TREND_CONTINUATION fire ≥ 2 times with one TP1 exit and one SL exit.
// Amplitude is sized for the production reward ladder (TP1 1:2, TP2 1:3,
// TP3 1:5): the ramp must out-run a 2R target and the decline must reach the
// stop, so both exits stay reachable.

import { describe, test, expect } from "bun:test";
import type { Candle } from "@/lib/market/canonical";
import type { CanonicalOptionChain } from "@/lib/data-layer/chains/option-chain";
import type { OptionLeg, OptionStrike } from "@/lib/data-layer/types";
import {
  loadCandlesForBacktest,
  runQuantBacktest,
  type QuantBacktestTrade,
} from "@/lib/quant/quant-backtest";

// ── fixtures ─────────────────────────────────────────────────────────

/** 300 candles: pure ramp (0..119), pure decline (120..179), flat tail. */
function engineeredSeries(): Candle[] {
  const N = 300;
  const t0 = Date.parse("2026-10-26T09:15:00+05:30");
  const out: Candle[] = [];
  let close = 20000;
  for (let i = 0; i < N; i++) {
    let step: number;
    if (i < 120) step = 100;
    else if (i < 180) step = -100;
    else step = i % 2 === 0 ? 1 : -1;
    const open = close;
    close = close + step;
    out.push({
      timestamp: new Date(t0 + i * 5 * 60_000).toISOString(),
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 5000,
    });
  }
  return out;
}

function leg(over: Partial<OptionLeg> = {}): OptionLeg {
  return {
    ltp: 150, volume: 5000, oi: 2000, oiChange: 100, iv: 14,
    bid: 149.5, ask: 150.5, delta: 0.52, gamma: 0.001, theta: -8, rho: null,
    ...over,
  };
}

function chainFixture(): CanonicalOptionChain {
  const spot = 22600;
  const strikes: OptionStrike[] = [];
  for (let strike = spot - 200; strike <= spot + 200; strike += 50) {
    strikes.push({ strike, ce: leg(), pe: leg({ delta: -0.48, theta: -8 }) });
  }
  return {
    underlying: "NIFTY",
    spot,
    expiry: "02-Nov-2026",
    strikes,
    timestamp: new Date(Date.parse("2026-10-26T13:30:00+05:30")).toISOString(),
    asOf: new Date(Date.parse("2026-10-26T13:29:55+05:30")).toISOString(),
    source: "NSE",
    fallbackUsed: false,
    freshness: "LIVE",
  };
}

const closed = (t: QuantBacktestTrade) => t.status.startsWith("CLOSED");

// ── the replay ───────────────────────────────────────────────────────

describe("runQuantBacktest — engineered series (underlying-sim)", () => {
  const r = runQuantBacktest({
    symbol: "NIFTY",
    candles: engineeredSeries(),
    options: { startIdx: 45, capital: 100000 },
  });

  test("underlying-sim instrument, full series consumed", () => {
    expect(r.instrument).toBe("UNDERLYING_SIM");
    expect(r.totalCandles).toBe(300);
    expect(r.startIdx).toBe(45);
    expect(r.capital).toBe(100000);
  });

  test("TREND_CONTINUATION triggers ≥ 2 times, in both directions (BUY_CE and mirrored BUY_PE)", () => {
    const trend = r.decisions.filter((d) => d.winner === "TREND_CONTINUATION" && d.verdict === "TRADE");
    expect(trend.length).toBeGreaterThanOrEqual(2);
    expect(trend.some((d) => d.direction === "BUY_CE")).toBe(true);
    expect(trend.some((d) => d.direction === "BUY_PE")).toBe(true);
    for (const d of trend) {
      expect(d.entry).toBeGreaterThan(0);
      expect(d.stopLoss!).toBeLessThan(d.entry!); // premium-space plan geometry
      expect(d.tp1!).toBeGreaterThan(d.entry!);
    }
  });

  test("one TP1 exit and one SL exit occur; statuses are engine statuses", () => {
    const tps = r.trades.filter((t) => t.status === "CLOSED_TP");
    const sls = r.trades.filter((t) => t.status === "CLOSED_SL");
    expect(tps.length).toBeGreaterThanOrEqual(1);
    expect(sls.length).toBeGreaterThanOrEqual(1);
    expect(tps.some((t) => t.tpHitLevel === "TP1" && t.events.includes("TP1_HIT"))).toBe(true);
  });

  test("no overlapping trades (one open position at a time)", () => {
    expect(r.trades.length).toBeGreaterThanOrEqual(3);
    for (let k = 1; k < r.trades.length; k++) {
      const prev = r.trades[k - 1];
      const cur = r.trades[k];
      expect(cur.idx).toBeGreaterThan(prev.exitIdx ?? prev.idx);
    }
  });

  test("gap-through SL fills at the conservative worst price (min(ltp, stop))", () => {
    const sl = r.trades.find((t) => t.status === "CLOSED_SL")!;
    expect(sl).toBeTruthy();
    expect(sl.exitReason).toBe("GAP_THROUGH_SL");
    expect(sl.exitPrice!).toBeLessThanOrEqual(sl.stopLoss); // never better than the stop
    expect(sl.grossPnl).toBeLessThan(0);
  });

  test("costs applied on every closed trade; net = gross − costs; realizedPnl carries gross", () => {
    for (const t of r.trades.filter(closed)) {
      expect(t.estCosts).toBeGreaterThan(0);
      expect(t.netPnl).toBeCloseTo(t.grossPnl - t.estCosts, 2);
      expect(t.realizedPnl).toBeCloseTo(t.grossPnl, 2);
    }
  });

  test("data-quality skips are recorded as rejected candidates with reasons", () => {
    expect(r.rejected.length).toBeGreaterThanOrEqual(1);
    const insufficient = r.rejected.filter((x) => x.stage === "insufficient_data");
    expect(insufficient.length).toBeGreaterThanOrEqual(1);
    for (const x of insufficient) expect(x.reason).toContain("candles");
  });

  test("performance fed through computePerformance: sane numbers, n = closed rows", () => {
    const closedTrades = r.trades.filter(closed);
    expect(r.performance.n).toBe(closedTrades.length);
    expect(r.performance.n).toBeGreaterThanOrEqual(3);
    expect(r.performance.winRate).toBeGreaterThanOrEqual(0);
    expect(r.performance.winRate).toBeLessThanOrEqual(100);
    expect(r.performance.wins).toBeGreaterThanOrEqual(1); // at least one TP1
    expect(r.performance.losses).toBeGreaterThanOrEqual(1); // at least one SL
    const sumNet = closedTrades.reduce((a, t) => a + t.netPnl, 0);
    expect(r.performance.netPnl).toBeCloseTo(sumNet, 1);
    expect(r.performance.profitFactor).toBeGreaterThan(0);
    expect(r.performance.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(r.performance.sampleSizeCaveat).toContain("not statistically significant"); // n < 30
  });

  test("a trade still open at series end is OPEN_SIM and excluded from performance", () => {
    expect(r.openAtEnd).toBeGreaterThanOrEqual(1);
    const openTrade = r.trades.find((t) => t.status === "OPEN_SIM");
    expect(openTrade).toBeTruthy();
    expect(openTrade!.exitPrice).toBeNull();
    expect(openTrade!.grossPnl).toBe(0);
  });

  test("honest notes: underlying-sim limitation + mirrored-PE approximation recorded", () => {
    expect(r.notes.join("\n")).toContain("underlying-sim mode: option premium dynamics approximated on the underlying");
    expect(r.notes.join("\n")).toContain("mirrored series");
    expect(r.notes.join("\n")).toContain("candles[0..i] only"); // no-look-ahead guarantee
  });

  test("BUY_PE trade plans stay in premium space (tp above entry, stop below)", () => {
    const pe = r.trades.find((t) => t.direction === "BUY_PE");
    expect(pe).toBeTruthy();
    expect(pe!.tp1!).toBeGreaterThan(pe!.entryPrice);
    expect(pe!.stopLoss).toBeLessThan(pe!.entryPrice);
  });
});

// ── chronology: a decision at i never used candle j > i ──────────────

describe("runQuantBacktest — no look-ahead", () => {
  test("mutating a future candle leaves every decision and entry up to i identical", () => {
    const original = runQuantBacktest({
      symbol: "NIFTY",
      candles: engineeredSeries(),
      options: { startIdx: 45, capital: 100000 },
    });

    const mutated = engineeredSeries();
    const K = 200; // a candle in the flat tail, after every asserted decision
    mutated[K] = {
      ...mutated[K],
      close: mutated[K].close + 2000,
      high: mutated[K].high + 2000,
    };
    const rerun = runQuantBacktest({
      symbol: "NIFTY",
      candles: mutated,
      options: { startIdx: 45, capital: 100000 },
    });

    // decisions strictly before the mutation are byte-identical
    expect(JSON.stringify(rerun.decisions.filter((d) => d.idx < K)))
      .toBe(JSON.stringify(original.decisions.filter((d) => d.idx < K)));

    // every trade ENTERED before the mutation has an identical entry
    const entryFields = (t: QuantBacktestTrade) => JSON.stringify([
      t.tradeId, t.idx, t.entryTs, t.entryPrice, t.stopLoss, t.tp1, t.tp2,
      t.tp3, t.tp4, t.lots, t.quantity, t.strategy, t.direction, t.instrument,
    ]);
    const origEntered = original.trades.filter((t) => t.idx < K).map(entryFields);
    const reEntered = rerun.trades.filter((t) => t.idx < K).map(entryFields);
    expect(reEntered).toEqual(origEntered);

    // trades fully CLOSED before the mutation are identical end to end
    const full = (t: QuantBacktestTrade) => JSON.stringify(t);
    const origClosedEarly = original.trades.filter((t) => t.exitIdx != null && t.exitIdx < K).map(full);
    const reClosedEarly = rerun.trades.filter((t) => t.exitIdx != null && t.exitIdx < K).map(full);
    expect(reClosedEarly).toEqual(origClosedEarly);
    expect(origClosedEarly.length).toBeGreaterThanOrEqual(3);
  });
});

// ── injectable candle source loader ──────────────────────────────────

describe("loadCandlesForBacktest — injectable source (the harness never fetches)", () => {
  test("validates, drops bad rows and sorts chronologically", async () => {
    const t0 = Date.parse("2026-10-26T09:15:00+05:30");
    const mk = (i: number, close: number) => ({
      timestamp: new Date(t0 + i * 60_000).toISOString(),
      open: close - 1, high: close + 1, low: close - 2, close, volume: 100,
    });
    const { candles, dropped, sourceError } = await loadCandlesForBacktest(
      async () => [mk(2, 103), mk(0, 101), { timestamp: "not-a-date", open: 1, high: 1, low: 1, close: Number.NaN, volume: 0 }, mk(1, 102)],
      "NIFTY",
      "5m",
      "2026-10-26",
      "2026-10-27",
    );
    expect(sourceError).toBeNull();
    expect(dropped).toBe(1);
    expect(candles.map((c) => c.close)).toEqual([101, 102, 103]); // sorted
  });

  test("a throwing source is reported, never thrown", async () => {
    const r = await loadCandlesForBacktest(
      async () => {
        throw new Error("provider down");
      },
      "NIFTY", "5m", "2026-10-26", "2026-10-27",
    );
    expect(r.candles).toEqual([]);
    expect(r.sourceError).toBe("provider down");
  });
});

// ── chain mode ───────────────────────────────────────────────────────

describe("runQuantBacktest — chain mode", () => {
  test("missing chain at a step → rejected chain_unavailable, zero trades", () => {
    const r = runQuantBacktest({
      symbol: "NIFTY",
      candles: engineeredSeries(),
      options: { startIdx: 60, capital: 100000, mode: "CHAIN" },
      chainProvider: () => null,
    });
    expect(r.instrument).toBe("CHAIN");
    expect(r.trades).toHaveLength(0);
    expect(r.rejected.some((x) => x.stage === "chain_unavailable")).toBe(true);
  });

  test("a valid injected chain → real strike-selector contract on the trade", () => {
    const r = runQuantBacktest({
      symbol: "NIFTY",
      candles: engineeredSeries(),
      options: { startIdx: 60, capital: 100000, mode: "CHAIN" },
      chainProvider: () => chainFixture(),
    });
    expect(r.instrument).toBe("CHAIN");
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
    const t = r.trades[0];
    expect(t.instrument).toBe("CHAIN");
    expect(t.tradingsymbol).toContain("NIFTY"); // built by buildTradingsymbol
    expect(t.lotSize).toBe(65); // NIFTY lot from the fail-closed symbol master
    expect(t.strike).toBe(22600); // ATM of the injected chain
    expect(t.entryPrice).toBeGreaterThan(0);
    expect(closed(t)).toBe(true);
  });
});

// ── capital guard ────────────────────────────────────────────────────

describe("runQuantBacktest — capital never assumed", () => {
  test("no capital → every candidate risk-blocked, zero trades, note recorded", () => {
    const r = runQuantBacktest({
      symbol: "NIFTY",
      candles: engineeredSeries(),
      options: { startIdx: 60, capital: null },
    });
    expect(r.trades).toHaveLength(0);
    expect(r.capital).toBeNull();
    expect(r.rejected.length).toBeGreaterThanOrEqual(1);
    expect(r.rejected.every((x) => x.stage === "risk_blocked" || x.stage === "insufficient_data")).toBe(true);
    expect(r.rejected.some((x) => x.stage === "risk_blocked" && x.reason.includes("capital"))).toBe(true);
    expect(r.notes.join("\n")).toContain("capital is never assumed");
  });
});
