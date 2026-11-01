// tests/quant-trailing.test.ts — Phase C trailing-ATR persistence + monitor trail.
//
// DB round-trip against the real dev SQLite DB. Rows carry the unique
// per-run PREFIX and are deleted in afterAll. NO REAL TELEGRAM (token
// deleted; monitor only enqueues to the outbox).
//
// Policy under test (documented in quant-paper-execution.ts):
//   after TP1 the stop first moves to entry (breakeven), then trails at
//   highestSinceTp1 − 1×atrPremium (max-only — never loosens); a NULL
//   atrPremium is a documented no-op (the trail never invents a number).

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { db } from "@/lib/db";
import type { Candle } from "@/lib/market/canonical";
import type { CanonicalOptionChain } from "@/lib/data-layer/chains/option-chain";
import type { OptionLeg, OptionStrike } from "@/lib/data-layer/types";
import type { QuantObservation } from "@/lib/quant/quant-types";
import { istDayKey } from "@/lib/quant/quant-data";
import { QUANT_FLAGS } from "@/lib/quant/quant-config";
import {
  __resetQuantRuntimeConfigForTests,
  setQuantRuntimeConfig,
} from "@/lib/quant/quant-runtime-config";
import {
  createQuantPaperTrade,
  tickMonitor,
  __setQuantLtpFetcherForTests,
} from "@/lib/quant/quant-position-monitor";
import {
  runQuantCycle,
  __setQuantEngineDepsForTests,
  type QuantDeps,
} from "@/lib/quant/quant-engine";

// ── harness ──────────────────────────────────────────────────────────

const RUN_KEY = Math.floor(Date.now() / 1000).toString(36);
const PREFIX = `QPT-TRAIL-${RUN_KEY}-`;
const NOW = Date.parse("2026-10-26T10:30:00+05:30"); // Monday 10:30 IST
const RUN_START = new Date(Date.now() - 60_000);
const FUTURE_EXPIRY = (() => {
  const d = new Date(NOW + 7 * 86400_000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d.getUTCDate()).padStart(2, "0")}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
})();

const ORIG_FLAGS_ENABLED = QUANT_FLAGS.enabled;

beforeEach(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN; // never a real send
  (QUANT_FLAGS as { enabled: boolean }).enabled = false;
  __resetQuantRuntimeConfigForTests();
  __setQuantLtpFetcherForTests(async () => 0); // never network unless a test overrides
  __setQuantEngineDepsForTests(null);
});

async function cleanup(): Promise<void> {
  // Only OUR rows: this suite's QPT-TRAIL-… fixtures plus the qtest-stamped
  // ids/keys the engine generates under test (scopedQid / qtest_sys). Never
  // the live engine's q_…/NA… rows — they share this SQLite DB.
  await db.quantAlertOutbox.deleteMany({
    where: { OR: [{ idempotencyKey: { contains: PREFIX } }, { idempotencyKey: { contains: "qtest" } }] },
  });
  await db.quantTradeEvent.deleteMany({
    where: { OR: [{ tradeId: { startsWith: PREFIX } }, { tradeId: { startsWith: "qtest_" } }] },
  });
  await db.quantPaperTrade.deleteMany({
    where: { OR: [{ tradeId: { startsWith: PREFIX } }, { tradeId: { startsWith: "qtest_" } }] },
  });
  await db.quantDecisionLog.deleteMany({
    where: { decisionId: { startsWith: "qtest_" } },
  });
}

afterAll(async () => {
  (QUANT_FLAGS as { enabled: boolean }).enabled = ORIG_FLAGS_ENABLED;
  __setQuantLtpFetcherForTests(null);
  __setQuantEngineDepsForTests(null);
  await cleanup();
  await db.$disconnect();
});

async function openTrade(suffix: string, over: Partial<Parameters<typeof createQuantPaperTrade>[0]> = {}) {
  return createQuantPaperTrade({
    tradeId: `${PREFIX}${suffix}`,
    strategy: "TREND_CONTINUATION",
    regime: "TRENDING_UP",
    symbol: "NIFTY",
    exchange: "NSE",
    direction: "BUY_CE",
    tradingsymbol: "NIFTY02NOV2622600CE",
    strike: 25000,
    optionType: "CE",
    expiry: FUTURE_EXPIRY,
    lotSize: 65,
    lots: 2, // quantity 130 — TP1 exits 65, 65 remain for the trail to manage
    entryPrice: 100,
    stopLoss: 80,
    tp1: 120,
    tp2: 140,
    ...over,
  });
}

// ── monitor trail (atrPremium persisted via createQuantPaperTrade) ───

describe("quant monitor — ATR trail (Phase C)", () => {
  test("TP1 with trailingAtrPremium → breakeven THEN trail: stop = highWater − atr (> breakeven)", async () => {
    await openTrade("A", { atrPremium: 2 });
    __setQuantLtpFetcherForTests(async () => 125); // crosses TP1 120, below TP2 140

    const summary = await tickMonitor(NOW);
    expect(summary.events).toBeGreaterThanOrEqual(1);

    const row = await db.quantPaperTrade.findUnique({ where: { tradeId: `${PREFIX}A` } });
    expect(row!.trailingAtrPremium).toBe(2);
    expect(row!.status).toBe("PARTIALLY_CLOSED");
    expect(row!.tpHitLevel).toBe("TP1");
    // breakeven arms at 100, then the trail ratchets to highWater 125 − 1×2 = 123
    expect(row!.currentStopLoss).toBe(123);
    expect(row!.trailingHighWater).toBe(125);
  });

  test("later observations ratchet the trail; a pullback ABOVE the stop never loosens it", async () => {
    // Trade A continues: highWater 125, stop 123 from the previous test.
    __setQuantLtpFetcherForTests(async () => 131);
    await tickMonitor(NOW + 60_000);
    let row = await db.quantPaperTrade.findUnique({ where: { tradeId: `${PREFIX}A` } });
    expect(row!.currentStopLoss).toBe(129); // max(123, 131 − 2)
    expect(row!.trailingHighWater).toBe(131);
    expect(row!.status).toBe("PARTIALLY_CLOSED"); // 131 < TP2 140 — still open

    // higher print: highWater 133 → trail 131
    __setQuantLtpFetcherForTests(async () => 133);
    await tickMonitor(NOW + 120_000);
    row = await db.quantPaperTrade.findUnique({ where: { tradeId: `${PREFIX}A` } });
    expect(row!.currentStopLoss).toBe(131);
    expect(row!.trailingHighWater).toBe(133);

    // pullback to 132 (above the stop 131): stop and highWater hold — never loosened
    __setQuantLtpFetcherForTests(async () => 132);
    await tickMonitor(NOW + 180_000);
    row = await db.quantPaperTrade.findUnique({ where: { tradeId: `${PREFIX}A` } });
    expect(row!.status).toBe("PARTIALLY_CLOSED");
    expect(row!.currentStopLoss).toBe(131);
    expect(row!.trailingHighWater).toBe(133);
  });

  test("a print at the trailed stop exits the position AT the trailed level", async () => {
    // Trade A continues: stop 131. ltp == stop → trail hit (not gapped),
    // exited exactly at the ATR-trailed level (131 > breakeven 100 > initial 80).
    __setQuantLtpFetcherForTests(async () => 131);
    const summary = await tickMonitor(NOW + 240_000);
    expect(summary.events).toBeGreaterThanOrEqual(1);

    const row = await db.quantPaperTrade.findUnique({ where: { tradeId: `${PREFIX}A` } });
    expect(row!.status).toBe("CLOSED_BREAKEVEN"); // post-TP1 stop ≥ entry classifies as breakeven
    expect(row!.exitPrice).toBe(131); // the trailed level, not the initial stop
    expect(row!.exitReason).toBe("BREAKEVEN_SL_HIT");
    expect(row!.currentStopLoss).toBe(131); // frozen — never loosened by lower prints
  });

  test("TP2 close with the trail armed: trade closes at TP2, trail frozen at its last value", async () => {
    await openTrade("B", { atrPremium: 2 });
    __setQuantLtpFetcherForTests(async () => 125);
    await tickMonitor(NOW); // TP1 → stop 123
    __setQuantLtpFetcherForTests(async () => 145);
    await tickMonitor(NOW + 60_000); // crosses TP2 140 → everything exits

    const row = await db.quantPaperTrade.findUnique({ where: { tradeId: `${PREFIX}B` } });
    expect(row!.status).toBe("CLOSED_TP");
    expect(row!.exitPrice).toBe(140);
    expect(row!.exitReason).toBe("TP2_HIT");
    expect(row!.tpHitLevel).toBe("TP2");
    expect(row!.currentStopLoss).toBe(123); // trail state frozen after the full exit
  });

  test("NULL trailingAtrPremium → trail is a no-op: breakeven only, stop unchanged, highWater null", async () => {
    await openTrade("C"); // no atrPremium
    __setQuantLtpFetcherForTests(async () => 125);
    await tickMonitor(NOW);

    let row = await db.quantPaperTrade.findUnique({ where: { tradeId: `${PREFIX}C` } });
    expect(row!.trailingAtrPremium).toBeNull();
    expect(row!.status).toBe("PARTIALLY_CLOSED");
    expect(row!.tpHitLevel).toBe("TP1");
    expect(row!.currentStopLoss).toBe(100); // breakeven armed, no trail beyond it
    expect(row!.trailingHighWater).toBeNull(); // applyTrail never ran

    // a higher observation changes nothing without an ATR premium
    __setQuantLtpFetcherForTests(async () => 135);
    await tickMonitor(NOW + 60_000);
    row = await db.quantPaperTrade.findUnique({ where: { tradeId: `${PREFIX}C` } });
    expect(row!.currentStopLoss).toBe(100);
    expect(row!.trailingHighWater).toBeNull();

    // close it out at its breakeven stop (a profit, not a loss — a loss here
    // would arm the 30m cooldown and block the engine-wiring test below)
    __setQuantLtpFetcherForTests(async () => 100);
    await tickMonitor(NOW + 120_000);
    row = await db.quantPaperTrade.findUnique({ where: { tradeId: `${PREFIX}C` } });
    expect(row!.status).toBe("CLOSED_BREAKEVEN");
    expect(row!.exitPrice).toBe(100);
  });
});

// ── engine wiring (buildQuantPlan atrProxy persisted on cycle entry) ──

// Same fixtures as tests/quant-engine.test.ts: a rising 5m series whose
// atr14 = 14 (TR = step 8 + 6), premium 150 → atrProxy = max(14, 150×0.04) = 14.
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

function chainFixture(): CanonicalOptionChain {
  const spot = 22600;
  const strikes: OptionStrike[] = [];
  for (let strike = spot - 200; strike <= spot + 200; strike += 50) {
    strikes.push({ strike, ce: leg(), pe: leg({ delta: -0.48, theta: -8 }) });
  }
  return {
    underlying: "NIFTY",
    spot,
    expiry: "02-Nov-2026",
    strikes,
    timestamp: new Date(NOW).toISOString(),
    asOf: new Date(NOW - 5_000).toISOString(),
    source: "NSE",
    fallbackUsed: false,
    freshness: "LIVE",
  };
}

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

function testDeps(): Partial<QuantDeps> {
  return {
    sessionFn: () => true,
    isExpiryDayFn: () => false,
    getChain: async () => ({ chain: chainFixture(), observation: obs({ contractId: "NIFTY:-:chain" }) }),
    getCandles: async () => ({ candles: candleSeries(8), observation: obs({ contractId: "NIFTY:5m:candles" }) }),
    getSpot: async () => ({ spot: 22600, observation: obs({ quality: "STALE", ageMs: null, providerTimestamp: null, contractId: "NIFTY:spot" }) }),
    getVix: async () => ({ value: 14, change: 0.2, observation: obs({ quality: "STALE", ageMs: null, providerTimestamp: null, symbol: "INDIA_VIX", contractId: "INDIA_VIX:vix" }) }),
  };
}

describe("quant engine — trailingAtrPremium persisted from the plan", () => {
  test("PAPER cycle stores atrProxy (max(atr14, entry×4%)) as trailingAtrPremium on the trade row", async () => {
    setQuantRuntimeConfig({ enabled: true, mode: "PAPER", paperCapital: 100000 });
    const r = await runQuantCycle({ nowMs: NOW, deps: testDeps() });

    expect(r.verdict).toBe("TRADE");
    expect(r.tradeId).toBeTruthy();

    const trade = await db.quantPaperTrade.findUnique({ where: { tradeId: r.tradeId! } });
    expect(trade).toBeTruthy();
    expect(trade!.status).toBe("OPEN");
    expect(trade!.entryPrice).toBeGreaterThan(0);
    // candleSeries(8): every TR = 14 → atr14 = 14; entry 150 → floor 6 → atrProxy = 14
    expect(trade!.trailingAtrPremium).toBe(14);
    // and the stop is consistent with that trail baseline: entry − 1.2×14 = 133.2
    expect(trade!.stopLoss).toBeCloseTo(150 - 1.2 * 14, 2);
  });
});
