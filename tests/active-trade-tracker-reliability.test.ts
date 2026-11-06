/// <reference types="bun-types" />
// TDD for activeTradeTracker.ts reliability fixes (Step 3 + Step 8).

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { addTrade, updateTradeStatus } from "@/lib/activeTradeTracker";
import { acquireTradeLock } from "@/lib/active-trade-lock";

afterEach(() => {
  mock.restore();
});

describe("addTrade returns boolean", () => {
  it("returns false when the lock is held", async () => {
    mock.module("@/lib/active-trade-lock", () => ({
      acquireTradeLock: mock(async () => ({
        blocked: true,
        activeTrade: { tradeId: "existing-1", symbol: "NIFTY" },
      })),
      releaseTradeLock: mock(async () => {}),
      updateTradeStatus: mock(async () => {}),
      isTradeActive: mock(() => null),
    }));

    const result = await addTrade({
      id: "test-trade-1",
      symbol: "NIFTY",
      side: "BUY",
      instrument: "NIFTY 24700 CE",
      strike: 24700,
      optionType: "CE",
      entry: 100,
      sl: 90,
      tp1: 110,
      status: "ACTIVE",
      sentAt: new Date().toISOString(),
      source: "test",
    });

    expect(result).toBe(false);
  });

  it("returns true when trade is added successfully", async () => {
    mock.module("@/lib/active-trade-lock", () => ({
      acquireTradeLock: mock(async () => ({ granted: true })),
      releaseTradeLock: mock(async () => {}),
      updateTradeStatus: mock(async () => {}),
      isTradeActive: mock(() => null),
    }));
    mock.module("./tradeStore", () => ({
      createTrade: mock(async () => {}),
    }));
    mock.module("./trade-audit-client", () => ({
      recordSignal: mock(async () => {}),
    }));
    mock.module("./training/trade-trainer", () => ({
      collectMarketSnapshot: mock(async () => null),
    }));

    const result = await addTrade({
      id: "test-trade-2",
      symbol: "NIFTY",
      side: "BUY",
      instrument: "NIFTY 24700 CE",
      strike: 24700,
      optionType: "CE",
      entry: 100,
      sl: 90,
      tp1: 110,
      status: "ACTIVE",
      sentAt: new Date().toISOString(),
      source: "test",
    });

    expect(result).toBe(true);
  });
});

describe("updateTradeStatus resilience", () => {
  it("completes close and releases lock when updateTrade throws", async () => {
    const lockReleased = mock(async () => {});
    mock.module("@/lib/active-trade-lock", () => ({
      acquireTradeLock: mock(async () => ({ granted: true })),
      releaseTradeLock: lockReleased,
      updateTradeStatus: mock(async () => {}),
      isTradeActive: mock(() => null),
    }));
    mock.module("./tradeStore", () => ({
      createTrade: mock(async () => {}),
      updateTrade: mock(async () => {
        throw new Error("db write failed");
      }),
    }));
    mock.module("./trade-audit-client", () => ({
      recordSignal: mock(async () => {}),
      updatePrice: mock(async () => {}),
      closeTrade: mock(async () => {}),
    }));

    // First add a trade
    await addTrade({
      id: "test-trade-3",
      symbol: "NIFTY",
      side: "BUY",
      instrument: "NIFTY 24700 CE",
      strike: 24700,
      optionType: "CE",
      entry: 100,
      sl: 90,
      tp1: 110,
      status: "ACTIVE",
      sentAt: new Date().toISOString(),
      source: "test",
    });

    // Now update to SL_HIT - updateTrade throws but status should still change
    await updateTradeStatus("test-trade-3", "SL_HIT", 90);

    // The lock should still be released (releaseTradeLock called)
    expect(lockReleased).toHaveBeenCalled();
  });
});
