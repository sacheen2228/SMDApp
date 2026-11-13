/// <reference types="bun-types" />
// TDD for the Simple Tab 14-factor quality adapter (option 2).

import { describe, test, expect } from "bun:test";
import {
  computeSimpleQuality,
  normalizeChain,
  marketStructureFromTrend,
  degradedGEX,
  degradedOI,
} from "@/lib/simple-quality";

const chain = normalizeChain([
  {
    strike: 25150,
    ce: { ltp: 137.75, oi: 55066, oiChg: 46437, volume: 3348879, iv: 12.55, delta: 0.52, gamma: 0.0012, theta: -18.93, vega: 10.49 },
    pe: { ltp: 136.6, oi: 48369, oiChg: 23849, volume: 3696162, iv: 13.57, delta: -0.48, gamma: 0.0011, theta: -15.44, vega: 10.49 },
  },
  {
    strike: 25200,
    ce: { ltp: 110, oi: 40000, oiChg: 5000, volume: 100000, iv: 13, delta: 0.4, gamma: 0.01, theta: -15, vega: 10, bid: null, ask: null },
    pe: { ltp: 120, oi: 50000, oiChg: -2000, volume: 90000, iv: 14, delta: -0.5, gamma: 0.01, theta: -16, vega: 10 },
  },
]);

describe("normalizeChain", () => {
  test("null greeks become 0, structure preserved", () => {
    expect(chain).toHaveLength(2);
    expect(chain[0].ce!.delta).toBe(0.52);
    expect(chain[1].ce!.iv).toBe(13);
    expect(chain[0].strike).toBe(25150);
  });

  test("non-array input → empty", () => {
    expect(normalizeChain(null)).toEqual([]);
    expect(normalizeChain(undefined)).toEqual([]);
  });
});

describe("marketStructureFromTrend", () => {
  test("missing trend → DEGRADED", () => {
    const m = marketStructureFromTrend(null);
    expect(m.status).toBe("DEGRADED");
    expect(m.structureEvent).toBeNull();
  });

  test("UP + BOS_UP → UPTREND + BOS BULLISH", () => {
    const m = marketStructureFromTrend({
      structureTrend: "UP",
      structureEvent: "BOS_UP",
      structureEventBarsAgo: 1,
      lastHigh: 25200,
      lastLow: 25050,
    });
    expect(m.status).toBe("OK");
    expect(m.trend).toBe("UPTREND");
    expect(m.structureEvent?.type).toBe("BOS");
    expect(m.structureEvent?.direction).toBe("BULLISH");
  });

  test("DOWN + CHOCH_DOWN → DOWNTREND + CHoCH BEARISH", () => {
    const m = marketStructureFromTrend({
      structureTrend: "DOWN",
      structureEvent: "CHOCH_DOWN",
    });
    expect(m.trend).toBe("DOWNTREND");
    expect(m.structureEvent?.type).toBe("CHoCH");
    expect(m.structureEvent?.direction).toBe("BEARISH");
  });
});

describe("computeSimpleQuality", () => {
  test("returns 14 factors, overall 0-100, valid grade", () => {
    const q = computeSimpleQuality({
      chain,
      spot: 25150,
      oiAnalysis: degradedOI(),
      trendRead: { structureTrend: "UP", structureEvent: "BOS_UP", structureEventBarsAgo: 2, lastHigh: 25200, lastLow: 25000 },
      vix: 14.2,
      tradeDirection: "CALL",
      entryPrice: 137.75,
      stopLoss: 120,
      target1: 175,
    });
    expect(q.factors).toHaveLength(14);
    expect(q.overall).toBeGreaterThanOrEqual(0);
    expect(q.overall).toBeLessThanOrEqual(100);
    expect(["A+", "A", "B", "C", "D"]).toContain(q.grade);
    // GEX / volume / consensus missing → DEGRADED status
    expect(q.status).toBe("DEGRADED");
    const gex = q.factors.find((f) => f.name === "Gamma Exposure")!;
    expect(gex.detail.toLowerCase()).toContain("degraded");
    const trend = q.factors.find((f) => f.name === "Trend")!;
    expect(trend.score).toBe(85); // UPTREND supports CALL
  });

  test("unknown VIX (0) never invents 15", () => {
    const q = computeSimpleQuality({
      chain,
      spot: 25150,
      vix: 0,
      tradeDirection: "CALL",
      entryPrice: 137,
      stopLoss: 120,
      target1: 175,
    });
    const vol = q.factors.find((f) => f.name === "Volatility")!;
    expect(vol.detail).toContain("VIX 0.0");
  });

  test("R:R from real plan levels scores Risk:Reward", () => {
    const q = computeSimpleQuality({
      chain,
      spot: 25150,
      vix: 15,
      tradeDirection: "CALL",
      entryPrice: 100,
      stopLoss: 80,   // risk 20
      target1: 160,   // reward 60 → R:R 3
    });
    const rr = q.factors.find((f) => f.name === "Risk:Reward")!;
    expect(rr.score).toBe(85);
    expect(rr.detail).toContain("1:3.0");
  });

  test("degraded GEX does not throw and stays neutral-weighted", () => {
    expect(degradedGEX().status).toBe("DEGRADED");
    const q = computeSimpleQuality({
      chain,
      spot: 25150,
      vix: 15,
      tradeDirection: "PUT",
      entryPrice: 136,
      stopLoss: 115,
      target1: 180,
    });
    expect(q.factors.length).toBe(14);
  });
});
