/// <reference types="bun-types" />
// TDD for telegram-queue.ts reliability fixes (Step 2 + Step 8).

import { describe, it, expect, mock, afterEach } from "bun:test";

afterEach(() => {
  mock.restore();
});

// The event-bus mock must carry the FULL export surface: mock.module replaces
// the module for the WHOLE test process, and later test files (paper-pe-side,
// hermes-paper) import emitTradeClosed etc. — a partial mock makes those
// imports fail with "Export not found". Real functions, mocked by default.
const eventBusMockFactory = (bus: Record<string, unknown>) => ({
  getEventBus: () => bus,
  emitTradeCreated: async () => "evt-mock",
  emitTP1Hit: async () => "evt-mock",
  emitTP2Hit: async () => "evt-mock",
  emitSLHit: async () => "evt-mock",
  emitTradeClosed: async () => "evt-mock",
  emitTrailingSL: async () => "evt-mock",
  emitThesisInvalidated: async () => "evt-mock",
  emitTimeExit: async () => "evt-mock",
  emitExpiryExit: async () => "evt-mock",
});

describe("TelegramQueue.start() resilience", () => {
  it("creates the timer even when getRecentEvents throws", async () => {
    const mockBus = {
      getRecentEvents: mock(() => {
        throw new Error("bus down");
      }),
    };
    mock.module("@/lib/hermes/event-bus", () => eventBusMockFactory(mockBus));

    // Dynamic import to pick up the mocked event-bus
    const { TelegramQueue, getTelegramQueue } = await import("@/lib/hermes/telegram-queue");
    const queue = new TelegramQueue();
    const sendFn = mock(async () => true);
    await queue.start(sendFn);

    expect(queue.isRunning()).toBe(true);
    expect(queue["processInterval"]).not.toBeNull();

    await queue.stop();
  });
});

describe("TelegramQueue.processQueue() resilience", () => {
  it("still sends when bus.markDelivered throws, and does NOT re-send", async () => {
    let markDeliveredThrows = true;
    const mockBus = {
      getRecentEvents: mock(() => []),
      markDelivered: mock(async () => {
        if (markDeliveredThrows) throw new Error("bus write failed");
      }),
      markFailed: mock(async () => {}),
    };
    mock.module("@/lib/hermes/event-bus", () => eventBusMockFactory(mockBus));

    const { TelegramQueue } = await import("@/lib/hermes/telegram-queue");
    const queue = new TelegramQueue();
    const sendFn = mock(async () => true);
    await queue.start(sendFn);

    await queue.enqueue("evt-1", "hello world", "SL_HIT");

    // Wait for processing (interval is 3s)
    await new Promise((r) => setTimeout(r, 4000));

    // sendFn must have been called (markDelivered was invoked only after send success)
    expect(sendFn.mock.calls.length).toBeGreaterThan(0);

    // After markDelivered throws, the item should still be SENT (not RETRYING/FAILED)
    // because markDelivered failure is caught and treated as non-fatal.
    const status = queue.getStatus();
    expect(status.pending).toBe(0);
    expect(status.retrying).toBe(0);

    await queue.stop();
  });
});
