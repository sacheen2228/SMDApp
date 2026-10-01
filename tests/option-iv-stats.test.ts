/// <reference types="bun-types" />
// deriveIvStats / findAtmStrike — shared pure helpers on the canonical
// option-chain normalizer. Feeds real ATM IV + option premium into the
// trade-intelligence modes (previously hardcoded ivMedian: 0 / ivRank: 0).

import { describe, it, expect } from "bun:test";
import { deriveIvStats, findAtmStrike } from "@/lib/option-chain-normalizer";

describe("findAtmStrike", () => {
  it("returns the strike nearest to spot", () => {
    expect(findAtmStrike([100, 110, 120, 130], 122)).toBe(120);
    expect(findAtmStrike([100, 110, 120, 130], 101)).toBe(100);
    expect(findAtmStrike([100, 110, 120, 130], 126)).toBe(130);
  });

  it("returns 0 for an empty strike list", () => {
    expect(findAtmStrike([], 122)).toBe(0);
  });
});

describe("deriveIvStats", () => {
  const strikes = [
    { strike: 1300, ce: { iv: 18.4, ltp: 45.5 }, pe: { iv: 16.2, ltp: 22.1 } },
    { strike: 1320, ce: { iv: 14.9, ltp: 30.4 }, pe: { iv: 15.1, ltp: 33.2 } },
    { strike: 1340, ce: { iv: 12.8, ltp: 18.7 }, pe: { iv: 13.5, ltp: 46.0 } },
  ];

  it("computes ATM IV as max(ce, pe) IV at the ATM strike", () => {
    const stats = deriveIvStats(strikes, 1320);
    expect(stats.atmIV).toBe(15.1);
  });

  it("computes real ATM premiums (never IV-as-premium)", () => {
    const stats = deriveIvStats(strikes, 1320);
    expect(stats.atmCePremium).toBe(30.4);
    expect(stats.atmPePremium).toBe(33.2);
  });

  it("computes median of positive IVs", () => {
    const stats = deriveIvStats(strikes, 1320);
    // IVs: 18.4, 16.2, 14.9, 15.1, 12.8, 13.5 → sorted: 12.8 13.5 14.9 15.1 16.2 18.4
    // median = (14.9 + 15.1) / 2 = 15
    expect(stats.ivMedian).toBe(15);
  });

  it("computes ivRank as ATM-IV percentile within today's distribution", () => {
    const stats = deriveIvStats(strikes, 1320);
    // atmIV 15.1 → IVs ≤ 15.1: 14.9, 15.1, 12.8, 13.5 = 4 of 6 = 66.7%
    expect(stats.ivRank).toBe(66.7);
  });

  it("returns zeros when no leg has IV (honest — no fabrication)", () => {
    const noIv = [{ strike: 1320, ce: { iv: 0, ltp: 30.4 }, pe: null }];
    const stats = deriveIvStats(noIv, 1320);
    expect(stats.ivMedian).toBe(0);
    expect(stats.ivRank).toBe(0);
    expect(stats.atmIV).toBe(0);
    // premium is REAL data — still returned even when IV is missing
    expect(stats.atmCePremium).toBe(30.4);
    expect(stats.atmPePremium).toBe(0);
  });

  it("handles null legs and missing strikes", () => {
    const stats = deriveIvStats(
      [{ strike: 1320, ce: null, pe: { iv: 20, ltp: 41.0 } }],
      1320
    );
    expect(stats.atmIV).toBe(20);
    expect(stats.atmCePremium).toBe(0);
    expect(stats.atmPePremium).toBe(41.0);
    expect(deriveIvStats([], 1320).atmIV).toBe(0);
  });
});
