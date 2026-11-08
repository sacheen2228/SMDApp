// Footprint aggregation — directional volume per price bin from live prints.
//
// Pure math, no clock/network: takes the Trade snapshots the futures tab
// already fetches and groups them into price-step bins with buy/sell split.
// Bins use side-agnostic nearest-step rounding (floor at exact .5 ties are
// avoided by adding half a step before flooring — see binOf).
//
// Data honesty: CoinDCX trade_history only returns recent prints, so callers
// should label this as a live-session footprint. Never invent historical bins.

import type { Trade } from "@/types/engine";

export interface FootprintBin {
  price: number;
  buyQty: number;
  sellQty: number;
  buyCount: number;
  sellCount: number;
  total: number;
  delta: number; // buyQty - sellQty
}

export interface FootprintResult {
  bins: FootprintBin[]; // ascending by price
  poc: number | null; // price-step of the highest-total bin
  totalVolume: number;
}

function binOf(price: number, step: number): number {
  // nearest multiple of step; exact .5 ties round toward +inf
  return Math.round(price / step) * step;
}

// ── session accumulator ──────────────────────────────────────────────────────
// Merge fresh poll prints into the session accumulator. Pure: returns a new
// array, never mutates inputs. Dedupes by print signature (overlapping polls
// re-send the same prints) and caps at the newest MAX_SESSION_PRINTS so an
// all-day session cannot grow without bound.

export const MAX_SESSION_PRINTS = 20_000;

function printSig(t: Trade): string {
  return `${t.time}|${t.price}|${t.size}|${t.isBuyerMaker}`;
}

export function mergePrints(prev: readonly Trade[], incoming: readonly Trade[]): Trade[] {
  if (incoming.length === 0) return prev as Trade[];
  const seen = new Set(prev.map(printSig));
  const added: Trade[] = [];
  for (const t of incoming) {
    const sig = printSig(t);
    if (seen.has(sig)) continue;
    seen.add(sig);
    added.push(t);
  }
  if (added.length === 0) return prev as Trade[];

  const merged = prev.length > 0 ? [...prev, ...added] : added.slice();
  if (merged.length > MAX_SESSION_PRINTS) {
    return merged.slice(merged.length - MAX_SESSION_PRINTS);
  }
  return merged;
}

export function aggregateFootprint(trades: Trade[], priceStep: number): FootprintResult {
  if (!Number.isFinite(priceStep) || priceStep <= 0) {
    throw new Error(`aggregateFootprint: priceStep must be > 0, got ${priceStep}`);
  }

  const byBin = new Map<number, FootprintBin>();

  for (const t of trades) {
    if (!Number.isFinite(t.price) || !Number.isFinite(t.size) || t.size <= 0) continue;
    const price = binOf(t.price, priceStep);
    // normalize float artifacts from price/step math (0.1+0.2 style)
    const key = Number(price.toFixed(10));
    let bin = byBin.get(key);
    if (!bin) {
      bin = { price: key, buyQty: 0, sellQty: 0, buyCount: 0, sellCount: 0, total: 0, delta: 0 };
      byBin.set(key, bin);
    }
    if (t.isBuyerMaker) {
      bin.sellQty += t.size;
      bin.sellCount += 1;
    } else {
      bin.buyQty += t.size;
      bin.buyCount += 1;
    }
    bin.total += t.size;
  }

  const bins = Array.from(byBin.values()).sort((a, b) => a.price - b.price);
  for (const b of bins) b.delta = b.buyQty - b.sellQty;

  let poc: number | null = null;
  let best = -1;
  let totalVolume = 0;
  for (const b of bins) {
    totalVolume += b.total;
    if (b.total > best) {
      best = b.total;
      poc = b.price;
    }
  }

  return { bins, poc, totalVolume };
}
