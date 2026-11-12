// tests/quant-comparison.test.ts — /api/quant/comparison route tests.
// Handlers are imported directly and called with plain Requests
// (quant-api.test.ts precedent). The trade-audit sidecar call is stubbed via
// globalThis.fetch — NO network, NO real sidecar. Quant rows are seeded with
// a unique prefix and cleaned up.

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { __resetQuantRuntimeConfigForTests } from "@/lib/quant/quant-runtime-config";
import { qid } from "@/lib/quant/quant-types";

// ── harness ──────────────────────────────────────────────────────────

const PREFIX = "qtest-cmp";
const ORIG_FETCH = globalThis.fetch;

const req = (url: string): any => new Request(`http://localhost:3000${url}`);

async function cleanup(): Promise<void> {
  await db.quantPaperTrade.deleteMany({ where: { tradeId: { startsWith: PREFIX } } });
}

beforeEach(async () => {
  __resetQuantRuntimeConfigForTests(); // mode SHADOW default
  await cleanup();
});

afterAll(async () => {
  globalThis.fetch = ORIG_FETCH;
  await cleanup();
  await db.$disconnect();
});

function stubFetch(handler: (url: string) => { status: number; body: unknown } | never): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    seen.push(u);
    const r = handler(u);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return seen;
}

async function seedTrade(suffix: string, over: Record<string, unknown> = {}): Promise<string> {
  const tradeId = `${PREFIX}-${suffix}`;
  await db.quantPaperTrade.create({
    data: {
      id: qid(),
      tradeId,
      engineVersion: "UNIVERSAL_QUANT_V1",
      mode: "PAPER",
      strategy: "TREND_CONTINUATION",
      regime: "TRENDING_UP",
      symbol: "NIFTY",
      exchange: "NSE",
      direction: "BUY_CE",
      lotSize: 65,
      lots: 1,
      quantity: 65,
      entryPrice: 150.55,
      entryTime: new Date("2026-10-20T10:00:00+05:30"),
      stopLoss: 133.2,
      currentStopLoss: 133.2,
      tp1: 175.2,
      status: "CLOSED_TP",
      exitPrice: 175.2,
      exitTime: new Date("2026-10-21T11:00:00+05:30"),
      exitReason: "TP1_HIT",
      realizedPnl: 1590.25,
      estCosts: 60.25,
      tpHitLevel: "TP1",
      ...over,
    },
  });
  return tradeId;
}

/** Environment-proof expectation: every CLOSED quant row's net, computed the
 *  same way computePerformance does (realizedPnl − estCosts). */
async function expectedNetFromDb(exitFilter: Record<string, unknown> = {}): Promise<{
  n: number;
  net: number;
}> {
  const rows = await db.quantPaperTrade.findMany({
    where: { status: { startsWith: "CLOSED" }, engineVersion: "UNIVERSAL_QUANT_V1", ...exitFilter },
    select: { realizedPnl: true, estCosts: true },
  });
  return {
    n: rows.length,
    net: rows.reduce((a, r) => a + (r.realizedPnl ?? 0) - (r.estCosts ?? 0), 0),
  };
}

const AUDIT_STATS = {
  totalTrades: 500,
  closedTrades: 480,
  wins: 250,
  losses: 230,
  winRate: 52.1,
  netPnl: 123456.5,
  profitFactor: 1.8,
  byStrategy: [
    { strategyId: "SMART_MONEY", trades: 210, wins: 134, losses: 76, winRate: 63.8, avgR: 0.9, netPnl: 351000, profitFactor: 4.7 },
    { strategyId: "BTST", trades: 270, wins: 116, losses: 154, winRate: 43.0, avgR: 0.4, netPnl: -12000, profitFactor: 1.2 },
  ],
  bySymbol: [],
  byMarketSession: [],
};

// ── tests ────────────────────────────────────────────────────────────

describe("GET /api/quant/comparison", () => {
  test("success envelope: quant side from seeded rows + mapped audit engines + comparisonRules", async () => {
    await seedTrade("win");
    await seedTrade("loss", {
      status: "CLOSED_SL",
      exitReason: "GAP_THROUGH_SL",
      exitPrice: 133.2,
      exitTime: new Date("2026-10-22T12:00:00+05:30"),
      realizedPnl: -1050,
      estCosts: 55,
      tpHitLevel: null,
    });
    stubFetch(() => ({ status: 200, body: AUDIT_STATS }));

    const { GET } = await import("@/app/api/quant/comparison/route");
    const res = await GET(req("/api/quant/comparison"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.generatedAt).toBeTruthy();

    // quant side — mirrors the DB expectation exactly
    const expected = await expectedNetFromDb();
    expect(body.quant.performance.n).toBe(expected.n);
    expect(body.quant.performance.n).toBeGreaterThanOrEqual(2);
    expect(body.quant.performance.netPnl).toBeCloseTo(expected.net, 2);
    expect(body.quant.mode).toBe("SHADOW"); // runtime config reset
    expect(body.quant.window).toBeNull();
    expect(typeof body.quant.sampleSizeCaveat === "string" || body.quant.sampleSizeCaveat === null).toBe(true);

    // existing side — mapped from the sidecar's byStrategy
    expect(body.existing.available).toBe(true);
    expect(body.existing.engines).toHaveLength(2);
    const sm = body.existing.engines.find((e: any) => e.strategyId === "SMART_MONEY");
    expect(sm).toEqual({ strategyId: "SMART_MONEY", trades: 210, winRate: 63.8, netPnl: 351000, profitFactor: 4.7 });

    // honesty rules always present
    expect(Array.isArray(body.comparisonRules)).toBe(true);
    expect(body.comparisonRules.length).toBeGreaterThanOrEqual(3);
    expect(body.comparisonRules.join(" ")).toContain("Aligned windows");
    expect(body.comparisonRules.join(" ")).toContain("Net-of-costs");
    expect(body.comparisonRules.join(" ")).toContain("Win rate alone");
    expect(body.comparisonRules.join(" ")).toContain("Sample size");
  });

  test("sidecar failure → existing: { available: false, reason } — nothing fabricated", async () => {
    await seedTrade("solo");
    stubFetch(() => {
      throw new Error("connection refused");
    });

    const { GET } = await import("@/app/api/quant/comparison/route");
    const body = await (await GET(req("/api/quant/comparison"))).json();

    expect(body.success).toBe(true);
    expect(body.existing.available).toBe(false);
    expect(body.existing.reason).toContain("trade-audit sidecar unavailable");
    expect(body.existing.engines).toBeUndefined();
    // the quant side still reports honestly
    const expected = await expectedNetFromDb();
    expect(body.quant.performance.n).toBe(expected.n);
    expect(body.comparisonRules.length).toBeGreaterThanOrEqual(3);
  });

  test("sidecar HTTP error (non-ok) → available: false as well", async () => {
    stubFetch(() => ({ status: 500, body: { error: "boom" } }));
    const { GET } = await import("@/app/api/quant/comparison/route");
    const body = await (await GET(req("/api/quant/comparison"))).json();
    expect(body.existing.available).toBe(false);
    expect(body.existing.reason).toContain("500");
  });

  test("aligned window (?dateFrom&dateTo) filters BOTH sides", async () => {
    await seedTrade("in-window", { exitTime: new Date("2026-10-23T11:00:00+05:30") });
    await seedTrade("out-window", { exitTime: new Date("2026-10-10T11:00:00+05:30") });
    const seen = stubFetch(() => ({ status: 200, body: AUDIT_STATS }));

    const { GET } = await import("@/app/api/quant/comparison/route");
    const body = await (
      await GET(req("/api/quant/comparison?dateFrom=2026-10-20&dateTo=2026-10-24"))
    ).json();

    // window echoed on the quant side
    expect(body.quant.window).toEqual({ dateFrom: "2026-10-20", dateTo: "2026-10-24" });

    // quant side honors the window (in-window row counted, out-window not)
    const expected = await expectedNetFromDb({
      exitTime: { gte: new Date("2026-10-20T00:00:00+05:30"), lte: new Date("2026-10-24T23:59:59.999+05:30") },
    });
    expect(body.quant.performance.n).toBe(expected.n);
    expect(body.quant.performance.n).toBeGreaterThanOrEqual(1);
    expect(body.quant.performance.netPnl).toBeCloseTo(expected.net, 2);

    // the audit sidecar call carried the same window
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("dateFrom=2026-10-20");
    expect(seen[0]).toContain("dateTo=2026-10-24");
  });
});
