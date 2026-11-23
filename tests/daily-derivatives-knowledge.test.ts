import { describe, it, expect, afterEach } from "bun:test";
import {
  DAILY_DERIVATIVES_KNOWLEDGE,
  DAILY_DERIVATIVES_TOOL,
  DD_STRATEGY_RULES,
  formatDailyDerivativesReport,
  runGetDailyDerivatives,
} from "@/lib/daily-derivatives-knowledge";
import { AGENT_TOOLS } from "@/lib/agent-brain";
import { selectToolsV2 } from "@/lib/agent-brain-gate";
import { PLAN_CONFIG } from "@/lib/option-plan";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeReport() {
  return {
    underlying: "NIFTY",
    timestamp: "2026-11-20T10:00:00.000Z",
    spot: 24500,
    indiaVix: 14.2,
    indiaVixChange: -0.4,
    pcr: 1.12,
    maxPain: 24550,
    callWall: 24700,
    putWall: 24300,
    totalCallOI: 10000000,
    totalPutOI: 11200000,
    atmStrike: 24500,
    atmIV: 13.4,
    atmGreeks: { delta: 0.52, gamma: 0.0008, theta: -3.5, vega: 0.45, iv: 13.4 },
    topCallOI: [],
    topPutOI: [],
    expiry: "2026-11-23",
    daysToExpiry: 3,
    latestSignals: [],
    sentiment: "Neutral",
    sentimentScore: 52,
    tradePlans: [
      {
        optionType: "CE",
        strike: 24500,
        entry: 120,
        stopLoss: 96,
        targets: [168, 192, 216],
        rr: 2,
        lots: 1,
        deployed: 12000,
        riskAmount: 2400,
        tradable: true,
        otmSteps: 0,
        reason: "ATM, delta 0.52",
        setup: "BREAKOUT",
        targetReach: [],
      },
    ],
    planAsOf: "2026-11-20T10:00:00.000Z",
    preferredSide: "CALL",
    directionBias: {
      side: "CALL",
      callVotes: 3,
      putVotes: 1,
      confidence: 0.75,
      votes: [{ factor: "PCR", vote: "CALL", detail: "PCR 1.12 — put-heavy (bullish)" }],
    },
    candleSource: "breeze",
    candleInterval: "5minute",
    candleDegraded: null,
    candleCount: 76,
    warmupBars: 30,
    dataSource: "canonical",
    freshness: "FRESH",
    futuresRelVol: {
      ratio: 2.4,
      average: 210_000,
      current: 504_000,
      barTime: "23-Nov-2026 14:55:00",
    },
    cvd: {
      mode: "FUTURES_CANDLE_SIGN",
      available: true,
      bars: 76,
      windowBars: 3,
      cumulative: 1188915,
      deltaPercent: 22.53,
      estimatedBuyVolume: 3200000,
      estimatedSellVolume: 2100000,
      totalVolume: 5277025,
      priceChangePercent: 0.21,
      cvdChange: 100,
      verdict: "BEARISH",
      points: [],
      source: "breeze",
      contract: "NIFTY 2026-11-23 futures",
      oiFirst: 8725015,
      oiLast: 8528845,
      oiChange: -196170,
      oiChangePct: -2.25,
      buildup: "SHORT_COVERING",
      divergence: "PRICE_UP_OI_DOWN",
    },
  };
}

describe("Daily Derivatives knowledge (Hermes)", () => {
  it("registers the get_daily_derivatives tool", () => {
    const names = AGENT_TOOLS.map((t: any) => t.function.name);
    expect(names).toContain("get_daily_derivatives");
    expect(DAILY_DERIVATIVES_TOOL.function.name).toBe("get_daily_derivatives");
  });

  it("the live router picks it for flow / CVD questions", () => {
    const picked = selectToolsV2(
      "what does the futures CVD and open interest build-up say today?",
      AGENT_TOOLS
    ).map((t: any) => t.function.name);
    expect(picked).toContain("get_daily_derivatives");
  });

  it("the knowledge block carries the strategy rules and the honest limits", () => {
    expect(DAILY_DERIVATIVES_KNOWLEDGE).toContain("1:2");
    expect(DAILY_DERIVATIVES_KNOWLEDGE).toContain("13:00");
    expect(DAILY_DERIVATIVES_KNOWLEDGE.toLowerCase()).toContain("candle-signed");
    expect(DAILY_DERIVATIVES_KNOWLEDGE.toLowerCase()).toContain("0 lots");
  });

  it("the strategy rules mirror the canonical plan builder and gate", () => {
    expect(DD_STRATEGY_RULES.targetMultipliers).toEqual(PLAN_CONFIG.targetMultipliers);
    expect(DD_STRATEGY_RULES.riskPctOfDeployed).toBe(PLAN_CONFIG.riskPctOfDeployed);
    expect(DD_STRATEGY_RULES.maxDeployedAmount).toBe(PLAN_CONFIG.maxDeployedAmount);
    expect(DD_STRATEGY_RULES.minOptionRR).toBe(PLAN_CONFIG.minOptionRR);
    expect(DD_STRATEGY_RULES.noOptionBuysAfterIst).toBe("13:00");
  });

  it("formats CVD, OI build-up, the bias votes and the plan ladder", () => {
    const out = formatDailyDerivativesReport(fakeReport() as any);

    expect(out).toContain("NIFTY");
    expect(out).toContain("PCR 1.12");
    expect(out).toContain("CVD");
    expect(out).toContain("11,88,915");
    expect(out).toContain("SHORT_COVERING");
    expect(out).toContain("OI");
    expect(out).toContain("24,500");
    expect(out).toContain("120");
    expect(out).toContain("96");
    expect(out).toContain("168");
    // CVD is context — never a trade vote.
    expect(out.toLowerCase()).toContain("context");
    // The honest fake-breakout half: rel-vol is surfaced, not dropped.
    expect(out).toContain("Relative volume 2.40x");
    expect(out).toContain("conviction bar");
  });

  it("never fabricates a relative volume when the flow read has none", () => {
    const fake = fakeReport() as any;
    fake.futuresRelVol = null;
    const out = formatDailyDerivativesReport(fake);
    expect(out).toContain("Relative volume: unavailable");
    expect(out).not.toContain("1.00x");
  });

  it("the runner reads the live DD endpoint and returns the formatted report", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      urls.push(String(input));
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: fakeReport() }),
      } as any;
    }) as any;

    const out = await runGetDailyDerivatives({ symbol: "NIFTY" }, "http://dd.test");
    expect(urls[0]).toContain("/api/daily-derivatives");
    expect(urls[0]).toContain("symbol=NIFTY");
    expect(out).toContain("SHORT_COVERING");
  });

  it("never invents numbers when the feed is down", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 503,
      json: async () => ({ success: false, error: "NO_DATA" }),
    })) as any;

    const out = await runGetDailyDerivatives({ symbol: "NIFTY" }, "http://dd.test");
    expect(out.toLowerCase()).toContain("unavailable");
    expect(out).not.toContain("PCR 1.12");
  });
});
