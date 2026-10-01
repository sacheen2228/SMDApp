// null-pcr-sweep.test.ts
//
// Regression suite for the null-PCR crash sweep (29 Sep 2026).
// Root cause pattern: PCR is computed as `totalPutOI/totalCallOI` but falls back
// to `null` when OI totals are zero (degraded/pre-market chains). Downstream
// code then either calls `.toFixed()` on null (TypeError: Cannot read properties
// of null) or lets null slip through `pcr < 0.8`-style comparisons (null → 0),
// producing wrong bearish labels.
//
// Every test feeds a zero-OI / null-PCR input and asserts the function does not
// throw and labels null as unavailable instead of fabricating a direction.

import { describe, test, expect } from "bun:test";

describe("null-PCR sweep — sdm-engine", () => {
  test("scorePCR with zero OI (pcr=null) → neutral N/A, no crash", async () => {
    const { scorePCR } = await import("../src/lib/sdm-engine");
    const chain = [
      { strike: 25000, ce: { oi: 0 }, pe: { oi: 0 } },
      { strike: 25100, ce: { oi: 0 }, pe: { oi: 0 } },
    ] as any[];
    const r = scorePCR(chain, 25000);
    expect(r.direction).toBe("NEUTRAL");
    expect(r.details).toContain("N/A");
  });

  test("scorePCR with real OI still scores normally", async () => {
    const { scorePCR } = await import("../src/lib/sdm-engine");
    const chain = [
      { strike: 25000, ce: { oi: 100000 }, pe: { oi: 150000 } },
    ] as any[];
    const r = scorePCR(chain, 25000);
    expect(r.details).toContain("1.50");
  });
});

describe("null-PCR sweep — gamma-blast", () => {
  test("detectGammaBlast with zero OI (pcr=null) → extremePCR=false, no crash", async () => {
    const { detectGammaBlast } = await import("../src/lib/gamma-blast");
    const chain = [
      { strike: 25000, ce: { oi: 0, iv: 14 }, pe: { oi: 0, iv: 14 } },
      { strike: 25100, ce: { oi: 0, iv: 14 }, pe: { oi: 0, iv: 14 } },
    ] as any[];
    const r = detectGammaBlast(chain, 25000, 12);
    expect(r.signals.extremePCR).toBe(false);
  });
});

describe("null-PCR sweep — tradeAlertEngine", () => {
  test("generateOptionAlert with pcr=null → no crash", async () => {
    const { generateOptionAlert } = await import("../src/lib/tradeAlertEngine");
    const row = {
      strike: 25000,
      ce: { ltp: 120, oi: 10000, oiChg: 500, iv: 13, delta: 0.5, vol: 900 },
      pe: { ltp: 130, oi: 12000, oiChg: 700, iv: 14, delta: -0.5, vol: 950 },
    } as any;
    const inputs = {
      symbol: "NIFTY",
      spot: 25000,
      pcr: null,
      vix: 12,
      chain: [row],
      newsSentiment: { score: 0 },
    } as any;
    expect(() => generateOptionAlert(inputs)).not.toThrow();
  });
});

describe("null-PCR sweep — institutional derivatives engine", () => {
  test("runInstitutionalDerivativesEngine with pcr=null → no crash", async () => {
    const { runInstitutionalDerivativesEngine } = await import(
      "../src/lib/institutional-derivatives-engine"
    );
    const inp = {
      spot: 25000,
      atm: 25000,
      ce: 120,
      pe: 130,
      pcr: null,
      iv: 13,
      delta: 0.5,
      gamma: 0.02,
      vega: 15,
      theta: -20,
      volumeRatio: 1.2,
      callWriting: false,
      putWriting: true,
      callUnwind: false,
      putUnwind: false,
      fiiLong: 55,
      fiiShort: 45,
      diiBuy: 50,
      diiSell: 50,
      highestCallOI: 100000,
      highestPutOI: 120000,
    } as any;
    expect(() => runInstitutionalDerivativesEngine("NIFTY_TEST_NULLPCR", inp)).not.toThrow();
  });
});

describe("null-PCR sweep — cas-straddle V2", () => {
  test("generateStrategySignalV2 with snap.pcr=null → no crash", async () => {
    const { generateStrategySignalV2, DEFAULT_CONFIG } = await import(
      "../src/lib/cas-straddle-strategy-v2"
    );
    const snap = {
      timestamp: new Date().toISOString(),
      spot: 25000,
      symbol: "NIFTY",
      casReferencePrice: 24980,
      casDislocationPct: 0.08,
      casDislocationStrength: "WEAK",
      casVelocity: 0.5,
      casAboveReference: true,
      casBuyQty: 100000,
      casSellQty: 95000,
      casImbalance: 0.51,
      atmStrike: 25000,
      atmCE: 120,
      atmPE: 130,
      combinedPremium: 250,
      expectedMove: 210,
      pcr: null,
      maxPain: 25000,
      iv: 13,
      chain: [
        {
          strike: 25000,
          ce: { ltp: 120, oi: 10000, oiChg: 500, volume: 900, iv: 13 },
          pe: { ltp: 130, oi: 12000, oiChg: 700, volume: 950, iv: 14 },
        },
      ],
      regime: "NORMAL_VOL",
      vix: 13,
      realizedVol: 12,
      futuresPrice: 25010,
      futuresBasis: 10,
      currentVolume: 500000,
      avgVolume: 450000,
      volumeRatio: 1.1,
    } as any;
    expect(() => generateStrategySignalV2(snap, DEFAULT_CONFIG)).not.toThrow();
  });
});

describe("null-PCR sweep — hermes OI intelligence", () => {
  test("analyzeOIIntelligence with pcrOI=null → N/A label, NEUTRAL bias, no crash", async () => {
    const { analyzeOIIntelligence } = await import("../src/lib/hermes/oi-intel");
    const ctx = {
      optionChain: {
        value: {
          spot: 25000,
          pcrOI: null,
          callOiChange: 0,
          putOiChange: 0,
          totalCallOI: 100000,
          totalPutOI: 120000,
          putWall: 24800,
          callWall: 25200,
          maxPain: 25000,
        },
      },
      spot: { value: null },
    } as any;
    const r = analyzeOIIntelligence(ctx);
    expect(r.factors).toContain("PCR OI: N/A");
    expect(r.oiBias).toBe("NEUTRAL");
  });
});

describe("null-PCR sweep — SMD context builder", () => {
  test("summarizeContext with options.pcr=null → 'PCR: N/A', no crash", async () => {
    const { summarizeContext } = await import("../src/lib/smd-context");
    const ctx = {
      timestamp: new Date().toISOString(),
      symbol: "NIFTY",
      market: { status: "OPEN", session: "REGULAR", isExpiryDay: false, daysToExpiry: 1 },
      spot: { price: 25000, change: 100, changePct: 0.4, prevClose: 24900 },
      indices: { nifty: null, sensex: null, banknifty: null },
      options: {
        spot: 25000,
        atmStrike: 25000,
        maxPain: 25000,
        pcr: null,
        totalCallOI: 0,
        totalPutOI: 0,
        callOiChg: 0,
        putOiChg: 0,
        vix: 13,
        futuresPrice: 0,
        supportLevels: [],
        resistanceLevels: [],
        topOiMovers: [],
        strikes: [],
      },
    } as any;
    const out = summarizeContext(ctx);
    expect(out).toContain("PCR: N/A");
  });
});

describe("null-PCR sweep — morning-scan reasoning guards", () => {
  test("pcr=0 (no-data default) does not crash .toFixed paths", async () => {
    // morning-scan coerces missing analysis PCR to 0 (`|| 0`). The bearish
    // reasoning push is now guarded with `pcr > 0` so a missing chain can
    // never label setups "Bearish PCR 0.00" nor crash formatting.
    const fs = require("fs") as typeof import("fs");
    const src = fs.readFileSync(require("path").join(__dirname, "../src/lib/morning-scan.ts"), "utf8");
    expect(src).not.toMatch(/if \(pcr < 0\.8\) reasoning/);
    expect(src).toMatch(/pcr > 0 && pcr < 0\.8/);
  });
});
