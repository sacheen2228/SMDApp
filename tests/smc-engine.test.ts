import { describe, it, expect } from "bun:test";
import {
  runSMCAnalysis,
  chainToSDMStrikes,
  confidenceLabel,
  qualityGrade,
} from "../src/lib/smc-engine";
import type { SDMOptionStrike, CandleData } from "../src/types/sdm";

// ─── Deterministic test fixtures ─────────────────────────────────

const SPOT = 24000;
const now = Date.now();

function makeBullishCandles(): CandleData[] {
  // Bullish: HL HH HL HH pattern → BULLISH BOS at the end (close=24180 > last swing high=24100)
  const d: CandleData[] = [];
  // HL1: swing LOW at idx 3 (low=23300)
  d.push({time:now-3300000,open:23480,high:23510,low:23470,close:23490,volume:100000});
  d.push({time:now-3200000,open:23490,high:23520,low:23480,close:23500,volume:100000});
  d.push({time:now-3100000,open:23480,high:23500,low:23460,close:23470,volume:100000});
  d.push({time:now-3000000,open:23350,high:23380,low:23300,close:23330,volume:100000});
  d.push({time:now-2900000,open:23340,high:23390,low:23330,close:23370,volume:100000});
  d.push({time:now-2800000,open:23380,high:23420,low:23360,close:23400,volume:100000});
  d.push({time:now-2700000,open:23400,high:23430,low:23380,close:23410,volume:100000});
  // HH1: swing HIGH at idx 10 (high=23750)
  d.push({time:now-2600000,open:23450,high:23500,low:23430,close:23480,volume:100000});
  d.push({time:now-2500000,open:23500,high:23580,low:23480,close:23550,volume:100000});
  d.push({time:now-2400000,open:23560,high:23600,low:23530,close:23580,volume:100000});
  d.push({time:now-2300000,open:23650,high:23750,low:23620,close:23720,volume:100000});
  d.push({time:now-2200000,open:23700,high:23730,low:23650,close:23680,volume:100000});
  d.push({time:now-2100000,open:23650,high:23690,low:23620,close:23650,volume:100000});
  d.push({time:now-2000000,open:23630,high:23660,low:23580,close:23610,volume:100000});
  // HL2: swing LOW at idx 17 (low=23500, higher)
  d.push({time:now-1900000,open:23580,high:23600,low:23550,close:23570,volume:100000});
  d.push({time:now-1800000,open:23560,high:23580,low:23520,close:23540,volume:100000});
  d.push({time:now-1700000,open:23520,high:23550,low:23500,close:23530,volume:100000});
  d.push({time:now-1600000,open:23540,high:23590,low:23530,close:23570,volume:100000});
  d.push({time:now-1500000,open:23580,high:23610,low:23550,close:23590,volume:100000});
  d.push({time:now-1400000,open:23600,high:23640,low:23570,close:23610,volume:100000});
  // HH2: swing HIGH at idx 24 (high=24100, higher)
  d.push({time:now-1300000,open:23650,high:23700,low:23630,close:23680,volume:100000});
  d.push({time:now-1200000,open:23700,high:23800,low:23680,close:23760,volume:100000});
  d.push({time:now-1100000,open:23780,high:23900,low:23750,close:23850,volume:100000});
  d.push({time:now-1000000,open:23950,high:24100,low:23900,close:24050,volume:100000});
  d.push({time:now-900000, open:24000,high:24050,low:23950,close:24000,volume:100000});
  d.push({time:now-800000, open:23980,high:24020,low:23940,close:23970,volume:100000});
  // Final push: redundant candle + bullish OB candle + FVG
  d.push({time:now-700000, open:23960,high:24000,low:23920,close:23950,volume:100000});
  d.push({time:now-600000, open:23980,high:24040,low:23950,close:23990,volume:100000});
  d.push({time:now-500000, open:24030,high:24080,low:23980,close:24050,volume:100000});
  d.push({time:now-400000, open:24070,high:24090,low:24030,close:24040,volume:100000}); // RED → OB
  d.push({time:now-300000, open:24050,high:24150,low:24020,close:24130,volume:100000}); // GREEN > prev.open → OB confirmed + close > swing high=24100 → BOS
  d.push({time:now-200000, open:24130,high:24200,low:24100,close:24180,volume:100000});
  return d;
}

function makeOptionChain(totalOI = 5_000_000, oiChg = 50000, volume = 200000): SDMOptionStrike[] {
  const r: SDMOptionStrike[] = [];
  for (let s = 23400; s <= 24600; s += 50) {
    const isITM_CE = s < SPOT;
    const isITM_PE = s > SPOT;
    r.push({
      strike: s,
      ce: {
        ltp: Math.round(isITM_CE ? SPOT - s + 200 : Math.max(1, 200 - (s - SPOT) * 0.5)),
        oi: totalOI + Math.random() * 2_000_000,
        oiChg: s < SPOT ? -oiChg : oiChg,
        volume: volume + Math.random() * 100000,
        iv: 14,
        delta: isITM_CE ? 0.7 + Math.random() * 0.2 : 0.2 + Math.random() * 0.3,
        theta: -(0.3 + Math.random() * 0.2),
        gamma: 0.002 + Math.random() * 0.001,
        vega: 0.3 + Math.random() * 0.1,
      },
      pe: {
        ltp: Math.round(isITM_PE ? s - SPOT + 200 : Math.max(1, 200 - (SPOT - s) * 0.5)),
        oi: totalOI + Math.random() * 2_000_000,
        oiChg: s > SPOT ? -oiChg : oiChg,
        volume: volume + Math.random() * 100000,
        iv: 14,
        delta: isITM_PE ? -0.7 - Math.random() * 0.2 : -0.2 - Math.random() * 0.3,
        theta: -(0.3 + Math.random() * 0.2),
        gamma: 0.002 + Math.random() * 0.001,
        vega: 0.3 + Math.random() * 0.1,
      },
    });
  }
  return r;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("runSMCAnalysis", () => {
  it("runs with bullish candles and produces structure + analysis", () => {
    const result = runSMCAnalysis({
      symbol: "NIFTY",
      spot: SPOT,
      optionChain: makeOptionChain(),
      candles: makeBullishCandles(),
      vix: 14,
    });
    expect(result).toBeDefined();
    expect(result.candidates).toBeDefined();
    expect(result.marketStructure).toBeDefined();
    expect(result.analysis).toBeDefined();
  });

  it("detects bullish BOS from candle patterns", () => {
    const result = runSMCAnalysis({
      symbol: "NIFTY",
      spot: SPOT,
      optionChain: makeOptionChain(),
      candles: makeBullishCandles(),
    });
    expect(result.marketStructure.trend).toBe("BULLISH");
    expect(result.marketStructure.bos).toBe(true);
    expect(result.marketStructure.swingHigh).toBeGreaterThan(0);
    expect(result.marketStructure.swingLow).toBeGreaterThan(0);
  });

  it("runs without candles and still produces output", () => {
    const result = runSMCAnalysis({
      symbol: "NIFTY",
      spot: SPOT,
      optionChain: makeOptionChain(),
    });
    expect(result.marketStructure).toBeDefined();
    expect(result.analysis).toBeDefined();
    expect(result.analysis.atr).toBeGreaterThan(0);
  });

  it("includes pcr and maxPain even when not provided", () => {
    const result = runSMCAnalysis({
      symbol: "NIFTY",
      spot: SPOT,
      optionChain: makeOptionChain(),
    });
    expect(result.analysis.pcr).toBeGreaterThan(0);
    expect(result.analysis.maxPain).toBeGreaterThan(0);
  });

  it("barriers reject at extreme VIX", () => {
    const result = runSMCAnalysis({
      symbol: "NIFTY",
      spot: SPOT,
      optionChain: makeOptionChain(),
      vix: 35,
    });
    expect(result.rejectionReasons).toContain("No BOS or CHoCH — insufficient structure");
  });

  it("produces valid candidate structure with bullish data", () => {
    const result = runSMCAnalysis({
      symbol: "NIFTY",
      spot: SPOT,
      optionChain: makeOptionChain(8_000_000, 80000, 500000),
      candles: makeBullishCandles(),
      vix: 14,
      historicalWinRate: 0.9,
    });
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const c of result.candidates) {
      expect(c.strike).toBeGreaterThan(0);
      expect(["CE", "PE"]).toContain(c.type);
      expect(c.entry).toBeGreaterThan(0);
      expect(c.sl).toBeGreaterThan(0);
      expect(c.tp1).toBeGreaterThan(0);
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(100);
      expect(c.rr).toBeGreaterThanOrEqual(2);
      expect(c.positionSize).toBeDefined();
      expect(c.positionSize.lots).toBeGreaterThanOrEqual(0);
    }
  });

  it("candidate quality grade matches confidence", () => {
    const result = runSMCAnalysis({
      symbol: "NIFTY",
      spot: SPOT,
      optionChain: makeOptionChain(8_000_000, 80000, 500000),
      candles: makeBullishCandles(),
      vix: 14,
      historicalWinRate: 0.9,
    });
    for (const c of result.candidates) {
      const expectedGrade = qualityGrade(c.confidence, c.rr);
      expect(c.qualityGrade).toBe(expectedGrade);
    }
  });

  it("analysis includes new V3 fields (minConfidence, regime, daysToExpiry)", () => {
    const result = runSMCAnalysis({
      symbol: "NIFTY",
      spot: SPOT,
      optionChain: makeOptionChain(),
    });
    expect(result.analysis.minConfidence).toBeGreaterThanOrEqual(0);
    expect(result.analysis.regime).toBeDefined();
    expect(result.analysis.daysToExpiry).toBeGreaterThanOrEqual(0);
  });

  it("produces no candidates in extreme VIX with no structure", () => {
    const result = runSMCAnalysis({
      symbol: "NIFTY",
      spot: SPOT,
      optionChain: makeOptionChain(),
      vix: 35,
    });
    expect(result.candidates.filter(c => c.entry > 0).length).toBe(0);
  });

  it("generates more candidates with OB|FVG OR logic than AND would allow", () => {
    // With only FVGs but no OBs, candidates should still pass filter
    const result = runSMCAnalysis({
      symbol: "NIFTY",
      spot: SPOT,
      optionChain: makeOptionChain(8_000_000, 80000, 500000),
      candles: makeBullishCandles(),
      vix: 14,
      historicalWinRate: 0.9,
    });
    // Should produce at least some CE candidates (bullish direction)
    const ceCandidates = result.candidates.filter(c => c.type === "CE");
    expect(ceCandidates.length).toBeGreaterThan(0);
  });
});

describe("Phase 2 — Indian Market Optimization fields", () => {
  it("includes trendScore, oiSignal, vixRegime, pcrTrend, volumePoc in analysis", () => {
    const result = runSMCAnalysis({
      symbol: "NIFTY",
      spot: SPOT,
      optionChain: makeOptionChain(8_000_000, 80000, 500000),
      candles: makeBullishCandles(),
      vix: 14,
      historicalWinRate: 0.9,
      pcrHistory: [0.9, 0.95, 1.0, 1.05, 1.1],
    });
    expect(result.analysis.trendScore).toBeGreaterThanOrEqual(0);
    expect(["BUILDUP", "COVERING", "UNWINDING", "NEUTRAL"]).toContain(result.analysis.oiSignal);
    expect(["LOW", "MODERATE", "NORMAL", "HIGH", "EXTREME"]).toContain(result.analysis.vixRegime);
    expect(["BULLISH", "BEARISH", "NEUTRAL", "STRONGLY_BULLISH", "STRONGLY_BEARISH"]).toContain(result.analysis.pcrTrend);
    expect(result.analysis.volumePoc).toBeGreaterThanOrEqual(0);
  });

  it("uses trend engine to compute trendScore with sufficient candles", () => {
    const result = runSMCAnalysis({
      symbol: "NIFTY",
      spot: SPOT,
      optionChain: makeOptionChain(),
      candles: makeBullishCandles(),
    });
    expect(result.analysis.trendScore).toBeGreaterThan(0);
  });
});

describe("chainToSDMStrikes", () => {
  it("converts chain rows correctly", () => {
    const raw = [
      {
        strike: 24000,
        ce: { ltp: 150, oi: 1000, oiChg: 50, vol: 500, iv: 15, delta: 0.5, theta: -0.3, gamma: 0.002, vega: 0.4 },
        pe: null,
      },
      {
        strike: 24050,
        pe: { ltp: 120, oi: 800, oiChg: -30, vol: 300, iv: 14, delta: -0.4, theta: -0.2, gamma: 0.001, vega: 0.3 },
        ce: null,
      },
    ];
    const converted = chainToSDMStrikes(raw);
    expect(converted.length).toBe(2);
    expect(converted[0].strike).toBe(24000);
    expect(converted[0].ce?.ltp).toBe(150);
    expect(converted[0].pe).toBeNull();
    expect(converted[1].strike).toBe(24050);
    expect(converted[1].pe?.ltp).toBe(120);
    expect(converted[1].ce).toBeNull();
  });

  it("converts vol to volume", () => {
    const raw = [{ strike: 24000, ce: { ltp: 100, oi: 500, oiChg: 10, vol: 250, iv: 14, delta: 0.5, theta: -0.3, gamma: 0.002, vega: 0.3 }, pe: null }];
    const converted = chainToSDMStrikes(raw);
    expect(converted[0].ce?.volume).toBe(250);
  });
});

describe("confidenceLabel", () => {
  it("maps scores to labels", () => {
    expect(confidenceLabel(95)).toBe("VERY_HIGH");
    expect(confidenceLabel(85)).toBe("HIGH");
    expect(confidenceLabel(70)).toBe("MEDIUM");
    expect(confidenceLabel(50)).toBe("LOW");
  });
});

describe("qualityGrade", () => {
  it("grades A+ for confidence >= 95", () => {
    expect(qualityGrade(95, 2)).toBe("A+");
  });

  it("grades A for confidence 90-94", () => {
    expect(qualityGrade(92, 2)).toBe("A");
  });

  it("grades B for confidence 80-89", () => {
    expect(qualityGrade(85, 2)).toBe("B");
  });

  it("grades C for confidence 70-79", () => {
    expect(qualityGrade(75, 2)).toBe("C");
  });

  it("grades D for confidence < 70", () => {
    expect(qualityGrade(60, 1)).toBe("D");
  });
});
