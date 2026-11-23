// ═══════════════════════════════════════════════════════════════════════════
// ALERT LEAK GUARD — a test run must never reach the real Telegram bot,
// and a restored trade must be monitored again.
//
// Covers the 21/11 blackout:
//   1. the central Telegram sender has NO test-mode guard → fixture trades
//      were delivered to the live chat (e2e-* ids, strike 23400, entry ₹100)
//   2. an LTP-feed failure was claimed as eventType SL_HIT → it squatted the
//      (tradeId, SL_HIT, targetLevel) key and printed "Event: SL_HIT (v1)"
//   3. a suppressed event was marked SENT → the journal claimed a delivery
//      that never happened and the event could never be retried
//   4. reloadActiveTrades() never registered the restored trade with the
//      universal monitor → after every restart the 5s TP/SL loop was blind
//   5. synthetic rows (probe-*, provenance-*) were reloaded → they blocked
//      NIFTY and produced monitoring-error spam
//   6. SENSEX (BSE) had no LTP rung in the monitor → never priced
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, afterAll } from "bun:test";

const PREFIX = "leakguard-";
const createdTradeIds: string[] = [];

async function getDb() {
  const { db } = await import("@/lib/db");
  return db;
}

/** A fetch stub that can NEVER reach api.telegram.org. */
function stubFetch() {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return {
      ok: false,
      status: 500,
      json: async () => ({ ok: false, description: "stubbed" }),
    } as any;
  }) as any;
  return {
    calls: () => calls,
    restore: () => { globalThis.fetch = realFetch; },
  };
}

function setAllowOffHours(value: string | undefined) {
  const prev = process.env.TELEGRAM_ALLOW_OFFHOURS;
  if (value === undefined) delete process.env.TELEGRAM_ALLOW_OFFHOURS;
  else process.env.TELEGRAM_ALLOW_OFFHOURS = value;
  return prev;
}

describe("Telegram sender: a test run can never reach the live bot", () => {
  it("blocks the send entirely while NODE_ENV=test", async () => {
    const { __setTelegramSenderForTests, sendTelegramMessage } = await import("@/lib/telegram");
    __setTelegramSenderForTests(null); // no mock — only the test guard may stop this
    const stub = stubFetch();
    const prev = setAllowOffHours("1"); // window OPEN: only the test guard can stop it
    try {
      const ok = await sendTelegramMessage("leak-guard probe");
      expect(ok).toBe(false);
      expect(stub.calls()).toBe(0);
    } finally {
      stub.restore();
      setAllowOffHours(prev);
    }
  });
});

describe("trade-event coordinator: the journal never claims an undelivered alert", () => {
  it("records a suppressed event as FAILED, never SENT", async () => {
    const db = await getDb();
    const stub = stubFetch();
    const prev = setAllowOffHours("1");
    const { sendTradeEvent } = await import("@/lib/trade-event-coordinator");
    const tradeId = `${PREFIX}${Date.now()}-evt`;
    try {
      const res = await sendTradeEvent({
        tradeId,
        eventType: "TP1_HIT",
        targetLevel: 120,
        symbol: "LEAKGUARD",
        action: "BUY",
        strike: 100,
        optionType: "CE",
        entry: 100,
        stopLoss: 90,
        target1: 120,
        confidence: 70,
        source: "leakguard-test",
      });
      const row = await db.notificationEvent.findFirst({ where: { tradeId } });
      expect(res.sent).toBe(false);
      expect(row).toBeTruthy();
      expect(row?.status).not.toBe("SENT");
    } finally {
      stub.restore();
      setAllowOffHours(prev);
    }
  });
});

describe("universal monitor: a feed failure is never an SL_HIT", () => {
  it("claims MONITOR_ERROR, not SL_HIT, when the LTP feed stays dead", async () => {
    const db = await getDb();
    const stub = stubFetch();
    const { registerTradeForMonitoring, pollTradesOnce } = await import("@/lib/agents/trade-monitor");
    const tradeId = `${PREFIX}${Date.now()}-mon`;
    registerTradeForMonitoring({
      tradeId,
      symbol: "LEAKGUARD",
      exchange: "NSE",
      instrument: "CALL",
      side: "BUY",
      strike: 100,
      entry: 100,
      stopLoss: 90,
      tp1: 120,
      tp2: 140,
      tp3: 160,
      expiry: "2026-11-27",
      confidence: 70,
      source: "stock-scanner",
    });
    try {
      for (let i = 0; i < 12; i++) await pollTradesOnce(async () => 0);
      const rows = await db.notificationEvent.findMany({ where: { tradeId } });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r: any) => r.eventType === "SL_HIT")).toBe(false);
      expect(rows.every((r: any) => r.eventType === "MONITOR_ERROR")).toBe(true);
    } finally {
      stub.restore();
    }
  });
});

describe("universal monitor: a BSE contract is priced from the BSE chain", () => {
  it("falls back to the BSE chain for a SENSEX contract", async () => {
    const { fetchLTP } = await import("@/lib/agents/trade-monitor");
    const ltp = await fetchLTP("SENSEX", 81000, "CE", "2026-11-27", {
      exchange: "BSE",
      moPath: async () => 0,
      breezeChain: async () => 0,
      nseChain: async () => 0,
      bseChain: async () => 123.45,
    } as any);
    expect(ltp).toBe(123.45);
  });
});

describe("active trade tracker: the journal is restored into the monitor", () => {
  it("re-registers a restored trade with the universal monitor", async () => {
    const db = await getDb();
    const { reloadActiveTrades, getTrade } = await import("@/lib/activeTradeTracker");
    const { getMonitoredTrade } = await import("@/lib/agents/trade-monitor");
    const tradeId = `${PREFIX}${Date.now()}-reload`;
    await db.trade.create({
      data: {
        tradeId,
        symbol: "LEAKGUARD",
        exchange: "NFO",
        strike: 100,
        type: "CE",
        side: "BUY",
        entryTime: new Date(),
        entryPrice: 100,
        confidence: 70,
        qualityScore: 70,
        qualityGrade: "B",
        aiReasonSnapshot: "leakguard",
        riskPerTrade: 10,
        positionSize: 1,
        stopLoss: 90,
        target1: 120,
        target2: 140,
        strategy: "leakguard-real",
        expiry: "2026-11-27",
        status: "ACTIVE",
      },
    });
    createdTradeIds.push(tradeId);
    await reloadActiveTrades();
    expect(getTrade(tradeId)).toBeDefined();
    const monitored = getMonitoredTrade(tradeId);
    expect(monitored).toBeDefined();
    expect(monitored?.source).toBe("leakguard-real");
  });

  it("never reloads a synthetic (probe-/provenance-) row", async () => {
    const db = await getDb();
    const { reloadActiveTrades, getTrade } = await import("@/lib/activeTradeTracker");
    const tradeId = `provenance-${Date.now()}-guard`;
    await db.trade.create({
      data: {
        tradeId,
        symbol: "LEAKGUARD2",
        exchange: "NFO",
        strike: 100,
        type: "CE",
        side: "BUY",
        entryTime: new Date(),
        entryPrice: 100,
        confidence: 50,
        qualityScore: 50,
        qualityGrade: "C",
        aiReasonSnapshot: "leakguard",
        riskPerTrade: 10,
        positionSize: 1,
        stopLoss: 90,
        target1: 120,
        strategy: "e2e-test",
        expiry: "2026-11-27",
        status: "ACTIVE",
      },
    });
    createdTradeIds.push(tradeId);
    await reloadActiveTrades();
    expect(getTrade(tradeId)).toBeUndefined();
  });
});

afterAll(async () => {
  try {
    const db = await getDb();
    await db.notificationEvent.deleteMany({ where: { tradeId: { startsWith: PREFIX } } });
    for (const tradeId of createdTradeIds) {
      await db.trade.deleteMany({ where: { tradeId } });
    }
    const { removeTradeForTest } = await import("@/lib/activeTradeTracker");
    for (const tradeId of createdTradeIds) removeTradeForTest(tradeId);
    const { closeTrade } = await import("@/lib/agents/trade-monitor");
    for (const tradeId of createdTradeIds) closeTrade(tradeId, 0, "test cleanup");
  } catch {
    // cleanup is best-effort
  }
});
