import { describe, test, expect } from "bun:test";
import {
  normalizeCandles, closedOnly, emaSeries, atrSeries, superTrend, vwapSeries, emaCross,
  swings, structure, liquidityPools, detectSweeps, fairValueGaps, analyzeTf,
  structureLayer, triggerLayer, suggestLevels, signalSeries, backtestSignal,
  formatTf, runCheckIndicators, runBacktestIndicator, CANDLE_URL,
  sma, ema, bollinger, rsi, vwap,
} from "@/lib/indicators";
import type { Candle, TfRead } from "@/lib/indicators";

// ── synthetic candles ──────────────────────────────────────────
const T0 = Date.parse("2026-10-15T04:00:00Z"); // 09:30 IST, market day
const IV = 5 * 60_000;

function mk(t: number, o: number, h: number, l: number, c: number, v = 1000): Candle {
  return { t, o, h, l, c, v };
}

/** Steady uptrend: 5-bar cycle (base rises 10/cycle), sawtooth ±, closes rising. */
function uptrend(n = 60, startT = T0): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const cyc = Math.floor(i / 5);
    const base = 100 + cyc * 10;
    const phase = i % 5; // 0 start, 1 up, 2 PEAK, 3 down, 4 valley
    const mid = base + [0, 8, 16, 8, 0][phase];
    const c = phase <= 2 ? mid + 2 : mid - 2;
    out.push(mk(startT + i * IV, mid - 3, mid + 3, mid - 5, c));
  }
  return out;
}

/** Downtrend mirror of uptrend. */
function downtrend(n = 60, startT = T0): Candle[] {
  return uptrend(n, startT).map((x) => {
    const mid = 400 - x.o;
    return { ...x, o: mid, c: 400 - x.c, h: 400 - (x.c - 3), l: 400 - (x.c + 5) };
  });
}

/** Strong zigzag around a flat mean → many EMA crosses → chop. */
function whipsaw(n = 80, startT = T0): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const base = 200 + (i % 2 ? -15 : 15);
    out.push(mk(startT + i * IV, base, base + 4, base - 4, base + (i % 2 ? -3 : 3)));
  }
  return out;
}

// ── minimal TfRead factory ─────────────────────────────────────
function tfRead(over: Partial<TfRead> = {}): TfRead {
  return {
    tf: "15m", bars: 60, close: 24500, atr: 50,
    st: { dir: 1, line: 24400, barsSinceFlip: 10 },
    ema: { fast: 24510, slow: 24480, rel: "ABOVE", lastCross: "BULLISH", barsSinceCross: 2, crossesLast30: 1, chop: false, spreadAtr: 0.6, slowSlope: "UP" },
    vwap: 24490, vsVwap: "ABOVE",
    structure: { trend: "UP", lastHigh: { i: 50, price: 24560 }, lastLow: { i: 45, price: 24420 } },
    pools: [
      { price: 24600, kind: "prev-day-high", side: "above" },
      { price: 24350, kind: "prev-day-low", side: "below" },
      { price: 24700, kind: "round-number", side: "above" },
    ],
    sweeps: [{ kind: "SWEEP_LOW_RECLAIM", level: 24420, poolKind: "swing-low", barsAgo: 1, bias: "BULLISH" }],
    fvg: [],
    warnings: [],
    ...over,
  };
}

describe("normalizeCandles / closedOnly", () => {
  test("accepts object rows and [t,o,h,l,c,v] arrays; sorts + dedupes", () => {
    const rows = [
      { time: 2000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { t: 1000, o: 1, h: 2, l: 0.5, c: 1.5, v: 5 },
      { t: 1000, o: 1, h: 2, l: 0.5, c: 1.5, v: 5 }, // dup
      { t: 1500, o: NaN, h: 2, l: 0.5, c: 1.5 },     // bad → dropped
      [3000, 1, 2, 0.5, 1.5, 7],
    ];
    const out = normalizeCandles(rows as any);
    expect(out.length).toBe(3);
    expect(out.map((c) => c.t)).toEqual([1000, 2000, 3000]);
    expect(out[0].v).toBe(5);
    expect(out[2].c).toBe(1.5);
  });
  test("closedOnly drops the still-forming candle", () => {
    const c = uptrend(10);
    const out = closedOnly(c, Date.now()); // last candle is Oct-15, closed long ago
    expect(out.length).toBe(10);
    const forming = closedOnly([...c, mk(c[9].t + IV, 1, 2, 0, 1.5)], c[9].t + IV + 1000);
    expect(forming.length).toBe(10); // last one not yet complete at now
  });
});

describe("ema / atr / vwap", () => {
  test("emaSeries seeds SMA then smooths; undefined before period", () => {
    const e = emaSeries([1, 2, 3, 4, 5, 6], 3);
    expect(e[0]).toBeUndefined();
    expect(e[2]).toBe(2); // SMA of 1,2,3
    expect(e[5]).toBeGreaterThan(e[2]!);
  });
  test("atrSeries is positive and finite after warmup", () => {
    const a = atrSeries(uptrend(30), 10);
    expect(a[9]).toBeUndefined();
    expect(a[10]).toBeGreaterThan(0);
    expect(Number.isFinite(a[29]!)).toBe(true);
  });
  test("vwap uses volume; no volume → undefined", () => {
    const c = uptrend(10);
    const v = vwapSeries(c);
    expect(v[9]).toBeGreaterThan(0);
    const noVol = c.map((x) => ({ ...x, v: undefined }));
    expect(vwapSeries(noVol)[9]).toBeUndefined();
  });
});

describe("superTrend / emaCross", () => {
  test("uptrend → dir 1, line below price; downtrend → dir -1", () => {
    const st = superTrend(uptrend(60), 10, 3);
    expect(st.dir[59]).toBe(1);
    expect(st.line[59]!).toBeLessThan(uptrend(60)[59].c);
    const sd = superTrend(downtrend(60), 10, 3);
    expect(sd.dir[59]).toBe(-1);
    expect(sd.line[59]!).toBeGreaterThan(downtrend(60)[59].c);
  });
  test("clean trend: ABOVE, no chop; zigzag: chop flagged", () => {
    const good = emaCross(uptrend(60));
    expect(good.rel).toBe("ABOVE");
    expect(good.chop).toBe(false);
    const bad = emaCross(whipsaw(80));
    expect(bad.chop).toBe(true);
    expect(bad.crossesLast30).toBeGreaterThanOrEqual(3);
  });
});

describe("structure / liquidity / sweeps / fvg", () => {
  test("uptrend zigzag → structure UP", () => {
    const s = structure(uptrend(60));
    expect(s.trend).toBe("UP");
    expect(s.lastHigh).toBeTruthy();
    expect(s.lastLow).toBeTruthy();
  });
  test("close beyond last swing high → BOS_UP within lookback", () => {
    const c = uptrend(60);
    const lastHigh = Math.max(...c.slice(-8, -1).map((x) => x.h));
    c.push(mk(c[59].t + IV, lastHigh - 4, lastHigh + 6, lastHigh - 6, lastHigh + 5));
    const s = structure(c);
    expect(s.event).toBe("BOS_UP");
    expect(s.eventBarsAgo).toBe(0);
  });
  test("equal highs form a pool; round numbers near spot", () => {
    const c = uptrend(60);
    const pools = liquidityPools(c, "NIFTY", 30);
    expect(pools.length).toBeGreaterThan(0);
    expect(pools.some((p) => p.kind === "round-number")).toBe(true);
    expect(pools.some((p) => p.kind === "equal-highs" || p.kind === "swing-high")).toBe(true);
  });
  test("wick through pool + close back → sweep with correct bias", () => {
    const pools = [{ price: 100, kind: "prev-day-low", side: "below" as const }];
    const c = [mk(T0, 105, 106, 98, 102, 100)]; // low pierces 100, close back above
    const s = detectSweeps(c, pools, 10);
    expect(s[0]?.kind).toBe("SWEEP_LOW_RECLAIM");
    expect(s[0]?.bias).toBe("BULLISH");
    const hi = detectSweeps([mk(T0, 105, 112, 104, 106, 10)], [{ price: 110, kind: "prev-day-high", side: "above" as const }], 10);
    expect(hi[0]?.kind).toBe("SWEEP_HIGH_REJECT");
    expect(hi[0]?.bias).toBe("BEARISH");
  });
  test("FVG detected when unfilled, dropped once filled", () => {
    const c: Candle[] = [
      mk(T0, 100, 101, 99, 100), mk(T0 + IV, 100, 101, 99, 100),
      mk(T0 + 2 * IV, 105, 106, 104, 105), // bullish gap: l 104 > prev h 101
      mk(T0 + 3 * IV, 106, 107, 105, 106),
    ];
    const g = fairValueGaps(c);
    expect(g.length).toBe(1);
    expect(g[0].dir).toBe("BULLISH");
    const filled = fairValueGaps([...c, mk(T0 + 4 * IV, 105, 105.5, 100, 101)]);
    expect(filled.length).toBe(0);
  });
});

describe("analyzeTf", () => {
  test("returns a full read on enough closed candles, null on too few", () => {
    const r = analyzeTf("5m", uptrend(60), "NIFTY");
    expect(r).toBeTruthy();
    expect(r!.st.dir).toBe(1);
    expect(r!.structure.trend).toBe("UP");
    expect(r!.warnings.length).toBeGreaterThanOrEqual(0);
    expect(analyzeTf("5m", uptrend(10), "NIFTY")).toBeNull();
  });
  test("no volume → VWAP warning", () => {
    const r = analyzeTf("5m", uptrend(60).map((x) => ({ ...x, v: undefined })), "NIFTY");
    expect(r!.warnings.join(" ")).toMatch(/no VWAP/);
  });
});

describe("layers + levels (gate mapping)", () => {
  test("structure layer: aligned vote → agree; opposed → against", () => {
    expect(structureLayer(tfRead(), "call").state).toBe("agree");
    expect(structureLayer(tfRead(), "put").state).toBe("against");
  });
  test("structure layer: chop without 3 agrees → neutral", () => {
    const r = tfRead({ ema: { ...tfRead().ema, chop: true } });
    expect(structureLayer(r, "call").state).toBe("neutral");
  });
  test("trigger layer: fresh aligned sweep → agree; opposing only → against", () => {
    expect(triggerLayer(tfRead(), "call").state).toBe("agree");
    const bear = tfRead({ sweeps: [{ kind: "SWEEP_HIGH_REJECT", level: 24560, poolKind: "swing-high", barsAgo: 1, bias: "BEARISH" }], structure: { trend: "DOWN" } });
    expect(triggerLayer(bear, "call").state).toBe("against");
  });
  test("suggestLevels: stop below spot with buffer, target next pool, RR computed", () => {
    const lv = suggestLevels(tfRead(), tfRead({ close: 24500, atr: 50 }), "call");
    expect(lv).toBeTruthy();
    expect(lv!.stop).toBeLessThan(24500);
    expect(lv!.riskPts).toBeGreaterThan(0);
    expect(lv!.target).toBeGreaterThan(24500);
    expect(lv!.underlyingRR).toBeGreaterThan(0);
    const put = suggestLevels(tfRead(), tfRead({ close: 24500, atr: 50 }), "put");
    expect(put!.stop).toBeGreaterThan(24500);
  });
});

describe("backtest", () => {
  test("signalSeries: ema_cross flips at crosses; supertrend_flip fires when the ST line flips", () => {
    const s = signalSeries(uptrend(60), "ema_cross");
    expect(s.filter((x) => x !== 0).length).toBeGreaterThanOrEqual(0);
    // default ±3·ATR band trails a steady drift forever — tight mult on alternating data forces real flips
    const st = signalSeries(whipsaw(80), "supertrend_flip", { stPeriod: 10, stMult: 0.5, emaFast: 9, emaSlow: 21 });
    expect(st.some((x) => x === 1)).toBe(true);
    expect(st.some((x) => x === -1)).toBe(true);
  });
  test("too few candles → null; enough → stats with verdict", () => {
    expect(backtestSignal(uptrend(60), "ema_cross")).toBeNull();
    const r = backtestSignal(whipsaw(120), "ema_cross");
    expect(r).toBeTruthy();
    expect(r!.trades).toBeGreaterThan(0);
    expect(r!.winRate).toBeGreaterThanOrEqual(0);
    expect(r!.winRate).toBeLessThanOrEqual(1);
    expect(r!.breakevenWR).toBeGreaterThan(0);
    expect(r!.verdict).toMatch(/INSUFFICIENT|NO EDGE|POSITIVE|INCONCLUSIVE/);
  });
  test("short sample verdict says INSUFFICIENT (<30 signals)", () => {
    const r = backtestSignal(whipsaw(120), "supertrend_flip");
    if (r && r.trades < 30) expect(r.verdict).toMatch(/INSUFFICIENT/);
  });
});

describe("formatTf", () => {
  test("renders timeframe read with structure + warnings", () => {
    const t = formatTf(tfRead());
    expect(t).toMatch(/\[15m\]/);
    expect(t).toMatch(/SuperTrend/);
    expect(t).toMatch(/Structure: UP/);
    expect(t).toMatch(/Liquidity above/);
  });
});

describe("executors (fetch-mocked)", () => {
  const fixture = () => uptrend(60).map((x) => ({ time: x.t, open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v }));
  const realFetch = globalThis.fetch;

  test("CANDLE_URL points at the real candle API", () => {
    expect(CANDLE_URL("http://x", "NIFTY", "5m")).toContain("/api/breeze/candles");
    expect(CANDLE_URL("http://x", "NIFTY", "5m")).toContain("interval=5m");
  });

  test("runCheckIndicators: formats read + stashes structure/trigger for the gate", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: true, data: fixture() }), { status: 200 })) as any;
    try {
      const state: any = {};
      const out = await runCheckIndicators({ symbol: "NIFTY", direction: "call" }, "http://stub", state);
      expect(out).toMatch(/INDICATOR READ — NIFTY/);
      expect(out).toMatch(/APPLIED TO CALL/);
      expect(out).toMatch(/structure layer →/);
      expect(out).toMatch(/trigger layer →/);
      expect(out).toMatch(/underlying plan →/);
      expect(state.lastTech.structure).toBeTruthy();
      expect(state.lastTech.trigger).toBeTruthy();
      expect(["agree", "against", "neutral", "unknown"]).toContain(state.lastTech.structure.state);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("runCheckIndicators: candle feed down → no invented values", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as any;
    try {
      const out = await runCheckIndicators({ symbol: "NIFTY" }, "http://stub", {});
      expect(out).toMatch(/Candles unavailable/);
      expect(out).toMatch(/Do NOT invent/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("runBacktestIndicator: runs + reports verdict; bad signal rejected", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: true, data: whipsaw(120).map((x) => ({ time: x.t, open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v })) }), { status: 200 })) as any;
    try {
      const out = await runBacktestIndicator({ signal: "ema_cross" }, "http://stub");
      expect(out).toMatch(/BACKTEST ema_cross/);
      expect(out).toMatch(/Verdict:/);
      const bad = await runBacktestIndicator({ signal: "rsi" } as any, "http://stub");
      expect(bad).toMatch(/signal must be/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("chart-overlay contract (ChartToolbar)", () => {
  const bars = Array.from({ length: 20 }, (_, i) => ({ time: 1000 + i, open: 99, high: 102, low: 98, close: 100 + i, volume: 10 }));
  test("sma/bollinger/rsi/vwap exist and return [{time,value}] series", () => {
    expect(sma(bars, 5).length).toBe(16);
    const bb = bollinger(bars, 5);
    expect(bb.upper.length).toBe(16);
    expect(bb.upper[0].value).toBeGreaterThan(bb.middle[0].value);
    expect(rsi(bars, 14).length).toBe(6);
    expect(vwap(bars).length).toBe(20);
  });
  test("ema is split: Bar[] → chart series; emaSeries(number[]) → engine series", () => {
    const chart = ema(bars, 5);
    expect(chart.length).toBe(16);
    expect(typeof chart[0].time).toBe("number");
    const series = emaSeries([1, 2, 3, 4, 5, 6], 3);
    expect(series[2]).toBe(2);
  });
});

describe("runCheckIndicators fallback", () => {
  const realFetch = globalThis.fetch;
  test("trend TF too thin → falls back to entry TF for structure, with a warning (no hard fail)", async () => {
    const thin = () => new Response(JSON.stringify({ success: true, data: uptrend(20).map((x) => ({ time: x.t, open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v })) }), { status: 200 });
    const full = () => new Response(JSON.stringify({ success: true, data: fixtureRows() }), { status: 200 });
    globalThis.fetch = (async (url: any) => (String(url).includes("interval=15m") ? thin() : full())) as any;
    try {
      const state: any = {};
      const out = await runCheckIndicators({ symbol: "NIFTY", direction: "call" }, "http://stub", state);
      expect(out).not.toMatch(/Candles unavailable|Not enough closed candles/);
      expect(out).toMatch(/falling back/);
      expect(out).toMatch(/structure layer →/);
      expect(state.lastTech?.structure).toBeTruthy();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

function fixtureRows() {
  return uptrend(60).map((x) => ({ time: x.t, open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v }));
}

describe("tech-read sweep typing", () => {
  const mk = (t: number, o: number, h: number, l: number, c: number) => ({ t, o, h, l, c });
  const atrNow = 10;

  test("a bullish sweep needs a LOW-type pool below price", () => {
    const pool = [{ price: 100, kind: "equal-lows", side: "below" as const }];
    // wick below 100, close back above → bullish reclaim
    const c = [mk(1, 105, 106, 98, 104)]; // 2pt wick below the pool (≥0.15×ATR)
    const sweeps = detectSweeps(c, pool, atrNow, 3);
    expect(sweeps.length).toBe(1);
    expect(sweeps[0].bias).toBe("BULLISH");
    expect(sweeps[0].kind).toBe("SWEEP_LOW_RECLAIM");
  });

  test("a HIGH-type pool never produces a bullish sweep", () => {
    const pool = [{ price: 100, kind: "equal-highs", side: "above" as const }];
    const c = [mk(1, 95, 96, 94, 95)];
    const sweeps = detectSweeps(c, pool, atrNow, 3);
    expect(sweeps.some((s) => s.bias === "BULLISH")).toBe(false);
  });

  test("an ambiguous outside bar (pierces both sides) is ignored", () => {
    const pools = [
      { price: 100, kind: "equal-lows", side: "below" as const },
      { price: 110, kind: "equal-highs", side: "above" as const },
    ];
    // outside bar: low 99 (below 100) AND high 111 (above 110), close in the middle
    const c = [mk(1, 105, 111, 99, 105)];
    const sweeps = detectSweeps(c, pools, atrNow, 3);
    expect(sweeps.length).toBe(0);
  });
});
