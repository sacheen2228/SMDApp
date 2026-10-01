/// <reference types="bun-types" />
// Jarvis pre-Hermes classifier + hermes diff backstop — unit tests.
// Both directions covered: false-negative (OPEN that should be DIRECT)
// and false-positive (DIRECT that should be OPEN) cases, plus the
// backstop's contradiction checks. No network, no LLM.

import { describe, it, expect } from "bun:test";
import { classifyJarvisQuestion, hermesResponseMatchesSignal } from "@/lib/jarvis-adapters";
import type { JarvisSignal } from "@/lib/jarvis/types";

function makeSignal(overrides: Partial<JarvisSignal> = {}): JarvisSignal {
  return {
    agentId: "jarvis-1",
    timestampIso: "2026-09-25T08:30:00.000Z",
    instrument: "NIFTY",
    spot: 23050,
    biasScore: -10,
    componentScores: {} as JarvisSignal["componentScores"],
    groupsAgreeing: 2,
    strategy: null,
    strategyName: null,
    levelsUsed: [],
    confluenceZone: null,
    action: "NO_TRADE",
    confidence: "NA",
    trade: null,
    keyLevels: { support: 23000, resistance: 23200, maxPain: 23100, pcr: 0.8 },
    greeks: null,
    newsHeadlinesUsed: [],
    reasons: ["|score| 10 below 40"],
    gatesFailed: ["|score| 10 below 40"],
    dataFreshnessMinutes: 0,
    disclaimer: "Educational only.",
    ...overrides,
  } as JarvisSignal;
}

function makeTradeSignal(): JarvisSignal {
  return makeSignal({
    action: "BUY_CE",
    confidence: "Moderate",
    trade: {
      strike: 23100,
      optionType: "CE",
      expiry: "2026-09-25",
      entryZone: [110, 120],
      stopLossPremium: 85,
      tp1Premium: 150,
      tp2Premium: 180,
      riskRewardTp1: 1.6,
      underlyingInvalidation: 23040,
      underlyingTargets: [23120, 23150],
      timeStopIso: "2026-09-25T09:20:00.000Z",
    },
    strategy: "S1",
    strategyName: "Momentum breakout",
  } as JarvisSignal);
}

describe("classifyJarvisQuestion — DIRECT (resolves from signal JSON)", () => {
  const sig = makeSignal();

  it('"why NO_TRADE" → DIRECT', () => {
    expect(classifyJarvisQuestion("why NO_TRADE", sig)).toBe("jarvis_direct");
  });

  it('"what\'s the stop loss" → DIRECT', () => {
    expect(classifyJarvisQuestion("what's the stop loss", sig)).toBe("jarvis_direct");
  });

  it('"explain the gamma flip level" → DIRECT', () => {
    expect(classifyJarvisQuestion("explain the gamma flip level", sig)).toBe("jarvis_direct");
  });

  it('"is this a good time to buy nifty" (setup rephrase) → DIRECT', () => {
    expect(classifyJarvisQuestion("is this a good time to buy nifty", sig)).toBe("jarvis_direct");
  });

  it('"why is this blocked" → DIRECT', () => {
    expect(classifyJarvisQuestion("why is this blocked", sig)).toBe("jarvis_direct");
  });

  it('"what\'s the entry zone and first target" → DIRECT', () => {
    expect(classifyJarvisQuestion("what's the entry zone and first target", sig)).toBe("jarvis_direct");
  });

  it('"how does RBI policy affect this" → DIRECT when newsHeadlinesUsed covers RBI', () => {
    const covered = makeSignal({
      newsHeadlinesUsed: ["RBI holds repo rate steady at 5.50% in policy review"],
    });
    expect(classifyJarvisQuestion("how does RBI policy affect this", covered)).toBe("jarvis_direct");
  });
});

describe("classifyJarvisQuestion — OPEN (needs research/opinion)", () => {
  const sig = makeSignal();

  it('"what\'s your view on the market for next week" → OPEN', () => {
    expect(classifyJarvisQuestion("what's your view on the market for next week", sig)).toBe("hermes");
  });

  it('"how does RBI policy affect this" → OPEN when headlines do not cover RBI', () => {
    expect(classifyJarvisQuestion("how does RBI policy affect this", sig)).toBe("hermes");
  });

  it('"compare nifty and banknifty setups right now" → OPEN (cross-instrument)', () => {
    expect(classifyJarvisQuestion("compare nifty and banknifty setups right now", sig)).toBe("hermes");
  });

  it('"what does PCR mean" → OPEN (education, not signal question)', () => {
    expect(classifyJarvisQuestion("what does PCR mean", sig)).toBe("hermes");
  });

  it('"what do you think will happen tomorrow" → OPEN (prediction)', () => {
    expect(classifyJarvisQuestion("what do you think will happen tomorrow", sig)).toBe("hermes");
  });

  it('"why is the market falling" → OPEN (bare why, no signal deixis/action)', () => {
    expect(classifyJarvisQuestion("why is the market falling", sig)).toBe("hermes");
  });

  it('"explain how gamma works" → OPEN (education)', () => {
    expect(classifyJarvisQuestion("explain how gamma works", sig)).toBe("hermes");
  });

  it('"what about sensex" → OPEN (different instrument)', () => {
    expect(classifyJarvisQuestion("what about sensex", sig)).toBe("hermes");
  });
});

describe("hermesResponseMatchesSignal — diff backstop", () => {
  it("NO_TRADE + BUY CE assertion → contradicts", () => {
    const sig = makeSignal();
    expect(hermesResponseMatchesSignal("Setup is clear: BUY CE 23100 now.", sig)).toBe(false);
  });

  it("NO_TRADE + buy calls prose → contradicts", () => {
    const sig = makeSignal();
    expect(hermesResponseMatchesSignal("I would buy calls here.", sig)).toBe(false);
  });

  it("NO_TRADE + strike-adjacent option mention (no trade in signal) → contradicts", () => {
    const sig = makeSignal();
    expect(hermesResponseMatchesSignal("23100 CE looks good for entry.", sig)).toBe(false);
  });

  it("NO_TRADE + plain level discussion → matches (levels ≠ strike claims)", () => {
    const sig = makeSignal();
    const text = "NIFTY spot 23050. Support 23000, resistance 23200, max pain 23100, PCR 0.8. Regime UNCERTAIN.";
    expect(hermesResponseMatchesSignal(text, sig)).toBe(true);
  });

  it("BUY_CE signal + matching strike → matches", () => {
    const sig = makeTradeSignal();
    expect(hermesResponseMatchesSignal("Enter 23100 CE at 110-120 with SL 85.", sig)).toBe(true);
  });

  it("BUY_CE signal + different strike CE → contradicts", () => {
    const sig = makeTradeSignal();
    expect(hermesResponseMatchesSignal("Better idea: switch to 23200 CE.", sig)).toBe(false);
  });

  it("BUY_CE signal + opposite-side buy → contradicts", () => {
    const sig = makeTradeSignal();
    expect(hermesResponseMatchesSignal("Ignore that, buy PE instead.", sig)).toBe(false);
  });

  it("hermes BUY decision vs NO_TRADE signal → contradicts", () => {
    const sig = makeSignal();
    expect(hermesResponseMatchesSignal("BUY_CE 23100 | entry 110 | SL 85", sig)).toBe(false);
  });
});
