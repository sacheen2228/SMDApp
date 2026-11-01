import { describe, test, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { db } from "@/lib/db";
import {
  createQuantPaperTrade,
  tickMonitor,
  alertTypeForEvent,
  __setQuantLtpFetcherForTests,
} from "@/lib/quant/quant-position-monitor";
import { shouldDeliverNow } from "@/lib/quant/quant-alert-policy";
import { istDayKey } from "@/lib/quant/quant-data";
import { qid } from "@/lib/quant/quant-types";

// DB round-trip against the real dev SQLite DB. Every row this file creates
// carries the unique per-run PREFIX and is deleted in afterAll.

const PREFIX = `QPT-T-${Math.floor(Date.now() / 1000).toString(36)}-`;
const NOW = Date.parse("2026-10-26T10:30:00+05:30");
const DAY = istDayKey(NOW);
const FUTURE_EXPIRY = (() => {
  const d = new Date(NOW + 7 * 86400_000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d.getUTCDate()).padStart(2, "0")}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
})();

async function openTrade(suffix: string, over: Partial<Parameters<typeof createQuantPaperTrade>[0]> = {}) {
  return createQuantPaperTrade({
    tradeId: `${PREFIX}${suffix}`,
    strategy: "TREND_CONTINUATION",
    regime: "TRENDING_UP",
    symbol: "NIFTY",
    exchange: "NSE",
    direction: "BUY_CE",
    tradingsymbol: "NIFTY31OCT2625000CE",
    strike: 25000,
    optionType: "CE",
    expiry: FUTURE_EXPIRY,
    lotSize: 65,
    lots: 2,
    entryPrice: 100,
    stopLoss: 80,
    tp1: 120,
    tp2: 140,
    ...over,
  });
}

const tradeA = `${PREFIX}A`;
const tradeB = `${PREFIX}B`;
const tradeC = `${PREFIX}C`;

beforeEach(() => {
  __setQuantLtpFetcherForTests(null);
});
afterEach(() => {
  __setQuantLtpFetcherForTests(null);
});
afterAll(async () => {
  await db.quantTradeEvent.deleteMany({ where: { tradeId: { startsWith: PREFIX } } });
  // `contains` catches both `${tradeId}:...` level-event keys and the
  // `DATA_WARNING:${tradeId}:...` keys (which do not start with the prefix).
  await db.quantAlertOutbox.deleteMany({ where: { idempotencyKey: { contains: PREFIX } } });
  await db.quantPaperTrade.deleteMany({ where: { tradeId: { startsWith: PREFIX } } });
  await db.$disconnect();
});

describe("quant monitor — DB round trip", () => {
  test("TP1 crossing → event persisted, trade PARTIALLY_CLOSED, breakeven armed, outbox PENDING", async () => {
    await openTrade("A");
    __setQuantLtpFetcherForTests(async () => 125); // crosses TP1 120, not TP2 140

    const summary = await tickMonitor(NOW);
    expect(summary.checked).toBeGreaterThanOrEqual(1);
    expect(summary.events).toBeGreaterThanOrEqual(1);
    expect(summary.degraded).toBe(0);

    const row = await db.quantPaperTrade.findUnique({ where: { tradeId: tradeA } });
    expect(row!.status).toBe("PARTIALLY_CLOSED");
    expect(row!.tpHitLevel).toBe("TP1");
    expect(row!.currentStopLoss).toBe(100); // breakeven: stop moved to entry
    expect(row!.monitorDegraded).toBe(false);
    expect(row!.unrealizedPnl).toBeCloseTo((125 - 100) * 65, 2);

    const events = await db.quantTradeEvent.findMany({ where: { tradeId: tradeA } });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("TP1_HIT");
    expect(events[0].level).toBe(120);
    expect(events[0].fillPrice).toBe(120);
    expect(events[0].quantityExited).toBe(65);
    expect(events[0].remainingQuantity).toBe(65);
    expect(events[0].realizedPnl).toBeCloseTo((120 - 100) * 65, 0);
    expect(events[0].eventId).toBe(`${tradeA}:TP1_HIT:120:${NOW}`);

    const outbox = await db.quantAlertOutbox.findMany({ where: { idempotencyKey: { startsWith: `${tradeA}:` } } });
    expect(outbox.length).toBe(1);
    expect(outbox[0].status).toBe("PENDING");
    expect(outbox[0].idempotencyKey).toBe(`${tradeA}:TP1_HIT:120:${DAY}`);
    // The alert type MUST be a deliverable policy type (a type outside the
    // policy union would sit in the outbox forever).
    expect(outbox[0].alertType).toBe("QUANT_TP1_HIT");
    expect(shouldDeliverNow(outbox[0].alertType)).toBe(true);
    const payload = JSON.parse(outbox[0].payload);
    expect(payload.tradeId).toBe(tradeA);
    expect(payload.type).toBe("TP1_HIT");
    // Persisted trade values are carried in the alert payload (the Telegram
    // message must contain the persisted numbers, not re-derived ones).
    expect(payload.entry).toBe(100);
    expect(payload.fillPrice).toBe(120);
    expect(payload.quantityExited).toBe(65);
    expect(payload.remainingQuantity).toBe(65);
    expect(payload.currentStopLoss).toBe(80);
  });

  test("every lifecycle event type maps to a deliverable policy alert type", () => {
    for (const t of ["TP1_HIT", "TP2_HIT", "TP3_HIT", "TP4_HIT", "SL_HIT", "GAP_THROUGH_SL", "TRAILING_SL_HIT", "BREAKEVEN_SL_HIT"]) {
      const mapped = alertTypeForEvent(t);
      expect(mapped).not.toBeNull();
      expect(shouldDeliverNow(mapped!)).toBe(true);
    }
    expect(alertTypeForEvent("DATA_WARNING")).toBeNull(); // uses its own type
  });

  test("re-tick dedupes (no second event/outbox row), then TP2 closes the trade", async () => {
    // Trade A is PARTIALLY_CLOSED with tpHitLevel TP1 from the previous test.
    __setQuantLtpFetcherForTests(async () => 125);
    await tickMonitor(NOW + 60_000); // above TP1 but below TP2 → no new events (TP1 taken)

    const events1 = await db.quantTradeEvent.findMany({ where: { tradeId: tradeA } });
    expect(events1.length).toBe(1);
    const outbox1 = await db.quantAlertOutbox.findMany({ where: { idempotencyKey: { startsWith: `${tradeA}:` } } });
    expect(outbox1.length).toBe(1);

    __setQuantLtpFetcherForTests(async () => 145); // crosses TP2 140
    const s2 = await tickMonitor(NOW + 120_000);
    expect(s2.events).toBeGreaterThanOrEqual(1);

    const row = await db.quantPaperTrade.findUnique({ where: { tradeId: tradeA } });
    expect(row!.status).toBe("CLOSED_TP");
    expect(row!.exitPrice).toBe(140);
    expect(row!.exitReason).toBe("TP2_HIT");
    expect(row!.exitTime).not.toBeNull();
    // realized = TP1 gross − costs + TP2 gross − costs (positive: 20×65 + 40×65 minus costs)
    expect(row!.realizedPnl!).toBeGreaterThan(3000);

    const events2 = await db.quantTradeEvent.findMany({ where: { tradeId: tradeA } });
    expect(events2.length).toBe(2);
    expect(events2.map((e) => e.type).sort()).toEqual(["TP1_HIT", "TP2_HIT"]);
  });

  test("stale LTP (0) → monitorDegraded + DATA_WARNING deduped per day, trade untouched", async () => {
    await openTrade("B");
    __setQuantLtpFetcherForTests(async () => 0);

    const s1 = await tickMonitor(NOW);
    expect(s1.degraded).toBeGreaterThanOrEqual(1);

    let row = await db.quantPaperTrade.findUnique({ where: { tradeId: tradeB } });
    expect(row!.monitorDegraded).toBe(true);
    expect(row!.status).toBe("OPEN"); // never claimed a hit from stale data
    expect(row!.exitPrice).toBeNull();

    const warnings1 = await db.quantTradeEvent.findMany({ where: { tradeId: tradeB, type: "DATA_WARNING" } });
    expect(warnings1.length).toBe(1);
    const outbox1 = await db.quantAlertOutbox.findMany({
      where: { idempotencyKey: { startsWith: `DATA_WARNING:${tradeB}:` } },
    });
    expect(outbox1.length).toBe(1);
    expect(outbox1[0].alertType).toBe("QUANT_DATA_WARNING");
    expect(outbox1[0].status).toBe("PENDING");

    // second identical warning the same IST day → deduped by idempotency key
    await tickMonitor(NOW + 30_000);
    const warnings2 = await db.quantTradeEvent.findMany({ where: { tradeId: tradeB, type: "DATA_WARNING" } });
    expect(warnings2.length).toBe(1);
    const outbox2 = await db.quantAlertOutbox.findMany({
      where: { idempotencyKey: { startsWith: `DATA_WARNING:${tradeB}:` } },
    });
    expect(outbox2.length).toBe(1);
  });

  test("recovered feed clears the degraded flag; SL through gap closes as CLOSED_SL", async () => {
    // Trade B recovers: a healthy tick resets monitorDegraded (no evaluation event since 80 < ltp < 120).
    __setQuantLtpFetcherForTests(async () => 95);
    await tickMonitor(NOW + 60_000);
    let row = await db.quantPaperTrade.findUnique({ where: { tradeId: tradeB } });
    expect(row!.monitorDegraded).toBe(false);
    expect(row!.status).toBe("OPEN");

    // Trade C: gap through the stop → CLOSED_SL at the worst realistic price.
    await openTrade("C", { tp2: null });
    __setQuantLtpFetcherForTests(async (_symbol, _strike, _type, _expiry) => 75);
    await tickMonitor(NOW + 90_000);

    const rowC = await db.quantPaperTrade.findUnique({ where: { tradeId: tradeC } });
    expect(rowC!.status).toBe("CLOSED_SL");
    expect(rowC!.exitPrice).toBe(75); // min(ltp 75, stop 80) — gap-through worst fill
    expect(rowC!.exitReason).toBe("GAP_THROUGH_SL");
    const evC = await db.quantTradeEvent.findMany({ where: { tradeId: tradeC } });
    expect(evC.length).toBe(1);
    expect(evC[0].type).toBe("GAP_THROUGH_SL");
    expect(evC[0].ambiguity ?? evC[0].note ?? "").toContain("gap");
  });

  test("monitor only touches its own engine rows", async () => {
    const all = await db.quantPaperTrade.findMany({ where: { status: { in: ["OPEN", "PARTIALLY_CLOSED"] } } });
    for (const row of all) {
      expect(row.engineVersion).toBe("UNIVERSAL_QUANT_V1");
    }
  });

  test("fully-exited trade left OPEN → closed + exactly one PAPER_EXIT alert (idempotent)", async () => {
    const tradeD = `${PREFIX}D`;
    // A trade whose full quantity was already exited by an earlier tick but
    // whose row was left OPEN (crash between event persist and row update).
    await db.quantPaperTrade.create({
      data: {
        tradeId: tradeD,
        engineVersion: "UNIVERSAL_QUANT_V1",
        mode: "PAPER",
        strategy: "TREND_CONTINUATION",
        regime: "TRENDING_UP",
        symbol: "NIFTY",
        exchange: "NSE",
        direction: "BUY_CE",
        tradingsymbol: "NIFTY31OCT2625000CE",
        strike: 25000,
        optionType: "CE",
        expiry: FUTURE_EXPIRY,
        lotSize: 65,
        lots: 2,
        quantity: 130,
        entryPrice: 100,
        stopLoss: 80,
        currentStopLoss: 80,
        tp1: 120,
        realizedPnl: 2600,
        estCosts: 90,
        exitPrice: 120,
        exitTime: new Date(NOW - 60_000),
        exitReason: "TP2_HIT",
        status: "OPEN",
      },
    });
    // The exited quantity is recorded as an event → remaining quantity = 0.
    await db.quantTradeEvent.create({
      data: {
        id: qid(),
        tradeId: tradeD,
        eventId: `${tradeD}:TP1_HIT:120:${NOW}`,
        type: "TP1_HIT",
        level: 120,
        fillPrice: 120,
        quantityExited: 130,
        remainingQuantity: 0,
        realizedPnl: 2600,
        ts: new Date(NOW - 60_000),
      },
    });

    __setQuantLtpFetcherForTests(async () => 125);
    await tickMonitor(NOW);
    const row = await db.quantPaperTrade.findUnique({ where: { tradeId: tradeD } });
    expect(row!.status).toBe("CLOSED_TP"); // never left OPEN (it would hold a slot forever)
    expect(row!.unrealizedPnl).toBe(0);

    const exits = await db.quantAlertOutbox.findMany({ where: { idempotencyKey: { contains: `${tradeD}:PAPER_EXIT` } } });
    expect(exits.length).toBe(1);
    expect(exits[0].alertType).toBe("QUANT_PAPER_EXIT");
    expect(shouldDeliverNow(exits[0].alertType)).toBe(true);
    const payload = JSON.parse(exits[0].payload);
    expect(payload.tradeId).toBe(tradeD);
    expect(payload.exitPrice).toBe(120);
    expect(payload.realizedPnl).toBe(2600);
    expect(payload.remainingQuantity).toBe(0);

    // Re-tick → no second PAPER_EXIT row (unique idempotency key).
    await db.quantPaperTrade.update({ where: { tradeId: tradeD }, data: { status: "OPEN" } });
    await tickMonitor(NOW + 60_000);
    const exits2 = await db.quantAlertOutbox.findMany({ where: { idempotencyKey: { contains: `${tradeD}:PAPER_EXIT` } } });
    expect(exits2.length).toBe(1);
  });
});
