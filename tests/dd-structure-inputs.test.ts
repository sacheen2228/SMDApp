/// <reference types="bun-types" />
// DD — WAVE 2: the indicator / structure inputs the card must expose.
//
// The card used to:
//   • run the setup engine on the STILL-FORMING bar (a signal could be created
//     by a candle that had not closed),
//   • label a CLOSE-AVERAGE as "VWAP" (the index-spot candles carry no
//     volume, so the VWAP silently degraded to an average of closes),
//   • expose no RSI / EMA20 / EMA50 / DI± and no structure (BOS/CHoCH) / FVG
//     outside the reversal role.
//
// These tests pin the replacement:
//   • RSI (Wilder), EMA 20/50, ATR, ADX + DI+/DI− are in the read
//   • VWAP comes from the FUTURES volume — or it is null, never a close-average
//   • the signals/structure are computed on CLOSED candles only
//   • the structure read reports HH/HL + BOS/CHoCH and the unfilled FVGs
//
// Educational framework, not financial advice.

import { describe, test, expect } from "bun:test";
import {
  computeMarketRead,
  closedAnalysisCandles,
  buildUnderlyingGeometry,
  ema,
  type Candle,
} from "@/lib/DailyDerivatives";

const DAY = "2026-11-27";

/** A minute-stamped 5-minute series inside one IST session. */
function mkCandles(
  n: number,
  opts: { volume?: number; start?: number; step?: number; closeAt?: (i: number) => number } = {},
): Candle[] {
  const volume = opts.volume ?? 0;
  const start = opts.start ?? 100;
  const step = opts.step ?? 1;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const mins = 9 * 60 + 15 + i * 5;
    const hh = String(Math.floor(mins / 60)).padStart(2, "0");
    const mm = String(mins % 60).padStart(2, "0");
    const base = opts.closeAt ? opts.closeAt(i) : start + i * step;
    out.push({
      time: new Date(`${DAY}T${hh}:${mm}:00+05:30`).toISOString(),
      open: base,
      high: base + 3,
      low: base - 3,
      close: base,
      volume,
    });
  }
  return out;
}

describe("DD wave 2 — the indicator bundle", () => {
  test("RSI, EMA20/50, ATR, ADX and DI± are all present", () => {
    const read = computeMarketRead({ candles: mkCandles(80) });
    const i = read.indicators;
    expect(i.rsi14).not.toBeNull();
    expect(Number.isFinite(i.rsi14!)).toBe(true);
    expect(i.ema9).not.toBeNull();
    expect(i.ema15).not.toBeNull();
    expect(i.ema20).not.toBeNull();
    expect(i.ema50).not.toBeNull();
    expect(i.atr14).not.toBeNull();
    expect(i.adx14).not.toBeNull();
    expect(i.plusDI).not.toBeNull();
    expect(i.minusDI).not.toBeNull();
    // the EMAs are ordered like the price they describe
    expect(i.ema9!).toBeGreaterThan(i.ema20!);
    expect(i.ema20!).toBeGreaterThan(i.ema50!);
  });

  test("a short series reports nulls — never a fabricated number", () => {
    const read = computeMarketRead({ candles: mkCandles(8) });
    expect(read.indicators.rsi14).toBeNull();
    expect(read.indicators.ema50).toBeNull();
    expect(read.indicators.adx14).toBeNull();
    expect(read.indicators.vwap).toBeNull();
  });

  test("the read states that it works on CLOSED candles", () => {
    const read = computeMarketRead({ candles: mkCandles(40) });
    expect(read.indicators.signalBasis).toMatch(/closed/i);
    expect(typeof read.indicators.closedBars).toBe("number");
  });
});

describe("DD wave 2 — VWAP must come from real futures volume", () => {
  test("no volume anywhere → VWAP is null, never a close-average", () => {
    const read = computeMarketRead({ candles: mkCandles(30) });
    expect(read.indicators.vwap).toBeNull();
    expect(read.indicators.vwapSource).toBeNull();
  });

  test("the futures volume produces a volume-weighted VWAP", () => {
    const spot = mkCandles(30, { volume: 0 });
    // Two bars with very different volume and price: the volume-weighted
    // average and the close-average are far apart.
    const futures: Candle[] = [
      {
        time: new Date(`${DAY}T09:15:00+05:30`).toISOString(),
        open: 100, high: 100, low: 100, close: 100, volume: 10,
      },
      {
        time: new Date(`${DAY}T09:20:00+05:30`).toISOString(),
        open: 200, high: 200, low: 200, close: 200, volume: 990,
      },
    ];
    const read = computeMarketRead({ candles: spot, futuresCandles: futures });
    expect(read.indicators.vwap).not.toBeNull();
    expect(read.indicators.vwapSource).toBe("futures");
    // typical price = (h + l + c) / 3
    const expected = (100 * 10 + 200 * 990) / 1000;
    expect(read.indicators.vwap!).toBeCloseTo(expected, 6);
    // and definitely NOT the close-average (150)
    expect(read.indicators.vwap!).not.toBeCloseTo(150, 1);
  });

  test("the index-spot candles are never used as the VWAP source", () => {
    const spotWithVolume = mkCandles(30, { volume: 5000 });
    const read = computeMarketRead({ candles: spotWithVolume });
    // The source is labelled — the card can never claim a spot VWAP.
    expect(read.indicators.vwapSource).toBeNull();
    expect(read.indicators.vwapNote ?? "").toMatch(/futures/i);
  });
});

describe("DD wave 2 — the forming bar must not create a signal", () => {
  test("the still-forming bar is dropped from the analysis", () => {
    const closed = mkCandles(40);
    const forming: Candle = {
      ...closed[closed.length - 1],
      time: new Date(`${DAY}T12:35:00+05:30`).toISOString(),
      open: 139,
      high: 400,
      low: 139,
      close: 399,
    };
    // 12:36 IST — the 5-minute bar that opened at 12:35 has not closed yet.
    const nowMs = new Date(`${DAY}T12:36:00+05:30`).getTime();
    const { candles: kept, excluded } = closedAnalysisCandles(
      [...closed, forming],
      nowMs,
    );
    expect(excluded).toBe(1);
    expect(kept.length).toBe(closed.length);

    const read = computeMarketRead({ candles: [...closed, forming], nowMs });
    expect(read.formingExcluded).toBe(true);
    expect(read.indicators.closedBars).toBe(closed.length);
    // the EMA is computed WITHOUT the forming bar's close
    const withForming = ema(
      [...closed, forming].map((c) => c.close),
      9,
    );
    expect(read.indicators.ema9!).not.toBeCloseTo(withForming[withForming.length - 1], 3);
  });

  test("a closed bar is kept (nothing is dropped when the feed is complete)", () => {
    const candles = mkCandles(40);
    const nowMs = new Date(`${DAY}T20:00:00+05:30`).getTime();
    const { candles: kept, excluded } = closedAnalysisCandles(candles, nowMs);
    expect(excluded).toBe(0);
    expect(kept.length).toBe(candles.length);
  });
});

describe("DD wave 2 — the structure read (HH/HL, BOS/CHoCH, FVG)", () => {
  // A rising ZIGZAG — a monotonic line has no swing pivots at all, so the
  // structure read would honestly find nothing to read.
  const zigzag = (i: number) => 25000 + i * 10 + 60 * Math.sin((2 * Math.PI * i) / 8);

  test("a rising series reads HH/HL and reports the swing levels", () => {
    const read = computeMarketRead({ candles: mkCandles(60, { closeAt: zigzag }) });
    const s = read.structure;
    expect(s).not.toBeNull();
    expect(s!.trend).toBe("UP");
    expect(s!.higherHigh).toBe(true);
    expect(s!.higherLow).toBe(true);
    expect(s!.lastHigh).not.toBeNull();
    expect(s!.lastLow).not.toBeNull();
    expect(s!.fvg).toBeDefined();
  });

  test("the structure is read on CLOSED candles", () => {
    const read = computeMarketRead({ candles: mkCandles(60, { closeAt: zigzag }) });
    expect(read.structure!.bars).toBe(read.indicators.closedBars);
  });
});

describe("DD wave 2 — the underlying geometry the card is priced from", () => {
  test("a call's stop is the swing low below spot and the path runs upward", () => {
    const g = buildUnderlyingGeometry({
      optionType: "CE",
      spot: 25000,
      atr: 100,
      structure: { lastHigh: 25400, lastLow: 24800 },
      pools: [
        { price: 25600, kind: "pool", side: "above" },
        { price: 24700, kind: "pool", side: "below" },
      ],
      fvgs: [{ dir: "BULLISH", lo: 25100, hi: 25200 }],
      wall: 25700,
    });
    expect(g.stop).toBe(24800);
    expect(g.trigger).toBeGreaterThan(25000);
    expect(g.path.length).toBeGreaterThan(0);
    expect(g.path.every((p) => p.price > 25000)).toBe(true);
  });

  test("a put's stop is the swing high above spot and the path runs downward", () => {
    const g = buildUnderlyingGeometry({
      optionType: "PE",
      spot: 25000,
      atr: 100,
      structure: { lastHigh: 25400, lastLow: 24800 },
      pools: [{ price: 24700, kind: "pool", side: "below" }],
      fvgs: [{ dir: "BEARISH", lo: 24900, hi: 24950 }],
      wall: 24600,
    });
    expect(g.stop).toBe(25400);
    expect(g.trigger).toBeLessThan(25000);
    expect(g.path.length).toBeGreaterThan(0);
    expect(g.path.every((p) => p.price < 25000)).toBe(true);
  });

  test("no swing on the trade side → no stop (an honest gap, never a guess)", () => {
    const g = buildUnderlyingGeometry({
      optionType: "CE",
      spot: 25000,
      atr: 100,
      structure: { lastHigh: 25400, lastLow: null },
      pools: [],
      fvgs: [],
      wall: null,
    });
    expect(g.stop).toBeNull();
    expect(g.notes.join(" ")).toMatch(/swing|structure/i);
  });
});
