// tests/quant-telegram.test.ts — Telegram notification layer for UNIVERSAL_QUANT_V1.
//
// Policy + formatter are pure unit tests. Queue tests run against the real dev
// SQLite DB; every row carries the "TESTQ:" idempotency-key prefix and is
// deleted in beforeEach/afterAll.
//
// NO REAL TELEGRAM: process.env.TELEGRAM_BOT_TOKEN is deleted in beforeEach so
// the raw sender fails fast; tests that exercise the delivered path stub
// globalThis.fetch BEFORE arming a fake token — the sender calls the stub, the
// network is never touched.

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { db } from "@/lib/db";
import {
  QUANT_ALERT_POLICY,
  shouldDeliverNow,
  isAggregated,
  AGGREGATE_WINDOW_MINUTES,
  type QuantAlertType,
} from "@/lib/quant/quant-alert-policy";
import { formatQuantAlert, type QuantAlertPayload } from "@/lib/quant/quant-alert-formatter";
import { buildIdempotencyKey, isDuplicateKey } from "@/lib/quant/quant-alert-dedupe";
import { enqueueQuantAlert, flushOutbox, getOutboxStatus } from "@/lib/quant/quant-alert-queue";
import { istDayKey } from "@/lib/quant/quant-data";

// ── env + fetch harness ──────────────────────────────────────────────

const ORIG = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  allow: process.env.TELEGRAM_ALLOW_OFFHOURS,
  chat: process.env.TELEGRAM_CHAT_ID,
  quantChat: process.env.QUANT_TELEGRAM_CHAT_ID,
};
const REAL_FETCH = globalThis.fetch;
const TESTQ = "TESTQ:";

function clearSendEnv(): void {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALLOW_OFFHOURS;
  delete process.env.QUANT_TELEGRAM_CHAT_ID;
}

/** Delivered-path harness: stubbed fetch + fake creds. Nothing leaves the process. */
function armStubSend(ok: boolean): void {
  (globalThis as any).fetch = async () => ({ ok, json: async () => ({ ok, result: {} }) });
  process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN";
  process.env.TELEGRAM_CHAT_ID = "TESTCHAT";
  process.env.TELEGRAM_ALLOW_OFFHOURS = "1"; // window gate off — fetch is stubbed
}

/** Tripwire harness: any network touch explodes; token deleted so the sender bails early. */
function armNoNetwork(): void {
  (globalThis as any).fetch = async () => {
    throw new Error("network must not be touched");
  };
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALLOW_OFFHOURS;
}

function restoreEnv(): void {
  if (ORIG.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = ORIG.token;
  if (ORIG.allow === undefined) delete process.env.TELEGRAM_ALLOW_OFFHOURS;
  else process.env.TELEGRAM_ALLOW_OFFHOURS = ORIG.allow;
  if (ORIG.chat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = ORIG.chat;
  if (ORIG.quantChat === undefined) delete process.env.QUANT_TELEGRAM_CHAT_ID;
  else process.env.QUANT_TELEGRAM_CHAT_ID = ORIG.quantChat;
}

beforeEach(async () => {
  clearSendEnv();
  globalThis.fetch = REAL_FETCH;
  await db.quantAlertOutbox.deleteMany({ where: { idempotencyKey: { startsWith: TESTQ } } });
});

afterAll(async () => {
  globalThis.fetch = REAL_FETCH;
  restoreEnv();
  await db.quantAlertOutbox.deleteMany({ where: { idempotencyKey: { startsWith: TESTQ } } });
  await db.$disconnect();
});

// ── shared fixtures ──────────────────────────────────────────────────

const NOW = Date.parse("2026-10-26T10:30:00+05:30"); // fixed IST instant → deterministic keys

const basePayload = (over: QuantAlertPayload = {}): QuantAlertPayload => ({
  mode: "PAPER",
  symbol: "NIFTY",
  exchange: "NSE",
  strategy: "TREND_CONTINUATION",
  direction: "BUY_CE",
  regime: "TRENDING_UP",
  tradingsymbol: "NIFTY31OCT2625000CE",
  strike: 25000,
  optionType: "CE",
  expiry: "31-Oct-2026",
  lotSize: 65,
  lots: 2,
  quantity: 130,
  entry: 100,
  stopLoss: 80,
  eventTime: NOW,
  ...over,
});

const allNull: QuantAlertPayload = {
  tradeId: null, eventId: null, decisionId: null, mode: null, symbol: null, exchange: null,
  underlying: null, strategy: null, direction: null, regime: null,
  tradingsymbol: null, strike: null, optionType: null, expiry: null, lotSize: null, lots: null, quantity: null,
  entry: null, stopLoss: null, currentStopLoss: null, targets: null, targetPrice: null, tpLevel: null,
  nextTarget: null, fillPrice: null, exitPrice: null, quantityExited: null, remainingQuantity: null,
  realizedPnl: null, unrealizedPnl: null, estCosts: null, riskAmount: null, maxLossPlanned: null,
  rewardRisk: null, exitReason: null, dataSource: null, dataHealth: null, eventTime: null,
  reasons: null, message: null, source: null, detail: null, notes: null,
  trades: null, wins: null, losses: null, winRate: null, pnl: null, symbols: null,
};

const ALL_TYPES = Object.keys(QUANT_ALERT_POLICY) as QuantAlertType[];

// ── policy ───────────────────────────────────────────────────────────

describe("quant alert policy", () => {
  test("every alert type has an enabled policy with a valid priority", () => {
    expect(ALL_TYPES.length).toBe(19);
    for (const t of ALL_TYPES) {
      expect(QUANT_ALERT_POLICY[t].enabled).toBe(true);
      expect(["HIGH", "MEDIUM", "LOW"]).toContain(QUANT_ALERT_POLICY[t].priority);
      expect(typeof QUANT_ALERT_POLICY[t].immediate).toBe("boolean");
    }
  });

  test("per-trade data warning is immediate MEDIUM (deliverable, deduped per trade/day)", () => {
    expect(QUANT_ALERT_POLICY.QUANT_DATA_WARNING).toEqual({ enabled: true, priority: "MEDIUM", immediate: true });
    expect(shouldDeliverNow("QUANT_DATA_WARNING")).toBe(true);
  });

  test("hit/exit/risk/error + candidate/entry types are immediate HIGH", () => {
    const immediateHigh: QuantAlertType[] = [
      "QUANT_TP1_HIT", "QUANT_TP2_HIT", "QUANT_TP3_HIT", "QUANT_TP4_HIT",
      "QUANT_SL_HIT", "QUANT_TRAILING_SL_HIT", "QUANT_BREAKEVEN_SL_HIT", "QUANT_GAP_THROUGH_SL",
      "QUANT_PARTIAL_PROFIT_BOOKED", "QUANT_PAPER_EXIT", "QUANT_PAPER_ENTRY",
      "QUANT_TRADE_CANDIDATE", "QUANT_RISK_BLOCK", "QUANT_ENGINE_ERROR",
    ];
    for (const t of immediateHigh) {
      expect(QUANT_ALERT_POLICY[t].immediate).toBe(true);
      expect(QUANT_ALERT_POLICY[t].priority).toBe("HIGH");
    }
  });

  test("aggregated and special types match the spec", () => {
    expect(QUANT_ALERT_POLICY.QUANT_NO_TRADE).toEqual({ enabled: true, priority: "MEDIUM", immediate: false });
    expect(QUANT_ALERT_POLICY.QUANT_DATA_FAILURE).toEqual({ enabled: true, priority: "LOW", immediate: false });
    expect(QUANT_ALERT_POLICY.QUANT_DAILY_SUMMARY).toEqual({ enabled: true, priority: "MEDIUM", immediate: true });
    expect(QUANT_ALERT_POLICY.QUANT_STARTUP).toEqual({ enabled: true, priority: "LOW", immediate: true });
  });

  test("shouldDeliverNow / isAggregated / aggregate window", () => {
    expect(shouldDeliverNow("QUANT_TP1_HIT")).toBe(true);
    expect(shouldDeliverNow("QUANT_NO_TRADE")).toBe(false);
    expect(isAggregated("QUANT_NO_TRADE")).toBe(true);
    expect(isAggregated("QUANT_TP1_HIT")).toBe(false);
    expect(AGGREGATE_WINDOW_MINUTES).toBe(60);
  });
});

// ── formatter ────────────────────────────────────────────────────────

describe("quant alert formatter", () => {
  test("candidate: paper/shadow label, engine, contract, SL, R:R, risk", () => {
    const text = formatQuantAlert(
      "QUANT_TRADE_CANDIDATE",
      basePayload({ tradeId: "TESTQ:CAND", decisionId: "DEC-1", targets: { tp1: 120, tp2: 140 }, riskAmount: 2000, rewardRisk: 2, estCosts: 85 }),
    );
    expect(text).toContain("UNIVERSAL QUANT — TRADE CANDIDATE");
    expect(text).toContain("PAPER / SHADOW — NO LIVE ORDER");
    expect(text).toContain("Engine: UNIVERSAL_QUANT_V1");
    expect(text).toContain("NIFTY31OCT2625000CE");
    expect(text).toContain("Stop Loss: ₹80");
    expect(text).toContain("R:R: 1:2");
    expect(text).toContain("Est Risk: ₹2000");
    expect(text).toContain("Est Costs: ₹85");
    expect(text).toContain("Regime: TRENDING_UP");
    expect(text).toContain("Event Time (IST)");
  });

  test("TP1 hit: level, booked P&L, ids, next target, paper footer", () => {
    const text = formatQuantAlert(
      "QUANT_TP1_HIT",
      basePayload({
        tradeId: "TESTQ:TP1", eventId: "q_evt_tp1",
        targets: { tp1: 120, tp2: 140 }, targetPrice: 120, fillPrice: 120,
        quantityExited: 65, remainingQuantity: 65, realizedPnl: 1290,
        currentStopLoss: 100, dataSource: "NSE", dataHealth: "FRESH",
      }),
    );
    expect(text).toContain("UNIVERSAL QUANT — TP1 HIT");
    expect(text).toContain("Target: TP1 — ₹120");
    expect(text).toContain("Simulated Fill: ₹120");
    expect(text).toContain("Booked P&L: ₹1290");
    expect(text).toContain("Next Target: TP2 — ₹140");
    expect(text).toContain("Data Source: NSE");
    expect(text).toContain("Data Health: FRESH");
    expect(text).toContain("Trade ID: TESTQ:TP1");
    expect(text).toContain("Event ID: q_evt_tp1");
    expect(text).toContain("PAPER TRADE — NO LIVE ORDER");
  });

  test("SL hit: stop-loss title, exit reason, configured SL, closed footer", () => {
    const text = formatQuantAlert(
      "QUANT_SL_HIT",
      basePayload({ tradeId: "TESTQ:SL", eventId: "q_evt_sl", exitReason: "STOP_LOSS", exitPrice: 80, quantityExited: 130, remainingQuantity: 0, realizedPnl: -2600 }),
    );
    expect(text).toContain("UNIVERSAL QUANT — STOP LOSS HIT");
    expect(text).toContain("Exit Reason: STOP_LOSS");
    expect(text).toContain("Configured SL: ₹80");
    expect(text).toContain("Simulated Exit: ₹80");
    expect(text).toContain("Realized P&L:");
    expect(text).toContain("PAPER TRADE CLOSED — NO LIVE ORDER");
  });

  test("SL partial exit footer when quantity remains", () => {
    const text = formatQuantAlert("QUANT_SL_HIT", basePayload({ exitReason: "STOP_LOSS", exitPrice: 80, remainingQuantity: 30 }));
    expect(text).toContain("PARTIAL EXIT — PAPER TRADE");
  });

  test("gap-through-stop variant title and derived exit reason", () => {
    const text = formatQuantAlert("QUANT_GAP_THROUGH_SL", basePayload({ exitPrice: 75, remainingQuantity: 0 }));
    expect(text).toContain("UNIVERSAL QUANT — GAP THROUGH STOP");
    expect(text).toContain("Exit Reason: GAP_THROUGH_SL");
  });

  test("trailing and breakeven variants carry their exit reasons", () => {
    expect(formatQuantAlert("QUANT_TRAILING_SL_HIT", basePayload({}))).toContain("Exit Reason: TRAILING_SL");
    expect(formatQuantAlert("QUANT_BREAKEVEN_SL_HIT", basePayload({}))).toContain("Exit Reason: BREAKEVEN_SL");
  });

  test("dynamic values are HTML-escaped", () => {
    const text = formatQuantAlert("QUANT_TRADE_CANDIDATE", basePayload({ tradingsymbol: "BAD<x>&y" }));
    expect(text).toContain("BAD&lt;x&gt;&amp;y"); // escaped form
    expect(text).not.toContain("BAD<x>");
  });

  test("NO_TRADE renders top 3 reasons only", () => {
    const text = formatQuantAlert("QUANT_NO_TRADE", basePayload({ tradeId: "TESTQ:HOLD", reasons: ["r1", "r2", "r3", "r4"] }));
    expect(text).toContain("1. r1");
    expect(text).toContain("3. r3");
    expect(text).not.toContain("r4");
  });

  test("every type formats with an all-null payload: no placeholders, no leaks", () => {
    for (const t of ALL_TYPES) {
      const text = formatQuantAlert(t, allNull);
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain("UNIVERSAL_QUANT_V1");
      expect(text).not.toContain("[actual");
      expect(text).not.toContain("[configured");
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("NaN");
      expect(text).not.toContain("[object");
    }
  });
});

// ── dedupe keys ──────────────────────────────────────────────────────

describe("quant alert dedupe keys", () => {
  test("key format: tradeId:type:level:occurrence:IST-day", () => {
    expect(buildIdempotencyKey({ tradeId: "TESTQ:K", type: "QUANT_TP1_HIT", level: 120, occurrence: null, nowMs: NOW })).toBe(
      "TESTQ:K:QUANT_TP1_HIT:120:0:2026-10-26",
    );
    expect(buildIdempotencyKey({ tradeId: null, type: "QUANT_NO_TRADE", level: null, occurrence: 2, nowMs: NOW })).toBe(
      "NA:QUANT_NO_TRADE:NA:2:2026-10-26",
    );
    expect(buildIdempotencyKey({ type: "QUANT_STARTUP" })).toMatch(/^NA:QUANT_STARTUP:NA:0:\d{4}-\d{2}-\d{2}$/);
  });
});

// ── queue (DB round trip, fetch stubbed) ─────────────────────────────

describe("quant alert queue", () => {
  test("enqueue persists a PENDING outbox row without any network activity", async () => {
    armNoNetwork(); // any send attempt during enqueue explodes
    const r = await enqueueQuantAlert({
      type: "QUANT_PAPER_ENTRY",
      tradeId: "TESTQ:OPEN",
      nowMs: NOW,
      eventId: "q_evt_open",
      payload: basePayload({ tradeId: "TESTQ:OPEN", eventId: "q_evt_open", fillPrice: 100.5 }),
    });
    expect(r.queued).toBe(true);
    expect(r.eventId).toBe("q_evt_open");
    const key = buildIdempotencyKey({ tradeId: "TESTQ:OPEN", type: "QUANT_PAPER_ENTRY", nowMs: NOW });
    const row = await db.quantAlertOutbox.findUnique({ where: { idempotencyKey: key } });
    expect(row).toBeTruthy();
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(0);
    expect(row!.eventId).toBe("q_evt_open");
    expect(row!.chatId).toBeNull(); // QUANT_TELEGRAM_CHAT_ID cleared
    const payload = JSON.parse(row!.payload);
    expect(payload.fillPrice).toBe(100.5);
    expect(payload.mode).toBe("PAPER");
  });

  test("flush delivers an immediate alert: PENDING → SENT with sentAt", async () => {
    armStubSend(true);
    const r = await enqueueQuantAlert({
      type: "QUANT_TP1_HIT",
      tradeId: "TESTQ:TP1",
      level: 120,
      nowMs: NOW,
      payload: basePayload({
        tradeId: "TESTQ:TP1", eventId: "q_evt_tp1", targets: { tp1: 120, tp2: 140 },
        targetPrice: 120, fillPrice: 120, quantityExited: 65, remainingQuantity: 65,
        realizedPnl: 1290, currentStopLoss: 100, dataSource: "NSE", dataHealth: "FRESH",
      }),
    });
    expect(r.queued).toBe(true);
    const key = buildIdempotencyKey({ tradeId: "TESTQ:TP1", type: "QUANT_TP1_HIT", level: 120, nowMs: NOW });
    const before = await db.quantAlertOutbox.findUnique({ where: { idempotencyKey: key } });
    expect(before!.status).toBe("PENDING");
    expect(before!.attempts).toBe(0);

    const res = await flushOutbox(NOW, { idempotencyKeyPrefix: TESTQ });
    expect(res.flushed).toBe(1);
    expect(res.sent).toBe(1);
    expect(res.deferred).toBe(0);
    expect(res.failed).toBe(0);

    const after = await db.quantAlertOutbox.findUnique({ where: { idempotencyKey: key } });
    expect(after!.status).toBe("SENT");
    expect(after!.sentAt).not.toBeNull();
  });

  test("send failure (ok:false) → RETRYING with attempts 1 and lastError", async () => {
    armStubSend(false);
    const r = await enqueueQuantAlert({
      type: "QUANT_SL_HIT",
      tradeId: "TESTQ:FAIL1",
      level: 80,
      nowMs: NOW,
      payload: basePayload({ tradeId: "TESTQ:FAIL1", exitReason: "STOP_LOSS", exitPrice: 80, remainingQuantity: 0 }),
    });
    expect(r.queued).toBe(true);
    const res = await flushOutbox(NOW, { idempotencyKeyPrefix: TESTQ });
    expect(res.sent).toBe(0);
    expect(res.deferred).toBe(1);
    expect(res.failed).toBe(0);
    const key = buildIdempotencyKey({ tradeId: "TESTQ:FAIL1", type: "QUANT_SL_HIT", level: 80, nowMs: NOW });
    const row = await db.quantAlertOutbox.findUnique({ where: { idempotencyKey: key } });
    expect(row!.status).toBe("RETRYING");
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toBe("send-false");
  });

  test("five failed flushes → FAILED (terminal), then no longer picked up", async () => {
    armStubSend(false);
    const r = await enqueueQuantAlert({
      type: "QUANT_TRAILING_SL_HIT",
      tradeId: "TESTQ:FAIL5",
      level: 90,
      nowMs: NOW,
      payload: basePayload({ tradeId: "TESTQ:FAIL5" }),
    });
    expect(r.queued).toBe(true);
    let last;
    for (let i = 0; i < 5; i++) last = await flushOutbox(NOW, { idempotencyKeyPrefix: TESTQ });
    expect(last!.failed).toBe(1);
    const key = buildIdempotencyKey({ tradeId: "TESTQ:FAIL5", type: "QUANT_TRAILING_SL_HIT", level: 90, nowMs: NOW });
    const row = await db.quantAlertOutbox.findUnique({ where: { idempotencyKey: key } });
    expect(row!.status).toBe("FAILED");
    expect(row!.attempts).toBe(5);
    const res6 = await flushOutbox(NOW, { idempotencyKeyPrefix: TESTQ });
    expect(res6.flushed).toBe(0); // attempts < 5 filter excludes terminal rows
  });

  test("duplicate enqueue → deduped, single outbox row", async () => {
    const input = {
      type: "QUANT_PAPER_ENTRY" as QuantAlertType,
      tradeId: "TESTQ:DUP",
      level: null,
      nowMs: NOW,
      payload: basePayload({ tradeId: "TESTQ:DUP", fillPrice: 100 }),
    };
    const r1 = await enqueueQuantAlert(input);
    const r2 = await enqueueQuantAlert(input);
    expect(r1.queued).toBe(true);
    expect(r2.queued).toBe(false);
    expect(r2.deduped).toBe(true);
    const rows = await db.quantAlertOutbox.findMany({ where: { idempotencyKey: { startsWith: "TESTQ:DUP:" } } });
    expect(rows.length).toBe(1);
    const key = buildIdempotencyKey({ tradeId: "TESTQ:DUP", type: "QUANT_PAPER_ENTRY", nowMs: NOW });
    expect(await isDuplicateKey(key)).toBe(true);
    expect(await isDuplicateKey("TESTQ:NOPE:QUANT_TP1_HIT:NA:0:2026-10-26")).toBe(false);
  });

  test("restart recovery: row persists through a failing sender, delivers on a later flush", async () => {
    armNoNetwork(); // enqueue must persist with zero network activity
    const r = await enqueueQuantAlert({
      type: "QUANT_BREAKEVEN_SL_HIT",
      tradeId: "TESTQ:RECOV",
      level: 100,
      nowMs: NOW,
      payload: basePayload({ tradeId: "TESTQ:RECOV", exitReason: "BREAKEVEN_SL" }),
    });
    expect(r.queued).toBe(true);
    const key = buildIdempotencyKey({ tradeId: "TESTQ:RECOV", type: "QUANT_BREAKEVEN_SL_HIT", level: 100, nowMs: NOW });

    const res1 = await flushOutbox(NOW, { idempotencyKeyPrefix: TESTQ });
    expect(res1.deferred).toBe(1);
    let row = await db.quantAlertOutbox.findUnique({ where: { idempotencyKey: key } });
    expect(row!.status).toBe("RETRYING"); // survived the failed flush — persistence before delivery
    expect(row!.attempts).toBe(1);

    armStubSend(true);
    const res2 = await flushOutbox(NOW, { idempotencyKeyPrefix: TESTQ });
    expect(res2.sent).toBe(1);
    row = await db.quantAlertOutbox.findUnique({ where: { idempotencyKey: key } });
    expect(row!.status).toBe("SENT");
    expect(row!.sentAt).not.toBeNull();
  });

  test("non-immediate type (QUANT_NO_TRADE) defers and stays PENDING inside the aggregate window", async () => {
    armStubSend(true); // even with a working sender, aggregated types wait for the window
    const r = await enqueueQuantAlert({
      type: "QUANT_NO_TRADE",
      tradeId: "TESTQ:HOLD",
      nowMs: NOW,
      payload: basePayload({ tradeId: "TESTQ:HOLD", reasons: ["trend filter failed", "confidence below floor", "spread too wide"] }),
    });
    expect(r.queued).toBe(true);
    const res = await flushOutbox(NOW, { idempotencyKeyPrefix: TESTQ });
    expect(res.flushed).toBe(1);
    expect(res.deferred).toBe(1);
    expect(res.sent).toBe(0);
    const key = buildIdempotencyKey({ tradeId: "TESTQ:HOLD", type: "QUANT_NO_TRADE", nowMs: NOW });
    const row = await db.quantAlertOutbox.findUnique({ where: { idempotencyKey: key } });
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(0);
  });

  test("aged aggregate (older than the aggregate window) is delivered once — no row stays PENDING forever", async () => {
    armStubSend(true);
    const r = await enqueueQuantAlert({
      type: "QUANT_NO_TRADE",
      tradeId: "TESTQ:AGED",
      nowMs: NOW,
      payload: basePayload({ tradeId: "TESTQ:AGED", reasons: ["no eligible strategy signal"] }),
    });
    expect(r.queued).toBe(true);
    const key = buildIdempotencyKey({ tradeId: "TESTQ:AGED", type: "QUANT_NO_TRADE", nowMs: NOW });
    // Age the row past the aggregate window (wall clock, not the test clock).
    await db.quantAlertOutbox.update({
      where: { idempotencyKey: key },
      data: { createdAt: new Date(Date.now() - (AGGREGATE_WINDOW_MINUTES + 5) * 60_000) },
    });

    const res = await flushOutbox(NOW, { idempotencyKeyPrefix: TESTQ });
    expect(res.sent).toBe(1);
    expect(res.deferred).toBe(0);
    const row = await db.quantAlertOutbox.findUnique({ where: { idempotencyKey: key } });
    expect(row!.status).toBe("SENT");
    expect(row!.sentAt).not.toBeNull();

    // A second flush does not resend it.
    const res2 = await flushOutbox(NOW, { idempotencyKeyPrefix: TESTQ });
    expect(res2.flushed).toBe(0);
  });

  test("unknown alert type is quarantined as FAILED (never PENDING forever)", async () => {
    armStubSend(true);
    const id = `TESTQ:UNKNOWN-${Date.now()}`;
    await db.quantAlertOutbox.create({
      data: {
        id,
        eventId: id,
        idempotencyKey: `${id}:QUANT_LEVEL_EVENT:NA:0:${istDayKey(NOW)}`,
        alertType: "QUANT_LEVEL_EVENT",
        payload: "{}",
        status: "PENDING",
        attempts: 0,
      },
    });
    const res = await flushOutbox(NOW, { idempotencyKeyPrefix: id });
    expect(res.failed).toBe(1);
    const row = await db.quantAlertOutbox.findUnique({ where: { idempotencyKey: `${id}:QUANT_LEVEL_EVENT:NA:0:${istDayKey(NOW)}` } });
    expect(row!.status).toBe("FAILED");
    expect(row!.lastError).toContain("unknown alert type");
    await db.quantAlertOutbox.deleteMany({ where: { idempotencyKey: { startsWith: id } } });
  });

  test("getOutboxStatus reports counts and recent failures", async () => {
    armStubSend(false);
    const r = await enqueueQuantAlert({
      type: "QUANT_GAP_THROUGH_SL",
      tradeId: "TESTQ:STAT",
      level: 80,
      nowMs: NOW,
      payload: basePayload({ tradeId: "TESTQ:STAT", exitPrice: 75, remainingQuantity: 0 }),
    });
    expect(r.queued).toBe(true);
    await flushOutbox(NOW, { idempotencyKeyPrefix: TESTQ });
    const status = await getOutboxStatus();
    expect(typeof status.counts).toBe("object");
    expect(status.counts["RETRYING"]).toBeGreaterThanOrEqual(1);
    const mine = status.recentFailures.find((f) => f.alertType === "QUANT_GAP_THROUGH_SL");
    expect(mine).toBeTruthy();
    expect(mine!.attempts).toBe(1);
    expect(mine!.lastError).toBe("send-false");
    expect(typeof mine!.eventId).toBe("string");
  });
});
