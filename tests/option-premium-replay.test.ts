/// <reference types="bun-types" />
// Option premium replay — the fix for "backtest replays premium SL/TP against
// SPOT candles". Option trades now replay against REAL daily premium OHLC from
// the NSE F&O bhavcopy (option-bhavcopy.ts), with:
//   • PE treated as LONG premium (sidecar has no side — every recorded option
//     trade bought the premium; old code replayed PE as a short and FLIPPED
//     the P&L sign),
//   • daily candles pinned at 00:00 UTC (inside the IST entry time) — the
//     prefiltered flag bypasses the millisecond entry-window filter that used
//     to drop every daily candle → NO_DATA,
//   • no premium data → NO_DATA (never a spot-vs-premium garbage win).

import { describe, it, expect } from "bun:test";
import {
  backtestSingleTrade,
  isOptionReplayTrade,
  premiumToCandle,
} from "@/lib/trade-backtest-engine";
import type { TradeRecord } from "@/lib/trade-audit-client";
import type { PremiumCandle } from "@/lib/option-bhavcopy";

function makeOptTrade(over: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: "opt-1",
    strategyId: "ZERO_HERO_AI",
    symbol: "NIFTY",
    exchange: "NSE",
    instrumentType: "OPTIONS",
    status: "closed",
    createdAtIst: "2026-07-17T10:00:00+05:30",
    entryTime: "2026-07-17T10:00:00+05:30",
    exitTime: "2026-07-17T15:00:00+05:30",
    entryPrice: 100,
    stopLoss: 85,
    tp1: 115,
    tp2: 130,
    tp3: null,
    spotPrice: 22650,
    strikePrice: 22700,
    optionType: "PE",
    expiry: null,
    trendDirection: "BEARISH",
    signalConfidence: 80,
    netPnl: -15,
    exitPrice: 85,
    exitReason: "stop_loss",
    mfe: 0,
    mae: 1,
    tp1Hit: 0,
    tp2Hit: 0,
    tp3Hit: 0,
    slHit: 1,
    rMultiple: -1,
    ...over,
  } as unknown as TradeRecord;
}

function pDay(date: string, low: number, high: number, close: number): PremiumCandle {
  return {
    date,
    symbol: "NIFTY",
    strike: 22700,
    optionType: "PE",
    expiry: "2026-07-17",
    open: close,
    high,
    low,
    close,
    underlying: 22650,
    lotSize: 75,
    volume: 1000,
    oi: 10000,
  };
}

describe("isOptionReplayTrade — which trades take the premium path", () => {
  it("detects OPTIONS instrument type and bare CE/PE optionType", () => {
    expect(isOptionReplayTrade(makeOptTrade())).toBe(true);
    expect(isOptionReplayTrade(makeOptTrade({ instrumentType: "EQUITY", optionType: null }))).toBe(false);
    expect(
      isOptionReplayTrade(makeOptTrade({ instrumentType: "EQUITY", optionType: "CE" as any }))
    ).toBe(true);
  });
});

describe("premiumToCandle — daily premium OHLC → replay candle", () => {
  it("maps date to epoch seconds and keeps premium OHLC", () => {
    const c = premiumToCandle(pDay("2026-07-17", 84, 120, 110));
    expect(c.time).toBe(Math.floor(Date.parse("2026-07-17T00:00:00Z") / 1000));
    expect(c.low).toBe(84);
    expect(c.high).toBe(120);
    expect(c.close).toBe(110);
  });
});

describe("backtestSingleTrade — option premium replay (prefiltered daily candles)", () => {
  it("PE SL loss is NEGATIVE (long premium) — old code flipped the sign", () => {
    const trade = makeOptTrade();
    const candles = [premiumToCandle(pDay("2026-07-17", 84, 105, 90))]; // low84 <= SL85
    const bt = backtestSingleTrade(trade, candles, { prefiltered: true });
    expect(bt.dataQuality).toBe("REAL");
    expect(bt.actualExitReason).toBe("SL_HIT");
    expect(bt.actualExitPrice).toBe(85);
    expect(bt.actualPnl).toBe(-15); // 85 - 100 — NOT +15
    expect(bt.actualRMultiple).toBeCloseTo(-1, 5);
  });

  it("CE TP2 hit on premium high — against PREMIUM levels, not spot", () => {
    const trade = makeOptTrade({ optionType: "CE" as any, trendDirection: "BULLISH" });
    const candles = [premiumToCandle(pDay("2026-07-17", 95, 131, 125))]; // high131 >= tp2 130
    const bt = backtestSingleTrade(trade, candles, { prefiltered: true });
    expect(bt.actualExitReason).toBe("TP2_HIT");
    expect(bt.actualExitPrice).toBe(130);
    expect(bt.actualPnl).toBe(30);
  });

  it("daily candle pinned at 00:00 UTC is NOT dropped by the entry-window filter", () => {
    const trade = makeOptTrade();
    const candles = [premiumToCandle(pDay("2026-07-17", 84, 105, 90))];
    // Without prefiltered, candle.time (00:00Z = 05:30 IST) < entry (10:00 IST)
    // → old code filtered it out → NO_DATA. With prefiltered → replayed.
    const without = backtestSingleTrade(trade, candles, { prefiltered: false });
    expect(without.dataQuality).toBe("NO_DATA");
    const with_ = backtestSingleTrade(trade, candles, { prefiltered: true });
    expect(with_.dataQuality).toBe("REAL");
  });

  it("same-day SL+TP ambiguity resolves conservatively (SL first)", () => {
    const trade = makeOptTrade();
    const candles = [premiumToCandle(pDay("2026-07-17", 84, 120, 118))]; // low<=SL, high>=TP1/2
    const bt = backtestSingleTrade(trade, candles, { prefiltered: true });
    expect(bt.actualExitReason).toBe("SL_HIT");
    expect(bt.actualPnl).toBe(-15);
  });

  it("no premium data → NO_DATA (never replayed against spot)", () => {
    const bt = backtestSingleTrade(makeOptTrade(), [], { prefiltered: true });
    expect(bt.dataQuality).toBe("NO_DATA");
    expect(bt.candleCount).toBe(0);
  });

  it("no SL/TP touch → EXPIRED_EOD at last premium close", () => {
    const trade = makeOptTrade();
    const candles = [
      premiumToCandle(pDay("2026-07-17", 96, 110, 105)),
      premiumToCandle(pDay("2026-07-20", 97, 112, 108)),
    ];
    const bt = backtestSingleTrade(trade, candles, { prefiltered: true });
    expect(bt.actualExitReason).toBe("EXPIRED_EOD");
    expect(bt.actualExitPrice).toBe(108);
    expect(bt.actualPnl).toBe(8);
    expect(bt.holdingCandles).toBe(2);
  });

  it("multi-day premium series: SL touched on day 2 only", () => {
    const trade = makeOptTrade({ exitTime: "2026-07-21T15:00:00+05:30" } as any);
    const candles = [
      premiumToCandle(pDay("2026-07-17", 96, 110, 105)),
      premiumToCandle(pDay("2026-07-20", 84, 106, 90)), // SL day
      premiumToCandle(pDay("2026-07-21", 88, 100, 95)),
    ];
    const bt = backtestSingleTrade(trade, candles, { prefiltered: true });
    expect(bt.actualExitReason).toBe("SL_HIT");
    expect(bt.actualPnl).toBe(-15);
    expect(bt.holdingCandles).toBe(2); // stops at SL
  });
});
