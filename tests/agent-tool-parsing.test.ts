/// <reference types="bun-types" />
// Agent tool parsing — regression for the 2026-10-01 full data audit.
// Every fixture below is the REAL body shape captured from the live API that
// day. Tools previously failed on these because of wrong URLs, wrong nesting
// (data.data vs top-level) or `success`-flag checks on endpoints that don't
// send one. fetch is stubbed → offline, deterministic.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { executeTool } from "@/lib/agent-brain";
import { collectHermesContext } from "@/lib/hermes/context";
import { getRequiredTools } from "@/lib/hermes/tool-registry";

const CTX = { symbol: "NIFTY", spotPrice: 22421.95, analysis: {}, summary: { indiaVIX: 14.44 }, apiBase: "http://stub" };

// ── Real captured fixtures ───────────────────────────────────────────────
const FIXTURES: Array<[RegExp, any]> = [
  [/\/api\/gift-nifty/, { success: true, price: 22421.95, change: -294.25, changePct: -1.29, previousClose: 22716.2, gap: -294.25, gapPct: -1.29, source: "nse", timestamp: "2026-10-01T17:00:00Z" }],
  [/\/api\/fii-dii/, { success: true, fiiNet: -9484.22, diiNet: 10041.84, date: "2026-10-01", fiiNet5dAvg: -3200.5, diiNet5dAvg: 4100.2, source: "nse" }],
  [/\/api\/market\/regime/, { regime: "BEARISH", bias: "BEARISH", tradeEnv: "FAVOR SHORTS", regimeScore: -22, confidence: 61, vix: 14.44, factors: { indexTrend: -26, breadth: -40, futuresBasis: 0.12 } }],
  [/\/api\/market\/breadth/, { breadth: { score: 36, label: "BEARISH", advances: 13, declines: 35, unchanged: 0, total: 48, adRatio: 0.37 } }],
  [/\/api\/challenge(\?|$)/, { success: true, challenge: { number: 1, status: "ACTIVE", startingCapital: 15000, currentCapital: 18500, progressPct: 5, totalTrades: 12, winCount: 7, winRate: 58.3 } }],
  [/\/api\/cas-straddle/, { success: true, symbol: "NIFTY", signal: { strategy: "NO_TRADE", confidence: 0, tradeQuality: 37, reasoning: ["CAS dislocation 0.00% — negligible", "IV 14.4 in sweet spot"] } }],
  [/\/api\/atm-straddle/, { success: true, symbol: "NIFTY", range: { symbol: "NIFTY", spot: 22421.95, atmStrike: 22400, cePremium: 156.95, pePremium: 103.6, combinedPremium: 260.55, expectedMove: 101.7, expectedMovePct: 0.45, iv: 14.4, pcr: 1.06, maxPain: 22650 } }],
  [/\/api\/options-edge/, {
    success: true, data: {
      symbol: "NIFTY", spot: 22421.95,
      strikeAnalyses: [
        { strike: 22350, distanceFromATM: 71.95, moneyness: "ITM", ce: { ltp: 187.9, delta: 0.62, iv: 19.8, premiumMeltScore: 55 }, pe: { ltp: 76.2, delta: -0.38, iv: 20.4, premiumMeltScore: 41 } },
        { strike: 22400, distanceFromATM: 21.95, moneyness: "ATM", ce: { ltp: 156.1, delta: 0.54, gamma: 0.0007, theta: -23.32, iv: 20.2, oi: 3563820, premiumMeltScore: { score: 71.5, level: "EXTREME" }, expectedPremiumMove: 12.4, ivState: "FAIR", premiumVelocity: 3.2 }, pe: { ltp: 103.6, delta: -0.46, iv: 20.8, premiumMeltScore: 60 } },
      ],
      tradeDecision: { action: "WAIT", confidence: 45 },
    },
  }],
  [/\/api\/institutional-greeks/, {
    success: true, data: {
      strikes: [], spot: 22421.95, atmStrike: 22400, expectedMove: 101.7, regime: "Breakout", sessionPhase: "POST_CLOSE",
      dealerWallStrike: { strike: 22500, type: "PE", acceleration: 76.4, speed: "INSTANT" },
      institutionalStrike: { strike: 22400, type: "PE", acceleration: 76.4 },
      trapRiskStrike: { strike: 22650, type: "CE", acceleration: 60.6 },
      stale: false,
      metrics: { avgAcceleration: 49.7, maxAcceleration: 76.2, avgVelocity: 82.9, totalVolume: 77005235, totalOIChange: 1715645, pcr: 0.69, vix: 14.44, atrSource: "real" },
    },
  }],
  [/\/api\/scanner(\?|$)/, {
    success: true, data: {
      timestamp: "2026-10-01T17:00:00Z", marketDirection: "BULLISH",
      candidates: [
        { symbol: "SBILIFE", totalScore: 64, technicalScore: 60, optionsScore: 55, direction: "BULLISH" },
        { symbol: "BRITANNIA", totalScore: 66, technicalScore: 62, optionsScore: 51, direction: "BULLISH" },
      ],
    },
  }],
  [/\/api\/expiry-liquidity/, {
    success: true, data: {
      symbol: "NIFTY", isExpiryDay: false, casActive: false,
      casReferencePrice: 22430.5, currentPrice: 22421.95, casDislocationPct: -0.04,
      futuresPrice: 22450, futuresConfirmed: false, atmStrike: 22400,
      bullishScore: 40, bearishScore: 45, expiryScore: 38, direction: "NEUTRAL",
      optionFlow: { callMomentum: 42, putMomentum: 48, netFlow: -6 },
    },
  }],
  [/\/api\/sdm-signal/, {
    success: true, signal: {
      direction: "WAIT", strike: 22421.95, strikeType: "ATM", entry: 0, tp1: 0, tp2: 0, tp3: 0, sl: 0,
      confidence: 45, riskReward: 0, isExpiryDay: false, daysToExpiry: 5, currentWindow: "POST_CLOSE",
      windowTimeRemaining: "—", tradesTakenToday: 0, tradesRemaining: 3, mode: "SWING",
      marketContext: { spot: 22421.95, change: 0, changePercent: 0, pcr: 1.06, maxPain: 22650, vix: 14.44, trend: "sideways", regime: "trending" },
      sdmScores: { pcr: 50, oiConcentration: 40, oiChange: 30, delta: 55, iv: 60, volume: 45, maxPain: 70, liquidity: 65 },
      gammaThetaData: { gammaExposure: 1200, thetaDecayRate: -23.3, premiumDecayPercent: 1.2, ivSkew: 2.1, vixLevel: 14.44, gammaBlastDetected: false },
      whyThisTrade: [{ type: "OI", signal: "Put writing at 22300", detail: "support holds" }],
      reason: "No edge at this hour", positionSizing: { lots: 2, quantity: 150, riskAmount: 2000, positionValue: 23500, maxLoss: 2000 },
      marketRegime: "trending", tradeGrade: "C", holdingTimeEstimate: "Intraday", expectedMove: 101.7,
      smartEntry: 0, smartExit: 0, premiumFairValue: 130, probabilities: { win: 0.5 }, watchList: [],
      sellerSLZone: "—", dataHealth: 95, timeSensitiveNote: "",
    },
  }],
  // context: /api/news WITHOUT ?symbol returns { success, data:{ label, overall, articles } };
  // WITH ?symbol (the old fetch URL) returns articles at TOP level — the shape
  // that made the supervisor's news slice always null.
  [/\/api\/news(\?|$)/, (u: string) => u.includes("symbol=")
    ? { success: true, symbol: "NIFTY", source: "Yahoo Finance", articles: [{ title: "RBI holds rates steady" }, { title: "FII sell ₹9,484 cr" }], count: 2, timestamp: "2026-10-01T17:00:00Z" }
    : { success: true, data: { overall: 49, label: "NEUTRAL", articles: [{ title: "RBI holds rates steady" }, { title: "FII sell ₹9,484 cr" }], timestamp: "2026-10-01T17:00:00Z" } }],
  [/\/api\/backtest\/trades/, { success: true, summary: { winRate: 50.9, profitFactor: 1.01, netPnL: 172.84, totalTrades: 542, avgWin: 850, avgLoss: -620 }, trades: [] }],
  [/\/api\/option-chain/, { success: true, source: "icici-breeze", data: { symbol: "NIFTY", spotPrice: 22421.95, strikes: [], summary: { spotPrice: 22421.95, indiaVIX: 14.44, atmStrike: 22400, maxPain: 22650, pcr: 1.06 } } }],
  [/\/api\/greek-flow/, { success: true, source: "nse-api", result: { strikes: [], dealerWallStrike: 22500, regime: "Breakout", metrics: { pcr: 0.69, maxAcceleration: 76.2 } } }],
];

let origFetch: any;

beforeAll(() => {
  origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts?: any) => {
    const u = String(url);
    const hit = FIXTURES.find(([re]) => re.test(u));
    if (!hit) return new Response("<html>404</html>", { status: 404 });
    const body = typeof hit[1] === "function" ? (hit[1] as any)(u) : hit[1];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

describe("tool parsing vs real API shapes", () => {
  it("get_gift_nifty reads top-level price/gap (no data wrapper)", async () => {
    const out = await executeTool("get_gift_nifty", {}, CTX);
    expect(out).not.toMatch(/Error fetching/);
    expect(out).toContain("22421.95");
    expect(out).toContain("GAP DOWN");
  });

  it("get_fii_dii reads top-level fiiNet (no latest wrapper)", async () => {
    const out = await executeTool("get_fii_dii", {}, CTX);
    expect(out).not.toMatch(/undefined/);
    expect(out).toContain("-9484.22");
    expect(out).toContain("10041.84");
  });

  it("get_market_regime accepts body without success flag", async () => {
    const out = await executeTool("get_market_regime", { symbol: "NIFTY" }, CTX);
    expect(out).not.toContain("Failed to fetch market regime");
    expect(out).toContain("BEARISH");
  });

  it("get_market_breadth accepts body without success flag", async () => {
    const out = await executeTool("get_market_breadth", {}, CTX);
    expect(out).not.toContain("Failed to fetch market breadth");
    expect(out).toMatch(/BEARISH|36/);
  });

  it("get_challenge_status calls /api/challenge and reads challenge key", async () => {
    const out = await executeTool("get_challenge_status", {}, CTX);
    expect(out).not.toMatch(/Failed|Error/);
    expect(out).toContain("58.3");
    expect(out).toContain("15,000");
  });

  it("get_cas_analysis calls /api/cas-straddle and reads signal", async () => {
    const out = await executeTool("get_cas_analysis", { symbol: "NIFTY" }, CTX);
    expect(out).not.toContain("Failed to fetch CAS analysis");
    expect(out).toContain("NO_TRADE");
    expect(out).toContain("37");
  });

  it("get_atm_straddle reads range.* (no data wrapper)", async () => {
    const out = await executeTool("get_atm_straddle", { symbol: "NIFTY" }, CTX);
    expect(out).not.toMatch(/Failed|Error/);
    expect(out).toContain("22400");
    expect(out).toContain("260.55");
  });

  it("get_options_edge reads strikeAnalyses for the requested strike", async () => {
    const out = await executeTool("get_options_edge", { symbol: "NIFTY", strike: 22400, side: "CE" }, CTX);
    expect(out).not.toMatch(/Failed|No options edge data/);
    expect(out).toContain("0.5400");
    expect(out).toContain("20.2");
  });

  it("get_institutional_positioning shows real metrics/walls (not all N/A)", async () => {
    const out = await executeTool("get_institutional_positioning", { symbol: "NIFTY" }, CTX);
    expect(out).not.toMatch(/FII: N\/A/);
    expect(out).not.toMatch(/\[object Object\]/); // walls are objects — must render strike/type
    expect(out).toContain("22500"); // dealer wall
    expect(out).toContain("PE");
    expect(out).toContain("76.2"); // max acceleration
    expect(out).toContain("Breakout");
  });

  it("get_option_chain reads PCR from summary (no undefined)", async () => {
    const out = await executeTool("get_option_chain", { symbol: "NIFTY" }, CTX);
    expect(out).not.toMatch(/undefined/);
    expect(out).toContain("PCR: 1.06");
    expect(out).toContain("22421.95");
  });

  it("get_scanner_picks reads real candidate field names (no undefined)", async () => {
    const out = await executeTool("get_scanner_picks", { symbol: "NIFTY" }, CTX);
    expect(out).not.toMatch(/undefined/);
    expect(out).toContain("SBILIFE");
    expect(out).toContain("64");
    expect(out).toContain("BULLISH");
  });

  it("get_market_regime renders factors object (no crash)", async () => {
    const out = await executeTool("get_market_regime", { symbol: "NIFTY" }, CTX);
    expect(out).not.toMatch(/Error fetching|undefined|\[object Object\]/);
    expect(out).toContain("indexTrend");
  });

  it("get_options_edge renders melt score object (no [object Object])", async () => {
    const out = await executeTool("get_options_edge", { symbol: "NIFTY", strike: 22400, side: "CE" }, CTX);
    expect(out).not.toMatch(/\[object Object\]/);
    expect(out).toContain("71.5");
    expect(out).toContain("EXTREME");
  });

  it("get_expiry_liquidity parses real route shape", async () => {
    const out = await executeTool("get_expiry_liquidity", { symbol: "NIFTY" }, CTX);
    expect(out).not.toMatch(/N\/A \|/); // old parse rendered every field N/A
    expect(out).toContain("NEUTRAL");
    expect(out).toContain("-0.04");
  });

  it("get_sdm_signal renders V2 signal without undefined structure fields", async () => {
    const out = await executeTool("get_sdm_signal", { symbol: "NIFTY" }, CTX);
    expect(out).not.toMatch(/undefined/);
    expect(out).toContain("sideways"); // marketContext.trend
    expect(out).toContain("22421.95");
  });

  it("get_market_structure falls back to marketContext when V2 has no structure", async () => {
    const out = await executeTool("get_market_structure", { symbol: "NIFTY" }, CTX);
    expect(out).not.toContain("No market structure data");
    expect(out).toContain("sideways");
  });

  it("get_trade_recommendation renders spot from marketContext", async () => {
    const out = await executeTool("get_trade_recommendation", { symbol: "NIFTY" }, CTX);
    expect(out).toContain("22421.95");
    expect(out).toMatch(/sideways/);
  });
});

describe("data-validation guards", () => {
  it("runQualityGates survives a chain with missing pcr (was a Hermes crash)", async () => {
    const { runQualityGates } = await import("@/lib/data-validation");
    const gates = runQualityGates({ strikes: [], atmStrike: 22400, pcr: undefined } as any, 22421.95, 14.44, "test");
    const pcrGate = gates.find((g: any) => g.gate === "PCR_REASONABLE");
    expect(pcrGate).toBeTruthy();
    expect(pcrGate!.passed).toBe(false);
    expect(pcrGate!.reason).toMatch(/missing/i);
  });
});

describe("hermes supervisor context vs real API shapes", () => {
  it("news slice populated from /api/news (label + articles)", async () => {
    const c: any = await collectHermesContext("NIFTY", "RESEARCH", "http://stub");
    expect(c.news?.value).toBeTruthy();
    expect(c.news.value.sentiment).toBe("NEUTRAL");
    expect(c.news.value.headlines.join(" ")).toContain("RBI holds rates");
  });

  it("LIVE_TRADE mode fetches backtest results (supervisor has all data)", async () => {
    expect(getRequiredTools("LIVE_TRADE")).toContain("get_backtest_results");
    const c: any = await collectHermesContext("NIFTY", "TRADE", "http://stub");
    expect(c.backtestResults?.value).toBeTruthy();
    expect(c.backtestResults.value.totalTrades).toBe(542);
  });

  it("structure trend falls back to marketContext.trend (V2 signal)", async () => {
    const c: any = await collectHermesContext("NIFTY", "RESEARCH", "http://stub");
    expect(c.marketStructure?.value).toBeTruthy();
    expect(c.marketStructure.value.trend).toBe("sideways");
  });
});
