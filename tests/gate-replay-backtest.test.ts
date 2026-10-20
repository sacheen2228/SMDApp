import { describe, test, expect } from "bun:test";
import {
  deriveGateInput,
  replayGate,
  summarize,
  deriveWeeklyExpiry,
  productionLots,
  sizingFormula,
  type ReplayTrade,
  type ReplayDeps,
} from "@/lib/gate-replay-backtest";
import { GATE_CONFIG, positionSize } from "@/lib/agent-brain-gate";
import type { Candle } from "@/lib/indicators";

// 2026-07-15 is a Wednesday (not expiry day). Thursday 2026-07-16.
const T0 = Date.parse("2026-06-01T09:15:00+05:30");
const IV = 24 * 3600_000;

function mkTrade(over: Partial<ReplayTrade> = {}): ReplayTrade {
  return {
    id: "t1",
    symbol: "NIFTY",
    createdAtIst: "2026-07-15T10:05:00+05:30",
    optionType: "CE",
    strikePrice: 25200, // 1 step OTM (NIFTY step 50) → otmSteps = 1
    spotPrice: 25150,
    // ₹260 premium × 75 qty = ₹19,500 per lot → fits the ₹20,000 per-trade
    // deployment budget (a ₹350 premium would NOT — see the affordability test).
    entryPrice: 260,
    stopLoss: 235,
    tp1: 310,
    signalConfidence: 70,
    trendDirection: "BULLISH",
    expiry: "2026-07-30",
    netPnl: 3000,
    status: "closed",
    exitTime: "2026-07-15T14:00:00+05:30",
    quantity: 75,
    strategyId: "TEST",
    ...over,
  };
}

// Rising daily bars (base +10/day) with engineered structure so the production
// engines see exactly what a breakout day looks like:
//  - SH bumps @23/@28 both at 25600 → equal-highs pool 350 pts above spot (target)
//  - SW @20 + SW @42 → HH/HL → structure trend UP
//  - SH @36 (25180) + SH @41 (25220) → h2 rising; last candle closes 25250 > 25220
//    with prior close below → fresh BOS_UP on bar 0
//  - tight elevated lows @40-43 → lastLow 25180 sits just under the breakout
function dailyBars(n = 45, endMs = Date.parse("2026-07-14T00:00:00+05:30")): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const base = 24700 + i * 10;
    const t = endMs - (n - 1 - i) * IV;
    let o = base, h = base + 60, l = base - 50, c = base + 15;
    if (i === 20) l = base - 80;                          // mid-series swing low
    if (i === 23 || i === 28) h = 25600;                  // equal-highs pair (far target pool)
    if (i === 36) { h = 25180; l = base - 40; c = base + 30; }
    if (i === 37) { o = 25120; h = 25120; l = 25090; c = 25110; }
    if (i === 38) { o = 25100; h = 25140; l = 25070; c = 25120; }
    if (i === 39) { o = 25120; h = 25150; l = 25090; c = 25130; }
    if (i === 40) { o = 25190; h = 25200; l = 25190; c = 25195; }
    if (i === 41) { o = 25200; h = 25220; l = 25195; c = 25210; } // swing high (BOS reference)
    if (i === 42) { o = 25190; h = 25200; l = 25180; c = 25185; } // swing low (lastLow)
    if (i === 43) { o = 25185; h = 25205; l = 25190; c = 25195; }
    if (i === 44) { o = 25190; h = 25260; l = 25185; c = 25250; } // breakout close > 25220
    out.push({ t, o, h, l, c });
  }
  return out;
}

// Two-day OI rows designed for a BULLISH_LEAN (score ≥ 2) on the production
// chain reader: put wall 25000 strengthening (+25% OI, premium down = writing),
// call wall 25400 weakening (−6% OI), fresh put writing (40.5k) outweighs fresh
// call writing (18k), no buying volume, no PCR base.
function chainRows(day: "prev" | "today") {
  const t = day === "today";
  const ceOi: Record<number, number> = {
    24800: 30000, 24900: 30000, 25000: 30000, 25100: 30000,
    25200: t ? 40000 : 32000, 25300: t ? 48000 : 38000, 25400: t ? 85000 : 90000,
  };
  const peOi: Record<number, number> = {
    24800: 50000, 24900: 50000,
    25000: t ? 140000 : 112000, 25100: t ? 62500 : 50000,
    25200: 20000, 25300: 20000, 25400: 20000,
  };
  const rows: any[] = [];
  for (const k of [24800, 24900, 25000, 25100, 25200, 25300, 25400]) {
    rows.push({
      date: "x", symbol: "NIFTY", strike: k, optionType: "CE", expiry: "2026-07-30",
      open: 0, high: 0, low: 0, close: t ? 97 : 100,
      underlying: 25150, lotSize: 75, volume: 1000, oi: ceOi[k],
    });
    rows.push({
      date: "x", symbol: "NIFTY", strike: k, optionType: "PE", expiry: "2026-07-30",
      open: 0, high: 0, low: 0, close: t ? 118 : 120,
      underlying: 25150, lotSize: 75, volume: 1000, oi: peOi[k],
    });
  }
  return rows;
}

function fixtureDeps(over: Partial<ReplayDeps> = {}): ReplayDeps {
  return {
    daily: async () => dailyBars(),
    chainPair: async () => ({ today: chainRows("today"), prev: chainRows("prev") }),
    lotSize: async () => 75,
    ...over,
  };
}

describe("deriveWeeklyExpiry", () => {
  test("nearest Thursday on/after the trade date", () => {
    expect(deriveWeeklyExpiry("2026-07-15")).toBe("2026-07-16");
    expect(deriveWeeklyExpiry("2026-07-16")).toBe("2026-07-16"); // it IS Thursday
    expect(deriveWeeklyExpiry("2026-07-17")).toBe("2026-07-23");
  });
});

describe("deriveGateInput", () => {
  test("maps a complete option trade to full gate inputs", async () => {
    const r = await deriveGateInput(mkTrade(), fixtureDeps());
    expect(r.exclude).toBeUndefined();
    const i = r.input!;
    expect(i.direction).toBe("call");
    expect(i.confidence).toBe(70);
    expect(i.asOfMs).toBe(Date.parse("2026-07-15T10:05:00+05:30"));
    expect(Math.abs(i.delta!)).toBeGreaterThanOrEqual(0.35); // real BS delta from recorded premium
    expect(i.strikeDistanceSteps).toBe(1);
    expect(i.optionRR!).toBeCloseTo(2.0, 1);
    expect(i.underlyingRR!).toBeGreaterThan(0);
    expect(i.isExpiryDay).toBe(false); // Wednesday
    expect(i.lots!).toBeGreaterThanOrEqual(1);
    expect(i.layers.structure.state).toBe("agree");
    expect(i.layers.trigger.state).toBe("agree");
    expect(i.layers.levels.state).toBe("agree");
    expect(i.layers.flow.state).toBe("unknown");
    expect(i.allLive).toBe(true);
    expect(i.stamps.length).toBe(1);
  });

  test("the replay's lot count is production-identical (same positionSize call)", async () => {
    const t = mkTrade();
    const r = await deriveGateInput(t, fixtureDeps());
    const expected = positionSize({
      entry: t.entryPrice, sl: t.stopLoss, lotSize: 75,
      capital: GATE_CONFIG.capital, riskPct: GATE_CONFIG.defaultRiskPct,
    }).lots;
    expect(r.input!.lots).toBe(expected);
    expect(productionLots(t.entryPrice, t.stopLoss, 75)).toBe(expected);
  });

  test("a lot that costs more than the per-trade deployment budget books 0 lots", async () => {
    // ₹350 premium × 75 qty = ₹26,250 > the ₹20,000 per-trade budget.
    const t = mkTrade({ entryPrice: 350, stopLoss: 320, tp1: 420 });
    const r = await deriveGateInput(t, fixtureDeps());
    expect(r.input!.lots).toBe(0);
    const out = await replayGate([t], fixtureDeps());
    expect(out[0].verdict).toBe("SKIP");
    expect(out[0].failedChecks).toContain("risk_budget");
  });

  test("excludes equity/no-strike trades (gate is options-only)", async () => {
    const r = await deriveGateInput(mkTrade({ strikePrice: undefined as any, optionType: undefined as any }), fixtureDeps());
    expect(r.input).toBeUndefined();
    expect(r.exclude).toMatch(/strike|option/i);
  });

  test("excludes when delta inputs are uncomputable (stock without expiry)", async () => {
    const r = await deriveGateInput(mkTrade({ symbol: "BPCL", expiry: undefined as any }), fixtureDeps());
    expect(r.input).toBeUndefined();
    expect(r.exclude).toMatch(/expiry/i);
  });

  test("excludes when no daily candles exist for the symbol", async () => {
    const r = await deriveGateInput(mkTrade(), fixtureDeps({ daily: async () => [] }));
    expect(r.input).toBeUndefined();
    expect(r.exclude).toMatch(/candle/i);
  });
});

describe("replayGate", () => {
  test("verdicts each trade and keeps future trades out of the ledger", async () => {
    const trades = [
      mkTrade({ id: "good", netPnl: 3000 }),
      mkTrade({ id: "weak-conf", signalConfidence: 40, netPnl: -2500, createdAtIst: "2026-07-15T11:00:00+05:30", exitTime: "2026-07-15T13:00:00+05:30" }),
      mkTrade({ id: "equity", strikePrice: undefined as any, optionType: undefined as any, netPnl: -100 }),
    ];
    const out = await replayGate(trades, fixtureDeps());
    expect(out).toHaveLength(3);
    const good = out.find((o) => o.id === "good")!;
    const weak = out.find((o) => o.id === "weak-conf")!;
    const eq = out.find((o) => o.id === "equity")!;
    expect(eq.verdict).toBe("NO_DATA");
    expect(weak.verdict).toBe("WAIT"); // confidence 40 < floor
    expect(weak.failedChecks).toContain("confidence");
    expect(["TRADE", "WAIT", "SKIP"]).toContain(good.verdict);
    expect(good.result?.layersAgree).toBeGreaterThanOrEqual(0);
  });

  test("summarize splits win rate by verdict with coverage + fail histogram + assumptions", async () => {
    const trades = [
      mkTrade({ id: "w1", netPnl: 4000 }),
      mkTrade({ id: "l1", signalConfidence: 40, netPnl: -2000 }),
      mkTrade({ id: "w2", netPnl: 1500, createdAtIst: "2026-07-15T12:00:00+05:30", exitTime: "2026-07-15T14:30:00+05:30" }),
      mkTrade({ id: "eq", strikePrice: undefined as any, optionType: undefined as any, netPnl: -50 }),
    ];
    const out = await replayGate(trades, fixtureDeps());
    const s = summarize(out);
    expect(s.coverage.total).toBe(4);
    expect(s.coverage.replayed + s.coverage.excluded).toBe(4);
    expect(s.coverage.excluded).toBe(1);
    expect(s.assumptions.length).toBeGreaterThan(0);
    expect(s.assumptions.join(" ")).toMatch(/feed/i);
    // the report must state the per-trade formula, not "X% of a ₹2L account"
    expect(s.assumptions.join(" ")).toMatch(/deployed/i);
    expect(s.assumptions.join(" ")).toMatch(/20%/);
    const verdicts = Object.keys(s.byVerdict);
    expect(verdicts.length).toBeGreaterThan(1);
    for (const v of Object.values(s.byVerdict)) {
      expect(v.n).toBeGreaterThan(0);
      expect(v.wr).toBeGreaterThanOrEqual(0);
      expect(v.wr).toBeLessThanOrEqual(1);
    }
    expect(Object.keys(s.failHistogram).length).toBeGreaterThan(0);
    expect(s.failHistogram["confidence"]).toBeGreaterThanOrEqual(1);
    const waiting = s.byVerdict["WAIT"];
    expect(waiting.netPnl).toBe(-2000);
  });
});
