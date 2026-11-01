// tests/quant-engine.test.ts — orchestrator tests for UNIVERSAL_QUANT_V1.
//
// DB round-trip against the real dev SQLite DB. Engine-generated rows carry
// qid() ids ("q_…" tradeIds/decisionIds) and are scoped by the run window in
// cleanup; system-level alert keys (tradeId "NA") are scoped by alert type +
// IST day. NO REAL TELEGRAM: TELEGRAM_BOT_TOKEN is deleted in beforeEach —
// runQuantCycle only enqueues (never sends) and the tickQuant test runs with
// no rows and no token, so the drain fails fast without touching the network.

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { db } from "@/lib/db";
import { QUANT_FLAGS } from "@/lib/quant/quant-config";
import { qid, type QuantObservation } from "@/lib/quant/quant-types";
import { istDayKey } from "@/lib/quant/quant-data";
import {
  __resetQuantRuntimeConfigForTests,
  setQuantRuntimeConfig,
} from "@/lib/quant/quant-runtime-config";
import {
  runQuantCycle,
  tickQuant,
  __setQuantEngineDepsForTests,
  type QuantDeps,
} from "@/lib/quant/quant-engine";
import { __setQuantLtpFetcherForTests } from "@/lib/quant/quant-position-monitor";
import type { CanonicalOptionChain } from "@/lib/data-layer/chains/option-chain";
import type { OptionLeg, OptionStrike } from "@/lib/data-layer/types";
import type { Candle } from "@/lib/market/canonical";

// ── env / config harness ─────────────────────────────────────────────

const NOW = Date.parse("2026-10-26T10:30:00+05:30"); // Monday 10:30 IST (a trading day)
const DAY = istDayKey(NOW);
// The fixture clock (NOW) is fixed at 10:30 IST while RUN_START used to ride
// the real clock — so every query/cleanup window silently EXCLUDED the fixture
// rows whenever the suite ran after 10:31 IST (a time-bomb: green in the
// morning, red after lunch). Cover both clocks.
const RUN_START = new Date(Math.min(Date.now(), NOW) - 60_000);
const REAL_DAY = istDayKey(Date.now());
const CONFIG_FILE = join(process.cwd(), "data", "quant-config.json");
const CONFIG_BACKUP = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : null;

const ORIG_FLAGS_ENABLED = QUANT_FLAGS.enabled;
const ORIG_QUANT_ENABLED_ENV = process.env.QUANT_ENABLED;

async function cleanupQuantRows(): Promise<void> {
  // Test rows are STAMPED by the engine (scopedQid → qtest_…, system keys →
  // qtest_sys:…) precisely so this cleanup can never touch the LIVE engine's
  // q_… / NA… rows — the old shared-prefix + shared-day-key version deleted
  // today's real paper trades, events, decisions and outbox rows on every run.
  await db.quantAlertOutbox.deleteMany({ where: { idempotencyKey: { contains: "qtest" } } });
  await db.quantTradeEvent.deleteMany({ where: { tradeId: { startsWith: "qtest_" } } });
  await db.quantPaperTrade.deleteMany({ where: { tradeId: { startsWith: "qtest_" } } });
  await db.quantDecisionLog.deleteMany({ where: { decisionId: { startsWith: "qtest_" } } });
}

beforeEach(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN; // never a real send
  delete process.env.QUANT_ENABLED;
  (QUANT_FLAGS as { enabled: boolean }).enabled = false; // arm only via runtime config
  __resetQuantRuntimeConfigForTests();
  __setQuantEngineDepsForTests(null);
  __setQuantLtpFetcherForTests(async () => 0); // never network in monitor ticks
  await cleanupQuantRows();
});

afterAll(async () => {
  (QUANT_FLAGS as { enabled: boolean }).enabled = ORIG_FLAGS_ENABLED;
  if (ORIG_QUANT_ENABLED_ENV === undefined) delete process.env.QUANT_ENABLED;
  else process.env.QUANT_ENABLED = ORIG_QUANT_ENABLED_ENV;
  __setQuantEngineDepsForTests(null);
  __setQuantLtpFetcherForTests(null);
  await cleanupQuantRows();
  if (CONFIG_BACKUP === null) {
    if (existsSync(CONFIG_FILE)) unlinkSync(CONFIG_FILE);
  } else {
    writeFileSync(CONFIG_FILE, CONFIG_BACKUP, "utf8");
  }
  await db.$disconnect();
});

// ── fixtures ─────────────────────────────────────────────────────────

function obs(over: Partial<QuantObservation> = {}): QuantObservation {
  return {
    source: "TEST",
    symbol: "NIFTY",
    exchange: "NSE",
    providerTimestamp: new Date(NOW - 10_000).toISOString(),
    collectedAt: new Date(NOW).toISOString(),
    ageMs: 10_000,
    quality: "FRESH",
    contractId: "NIFTY:test",
    ...over,
  };
}

/** Rising (step > 0) / falling (step < 0) 5-minute series ending at NOW. */
function candleSeries(step: number, n = 60): Candle[] {
  const start = 22600 - step * (n - 1);
  const t0 = NOW - (n - 1) * 5 * 60_000;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = start + i * step;
    const open = i === 0 ? close - step : start + (i - 1) * step;
    out.push({
      timestamp: new Date(t0 + i * 5 * 60_000).toISOString(),
      open,
      high: Math.max(open, close) + 3,
      low: Math.min(open, close) - 3,
      close,
      volume: 5000,
    });
  }
  return out;
}

function leg(over: Partial<OptionLeg> = {}): OptionLeg {
  return {
    ltp: 150, volume: 5000, oi: 2000, oiChange: 100, iv: 14,
    bid: 149.5, ask: 150.5, delta: 0.52, gamma: 0.001, theta: -8, rho: null,
    ...over,
  };
}

function chainFixture(opts: { spot?: number; withLegs?: boolean; peOnly?: boolean } = {}): CanonicalOptionChain {
  const spot = opts.spot ?? 22600;
  const withLegs = opts.withLegs ?? true;
  const strikes: OptionStrike[] = [];
  for (let strike = spot - 200; strike <= spot + 200; strike += 50) {
    strikes.push({
      strike,
      ce: withLegs && !opts.peOnly ? leg() : null,
      pe: withLegs ? leg({ delta: -0.48, theta: -8 }) : null,
    });
  }
  return {
    underlying: "NIFTY",
    spot,
    expiry: "02-Nov-2026", // NOW + 7 days — live, unexpired
    strikes,
    timestamp: new Date(NOW).toISOString(),
    asOf: new Date(NOW - 5_000).toISOString(),
    source: "NSE",
    fallbackUsed: false,
    freshness: "LIVE",
  };
}

function testDeps(over: Partial<QuantDeps> = {}): Partial<QuantDeps> {
  return {
    sessionFn: () => true,
    isExpiryDayFn: () => false,
    getChain: async () => ({ chain: chainFixture(), observation: obs({ contractId: "NIFTY:-:chain" }) }),
    getCandles: async () => ({ candles: candleSeries(8), observation: obs({ contractId: "NIFTY:5m:candles" }) }),
    getSpot: async () => ({ spot: 22600, observation: obs({ quality: "STALE", ageMs: null, providerTimestamp: null, contractId: "NIFTY:spot" }) }),
    getVix: async () => ({ value: 14, change: 0.2, observation: obs({ quality: "STALE", ageMs: null, providerTimestamp: null, symbol: "INDIA_VIX", contractId: "INDIA_VIX:vix" }) }),
    ...over,
  };
}

const TRADE_WHERE = { tradeId: { startsWith: "qtest_" }, createdAt: { gte: RUN_START } };
const DECISION_WHERE = { decisionId: { startsWith: "qtest_" }, ts: { gte: RUN_START } };

// ── the cycle ────────────────────────────────────────────────────────

describe("runQuantCycle — gates", () => {
  test("disabled → skipped, zero DB writes, zero alerts", async () => {
    __resetQuantRuntimeConfigForTests(); // no runtime file, QUANT_FLAGS.enabled forced false
    const r = await runQuantCycle({ nowMs: NOW });
    expect(r.skipped).toBe("disabled");
    expect(r.verdict).toBe("SKIPPED");
    expect(await db.quantPaperTrade.count({ where: TRADE_WHERE })).toBe(0);
    expect(await db.quantDecisionLog.count({ where: DECISION_WHERE })).toBe(0);
    expect(await db.quantAlertOutbox.count({ where: { idempotencyKey: { contains: "qtest" }, alertType: { startsWith: "QUANT_" } } })).toBe(0);
  });

  test("market closed → skipped, zero DB writes", async () => {
    setQuantRuntimeConfig({ enabled: true, mode: "PAPER", paperCapital: 100000 });
    const r = await runQuantCycle({ nowMs: NOW, deps: { sessionFn: () => false } });
    expect(r.skipped).toBe("market-closed");
    expect(await db.quantPaperTrade.count({ where: TRADE_WHERE })).toBe(0);
    expect(await db.quantDecisionLog.count({ where: DECISION_WHERE })).toBe(0);
  });
});

describe("runQuantCycle — decisions", () => {
  test("data gate: chain AND candles unavailable → NO_TRADE 'data unavailable' + QUANT_DATA_FAILURE", async () => {
    setQuantRuntimeConfig({ enabled: true, mode: "PAPER", paperCapital: 100000 });
    const r = await runQuantCycle({
      nowMs: NOW,
      deps: testDeps({
        getChain: async () => ({ chain: null, observation: obs({ quality: "UNAVAILABLE", ageMs: null, providerTimestamp: null, source: "NO_DATA" }) }),
        getCandles: async () => ({ candles: [], observation: obs({ quality: "UNAVAILABLE", ageMs: null, providerTimestamp: null, source: "none" }) }),
      }),
    });
    expect(r.verdict).toBe("NO_TRADE");
    expect(r.blockReason).toBe("data unavailable");
    const logged = await db.quantDecisionLog.findFirst({ where: { ...DECISION_WHERE, verdict: "NO_TRADE" } });
    expect(logged).toBeTruthy();
    expect(logged!.blockReason).toBe("data unavailable");
    const alert = await db.quantAlertOutbox.findFirst({
      where: { alertType: "QUANT_DATA_FAILURE", idempotencyKey: { endsWith: `:${DAY}`, contains: "qtest" } },
    });
    expect(alert).toBeTruthy();
    expect(alert!.status).toBe("PENDING");
  });

  test("uptrend + valid chain, PAPER mode → TRADE, OPEN trade row, entry + candidate alerts queued", async () => {
    setQuantRuntimeConfig({ enabled: true, mode: "PAPER", paperCapital: 100000 });
    const r = await runQuantCycle({ nowMs: NOW, deps: testDeps() });

    expect(r.verdict).toBe("TRADE");
    expect(r.mode).toBe("PAPER");
    expect(r.tradeId!).toMatch(/^qtest_/); // per-call deps → test-stamped id
    expect(r.alertsQueued).toBe(2);

    const trade = await db.quantPaperTrade.findUnique({ where: { tradeId: r.tradeId! } });
    expect(trade).toBeTruthy();
    expect(trade!.status).toBe("OPEN");
    expect(trade!.engineVersion).toBe("UNIVERSAL_QUANT_V1");
    expect(trade!.mode).toBe("PAPER");
    expect(trade!.strategy).toBe("TREND_CONTINUATION");
    expect(trade!.regime).toBe("TRENDING_UP");
    expect(trade!.direction).toBe("BUY_CE");
    expect(trade!.optionType).toBe("CE");
    expect(trade!.lotSize).toBe(65);
    expect(trade!.lots).toBeGreaterThanOrEqual(1);
    expect(trade!.quantity).toBe(trade!.lots! * 65);
    expect(trade!.entryPrice).toBeGreaterThan(0);
    expect(trade!.stopLoss!).toBeLessThan(150); // below the planned entry
    expect(trade!.tp1!).toBeGreaterThan(trade!.entryPrice!);
    expect(trade!.riskAmount!).toBeGreaterThan(0);
    expect(trade!.dataQuality!).toBeGreaterThan(0);
    expect(trade!.dataQuality!).toBeLessThanOrEqual(1);
    expect(trade!.decisionId).toBe(r.decisionId!);
    expect(JSON.parse(trade!.provenance!)).toHaveLength(4);

    const decision = await db.quantDecisionLog.findUnique({ where: { decisionId: r.decisionId! } });
    expect(decision).toBeTruthy();
    expect(decision!.verdict).toBe("TRADE");
    expect(decision!.winnerStrategy).toBe("TREND_CONTINUATION");
    expect(decision!.regime).toBe("TRENDING_UP");

    const alerts = await db.quantAlertOutbox.findMany({
      where: { idempotencyKey: { startsWith: r.tradeId! } },
    });
    expect(alerts.map((a) => a.alertType).sort()).toEqual(["QUANT_PAPER_ENTRY", "QUANT_TRADE_CANDIDATE"]);
    for (const a of alerts) expect(a.status).toBe("PENDING"); // no token → never sent
  });

  test("same fixture, SHADOW mode → decision logged + candidate alert, NO trade row", async () => {
    setQuantRuntimeConfig({ enabled: true, mode: "SHADOW", paperCapital: 100000 });
    const r = await runQuantCycle({ nowMs: NOW, deps: testDeps() });

    expect(r.verdict).toBe("TRADE");
    expect(r.mode).toBe("SHADOW");
    expect(r.tradeId).toBeUndefined();
    expect(await db.quantPaperTrade.count({ where: TRADE_WHERE })).toBe(0);

    const decision = await db.quantDecisionLog.findFirst({ where: { ...DECISION_WHERE, verdict: "TRADE" } });
    expect(decision).toBeTruthy();
    expect(decision!.winnerStrategy).toBe("TREND_CONTINUATION");

    const candidates = await db.quantAlertOutbox.findMany({
      where: { alertType: "QUANT_TRADE_CANDIDATE", idempotencyKey: { endsWith: `:${DAY}`, contains: "qtest" } },
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("PENDING");
    expect(JSON.parse(candidates[0].payload).mode).toBe("SHADOW");
  });

  test("paperCapital null → NO_TRADE risk block + QUANT_RISK_BLOCK queued", async () => {
    setQuantRuntimeConfig({ enabled: true, mode: "PAPER" }); // capital never assumed
    const r = await runQuantCycle({ nowMs: NOW, deps: testDeps() });

    expect(r.verdict).toBe("NO_TRADE");
    expect(r.blockReason).toContain("capital not configured");
    expect(await db.quantPaperTrade.count({ where: TRADE_WHERE })).toBe(0);

    const decision = await db.quantDecisionLog.findFirst({ where: { ...DECISION_WHERE, verdict: "NO_TRADE" } });
    expect(decision).toBeTruthy();
    expect(decision!.blockReason).toContain("capital not configured");

    const alert = await db.quantAlertOutbox.findFirst({
      where: { alertType: "QUANT_RISK_BLOCK", idempotencyKey: { endsWith: `:${DAY}`, contains: "qtest" } },
    });
    expect(alert).toBeTruthy();
    expect(alert!.status).toBe("PENDING");
  });

  test("downtrend + chain without tradable legs → NO_TRADE with strike-rejection blockReason", async () => {
    setQuantRuntimeConfig({ enabled: true, mode: "PAPER", paperCapital: 100000 });
    const r = await runQuantCycle({
      nowMs: NOW,
      deps: testDeps({
        getCandles: async () => ({ candles: candleSeries(-8), observation: obs({ contractId: "NIFTY:5m:candles" }) }),
        getChain: async () => ({ chain: chainFixture({ withLegs: false }), observation: obs({ contractId: "NIFTY:-:chain" }) }),
      }),
    });

    expect(["NO_TRADE", "WAIT"]).toContain(r.verdict!);
    expect(r.blockReason!).toContain("no candidate strike passed the entry gates");
    expect(await db.quantPaperTrade.count({ where: TRADE_WHERE })).toBe(0);
    const decision = await db.quantDecisionLog.findFirst({ where: { ...DECISION_WHERE, verdict: r.verdict } });
    expect(decision).toBeTruthy();
    expect(decision!.blockReason).toContain("no candidate strike passed the entry gates");
  });
});

// ── the tick ─────────────────────────────────────────────────────────

describe("tickQuant", () => {
  test("disabled engine → cycle skipped, monitor + outbox still run, no errors", async () => {
    __resetQuantRuntimeConfigForTests();
    const r = await tickQuant({ nowMs: NOW });
    expect(r.cycle).toBeTruthy();
    expect(r.cycle.skipped).toBe("disabled");
    expect(r.monitor).toEqual({ checked: 0, events: 0, degraded: 0 });
    expect(typeof r.outbox.flushed).toBe("number");
    expect(typeof r.outbox.sent).toBe("number");
    expect(r.errors).toEqual([]);
  });

  test("session closed inside a tick → cycle skipped market-closed, monitor + outbox still run", async () => {
    setQuantRuntimeConfig({ enabled: true, mode: "PAPER", paperCapital: 100000 });
    __setQuantEngineDepsForTests({ sessionFn: () => false });
    const r = await tickQuant({ nowMs: NOW });
    expect(r.cycle.skipped).toBe("market-closed");
    expect(r.monitor).toEqual({ checked: 0, events: 0, degraded: 0 });
    expect(r.errors).toEqual([]);
  });
});

// guard: qid uniqueness (engine relies on it for decision/trade ids)
test("qid() ids never collide across a burst", () => {
  const ids = new Set(Array.from({ length: 500 }, () => qid()));
  expect(ids.size).toBe(500);
});
