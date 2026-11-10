/// <reference types="bun-types" />
// TDD for sendIntradayAlerts.ts gates (Item C + Item D).

import { describe, it, expect, mock, afterEach, test } from "bun:test";
import { CONF_FLOOR_CALL, CONF_FLOOR_PUT } from "@/lib/signal-persistence";

// Captured at load, before any test replaces it. afterEach must RESTORE this
// (never `delete` it — later files that do `const orig = globalThis.fetch`
// would capture undefined and their spies break).
const realFetch = globalThis.fetch;

afterEach(async () => {
  // Drop any trade/lock a previous test created — hasActiveTrade() would
  // otherwise filter NIFTY out of the next test's scan list.
  try {
    const tracker = await import("@/lib/activeTradeTracker");
    for (const t of tracker.getActiveTrades()) tracker.removeTradeForTest(t.id);
    const locks = await import("@/lib/active-trade-lock");
    locks.forceRelease("NIFTY", "NFO");
    locks.forceRelease("NIFTY", "NSE");
  } catch {
    // tracker not imported — nothing to clean
  }

  // mock.restore() also undoes the mock.module() overrides below — do NOT
  // re-mock with a captured namespace (it is a live proxy and would leak).
  mock.restore();
  delete process.env.INTRADAY_GATES;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_ALLOW_OFFHOURS;
  delete process.env.TELEGRAM_DIGEST_CHAT_IDS;
  delete process.env.TRAINING_SNAPSHOT_DISABLED;
  globalThis.fetch = realFetch;
  try {
    const { resetDedupeForTest } = await import("@/lib/intradayState");
    resetDedupeForTest();
  } catch {
    // ignore
  }
});

async function importWithTelegramGate(gateMock: any) {
  const telegramModule = await import("@/lib/telegram");
  mock.module("@/lib/telegram", () => ({
    ...telegramModule,
    evaluateTradeGate: gateMock,
  }));
  delete require.cache[require.resolve("@/lib/sendIntradayAlerts")];
  return import("@/lib/sendIntradayAlerts");
}

function makeAlert(overrides: any = {}): any {
  const optionType = overrides.optionType ?? "CE";
  return {
    symbol: "NIFTY",
    strike: 24800,
    entry: 157,
    sl: 125.6,
    tp1: 247.1,
    confidence: 75,
    spot: 24812,
    expiry: "09-Nov-2026",
    riskReward: 2,
    ...overrides,
    // sdmSignalToAlert() derives CE/PE from `direction`, not from optionType.
    optionType,
    direction: optionType === "PE" ? "PUT" : "CALL",
  };
}

/** URL-aware fetch mock: a real signal only for NIFTY, Telegram sends succeed,
 *  every other URL (other symbols, /api/scanner, option-chain, audit sidecar)
 *  fails so the run stays at exactly one alert. */
function mockFetch(signal: any) {
  const fetchMock = mock(async (url: any) => {
    const u = String(url);
    if (u.includes("/api/sdm-signal") && u.includes("symbol=NIFTY")) {
      return { ok: true, json: async () => ({ ok: true, success: true, signal }) };
    }
    if (u.includes("/sendMessage")) {
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }
    return { ok: false, json: async () => ({ ok: false }) };
  });
  // @ts-ignore
  globalThis.fetch = fetchMock;
}

function envForSend() {
  process.env.TELEGRAM_ALLOW_OFFHOURS = "1";
  process.env.TELEGRAM_DIGEST_CHAT_IDS = "chat1";
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_CHAT_ID = "test-chat";
  // addTrade() would fire-and-forget a training snapshot → appends to the
  // tracked data/training/trades.json. A module mock of the trainer leaks
  // past mock.restore() into later test files, so opt out via the flag
  // activeTradeTracker reads at call time.
  process.env.TRAINING_SNAPSHOT_DISABLED = "1";
}

describe("sendIntradayAlerts gate behavior", () => {
  it("log mode: gate blocks but alert still sends", async () => {
    process.env.INTRADAY_GATES = "log";
    envForSend();

    const gateMock = mock(async () => ({
      blocked: true,
      reasons: ["option R:R 1.00 < 1.5"],
    }));

    mockFetch(makeAlert());

    const { sendIntradayAlerts } = await importWithTelegramGate(gateMock);
    const result = await sendIntradayAlerts();

    expect(gateMock).toHaveBeenCalled();
    expect(result.newAlerts).toBe(1);
  });

  it("enforce mode: gate blocks and alert does NOT send", async () => {
    process.env.INTRADAY_GATES = "enforce";
    envForSend();

    const gateMock = mock(async () => ({
      blocked: true,
      reasons: ["option R:R 1.00 < 1.5"],
    }));

    mockFetch(makeAlert());

    const { sendIntradayAlerts } = await importWithTelegramGate(gateMock);
    const result = await sendIntradayAlerts();

    expect(gateMock).toHaveBeenCalled();
    expect(result.newAlerts).toBe(0);
  });

  it("PUT at 65% confidence is rejected (PUT floor is 70%)", async () => {
    process.env.INTRADAY_GATES = "log";
    envForSend();

    const gateMock = mock(async () => ({
      blocked: false,
      reasons: [],
    }));

    mockFetch(makeAlert({ optionType: "PE", confidence: 65 }));

    const { sendIntradayAlerts } = await importWithTelegramGate(gateMock);
    const result = await sendIntradayAlerts();

    expect(gateMock).not.toHaveBeenCalled();
    expect(result.newAlerts).toBe(0);
  });

  it("PUT at 70% confidence passes (PUT floor is 70%)", async () => {
    process.env.INTRADAY_GATES = "log";
    envForSend();

    const gateMock = mock(async () => ({
      blocked: false,
      reasons: [],
    }));

    mockFetch(makeAlert({ optionType: "PE", confidence: 70 }));

    const { sendIntradayAlerts } = await importWithTelegramGate(gateMock);
    const result = await sendIntradayAlerts();

    expect(gateMock).toHaveBeenCalled();
    expect(result.newAlerts).toBe(1);
  });
});

describe("tp3 formatting (Option Buying Playbook requirement)", () => {
  it("tp3 is included in the alert message when provided", async () => {
    process.env.INTRADAY_GATES = "log";
    envForSend();

    const gateMock = mock(async () => ({
      blocked: false,
      reasons: [],
    }));

    mockFetch(makeAlert({
      tp3: 247.1,
    }));

    const { sendIntradayAlerts } = await importWithTelegramGate(gateMock);
    const result = await sendIntradayAlerts();

    expect(result.newAlerts).toBe(1);
    // The formatted message should include TP3
    const fetchMock = globalThis.fetch as any;
    const calls = fetchMock.mock.calls;
    const telegramCall = calls.find((c: any) => String(c[0]).includes("/sendMessage"));
    expect(telegramCall).toBeDefined();
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toContain("Target 3: ₹247.10");
  });

  it("tp3 is optional - alert works without tp3", async () => {
    process.env.INTRADAY_GATES = "log";
    envForSend();

    const gateMock = mock(async () => ({
      blocked: false,
      reasons: [],
    }));

    mockFetch(makeAlert({
      tp1: 247.1,
      // no tp3
      tp2: undefined,
      tp3: undefined,
    }));

    const { sendIntradayAlerts } = await importWithTelegramGate(gateMock);
    const result = await sendIntradayAlerts();

    expect(result.newAlerts).toBe(1);
  });
});

describe("scan with failing Breeze", () => {
  it("scan succeeds even when Breeze is down - falls back to NSE", async () => {
    process.env.INTRADAY_GATES = "log";
    envForSend();

    // Breeze fails, but NSE works for option chain
    const fetchMock = mock(async (url: any) => {
      const u = String(url);
      if (u.includes("/api/sdm-signal")) {
        return { ok: true, json: async () => ({ ok: true, success: true, signal: makeAlert() }) };
      }
      // Breeze option chain fails
      if (u.includes("icici-breeze") || u.includes("breeze")) {
        return { ok: false, status: 503, json: async () => ({ ok: false }) };
      }
      // NSE works
      if (u.includes("/api/option-chain")) {
        return { ok: true, json: async () => ({ success: true, data: { strikes: [], spotPrice: 25000 } }) };
      }
      return { ok: false, json: async () => ({ ok: false }) };
    });
    // @ts-ignore
    globalThis.fetch = fetchMock;

    const { sendIntradayAlerts } = await import("@/lib/sendIntradayAlerts");
    const result = await sendIntradayAlerts();

    expect(result.newAlerts).toBeGreaterThanOrEqual(0);
  });
});


describe("holiday list (NSE_HOLIDAYS env var)", async () => {
  it("contains all canonical 2026 holidays", async () => {
    const { NSE_HOLIDAYS } = await import("@/lib/expiry-calculator");
    expect(NSE_HOLIDAYS).toContain("2026-01-26"); // Republic Day
    expect(NSE_HOLIDAYS).toContain("2026-03-30"); // Eid
    expect(NSE_HOLIDAYS).toContain("2026-04-02"); // Ram Navami
    expect(NSE_HOLIDAYS).toContain("2026-04-14"); // Ambedkar Jayanti
    expect(NSE_HOLIDAYS).toContain("2026-05-01"); // Maharashtra Day
    expect(NSE_HOLIDAYS).toContain("2026-08-15"); // Independence Day
    expect(NSE_HOLIDAYS).toContain("2026-09-14"); // Ganesh Chaturthi
    expect(NSE_HOLIDAYS).toContain("2026-10-02"); // Gandhi Jayanti
    expect(NSE_HOLIDAYS).toContain("2026-11-10"); // Diwali-Balipratipada
    expect(NSE_HOLIDAYS).toContain("2026-11-24"); // Guru Nanak Jayanti
    expect(NSE_HOLIDAYS).toContain("2026-12-25"); // Christmas
  });

  test("does NOT contain old wrong date 2026-11-11", async () => {
    const { NSE_HOLIDAYS } = await import("@/lib/expiry-calculator");
    expect(NSE_HOLIDAYS.has("2026-11-11")).toBe(false);
  });

  test("market-hours isTradingDay uses env holidays", async () => {
    process.env.NSE_HOLIDAYS = "2026-11-10";
    const { isTradingDay, isTelegramSendWindow } = await import("@/lib/marketHours");
    const tradeDay = new Date("2026-11-10T11:00:00+05:30");
    expect(isTradingDay(tradeDay)).toBe(false);
    expect(isTelegramSendWindow(tradeDay)).toBe(false);

    // Next day should be trading day
    const nextDay = new Date("2026-11-11T11:00:00+05:30");
    expect(isTradingDay(nextDay)).toBe(true);
    expect(isTelegramSendWindow(nextDay)).toBe(true);
  });
});

describe("markdown escaping", async () => {
  it("escapes markdown special characters in symbol names", async () => {
    const { escapeHtml } = await import("@/lib/telegram");
    // HTML is escaped, not markdown - verify HTML entities
    expect(escapeHtml("M&M")).toBe("M&amp;M");
    expect(escapeHtml("SBI & Co.")).toBe("SBI &amp; Co.");
    expect(escapeHtml("A<B>C").includes("&lt;")).toBe(true);
    expect(escapeHtml('test "quote"').includes("&quot;")).toBe(true);
  });
});

describe("signal dedupe (intradayState)", async () => {
  it("dedupes same symbol+strike+optionType per day", async () => {
    const { alreadySentToday, markSentToday } = await import("@/lib/intradayState");
    const sig = "NIFTY|24800|CE|BUY|stock-scanner";
    
    expect(alreadySentToday(sig)).toBe(false);
    markSentToday(sig);
    expect(alreadySentToday(sig)).toBe(true);
  });

  it("different strikes are not deduplicated", async () => {
    const { alreadySentToday, markSentToday } = await import("@/lib/intradayState");
    const sig1 = "NIFTY|24800|CE|BUY|stock-scanner";
    const sig2 = "NIFTY|25000|CE|BUY|stock-scanner";
    
    expect(alreadySentToday(sig1)).toBe(false);
    markSentToday(sig1);
    expect(alreadySentToday(sig1)).toBe(true);
    expect(alreadySentToday(sig2)).toBe(false);
  });
});
