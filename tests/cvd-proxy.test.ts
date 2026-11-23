import { describe, it, expect } from "bun:test";
import * as orderflow from "@/engines/orderflow/orderflow-engine";

const compute: any = (orderflow as any).computeCandleCvdProxy;

const candle = (
  time: number,
  open: number,
  close: number,
  volume: number,
) => ({
  time,
  open,
  high: Math.max(open, close) + 1,
  low: Math.min(open, close) - 1,
  close,
  volume,
});

describe("computeCandleCvdProxy", () => {
  it("accumulates candle-signed volume and reports delta percent", () => {
    expect(typeof compute).toBe("function");

    const res = compute([
      candle(1, 100, 102, 1000),
      candle(2, 102, 101, 500),
      candle(3, 101, 101, 300),
    ]);

    expect(res.available).toBe(true);
    expect(res.mode).toBe("CANDLE_PROXY");
    expect(res.bars).toBe(3);
    expect(res.cumulative).toBe(500);
    expect(res.deltaPercent).toBeCloseTo((500 / 1800) * 100, 6);
    expect(res.estimatedBuyVolume).toBe(1000);
    expect(res.estimatedSellVolume).toBe(500);
    expect(res.totalVolume).toBe(1800);
    expect(res.points.length).toBe(3);
    expect(res.points.map((p: any) => p.cvd)).toEqual([1000, 500, 500]);
    expect(res.points[0].delta).toBe(1000);
    expect(res.points[2].delta).toBe(0);
  });

  it("marks a rising price with falling delta as a bearish divergence", () => {
    const res = compute([
      candle(1, 100, 99, 1000),
      candle(2, 99, 101, 100),
    ]);

    expect(res.priceChangePercent).toBeCloseTo(1, 6);
    expect(res.cvdChange).toBe(-900);
    expect(res.verdict).toBe("BEARISH_DIVERGENCE");
  });

  it("marks aligned price and delta as bullish or bearish", () => {
    const bullish = compute([candle(1, 100, 102, 1000), candle(2, 102, 104, 500)]);
    expect(bullish.verdict).toBe("BULLISH");
    expect(bullish.priceChangePercent).toBeGreaterThan(0);
    expect(bullish.cvdChange).toBeGreaterThan(0);

    const bearish = compute([candle(1, 100, 98, 1000), candle(2, 98, 96, 500)]);
    expect(bearish.verdict).toBe("BEARISH");
    expect(bearish.priceChangePercent).toBeLessThan(0);
    expect(bearish.cvdChange).toBeLessThan(0);
  });

  it("reports unavailable when there are no candles or no volume", () => {
    const empty = compute([]);
    expect(empty.available).toBe(false);
    expect(empty.verdict).toBe("UNAVAILABLE");
    expect(empty.cumulative).toBe(0);
    expect(empty.points).toEqual([]);

    const noVolume = compute([candle(1, 100, 101, 0)]);
    expect(noVolume.available).toBe(false);
    expect(noVolume.verdict).toBe("UNAVAILABLE");
  });

  it("carries the source, contract and mode labels through", () => {
    const res = compute([candle(1, 100, 102, 1000), candle(2, 102, 103, 500)], {
      mode: "FUTURES_CANDLE_SIGN",
      source: "breeze",
      contract: "NIFTY 23-Nov-2026 futures",
    });

    expect(res.mode).toBe("FUTURES_CANDLE_SIGN");
    expect(res.source).toBe("breeze");
    expect(res.contract).toBe("NIFTY 23-Nov-2026 futures");
  });

  it("computes the session OI change and the price/OI build-up", () => {
    const withOi = (time: number, close: number, volume: number, oi: number) => ({
      ...candle(time, close, close + 2, volume),
      oi,
    });

    const rising = compute([
      withOi(1, 100, 1000, 100000),
      withOi(2, 104, 1200, 108000),
    ], { mode: "FUTURES_CANDLE_SIGN" });

    expect(rising.oiFirst).toBe(100000);
    expect(rising.oiLast).toBe(108000);
    expect(rising.oiChange).toBe(8000);
    expect(rising.oiChangePct).toBeCloseTo(8, 6);
    expect(rising.buildup).toBe("LONG_BUILDUP");

    const covering = compute([
      withOi(1, 100, 1000, 100000),
      withOi(2, 104, 1200, 92000),
    ], { mode: "FUTURES_CANDLE_SIGN" });

    expect(covering.oiChange).toBe(-8000);
    expect(covering.buildup).toBe("SHORT_COVERING");

    const unwinding = compute([
      withOi(1, 100, 1000, 100000),
      withOi(2, 96, 1200, 92000),
    ], { mode: "FUTURES_CANDLE_SIGN" });

    expect(unwinding.buildup).toBe("LONG_UNWINDING");

    const shorts = compute([
      withOi(1, 100, 1000, 100000),
      withOi(2, 96, 1200, 108000),
    ], { mode: "FUTURES_CANDLE_SIGN" });

    expect(shorts.buildup).toBe("SHORT_BUILDUP");
  });

  it("leaves the OI read unknown when the feed carries no open interest", () => {
    const res = compute([candle(1, 100, 102, 1000), candle(2, 102, 103, 500)]);
    expect(res.oiFirst).toBeUndefined();
    expect(res.oiLast).toBeUndefined();
    expect(res.oiChange).toBeUndefined();
    expect(res.buildup).toBeNull();
  });
});
