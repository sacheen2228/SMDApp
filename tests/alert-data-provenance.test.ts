import { describe, test, expect } from "bun:test";
import { chainAgeMinutes, isChainFresh } from "@/lib/sendIntradayAlerts";
import { formatStockOptionAlert } from "@/lib/sendIntradayAlerts";

describe("alert data provenance", () => {
  test("the stock-option alert names the data source", () => {
    const msg = formatStockOptionAlert(
      { symbol: "SBIN", totalScore: 62, reasons: ["RVOL 1.6x"] },
      { optionType: "PE", strike: 970, premium: 8.5, stopLoss: 10.2, targets: [5.1, 3.4, 1.7], expiryLabel: "27-Oct-2026" },
      { quotes: "nse", daily: "nse", intraday: "none", chain: "NSE (2m ago)" },
    );
    expect(msg).toContain("📡 Data:");
    expect(msg).toContain("NSE");
    expect(msg).toContain("5m UNAVAILABLE");
  });

  test("a chain older than 15 minutes is not tradable (fail closed)", () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    const fresh = new Date(Date.now() - 2 * 60_000).toISOString();
    expect(isChainFresh(old)).toBe(false);
    expect(isChainFresh(fresh)).toBe(true);
    expect(chainAgeMinutes(old)!).toBeGreaterThan(19);
    // unknown age is not provably stale — it is reported, not blocked
    expect(isChainFresh(undefined)).toBe(true);
  });
});

describe("monitoring errors never reach the real Telegram from a test run", () => {
  test("the monitoring-error alert goes through the injectable sender", async () => {
    const { __setAlertSenderForTests } = await import("@/lib/agents/telegram-alerts");
    const sent: string[] = [];
    __setAlertSenderForTests(async (text: string) => { sent.push(text); return true; });
    const { pollTradesOnce } = await import("@/lib/agents/trade-monitor");
    const { addTrade } = await import("@/lib/activeTradeTracker");
    const id = `provenance-${Date.now()}`;
    await addTrade({
      id, symbol: "NIFTY", side: "BUY", instrument: "NIFTY 23400 CE", strike: 23400,
      optionType: "CE", entry: 100, sl: 90, tp1: 110, tp2: 120, tp3: 130,
      status: "ACTIVE", sentAt: new Date().toISOString(), source: "e2e-test", exchange: "NFO",
    }, true);
    // an LTP feed that never works → the monitoring error must be captured, not sent
    await pollTradesOnce(async () => 0);
    await pollTradesOnce(async () => 0);
    await pollTradesOnce(async () => 0);
    await pollTradesOnce(async () => 0);
    await pollTradesOnce(async () => 0);
    await pollTradesOnce(async () => 0);
    await pollTradesOnce(async () => 0);
    await pollTradesOnce(async () => 0);
    await pollTradesOnce(async () => 0);
    await pollTradesOnce(async () => 0);
    const monitoring = sent.filter((s) => s.includes("MONITORING ERROR"));
    expect(monitoring.length).toBe(1);
    expect(monitoring[0]).toContain("LTP feed unavailable");
    __setAlertSenderForTests(null);

    // CLEANUP: the fixture must not stay ACTIVE — an open NIFTY trade blocks the
    // next entry for the same symbol (and broke the option-engine test).
    const { removeTradeForTest } = await import("@/lib/activeTradeTracker");
    removeTradeForTest(id);
    // release the in-memory trade LOCK too — an open NIFTY lock blocks the next
    // entry for the same underlying (it silently turned the option-engine test NO_TRADE)
    const { releaseTradeLock } = await import("@/lib/active-trade-lock");
    releaseTradeLock("NIFTY", "NFO");
    const { db } = await import("@/lib/db");
    await db.trade.deleteMany({ where: { tradeId: id } });
  });
});
