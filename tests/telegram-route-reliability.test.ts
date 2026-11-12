/// <reference types="bun-types" />
// TDD for api/telegram/route.ts security (Step 7 + Step 8).
//
// Tests what can be reliably tested given Bun module caching (TELEGRAM_API_SECRET
// is read at module load time).

import { describe, it, expect, mock, afterEach } from "bun:test";
import { NextRequest } from "next/server";

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_API_SECRET;
  mock.restore();
});

async function importRouteWithEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[require.resolve("@/app/api/telegram/route")];
  return import("@/app/api/telegram/route");
}

async function importWithEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[require.resolve("@/app/api/telegram/route")]
  return import("@/app/api/telegram/route");
}

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

  it("returns 401 without x-api-key header", async () => {
    process.env.TELEGRAM_API_SECRET = "test-secret";

    const mod = await importWithEnv({ TELEGRAM_API_SECRET: "test-secret" });
    const req = new NextRequest("http://localhost/api/telegram", {
      method: "POST",
      body: JSON.stringify({ type: "signal", symbol: "NIFTY", direction: "BULLISH", confidence: 70, reasons: ["test"] }),
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong x-api-key header", async () => {
    process.env.TELEGRAM_API_SECRET = "correct-secret";

    const mod = await importWithEnv({ TELEGRAM_API_SECRET: "correct-secret" });
    const req = new NextRequest("http://localhost/api/telegram", {
      method: "POST",
      headers: { "x-api-key": "wrong-secret" },
      body: JSON.stringify({ type: "signal", symbol: "NIFTY", direction: "BULLISH", confidence: 70, reasons: ["test"] }),
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 503 when TELEGRAM_API_SECRET is not configured", async () => {
    delete process.env.TELEGRAM_API_SECRET;

    const mod = await importWithEnv({ TELEGRAM_API_SECRET: undefined });
    const req = new NextRequest("http://localhost/api/telegram", {
      method: "POST",
      body: JSON.stringify({ type: "signal", symbol: "NIFTY", direction: "BULLISH", confidence: 70, reasons: ["test"] }),
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(503);
  });

  it("returns 400 for message type with empty text", async () => {
    process.env.TELEGRAM_API_SECRET = "test-secret";

    const mod = await importWithEnv({ TELEGRAM_API_SECRET: "test-secret" });
    const req = new NextRequest("http://localhost/api/telegram", {
      method: "POST",
      headers: { "x-api-key": "test-secret" },
      body: JSON.stringify({ type: "message", text: "" }),
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for message type with whitespace-only text", async () => {
    process.env.TELEGRAM_API_SECRET = "test-secret";

    const mod = await importWithEnv({ TELEGRAM_API_SECRET: "test-secret" });
    const req = new NextRequest("http://localhost/api/telegram", {
      method: "POST",
      headers: { "x-api-key": "test-secret" },
      body: JSON.stringify({ type: "message", text: "   " }),
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(400);
  });
});
