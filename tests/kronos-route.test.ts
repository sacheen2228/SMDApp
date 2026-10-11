/// <reference types="bun-types" />
// TDD for /api/kronos proxy route: passes query through to the :8770
// sidecar, normalizes to { success }, 503 when sidecar is down.

import { describe, test, expect, beforeEach, mock } from "bun:test";

const fetchMock = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
globalThis.fetch = fetchMock as any;

const { GET } = await import("@/app/api/kronos/route");

function req(url: string) {
  return new Request(url);
}

describe("/api/kronos", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ success: true, symbol: "NIFTY", direction: "UP", confidence: 62, spot: 22520, target: 22700, pred: [] }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
  });

  test("proxies symbol/interval/predLen to sidecar and returns its JSON", async () => {
    const res = await GET(req("http://x/api/kronos?symbol=SENSEX&interval=1d&predLen=5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.symbol).toBe("NIFTY");

    const called = fetchMock.mock.calls[0][0] as string;
    expect(called).toContain("8770");
    expect(called).toContain("symbol=SENSEX");
    expect(called).toContain("interval=1d");
    expect(called).toContain("pred_len=5");
  });

  test("defaults to NIFTY when no query given", async () => {
    await GET(req("http://x/api/kronos"));
    const called = fetchMock.mock.calls[0][0] as string;
    expect(called).toContain("symbol=NIFTY");
  });

  test("returns 503 when sidecar is unreachable", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("ECONNREFUSED")));
    const res = await GET(req("http://x/api/kronos?symbol=NIFTY"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  test("passes through sidecar error status", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: false, error: "only 3 candles" }), { status: 502 })
      )
    );
    const res = await GET(req("http://x/api/kronos?symbol=XYZ"));
    expect(res.status).toBe(502);
  });
});
