/// <reference types="bun-types" />
// TDD for runFullAnalysis: NEUTRAL sentiment must NOT emit optionType PE/CE
// or pick a PE premium as entry (the D-1 defect).

import { describe, test, expect } from "bun:test";
import { runFullAnalysis } from "@/lib/sdm-engine";
import type { SDMOptionStrike } from "@/types/sdm";

function leg(ltp: number, oi: number, oiChg = 0) {
  return {
    ltp,
    oi,
    oiChg,
    volume: 1000,
    iv: 14,
    delta: 0.5,
    theta: -0.05,
    gamma: 0.01,
    vega: 0.1,
  };
}

/** Chain where total PE OI / CE OI lands in the neutral band [0.75, 1.2]. */
function neutralChain(): SDMOptionStrike[] {
  // CE total 100000, PE total 81000 → PCR 0.81 (neutral)
  const rows: SDMOptionStrike[] = [];
  for (let i = 0; i < 10; i++) {
    const strike = 25000 + i * 50;
    rows.push({
      strike,
      ce: leg(100 + i, 10000, 100),
      pe: leg(90 + i, 8100, -50),
    });
  }
  return rows;
}

function bullishChain(): SDMOptionStrike[] {
  const rows: SDMOptionStrike[] = [];
  for (let i = 0; i < 10; i++) {
    const strike = 25000 + i * 50;
    rows.push({
      strike,
      ce: leg(100 + i, 5000, 10),
      pe: leg(90 + i, 15000, 200), // PCR = 3.0 bullish
    });
  }
  return rows;
}

function bearishChain(): SDMOptionStrike[] {
  const rows: SDMOptionStrike[] = [];
  for (let i = 0; i < 10; i++) {
    const strike = 25000 + i * 50;
    rows.push({
      strike,
      ce: leg(100 + i, 20000, 300), // PCR = 0.25 bearish
      pe: leg(90 + i, 5000, -10),
    });
  }
  return rows;
}

describe("runFullAnalysis — NEUTRAL never invents a PE leg", () => {
  test("neutral PCR → direction NEUTRAL, optionType undefined, action WAIT", () => {
    const a = runFullAnalysis(neutralChain(), 25140, "2099-01-01", "NIFTY");
    expect(a.sentiment).toBe("neutral");
    expect(a.recommendation.direction).toBe("NEUTRAL");
    expect(a.recommendation.optionType).toBeUndefined();
    expect(a.recommendation.action).toBe("WAIT");
    expect(a.recommendation.entryPrice).toBe(0);
    expect(a.recommendation.stopLoss).toBe(0);
    expect(a.recommendation.tp1).toBe(0);
  });

  test("neutral PCR → confidence is the neutral floor (40), not a PE score", () => {
    const a = runFullAnalysis(neutralChain(), 25140, "2099-01-01", "NIFTY");
    expect(a.recommendation.confidence).toBe(40);
    expect(a.recommendation.sdmScore).toBe(40);
  });

  test("bullish PCR → optionType CE with real CE entry", () => {
    const a = runFullAnalysis(bullishChain(), 25140, "2099-01-01", "NIFTY");
    expect(a.recommendation.direction).toBe("CALL");
    expect(a.recommendation.optionType).toBe("CE");
    expect(a.recommendation.action).toBe("BUY CALL");
    expect(a.recommendation.entryPrice).toBeGreaterThan(0);
  });

  test("bearish PCR → optionType PE with real PE entry", () => {
    const a = runFullAnalysis(bearishChain(), 25140, "2099-01-01", "NIFTY");
    expect(a.recommendation.direction).toBe("PUT");
    expect(a.recommendation.optionType).toBe("PE");
    expect(a.recommendation.action).toBe("BUY PUT");
    expect(a.recommendation.entryPrice).toBeGreaterThan(0);
  });

  test("neutral chain PE premium exists but is NOT selected as entry", () => {
    const chain = neutralChain();
    const atm = chain.find((s) => s.strike === 25150)!;
    expect(atm.pe!.ltp).toBeGreaterThan(5); // PE is a real premium
    const a = runFullAnalysis(chain, 25140, "2099-01-01", "NIFTY");
    expect(a.recommendation.entryPrice).toBe(0); // still not used
    expect(a.recommendation.optionType).toBeUndefined();
  });
});
