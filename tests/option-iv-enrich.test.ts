// option-iv-enrich.test.ts — IV fill from NSE by strike (never invents IV).
import { describe, test, expect } from "bun:test";
import { ivMissing, needsIvEnrichment, mergeNseIv } from "../src/lib/option-iv-enrich";

const nseRows = [
  { strikePrice: 25000, CE: { impliedVolatility: 17.5 }, PE: { impliedVolatility: 16.1 } },
  { strikePrice: 25100, CE: { impliedVolatility: 17.8 }, PE: { impliedVolatility: 16.4 } },
  { strikePrice: 25200, CE: { impliedVolatility: 0 }, PE: { impliedVolatility: 16.9 } }, // CE IV missing on NSE too
];

describe("ivMissing", () => {
  test("null/0/NaN/undefined are missing; positive finite is present", () => {
    expect(ivMissing(null)).toBe(true);
    expect(ivMissing(undefined)).toBe(true);
    expect(ivMissing(0)).toBe(true);
    expect(ivMissing("abc")).toBe(true);
    expect(ivMissing(17.4)).toBe(false);
    expect(ivMissing("18.2")).toBe(false);
  });
});

describe("needsIvEnrichment", () => {
  test("true when near-the-money legs mostly lack IV", () => {
    const strikes = [
      { strike: 25100, ce: { iv: null }, pe: { iv: null } },
      { strike: 25200, ce: { iv: null }, pe: { iv: 16 } },
    ];
    expect(needsIvEnrichment(strikes as any, 25100)).toBe(true);
  });
  test("false when IV already present", () => {
    const strikes = [
      { strike: 25100, ce: { iv: 17.2 }, pe: { iv: 16.4 } },
      { strike: 25200, ce: { iv: 17.5 }, pe: { iv: 16.8 } },
    ];
    expect(needsIvEnrichment(strikes as any, 25100)).toBe(false);
  });
  test("false when no spot or empty chain", () => {
    expect(needsIvEnrichment([], 25100)).toBe(false);
    expect(needsIvEnrichment([{ strike: 25100, ce: { iv: null } }] as any, 0)).toBe(false);
  });
});

describe("mergeNseIv", () => {
  test("fills only missing IV by strike; leaves present IV alone", () => {
    const strikes = [
      { strike: 25000, ce: { iv: null, ltp: 100 }, pe: { iv: null, ltp: 90 } },
      { strike: 25100, ce: { iv: 19.9, ltp: 80 }, pe: { iv: null, ltp: 70 } }, // CE already has IV
      { strike: 25200, ce: { iv: null, ltp: 60 }, pe: { iv: null, ltp: 55 } },
    ];
    const { strikes: out, filled, nseIvCount } = mergeNseIv(strikes as any, nseRows);
    expect(nseIvCount).toBe(5); // 25000 CE+PE, 25100 CE+PE, 25200 PE (CE is 0)
    // 25000: both filled; 25100: only PE; 25200: only PE (NSE CE IV=0 → not filled)
    expect(filled).toBe(4);
    expect(out[0].ce!.iv).toBe(17.5);
    expect(out[0].pe!.iv).toBe(16.1);
    expect(out[1].ce!.iv).toBe(19.9); // untouched
    expect(out[1].pe!.iv).toBe(16.4);
    expect(out[2].ce!.iv).toBe(null); // NSE published 0 → stays null (no invent)
    expect(out[2].pe!.iv).toBe(16.9);
    // prices never touched
    expect(out[0].ce!.ltp).toBe(100);
  });
  test("unknown strike stays as-is", () => {
    const strikes = [{ strike: 99999, ce: { iv: null }, pe: { iv: null } }];
    const { strikes: out, filled } = mergeNseIv(strikes as any, nseRows);
    expect(filled).toBe(0);
    expect(out[0].ce!.iv).toBe(null);
  });
  test("empty NSE rows → no-op", () => {
    const strikes = [{ strike: 25000, ce: { iv: null }, pe: { iv: null } }];
    const { strikes: out, filled } = mergeNseIv(strikes as any, []);
    expect(filled).toBe(0);
    expect(out[0].ce!.iv).toBe(null);
  });
  test("BSE row shape ({strike, ce:{iv}, pe:{iv}}) fills the same way", () => {
    // SENSEX/BANKEX live on BSE — DerivOptionChain_IV returns ce.iv/pe.iv,
    // not NSE's CE.impliedVolatility. mergeNseIv must accept both shapes.
    const bseRows = [
      { strike: 82000, ce: { iv: 14.92 }, pe: { iv: 16.03 } },
      { strike: 82100, ce: { iv: 15.1 }, pe: { iv: 0 } }, // BSE PE IV 0 → not filled
    ];
    const strikes = [
      { strike: 82000, ce: { iv: null, ltp: 200 }, pe: { iv: null, ltp: 180 } },
      { strike: 82100, ce: { iv: null, ltp: 150 }, pe: { iv: null, ltp: 140 } },
    ];
    const { strikes: out, filled, nseIvCount } = mergeNseIv(strikes as any, bseRows as any);
    expect(nseIvCount).toBe(3);
    expect(filled).toBe(3);
    expect(out[0].ce!.iv).toBe(14.92);
    expect(out[0].pe!.iv).toBe(16.03);
    expect(out[1].ce!.iv).toBe(15.1);
    expect(out[1].pe!.iv).toBe(null);
    expect(out[0].ce!.ltp).toBe(200);
  });
});
