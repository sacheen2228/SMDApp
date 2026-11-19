// Phase 8B — EMA shadow observation recorder tests.
//
// Pure functions are tested directly; the recorder is tested end-to-end against
// the dev DB with cleanup so no residue is left.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PrismaClient } from "@prisma/client";
import {
  buildEmaShadowFields,
  instrumentTypeOf,
  normaliseDirection,
  outcomeFor,
  recordEmaShadowObservations,
  type EmaShadowFields,
} from "@/lib/ema-shadow-observer";
import type { StockCandidate } from "@/lib/intraday-scanner";
import type { WeeklyCandidate } from "@/lib/weekly-equity-scanner";

const prisma = new PrismaClient();
const TEST_SYMBOL = "EMA_SHADOW_TEST";
const DEDUPE_SYMBOL = "EMA_SHADOW_DEDUPE";

function mkEma(overrides: Partial<{
  alignment: EmaShadowFields["emaAlignment"];
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  dataQuality: EmaShadowFields["emaDataQuality"];
  bars: number;
  lastCandleTime: number | null;
  setups: Array<{ confirmed: boolean; type: string }>;
}> = {}): any {
  return {
    alignment: overrides.alignment ?? "BULLISH",
    direction: overrides.direction ?? "BULLISH",
    ema9: 100, ema21: 99, ema50: 98,
    slope21: 1, slope50: 1,
    dataQuality: overrides.dataQuality ?? "LIVE",
    bars: overrides.bars ?? 120,
    lastCandleTime: overrides.lastCandleTime ?? Date.now() - 60_000,
    setups: overrides.setups ?? [{ confirmed: true, type: "EMA21_PULLBACK" }],
  } as any;
}

async function cleanupRows() {
  await prisma.candidateLog.deleteMany({
    where: {
      symbol: { in: [TEST_SYMBOL, DEDUPE_SYMBOL] },
      observationSource: { in: ["intraday-scanner:shadow", "weekly-scanner:shadow"] },
    },
  });
}

describe("instrumentTypeOf", () => {
  test("index symbols", () => {
    expect(instrumentTypeOf("NIFTY")).toBe("INDEX");
    expect(instrumentTypeOf("SENSEX")).toBe("INDEX");
    expect(instrumentTypeOf("BANKNIFTY")).toBe("INDEX");
  });
  test("stock symbols", () => {
    expect(instrumentTypeOf("RELIANCE")).toBe("STOCK");
    expect(instrumentTypeOf("SBIN")).toBe("STOCK");
  });
});

describe("normaliseDirection", () => {
  test.each([
    ["BULLISH", "BULLISH"], ["UP", "BULLISH"], ["LONG", "BULLISH"], ["BUY", "BULLISH"],
    ["BEARISH", "BEARISH"], ["DOWN", "BEARISH"], ["SHORT", "BEARISH"], ["SELL", "BEARISH"],
    ["NEUTRAL", "NEUTRAL"], ["FLAT", "NEUTRAL"], ["", "NEUTRAL"],
  ])("%s -> %s", (input, expected) => {
    expect(normaliseDirection(input)).toBe(expected);
  });
});

describe("outcomeFor", () => {
  test("directional + actionable => BUY_RESEARCH", () => {
    expect(outcomeFor("BULLISH", true)).toBe("BUY_RESEARCH");
    expect(outcomeFor("BEARISH", true)).toBe("BUY_RESEARCH");
  });
  test("not actionable or neutral => NO_TRADE", () => {
    expect(outcomeFor("BULLISH", false)).toBe("NO_TRADE");
    expect(outcomeFor("NEUTRAL", true)).toBe("NO_TRADE");
    expect(outcomeFor("NEUTRAL", false)).toBe("NO_TRADE");
  });
});

describe("buildEmaShadowFields", () => {
  test("intraday with valid EMA data", () => {
    const f = buildEmaShadowFields({
      symbol: "NIFTY",
      ema: mkEma({ alignment: "BULLISH", dataQuality: "LIVE" }),
      directionalCheck: "CONSISTENT",
      optionsConfirmation: "SUPPORTIVE",
      existingSignalDirection: "BULLISH",
      actionable: true,
      optionType: "CE",
      expiryType: "MONTHLY",
      marketOpen: true,
      asOfMs: Date.now(),
    });
    expect(f.emaAlignment).toBe("BULLISH");
    expect(f.emaDataQuality).toBe("LIVE");
    expect(f.emaIsStale).toBe(false);
    expect(f.outcome).toBe("BUY_RESEARCH");
    expect(f.instrumentType).toBe("INDEX");
    expect(f.expiryType).toBe("MONTHLY");
    expect(f.isMarketOpen).toBe(true);
    expect(f.sessionWindow).toBe("MARKET_ACTIVE");
    expect(f.emaSetupType).toBe("EMA21_PULLBACK");
  });

  test("intraday without EMA data => stale/missing flags", () => {
    const f = buildEmaShadowFields({
      symbol: "RELIANCE",
      ema: null,
      directionalCheck: null,
      optionsConfirmation: null,
      existingSignalDirection: "NEUTRAL",
      actionable: false,
      optionType: null,
      expiryType: null,
      marketOpen: false,
      asOfMs: Date.now(),
    });
    expect(f.emaAlignment).toBeNull();
    expect(f.emaIsStale).toBe(true);
    expect(f.emaDataQuality).toBe("INSUFFICIENT");
    expect(f.outcome).toBe("NO_TRADE");
    expect(f.instrumentType).toBe("STOCK");
    expect(f.isMarketOpen).toBe(false);
  });

  test("weekly candidate maps weeklyTrend and expiry null", () => {
    const f = buildEmaShadowFields({
      symbol: "RELIANCE",
      ema: mkEma({ alignment: "BEARISH" }),
      directionalCheck: "CONFLICT",
      optionsConfirmation: "INCONCLUSIVE",
      existingSignalDirection: "BEARISH",
      actionable: true,
      optionType: "PE",
      expiryType: null,
      marketOpen: true,
      asOfMs: Date.now(),
    });
    expect(f.existingSignalDirection).toBe("BEARISH");
    expect(f.emaDirectionalVerdict).toBe("CONFLICT");
    expect(f.emaOptionsConfirmation).toBe("INCONCLUSIVE");
    expect(f.expiryType).toBeNull();
    expect(f.outcome).toBe("BUY_RESEARCH");
  });

  test("stale last candle => isStale true", () => {
    const f = buildEmaShadowFields({
      symbol: "NIFTY",
      ema: mkEma({ dataQuality: "LIVE", lastCandleTime: Date.now() - 2 * 60 * 60 * 60 * 1000 }),
      directionalCheck: "CONSISTENT",
      optionsConfirmation: "SUPPORTIVE",
      existingSignalDirection: "BULLISH",
      actionable: true,
      optionType: "CE",
      expiryType: "MONTHLY",
      marketOpen: true,
      asOfMs: Date.now(),
    });
    expect(f.emaIsStale).toBe(true);
  });
});

describe("recordEmaShadowObservations", () => {
  beforeEach(async () => { await cleanupRows(); });
  afterEach(async () => { await cleanupRows(); });

  test("empty array does not throw", () => {
    expect(() =>
      recordEmaShadowObservations([], "intraday-scanner:shadow"),
    ).not.toThrow();
  });

  test("writes one observation row per intraday candidate", async () => {
    const now = Date.now();
    const c = {
      symbol: TEST_SYMBOL,
      direction: "BULLISH",
      grade: "B",
      totalScore: 60,
      monthlyOptionTrade: { optionType: "CE" as const },
      emaStructure: mkEma({ alignment: "BULLISH", dataQuality: "LIVE" }),
      directionalCheck: "CONSISTENT",
      optionsConfirmation: "SUPPORTIVE",
    } as unknown as StockCandidate;

    await recordEmaShadowObservations([c], "intraday-scanner:shadow", { asOfMs: now });
    // logCandidate is fire-and-forget; let the async write commit.
    await new Promise((r) => setTimeout(r, 250));

    const rows = await prisma.candidateLog.findMany({
      where: { symbol: TEST_SYMBOL, observationSource: "intraday-scanner:shadow" },
    });
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.emaAlignment).toBe("BULLISH");
    expect(r.emaDataQuality).toBe("LIVE");
    expect(r.emaIsStale).toBe(false);
    expect(r.existingSignalDirection).toBe("BULLISH");
    expect(r.outcome).toBe("BUY_RESEARCH");
    expect(r.instrumentType).toBe("STOCK");
    expect(r.expiryType).toBe("MONTHLY");
    expect(r.optionType).toBe("CE");
    expect(r.emaDirectionalVerdict).toBe("CONSISTENT");
    expect(r.emaOptionsConfirmation).toBe("SUPPORTIVE");
    expect(r.isMarketOpen).toBe(isMarketOpenNow(now));
  });

  test("dedupes repeated calls for same symbol/day", async () => {
    const now = Date.now();
    const c = {
      symbol: DEDUPE_SYMBOL,
      direction: "BEARISH",
      grade: "C",
      totalScore: 50,
      monthlyOptionTrade: { optionType: "PE" as const },
      emaStructure: mkEma({ alignment: "BEARISH", dataQuality: "FRESH" }),
      directionalCheck: "CONFLICT",
      optionsConfirmation: "ADVERSE",
    } as unknown as StockCandidate;

    await recordEmaShadowObservations([c], "intraday-scanner:shadow", { asOfMs: now });
    await recordEmaShadowObservations([c], "intraday-scanner:shadow", { asOfMs: now });
    await recordEmaShadowObservations([c], "intraday-scanner:shadow", { asOfMs: now });
    await new Promise((r) => setTimeout(r, 250));

    const rows = await prisma.candidateLog.findMany({
      where: { symbol: DEDUPE_SYMBOL, observationSource: "intraday-scanner:shadow" },
    });
    expect(rows.length).toBe(1);
  });
});

function isMarketOpenNow(now: number): boolean {
  const p = new Date(now + 5.5 * 3600 * 1000);
  const m = p.getUTCHours() * 60 + p.getUTCMinutes();
  return m >= 9 * 60 + 15 && m <= 15 * 60 + 30;
}
