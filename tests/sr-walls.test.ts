/// <reference types="bun-types" />
// TDD for computeSupportResistance (sdm-oianalysis.ts) — the OI Analysis
// panel's Support / Resistance lines on the SimpleMode card.
//
// The old version ranked candidates by OI / distance (distance clamped to 1
// point), so the strike ONE tick above/below spot ALWAYS won as
// "Resistance"/"Support" — pure proximity noise, never the real OI wall.
// (Observed live: spot 25,299 → "Resistance 25,300 / Support 25,250" while
// the actual walls sat at 25,400 CE and 25,200 PE.)
//
// The fixed version mirrors the canonical chain reader
// (option-chain-reader.ts): rank by RAW OI concentration inside a ±5%
// window around spot. Zero-OI strikes are excluded — no fabricated levels.

import { describe, test, expect } from "bun:test";
import { computeSupportResistance } from "@/lib/sdm-oianalysis";
import type { SDMOptionStrike } from "@/types/sdm";

function leg(oi: number, oiChg = 0) {
  return { ltp: 100, oi, oiChg, volume: 0, iv: 0, delta: 0, theta: 0, gamma: 0, vega: 0 };
}

function strikeRow(strike: number, ceOi = 0, peOi = 0): SDMOptionStrike {
  return {
    strike,
    ce: leg(ceOi),
    pe: leg(peOi),
  } as unknown as SDMOptionStrike;
}

const SPOT = 25299;

const CHAIN: SDMOptionStrike[] = [
  strikeRow(25000, 0, 180_000),
  strikeRow(25100, 0, 220_000),
  strikeRow(25200, 10_000, 520_000),   // real put wall
  strikeRow(25250, 5_000, 25_000),     // adjacent strike — tiny OI
  strikeRow(25300, 15_000, 0),         // adjacent strike — tiny OI
  strikeRow(25400, 480_000, 0),        // real call wall
  strikeRow(25500, 160_000, 0),
  strikeRow(25600, 40_000, 0),
];

describe("computeSupportResistance — walls by real OI, not proximity", () => {
  test("resistance[0] is the BIGGEST call OI above spot, not the strike 1 pt away", () => {
    const sr = computeSupportResistance(CHAIN, SPOT);
    expect(sr.resistance[0].strike).toBe(25400);
    expect(sr.resistance[0].oi).toBe(480_000);
  });

  test("support[0] is the BIGGEST put OI below spot, not the strike 1 pt away", () => {
    const sr = computeSupportResistance(CHAIN, SPOT);
    expect(sr.support[0].strike).toBe(25200);
    expect(sr.support[0].oi).toBe(520_000);
  });

  test("lists are sorted by OI descending", () => {
    const sr = computeSupportResistance(CHAIN, SPOT);
    const rOi = sr.resistance.map((r) => r.oi);
    const sOi = sr.support.map((s) => s.oi);
    expect([...rOi].sort((a, b) => b - a)).toEqual(rOi);
    expect([...sOi].sort((a, b) => b - a)).toEqual(sOi);
  });

  test("zero-OI strikes never become a level (no fabricated walls)", () => {
    const sr = computeSupportResistance(CHAIN, SPOT);
    expect(sr.resistance.every((r) => r.oi > 0)).toBe(true);
    expect(sr.support.every((s) => s.oi > 0)).toBe(true);
  });

  test("far strikes beyond the ±5% window are excluded", () => {
    const chain = [
      ...CHAIN,
      strikeRow(27000, 900_000, 0),   // huge but 6.7% away — junk
      strikeRow(24000, 0, 900_000),   // huge but 5.1% away — junk
    ];
    const sr = computeSupportResistance(chain, SPOT);
    expect(sr.resistance.find((r) => r.strike === 27000)).toBeUndefined();
    expect(sr.support.find((s) => s.strike === 24000)).toBeUndefined();
  });

  test("weight is the real OI share of the side max (0..1]", () => {
    const sr = computeSupportResistance(CHAIN, SPOT);
    expect(sr.resistance[0].weight).toBeCloseTo(1.0);
    expect(sr.support[0].weight).toBeCloseTo(1.0);
  });

  test("no chain / no walls → empty lists (card shows —, never invented levels)", () => {
    const sr = computeSupportResistance([], SPOT);
    expect(sr.resistance).toEqual([]);
    expect(sr.support).toEqual([]);
  });
});
