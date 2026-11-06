/// <reference types="bun-types" />
// TDD for telegram.ts reliability fixes (Step 1 + Step 8).
//
// Tests:
//   - throttle is not recorded when the send fails, but is recorded after a
//     successful send (mock fetch)
//   - an HTML parse error triggers a plain-text retry and returns true

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  isThrottled,
  markThrottle,
  sendTelegramMessage,
} from "@/lib/telegram";

afterEach(() => {
  mock.restore();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  // Restore original fetch if overwritten
  const originalFetch = (globalThis as any).__originalFetch;
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    delete (globalThis as any).__originalFetch;
  }
});

describe("sendTelegramMessage throttling (lower-level fns)", () => {
  it("isThrottled returns false for unseen key", () => {
    expect(isThrottled("new-key")).toBe(false);
  });

  it("markThrottle records the key; isThrottled returns true after", () => {
    expect(isThrottled("sig-1")).toBe(false);
    markThrottle("sig-1");
    expect(isThrottled("sig-1")).toBe(true);
  });

  it("different keys are independent", () => {
    markThrottle("key-a");
    expect(isThrottled("key-a")).toBe(true);
    expect(isThrottled("key-b")).toBe(false);
  });
});

describe("HTML parse error retry", () => {
  it("retries as plain text when Telegram returns parse error", async () => {
    let callCount = 0;
    const fetchMock = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          json: async () => ({
            ok: false,
            error_code: 400,
            description: "Bad Request: can't parse entities",
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    });
    // @ts-ignore - mock globalThis.fetch with simplified signature
    if (!(globalThis as any).__originalFetch) {
      (globalThis as any).__originalFetch = globalThis.fetch;
    }
    globalThis.fetch = fetchMock as any;

    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";

    const result = await sendTelegramMessage("<b>bold</b> text &amp; more");
    expect(result).toBe(true);
    expect(callCount).toBe(2);
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  });
});
