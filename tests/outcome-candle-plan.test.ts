import { describe, test, expect } from "bun:test";
import {
  outcomeCandlePlan,
  parseBarTimeMs,
  toCandleBars,
  aggregateBars,
  sessionAnchorMs,
} from "@/lib/premarket-lab/outcome-attach";

// outcome-attach must read real candles WITHOUT importing the live candle
// chain (tests/candle-chain.test.ts import scan). These cover the pure pieces
// of that reader: the interval plan, time parsing (naive strings are IST),
// row → CandleBar mapping, and 1m/5m → bucket aggregation with no look-ahead.
describe("outcome candle plan", () => {
  test("accepts the intraday buckets Breeze/recorder can actually serve", () => {
    expect(outcomeCandlePlan(5)).toEqual({ bucketMin: 5 });
    expect(outcomeCandlePlan(15)).toEqual({ bucketMin: 15 });
    expect(outcomeCandlePlan(30)).toEqual({ bucketMin: 30 });
    expect(outcomeCandlePlan(1)).toEqual({ bucketMin: 1 });
  });

  test("defaults to 5m and refuses anything above 30m (never substitutes a timeframe)", () => {
    expect(outcomeCandlePlan(undefined)).toEqual({ bucketMin: 5 });
    expect(outcomeCandlePlan(0)).toEqual({ bucketMin: 5 });
    expect(outcomeCandlePlan(60)).toBeNull();
    expect(outcomeCandlePlan(1440)).toBeNull();
  });
});

describe("parseBarTimeMs", () => {
  test("ISO with Z is absolute; a naive timestamp is read as IST", () => {
    // 03:45Z == 09:15 IST
    expect(parseBarTimeMs("2026-11-09T03:45:00.000Z")).toBe(Date.UTC(2026, 10, 9, 3, 45));
    expect(parseBarTimeMs("2026-11-09 09:15:00")).toBe(Date.UTC(2026, 10, 9, 3, 45));
    expect(parseBarTimeMs("2026-11-09T09:15:00+05:30")).toBe(Date.UTC(2026, 10, 9, 3, 45));
  });

  test("epoch seconds are scaled to ms; junk is rejected", () => {
    expect(parseBarTimeMs(1794203340)).toBe(1794203340 * 1000);
    expect(parseBarTimeMs(1794203340000)).toBe(1794203340000);
    expect(parseBarTimeMs("not-a-date")).toBeNull();
    expect(parseBarTimeMs(null)).toBeNull();
    expect(parseBarTimeMs("")).toBeNull();
  });
});

describe("sessionAnchorMs", () => {
  test("is 09:15 IST of the trade date, independent of the host timezone", () => {
    expect(sessionAnchorMs("2026-11-09")).toBe(Date.UTC(2026, 10, 9, 3, 45));
    expect(Number.isFinite(sessionAnchorMs("2026-11-09"))).toBe(true);
    expect(Number.isNaN(sessionAnchorMs("bogus"))).toBe(true);
  });
});

describe("toCandleBars", () => {
  test("maps recorder rows (timestamp/ISO) and Breeze rows (time/naive IST) to numeric epoch ms", () => {
    const bars = toCandleBars([
      { timestamp: "2026-11-09T03:45:00.000Z", open: 100, high: 110, low: 95, close: 105, volume: 10 },
      { time: "2026-11-09 09:16:00", open: 105, high: 112, low: 104, close: 110 },
    ]);
    expect(bars).toHaveLength(2);
    expect(bars[0].time).toBe(Date.UTC(2026, 10, 9, 3, 45));
    expect(bars[1].time).toBe(Date.UTC(2026, 10, 9, 3, 46));
    expect(typeof bars[0].time).toBe("number");
    expect(bars[1].volume).toBe(0);
    expect(bars[0].close).toBe(105);
  });

  test("drops rows with an unparseable time or non-finite OHLC, and sorts ascending", () => {
    const bars = toCandleBars([
      { time: "2026-11-09 09:17:00", open: 1, high: 2, low: 0.5, close: 1.5 },
      { time: "nonsense", open: 1, high: 2, low: 0.5, close: 1.5 },
      { time: "2026-11-09 09:16:00", open: NaN, high: 2, low: 0.5, close: 1.5 },
      null,
      { time: "2026-11-09 09:15:00", open: 1, high: 2, low: 0.5, close: 1.5 },
    ]);
    expect(bars.map((b) => b.time)).toEqual([
      Date.UTC(2026, 10, 9, 3, 45),
      Date.UTC(2026, 10, 9, 3, 47),
    ]);
  });
});

describe("aggregateBars (1m/5m → bucket, anchored at the 09:15 open)", () => {
  const anchor = Date.UTC(2026, 10, 9, 3, 45); // 09:15 IST
  const min = (h: number, m: number) => anchor + ((h - 9) * 60 + (m - 15)) * 60_000;

  test("five 1m bars become one 5m bar with correct OHLC and bucket start", () => {
    const bars = toCandleBars([
      { time: "2026-11-09 09:15:00", open: 100, high: 110, low: 95, close: 105, volume: 1 },
      { time: "2026-11-09 09:16:00", open: 105, high: 120, low: 100, close: 115, volume: 2 },
      { time: "2026-11-09 09:17:00", open: 115, high: 118, low: 90, close: 92, volume: 3 },
      { time: "2026-11-09 09:18:00", open: 92, high: 99, low: 91, close: 98, volume: 4 },
      { time: "2026-11-09 09:19:00", open: 98, high: 101, low: 97, close: 100, volume: 5 },
    ]);
    const out = aggregateBars(bars, 5, anchor);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      time: anchor, // bucket start, not the last bar's time
      open: 100,
      high: 120,
      low: 90,
      close: 100, // close of the LAST bar in the bucket
      volume: 15,
    });
  });

  test("bucket boundaries are anchored at 09:15, not midnight (09:15→09:45 for 30m)", () => {
    const bars = toCandleBars([
      { time: "2026-11-09 09:15:00", open: 10, high: 12, low: 9, close: 11 },
      { time: "2026-11-09 09:30:00", open: 11, high: 13, low: 10, close: 12 },
      { time: "2026-11-09 09:44:00", open: 12, high: 14, low: 11, close: 13 },
      { time: "2026-11-09 09:45:00", open: 13, high: 15, low: 12, close: 14 },
    ]);
    const out = aggregateBars(bars, 30, anchor);
    expect(out.map((b) => b.time)).toEqual([anchor, anchor + 30 * 60_000]);
    expect(out[0]).toMatchObject({ open: 10, high: 14, low: 9, close: 13 });
    expect(out[1]).toMatchObject({ open: 13, high: 15, low: 12, close: 14 });
  });

  test("no look-ahead: a bucket never absorbs a bar that starts in the next bucket", () => {
    const bars = toCandleBars([
      { time: "2026-11-09 09:15:00", open: 1, high: 1, low: 1, close: 1 },
      { time: "2026-11-09 09:19:00", open: 2, high: 2, low: 2, close: 2 }, // last bar of bucket 1
      { time: "2026-11-09 09:20:00", open: 99, high: 99, low: 99, close: 99 }, // first bar of bucket 2
    ]);
    const out = aggregateBars(bars, 5, anchor);
    expect(out).toHaveLength(2);
    expect(out[0].close).toBe(2);
    expect(out[1].close).toBe(99);
    expect(out[1].time).toBe(anchor + 5 * 60_000);
  });

  test("bars before the session anchor are dropped; output is ascending", () => {
    const bars = toCandleBars([
      { time: "2026-11-09 09:14:00", open: 1, high: 1, low: 1, close: 1 },
      { time: "2026-11-09 09:21:00", open: 2, high: 2, low: 2, close: 2 },
      { time: "2026-11-09 09:16:00", open: 3, high: 3, low: 3, close: 3 },
    ]);
    const out = aggregateBars(bars, 5, anchor);
    expect(out.map((b) => b.time)).toEqual([anchor, anchor + 5 * 60_000]);
    expect(out[0].open).toBe(3); // 09:16 is the first bar inside the bucket
    expect(out[1].open).toBe(2);
    expect(min(9, 21)).toBe(anchor + 6 * 60_000);
  });
});
