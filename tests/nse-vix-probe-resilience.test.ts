/// <reference types="bun-types" />
// Regression: getNSEIndiaVIX must survive a poisoned nse-all-indices gate key.
//
// Live 2026-11-20: one timeout on key "nse-all-indices" suppresses it for
// keyCooldownMs (300s). getNSEIndiaVIX swallowed NseSuppressedError and
// returned null, so /api/premarket-readiness reported
// "allIndices probe empty" for five minutes after a single blip.

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { NseSuppressedError, NseBlockedError } from "@/lib/market/nse-gate";

const VIX_BODY = {
  data: [
    { index: "NIFTY 50", last: 25700.1, previousClose: 25500, percentChange: 0.78 },
    { index: "INDIA VIX", last: 17.44, previousClose: 16.11, percentChange: 8.27 },
  ],
};

const realFetch = globalThis.fetch;
let gateError: Error | null = null;
let gateCalls = 0;
let directCalls = 0;

// Inject a gate that always throws the configured error (simulates suppression
// after a prior timeout) while still exporting the error classes nse-api may
// check by name/code.
mock.module("@/lib/market/nse-gate", () => ({
  nseGate: {
    fetchJson: async () => {
      gateCalls++;
      if (gateError) throw gateError;
      return VIX_BODY;
    },
    call: async (_key: string, fn: () => Promise<unknown>) => {
      gateCalls++;
      if (gateError) throw gateError;
      return fn();
    },
    getSnapshot: () => null,
    getState: () => ({ blocked: false }),
  },
  NseSuppressedError,
  NseBlockedError,
  isNseForbidden: () => false,
  isNseProviderFailure: () => false,
}));

const { getNSEIndiaVIX, getNSEIndices } = await import("@/lib/nse-api");

describe("NSE allIndices readers — gate-suppression resilience", () => {
  beforeEach(() => {
    gateError = null;
    gateCalls = 0;
    directCalls = 0;
    globalThis.fetch = (async (input: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      if (url.includes("/api/allIndices")) {
        directCalls++;
        return Response.json(VIX_BODY);
      }
      // cookie warm-up (home) — 403 under bot protection, no set-cookie needed
      return new Response("forbidden", { status: 403 });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns INDIA VIX when the gate key is suppressed (direct fallback)", async () => {
    gateError = new NseSuppressedError(250_000, "error");
    const vix = await getNSEIndiaVIX();
    expect(vix).not.toBeNull();
    expect(vix!.value).toBe(17.44);
    expect(vix!.change).toBe(8.27);
    expect(directCalls).toBeGreaterThanOrEqual(1);
  });

  test("returns INDIA VIX when the gate throws a timeout", async () => {
    gateError = new Error("timeout of 8000ms exceeded");
    const vix = await getNSEIndiaVIX();
    expect(vix?.value).toBe(17.44);
    expect(directCalls).toBeGreaterThanOrEqual(1);
  });

  test("returns INDIA VIX when the global gate is blocked (NSE_BLOCKED)", async () => {
    gateError = new NseBlockedError(60_000);
    const vix = await getNSEIndiaVIX();
    expect(vix?.value).toBe(17.44);
    expect(directCalls).toBeGreaterThanOrEqual(1);
  });

  test("getNSEIndices maps rows when the gate key is suppressed", async () => {
    gateError = new NseSuppressedError(250_000, "error");
    const rows = await getNSEIndices();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.key === "NIFTY")).toBe(true);
    expect(directCalls).toBeGreaterThanOrEqual(1);
  });

  test("healthy gate path does not need a direct allIndices fetch", async () => {
    gateError = null;
    const vix = await getNSEIndiaVIX();
    expect(vix?.value).toBe(17.44);
    expect(gateCalls).toBeGreaterThanOrEqual(1);
    expect(directCalls).toBe(0);
  });

  test("returns null when both gate and direct fetch fail (no fabricated VIX)", async () => {
    gateError = new NseSuppressedError(250_000, "error");
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as any;
    const vix = await getNSEIndiaVIX();
    expect(vix).toBeNull();
  });
});
