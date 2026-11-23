import { describe, it, expect } from "bun:test";
import { runAllAgents } from "@/lib/agents/registry-30";
import type { AgentContext } from "@/lib/agents/agent-contract";

function baseCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  const iso = new Date().toISOString();
  return {
    symbol: "NIFTY",
    timeframe: "15m",
    exchange: "NSE",
    instrument: "index",
    spot: 24500,
    prevClose: 24450,
    open: 24460,
    high: 24560,
    low: 24420,
    // Aggregate index quote volume — NOT the futures leg. It must never be
    // treated as breakout confirmation.
    volume: 50000000,
    optionChain: { spot: 24500, strikes: [], expiry: "2026-11-23", daysToExpiry: 3 },
    strikes: [],
    vix: 14,
    vixChange: 0,
    fiiNet: 0,
    diiNet: 0,
    fiiBias: "NEUTRAL",
    participantOI: null,
    regime: "TRENDING_UP",
    regimeBias: "BULLISH",
    regimeConfidence: 60,
    trend: "UP",
    swingHigh: 24560,
    swingLow: 24420,
    supportLevels: [24400],
    resistanceLevels: [24600],
    pdh: 24480,
    pdl: 24350,
    lastEvent: "BOS_UP",
    atmDelta: 0.52,
    atmGamma: 0.0008,
    atmTheta: -3.5,
    atmVega: 0.45,
    atmIV: 13.4,
    totalVolume: 0,
    poc: 0,
    vah: 0,
    val: 0,
    gammaDetected: false,
    gammaWallStrike: 0,
    gammaFlip: 0,
    dealerBias: "NEUTRAL",
    newsSentiment: "NEUTRAL",
    newsScore: 0,
    headlines: [],
    marketStatus: "OPEN",
    daysToExpiry: 3,
    expiry: "2026-11-23",
    dataTimestamp: iso,
    spotFreshness: "FRESH",
    chainFreshness: "FRESH",
    fetchedAtIso: iso,
    ...overrides,
  } as AgentContext;
}

const FLOW_STRONG = {
  available: true,
  source: "breeze",
  contract: "NIFTY 2026-11-23 futures",
  bars: 76,
  cvd: 1188915,
  deltaPercent: 22.53,
  verdict: "BULLISH",
  oiChange: 120000,
  oiChangePct: 1.4,
  buildup: "LONG_BUILDUP" as const,
  divergence: "PRICE_UP_OI_UP" as const,
  relativeVolume: 2.1,
  avgVolume: 90000,
  lastBarVolume: 189000,
};

const FLOW_COVERING = {
  ...FLOW_STRONG,
  oiChange: -196170,
  oiChangePct: -2.25,
  buildup: "SHORT_COVERING" as const,
  divergence: "PRICE_UP_OI_DOWN" as const,
};

describe("Grok flow evidence (VOLUME + BREAKOUT)", () => {
  it("BREAKOUT confirms a breakout from the REAL futures volume + OI build-up", async () => {
    const out = await runAllAgents(baseCtx({ flow: FLOW_STRONG } as any), ["BREAKOUT"]);
    const bo = out[0];

    expect(bo.agentId).toBe("BREAKOUT");
    expect(bo.bias).toBe("BULLISH");
    expect(bo.evidence.join(" | ").toLowerCase()).toContain("futures");
    expect(bo.evidence.join(" | ").toLowerCase()).toContain("confirms");
    expect(bo.riskFlags.join(" | ").toLowerCase()).not.toContain("possible fakeout");
  });

  it("BREAKOUT flags a short-covering breakout as less durable", async () => {
    const out = await runAllAgents(baseCtx({ flow: FLOW_COVERING } as any), ["BREAKOUT"]);
    const bo = out[0];
    expect(bo.riskFlags.join(" | ").toLowerCase()).toContain("short covering");
  });

  it("BREAKOUT reports weak futures volume as unconfirmed — never a fakeout claim", async () => {
    const out = await runAllAgents(
      baseCtx({ flow: { ...FLOW_STRONG, relativeVolume: 0.8 } } as any),
      ["BREAKOUT"]
    );
    const bo = out[0];
    expect(bo.evidence.join(" | ")).not.toContain("Volume confirmation available");
    expect(bo.riskFlags.join(" | ").toLowerCase()).toContain("unconfirmed");
  });

  it("BREAKOUT never claims volume confirmation from the aggregate index volume", async () => {
    const out = await runAllAgents(baseCtx(), ["BREAKOUT"]);
    const bo = out[0];
    // ctx.volume is the whole-market index volume, not the futures leg.
    expect(bo.evidence.join(" | ")).not.toContain("Volume confirmation available");
    expect(bo.riskFlags.join(" | ").toLowerCase()).toContain("unconfirmed");
  });

  it("VOLUME carries the futures CVD and OI read as evidence", async () => {
    const out = await runAllAgents(baseCtx({ flow: FLOW_STRONG } as any), ["VOLUME"]);
    const vol = out[0];
    const evidence = vol.evidence.join(" | ");
    expect(evidence.toLowerCase()).toContain("cvd");
    expect(evidence.toLowerCase()).toContain("open interest");
    expect((vol.data as any).futuresCvd).toBe(1188915);
  });

  it("VOLUME invents no flow numbers when the read is unavailable", async () => {
    const out = await runAllAgents(baseCtx(), ["VOLUME"]);
    const vol = out[0];
    expect(vol.evidence.join(" | ").toLowerCase()).not.toContain("cvd");
    expect((vol.data as any).futuresCvd ?? null).toBeNull();
  });
});
