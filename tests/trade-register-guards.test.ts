// tests/trade-register-guards.test.ts
//
// /api/trade/register is the funnel EVERY Terminal-tab registration flows
// through (ZeroHeroTerminal → registerTrades → POST /api/trade/register →
// addTrade → recordSignal → audit sidecar). These tests pin its safety
// contract:
//   - a missing stop is REJECTED, never invented (the old code fabricated
//     sl = entry × 0.78 — a made-up −22% stop on a real money trade)
//   - confidence floors (CE 55 / PE 65; 0-confidence never bypasses)
//   - option selling rejected, wrong-symbol strikes rejected
//   - level sanity (entry>=5, 0<sl<entry<tp1)
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { NextRequest } from "next/server";

function post(body: any): Request {
  return new NextRequest("http://localhost/api/trade/register", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const GOOD = {
  strategyId: "ZERO_HERO_AI",
  symbol: "NIFTY",
  strike: 23000,
  optionType: "CE",
  entry: 150,
  sl: 120,
  tp1: 210,
  confidence: 72,
  side: "BUY",
};

let POST: (req: Request) => Promise<Response>;

beforeEach(async () => {
  ({ POST } = await import("@/app/api/trade/register/route"));
});

// DB writes happen for accepted trades — keep them out of the real tables by
// rejecting every addTrade path except the guard-rejections we assert.
afterEach(async () => {
  const { __resetActiveTradesForTests } = await import("@/lib/activeTradeTracker");
  __resetActiveTradesForTests?.();
});

describe("POST /api/trade/register — safety contract", () => {
  test("missing sl → 422, never a fabricated −22% stop", async () => {
    const res = await POST(post({ ...GOOD, sl: undefined }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("sl");
  });

  test("sl=0 → 422", async () => {
    const res = await POST(post({ ...GOOD, sl: 0 }));
    expect(res.status).toBe(422);
  });

  test("sl >= entry → 422 (stop must sit below entry for options)", async () => {
    const res = await POST(post({ ...GOOD, sl: 160 }));
    expect(res.status).toBe(422);
  });

  test("tp1 <= entry → 422 (a target at or below entry is not a plan)", async () => {
    const res = await POST(post({ ...GOOD, tp1: 150 }));
    expect(res.status).toBe(422);
  });

  test("entry < 5 → 422 (NIFTY/SENSEX options never trade below ₹5 — stale quote)", async () => {
    const res = await POST(post({ ...GOOD, entry: 3, sl: 2, tp1: 5 }));
    expect(res.status).toBe(422);
  });

  test("confidence 0 on an option → 422 (the conf=0 hole stays closed)", async () => {
    const res = await POST(post({ ...GOOD, confidence: 0 }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("floor");
  });

  test("PE floor is 65", async () => {
    const res = await POST(post({ ...GOOD, optionType: "PE", confidence: 64 }));
    expect(res.status).toBe(422);
  });

  test("option selling → 422 OPTION_SELLING_NOT_ALLOWED", async () => {
    const res = await POST(post({ ...GOOD, side: "SELL" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("OPTION_SELLING");
  });

  test("wrong-symbol strike scale → 422 (the Jul-15 SENSEX-24200 class)", async () => {
    const res = await POST(post({ ...GOOD, symbol: "SENSEX", strike: 24200, spotPrice: 77000 }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("off-scale");
  });

  test("missing strategyId/symbol/entry → 400", async () => {
    expect((await POST(post({ ...GOOD, strategyId: undefined }))).status).toBe(400);
    expect((await POST(post({ ...GOOD, symbol: undefined }))).status).toBe(400);
    expect((await POST(post({ ...GOOD, entry: undefined }))).status).toBe(400);
  });
});
