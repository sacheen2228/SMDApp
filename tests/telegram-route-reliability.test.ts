/// <reference types="bun-types" />
// TDD for api/telegram/route.ts security (Step 7 + Step 8).
//
// Tests what can be reliably tested given Bun module caching (TELEGRAM_API_SECRET
// is read at module load time).

import { describe, it, expect, mock, afterEach } from "bun:test";
import { NextRequest } from "next/server";

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  mock.restore();
});

describe("telegram route security", () => {
  it("verify type does not require API key", async () => {
    delete process.env.TELEGRAM_API_SECRET;
    process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";

    const fetchMock = mock(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { username: "test_bot" } }),
    }));
    // @ts-ignore
    globalThis.fetch = fetchMock;

    const mod = await import("@/app/api/telegram/route");
    const req = new NextRequest("http://localhost/api/telegram", {
      method: "POST",
      body: JSON.stringify({ type: "verify" }),
    });
    const res = await mod.POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });
});
