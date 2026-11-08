/// <reference types="bun-types" />
// Footprint aggregation — buy/sell volume per price bin from live prints.
// Design reference: native footprint panes (bins at a price step, POC,
// delta). Pure math: no rendering, no clock, no network.

import { describe, it, expect } from "bun:test";
import { aggregateFootprint, mergePrints } from "@/lib/futures/footprint";
import type { Trade } from "@/types/engine";

const t = (price: number, size: number, isBuyerMaker: boolean, time = 1_000): Trade => ({
  price,
  size,
  isBuyerMaker,
  time,
});

describe("aggregateFootprint", () => {
  it("returns empty bins and null POC for no trades", () => {
    const r = aggregateFootprint([], 1);
    expect(r.bins).toEqual([]);
    expect(r.poc).toBeNull();
    expect(r.totalVolume).toBe(0);
  });

  it("bins trades to the nearest price step", () => {
    // step 10 → 100.4 and 99.7 both round to 100
    const r = aggregateFootprint([t(100.4, 2, false), t(99.7, 3, false)], 10);
    expect(r.bins).toHaveLength(1);
    expect(r.bins[0].price).toBe(100);
    expect(r.bins[0].total).toBe(5);
  });

  it("splits volume by aggressor side (isBuyerMaker = seller aggressor)", () => {
    const r = aggregateFootprint(
      [t(500, 4, false), t(500, 1, true), t(500, 2, true)],
      5,
    );
    const bin = r.bins[0];
    expect(bin.buyQty).toBe(4); // aggressor buy
    expect(bin.sellQty).toBe(3); // aggressor sells
    expect(bin.buyCount).toBe(1);
    expect(bin.sellCount).toBe(2);
    expect(bin.delta).toBe(1); // buyQty - sellQty
  });

  it("computes POC as the highest-total bin", () => {
    const r = aggregateFootprint(
      [t(100, 1, false), t(100, 1, true), t(200, 9, false), t(300, 2, false)],
      100,
    );
    expect(r.poc).toBe(200);
    expect(r.totalVolume).toBe(13);
  });

  it("keeps bins sorted ascending by price", () => {
    const r = aggregateFootprint([t(300, 1, false), t(100, 1, false), t(200, 1, false)], 100);
    expect(r.bins.map(b => b.price)).toEqual([100, 200, 300]);
  });

  it("is deterministic for the same input", () => {
    const trades = [t(10.4, 2, false), t(9.6, 3, true), t(10.1, 1, false)];
    const a = aggregateFootprint(trades, 1);
    const b = aggregateFootprint(trades, 1);
    expect(a).toEqual(b);
  });

  it("rejects a non-positive price step instead of dividing by zero", () => {
    expect(() => aggregateFootprint([t(1, 1, false)], 0)).toThrow();
  });
});

describe("mergePrints", () => {
  const sig = (p: Trade) => `${p.time}|${p.price}|${p.size}|${p.isBuyerMaker}`;

  it("returns the incoming prints when the accumulator is empty", () => {
    const incoming = [t(100, 1, false), t(101, 2, true)];
    expect(mergePrints([], incoming)).toEqual(incoming);
  });

  it("dedupes prints already present (overlapping polls)", () => {
    const a = [t(100, 1, false), t(101, 2, true)];
    const merged = mergePrints(a, [t(101, 2, true), t(102, 3, false)]);
    expect(merged).toHaveLength(3);
    expect(merged.map(sig)).toEqual([sig(a[0]), sig(a[1]), sig(t(102, 3, false))]);
  });

  it("keeps two prints with the same price/size but different times", () => {
    const merged = mergePrints([], [t(100, 1, false, 1), t(100, 1, false, 2)]);
    expect(merged).toHaveLength(2);
  });

  it("does not mutate the inputs", () => {
    const prev = [t(100, 1, false)];
    const incoming = [t(101, 2, true)];
    const frozenPrev = prev.map(sig);
    const frozenIn = incoming.map(sig);
    mergePrints(prev, incoming);
    expect(prev.map(sig)).toEqual(frozenPrev);
    expect(incoming.map(sig)).toEqual(frozenIn);
  });

  it("caps the accumulator at the newest 20000 prints", () => {
    const old = Array.from({ length: 20000 }, (_, i) => t(1, 1, false, i));
    const merged = mergePrints(old, [t(2, 1, false, 999999)]);
    expect(merged).toHaveLength(20000);
    expect(merged[merged.length - 1].time).toBe(999999);
    expect(merged[0].time).toBe(1); // oldest dropped from the front
  });
});
