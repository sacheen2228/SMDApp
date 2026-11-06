/// <reference types="bun-types" />
// TDD for expiry-liquidity/chain-source.ts gatherChainWithFallback (Item D)

import { describe, it, expect, mock, afterEach } from "bun:test";

afterEach(() => {
  mock.restore();
  delete process.env.INTRADAY_GATES;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_ALLOW_OFFHOURS;
  delete (globalThis as any).fetch;
});

async function importWithGateMock(gateMock: any) {
  const telegramModule = await import("@/lib/telegram");
  mock.module("@/lib/telegram", () => ({
    ...telegramModule,
    evaluateTradeGate: gateMock,
  }));
  delete require.cache[require.resolve("@/lib/expiry-liquidity/chain-source")];
  return import("@/lib/expiry-liquidity/chain-source");
}

function makeChainSourceDeps(overrides: any = {}): any {
  return {
    symbol: "NIFTY",
    strike: 24800,
    entry: 157,
    sl: 125.6,
    tp1: 247.1,
    confidence: 75,
    spot: 24812,
    expiry: "09-Nov-2026",
    ...overrides,
  };
}

describe("gatherChainWithFallback gate integration (Item D)", () => {
  it("gatherChainWithFallback calls evaluate_trade_gate when NSE primary is used", async () => {
    process.env.INTRADAY_GATES = "log";
    process.env.TELEGRAM_ALLOW_OFFHOURS = "1";

    const gateMock = mock(async () => ({
      blocked: false,
      reasons: [],
    }));

    const { gatherChainWithFallback } = await importWithTelegramGate(gateMock);
    const result = await gatherChainWithFallback("NIFTY");

    expect(gateMock).toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result?.source).toBe("nse-api");
  });

  it("gatherChainWithFallback skips breeze when gate blocks", async () => {
    process.env.INTRADAY_GATES = "enforce";
    process.env.TELEGRAM_ALLOW_OFFHOURS = "1";

    const gateMock = mock(async () => ({
      blocked: true,
      reasons: ["option R:R 1.00 < 1.5"],
    }));

    const { gatherChainWithFallback } = await importWithTelegramGate(gateMock);
    const result = await gatherChainWithFallback("NIFTY");

    expect(gateMock).toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("PUT at 65% confidence is rejected by gate (PUT floor is 70%)", async () => {
    process.env.INTRADAY_GATES = "log";
    process.env.TELEGRAM_ALLOW_OFFHOURS = "1";

    const gateMock = mock(async () => ({
      blocked: false,
      reasons: [],
    }));

    const { gatherChainWithFallback } = await importWithTelegramGate(gateMock);
    const result = await gatherChainWithFallback("NIFTY", {
      spot: 24812,
      spotPrice: 24812,
      confidence: 65,
    } as any);

    expect(gateMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("PUT at 70% confidence passes (PUT floor is 70%)", async () => {
    process.env.INTRADAY_GATES = "log";
    process.env.TELEGRAM_ALLOW_OFFHOURS = "1";

    const gateMock = mock(async () => ({
      blocked: false,
      reasons: [],
    }));

    const { gatherChainWithFallback } = await importWithTelegramGate(gateMock);
    const result = await gatherChainWithFallback("NIFTY", {
      spot: 24812,
      spotPrice: 24812,
      confidence: 70,
    } as any);

    expect(gateMock).toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result?.source).toBe("nse-api");
  });
});
