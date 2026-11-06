/// <reference types="bun-types" />
// TDD for sendIntradayAlerts.ts gates (Item C + Item D).

import { describe, it, expect, mock, afterEach } from "bun:test";
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
