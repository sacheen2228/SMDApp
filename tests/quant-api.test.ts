// tests/quant-api.test.ts — route-handler tests for /api/quant/*.
// Handlers are imported directly (kronos-route.test.ts precedent) and called
// with plain Requests. NO REAL TELEGRAM (token deleted); the tick test runs
// with the engine disabled so the drain has nothing to send.

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { db } from "@/lib/db";
import { QUANT_FLAGS } from "@/lib/quant/quant-config";
import { __resetQuantRuntimeConfigForTests } from "@/lib/quant/quant-runtime-config";
import { qid } from "@/lib/quant/quant-types";

// ── harness ──────────────────────────────────────────────────────────

const CONFIG_FILE = join(process.cwd(), "data", "quant-config.json");
const CONFIG_BACKUP = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : null;
const ORIG_FLAGS_ENABLED = QUANT_FLAGS.enabled;
const TRADE_PREFIX = "qtest-api";

const ORIG = {
  admin: process.env.QUANT_ADMIN_SECRET,
  tick: process.env.QUANT_TICK_SECRET,
  token: process.env.TELEGRAM_BOT_TOKEN,
};

const seededTradeIds: string[] = [];

beforeEach(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.QUANT_TICK_SECRET;
  delete process.env.QUANT_ADMIN_SECRET;
  (QUANT_FLAGS as { enabled: boolean }).enabled = false;
  __resetQuantRuntimeConfigForTests();
  await db.quantAlertOutbox.deleteMany({ where: { idempotencyKey: { contains: TRADE_PREFIX } } });
  await db.quantTradeEvent.deleteMany({ where: { tradeId: { startsWith: TRADE_PREFIX } } });
  await db.quantPaperTrade.deleteMany({ where: { tradeId: { startsWith: TRADE_PREFIX } } });
  await db.quantDecisionLog.deleteMany({ where: { decisionId: { startsWith: TRADE_PREFIX } } });
});

afterAll(async () => {
  (QUANT_FLAGS as { enabled: boolean }).enabled = ORIG_FLAGS_ENABLED;
  if (ORIG.admin === undefined) delete process.env.QUANT_ADMIN_SECRET;
  else process.env.QUANT_ADMIN_SECRET = ORIG.admin;
  if (ORIG.tick === undefined) delete process.env.QUANT_TICK_SECRET;
  else process.env.QUANT_TICK_SECRET = ORIG.tick;
  if (ORIG.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = ORIG.token;
  await db.quantAlertOutbox.deleteMany({ where: { idempotencyKey: { contains: TRADE_PREFIX } } });
  await db.quantTradeEvent.deleteMany({ where: { tradeId: { startsWith: TRADE_PREFIX } } });
  await db.quantPaperTrade.deleteMany({ where: { tradeId: { startsWith: TRADE_PREFIX } } });
  await db.quantDecisionLog.deleteMany({ where: { decisionId: { startsWith: TRADE_PREFIX } } });
  if (CONFIG_BACKUP === null) {
    if (existsSync(CONFIG_FILE)) unlinkSync(CONFIG_FILE);
  } else {
    writeFileSync(CONFIG_FILE, CONFIG_BACKUP, "utf8");
  }
  await db.$disconnect();
});

async function seedTrade(suffix: string, status: string): Promise<string> {
  const tradeId = `${TRADE_PREFIX}-${suffix}`;
  seededTradeIds.push(tradeId);
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
      tradingsymbol: "NIFTY02NOV2622600CE",
      strike: 22600,
      optionType: "CE",
      expiry: "02-Nov-2026",
      lotSize: 65,
      lots: 1,
      quantity: 65,
      entryPrice: 150.55,
      entryTime: new Date(Date.now() - 3_600_000),
      stopLoss: 133.2,
      currentStopLoss: 133.2,
      tp1: 175.2,
      status,
      ...(status.startsWith("CLOSED")
        ? {
            exitPrice: 175.2,
            exitTime: new Date(),
            exitReason: "TP1_HIT",
            realizedPnl: 1590.25,
            estCosts: 60.25,
            tpHitLevel: "TP1",
          }
        : {}),
    },
  });
  return tradeId;
}

// Handlers take NextRequest; tests pass plain Requests (cast — bun runs them fine).
const req = (url: string, init?: RequestInit) => new Request(url, init);
const get = (path: string): any => req(`http://localhost:3000${path}`);
const postJson = (path: string, body: unknown): any =>
  req(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// ── status ───────────────────────────────────────────────────────────

describe("GET /api/quant/status", () => {
  test("success envelope with enabled/mode/session/outbox", async () => {
    const { GET } = await import("@/app/api/quant/status/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.enabled).toBe(false); // runtime config reset + flags forced off
    expect(body.mode).toBe("SHADOW"); // default
    expect(typeof body.session).toBe("string");
    expect(typeof body.openPositions).toBe("number");
    expect(typeof body.outbox.counts).toBe("object");
    expect(Array.isArray(body.outbox.recentFailures)).toBe(true);
  });

  test("openPositions counts seeded OPEN rows; lastDecision surfaces", async () => {
    const { GET } = await import("@/app/api/quant/status/route");
    const tradeId = await seedTrade("status", "OPEN");
    await db.quantDecisionLog.create({
      data: {
        id: qid(),
        decisionId: `${TRADE_PREFIX}-dec-1`,
        symbol: "NIFTY",
        verdict: "NO_TRADE",
        regime: "TRENDING_UP",
        blockReason: "test block",
        payload: "{}",
      },
    });
    const body = await (await GET()).json();
    expect(body.openPositions).toBeGreaterThanOrEqual(1);
    expect(body.lastDecision).toBeTruthy();
    expect(body.lastDecision.verdict).toBe("NO_TRADE");
    expect(body.lastDecision.blockReason).toBe("test block");
    void tradeId;
  });
});

// ── tick ─────────────────────────────────────────────────────────────

describe("/api/quant/tick", () => {
  test("GET without a secret (QUANT_TICK_SECRET unset) → 503, tick refused (fail closed)", async () => {
    const { GET } = await import("@/app/api/quant/tick/route");
    // NOTE: importing the route pulls in next/server → @next/env, which
    // re-loads .env (where QUANT_TICK_SECRET IS configured in production).
    // The delete must therefore happen AFTER the import — the route reads
    // process.env at request time, so the unset branch is still what runs.
    delete process.env.QUANT_TICK_SECRET;
    const res = await GET(get("/api/quant/tick"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("secret");
  });

  test("secret enforced when QUANT_TICK_SECRET is set; wrong secret → 403", async () => {
    process.env.QUANT_TICK_SECRET = "ticksecret";
    const { GET } = await import("@/app/api/quant/tick/route");
    const res = await GET(get("/api/quant/tick"));
    expect(res.status).toBe(403);
    expect((await res.json()).success).toBe(false);
    const ok = await GET(get("/api/quant/tick?secret=ticksecret"));
    expect(ok.status).toBe(200);
    expect((await ok.json()).success).toBe(true);
  });

  test("the secret may travel in the x-quant-tick-secret header", async () => {
    process.env.QUANT_TICK_SECRET = "ticksecret";
    const { POST } = await import("@/app/api/quant/tick/route");
    const req = postJson("/api/quant/tick", {});
    req.headers.set("x-quant-tick-secret", "ticksecret");
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  test("POST without a secret is refused exactly like GET", async () => {
    const { POST } = await import("@/app/api/quant/tick/route");
    delete process.env.QUANT_TICK_SECRET; // after import — see GET note above
    const res = await POST(postJson("/api/quant/tick", {}));
    expect(res.status).toBe(503);
    expect((await res.json()).success).toBe(false);
  });
});

// ── positions ────────────────────────────────────────────────────────

describe("GET /api/quant/positions", () => {
  test("returns seeded OPEN position", async () => {
    const { GET } = await import("@/app/api/quant/positions/route");
    const tradeId = await seedTrade("pos", "OPEN");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    const mine = body.positions.find((p: any) => p.tradeId === tradeId);
    expect(mine).toBeTruthy();
    expect(mine.status).toBe("OPEN");
    expect(mine.mode).toBe("PAPER");
  });
});

// ── trades + performance ─────────────────────────────────────────────

describe("GET /api/quant/trades", () => {
  test("returns trades + closed-trade performance (exact net of seeded closed row)", async () => {
    const { GET } = await import("@/app/api/quant/trades/route");
    await seedTrade("closed", "CLOSED_TP");
    const res = await GET(get("/api/quant/trades"));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.trades.length).toBeGreaterThanOrEqual(1);
    expect(body.performance.n).toBeGreaterThanOrEqual(1);
    // net = 1590.25 − 60.25 = 1530 for the seeded closed row
    expect(body.performance.netPnl).toBeCloseTo(1530, 2);
    expect(body.performance.winRate).toBe(100);
  });

  test("strategy/symbol filters apply", async () => {
    const { GET } = await import("@/app/api/quant/trades/route");
    const tradeId = await seedTrade("filter", "CLOSED_TP");
    const body = await (await GET(get("/api/quant/trades?strategy=NO_SUCH_STRATEGY"))).json();
    expect(body.trades.find((t: any) => t.tradeId === tradeId)).toBeUndefined();
    const hit = await (await GET(get("/api/quant/trades?symbol=NIFTY"))).json();
    expect(hit.trades.find((t: any) => t.tradeId === tradeId)).toBeTruthy();
  });
});

// ── events ───────────────────────────────────────────────────────────

describe("GET /api/quant/events", () => {
  test("default view: latest events; ?tradeId filters", async () => {
    const { GET } = await import("@/app/api/quant/events/route");
    const tradeId = await seedTrade("evt", "OPEN");
    await db.quantTradeEvent.create({
      data: { id: `${TRADE_PREFIX}-ev-1`, tradeId, eventId: `${TRADE_PREFIX}-evt-1`, type: "STATUS_CHANGE", note: "seeded" },
    });
    const all = await (await GET(get("/api/quant/events"))).json();
    expect(all.success).toBe(true);
    expect(Array.isArray(all.events)).toBe(true);
    const scoped = await (await GET(get(`/api/quant/events?tradeId=${tradeId}`))).json();
    expect(scoped.success).toBe(true);
    expect(scoped.events).toHaveLength(1);
    expect(scoped.events[0].type).toBe("STATUS_CHANGE");
  });

  test("?view=outbox returns delivery state rows", async () => {
    const { GET } = await import("@/app/api/quant/events/route");
    await db.quantAlertOutbox.create({
      data: {
        id: `${TRADE_PREFIX}-ob-1`,
        eventId: `${TRADE_PREFIX}-ob-evt-1`,
        idempotencyKey: `${TRADE_PREFIX}:QUANT_PAPER_ENTRY:NA:0:${new Date().toISOString().slice(0, 10)}`,
        alertType: "QUANT_PAPER_ENTRY",
        payload: "{}",
        status: "PENDING",
        attempts: 0,
      },
    });
    const body = await (await GET(get("/api/quant/events?view=outbox"))).json();
    expect(body.success).toBe(true);
    expect(body.view).toBe("outbox");
    const mine = body.events.find((e: any) => e.eventId === `${TRADE_PREFIX}-ob-evt-1`);
    expect(mine).toBeTruthy();
    expect(mine.status).toBe("PENDING");
    expect(mine.attempts).toBe(0);
    expect(mine.payload).toBeUndefined(); // payload excluded from the list view
  });
});

// ── decisions ────────────────────────────────────────────────────────

describe("GET /api/quant/decisions", () => {
  test("latest decisions without the payload field", async () => {
    const { GET } = await import("@/app/api/quant/decisions/route");
    await db.quantDecisionLog.create({
      data: {
        id: qid(),
        decisionId: `${TRADE_PREFIX}-dec-2`,
        symbol: "NIFTY",
        verdict: "TRADE",
        regime: "TRENDING_UP",
        winnerStrategy: "TREND_CONTINUATION",
        payload: JSON.stringify({ secretish: "should-not-leak" }),
      },
    });
    const body = await (await GET()).json();
    expect(body.success).toBe(true);
    const mine = body.decisions.find((d: any) => d.decisionId === `${TRADE_PREFIX}-dec-2`);
    expect(mine).toBeTruthy();
    expect(mine.verdict).toBe("TRADE");
    expect(mine.winnerStrategy).toBe("TREND_CONTINUATION");
    expect(mine.payload).toBeUndefined();
  });
});

// ── config ───────────────────────────────────────────────────────────

describe("/api/quant/config", () => {
  test("GET: effective + file + settable doc", async () => {
    const { GET } = await import("@/app/api/quant/config/route");
    const body = await (await GET()).json();
    expect(body.success).toBe(true);
    expect(body.effective.enabled).toBe(false);
    expect(body.effective.mode).toBe("SHADOW");
    expect(body.effective.paperCapital).toBeNull();
    expect(body.effective.symbols).toEqual(["NIFTY"]);
    expect(body.settable.enabled).toContain("boolean");
  });

  test("POST with a wrong/missing secret → 403 and NO file write", async () => {
    const { POST } = await import("@/app/api/quant/config/route");
    process.env.QUANT_ADMIN_SECRET = "testsecret";
    for (const body of [{ secret: "wrong", patch: { enabled: true } }, { patch: { enabled: true } }, {}]) {
      const res = await POST(postJson("/api/quant/config", body));
      expect(res.status).toBe(403);
      expect((await res.json()).success).toBe(false);
    }
    expect(existsSync(CONFIG_FILE)).toBe(false); // nothing written
  });

  test("POST with the correct secret writes the file and returns the new effective config", async () => {
    const { POST } = await import("@/app/api/quant/config/route");
    process.env.QUANT_ADMIN_SECRET = "testsecret";
    const res = await POST(
      postJson("/api/quant/config", {
        secret: "testsecret",
        patch: { enabled: true, mode: "PAPER", paperCapital: 100000, symbols: ["NIFTY", "SENSEX", "", 42] },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.effective.enabled).toBe(true);
    expect(body.effective.mode).toBe("PAPER");
    expect(body.effective.paperCapital).toBe(100000);
    expect(body.effective.symbols).toEqual(["NIFTY", "SENSEX"]); // junk entries dropped

    const onDisk = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    expect(onDisk.enabled).toBe(true);
    expect(onDisk.updatedAt).toBeTruthy();

    // invalid patch values are dropped (mode guard, bad capital, >10 symbols)
    const res2 = await POST(
      postJson("/api/quant/config", { secret: "testsecret", patch: { mode: "LIVE", paperCapital: -5 } }),
    );
    const body2 = await res2.json();
    expect(body2.effective.mode).toBe("PAPER"); // unchanged
    expect(body2.effective.paperCapital).toBe(100000); // unchanged
  });

  test("POST accepts null caps (unlimited) and drops invalid tuning values", async () => {
    const { POST } = await import("@/app/api/quant/config/route");
    process.env.QUANT_ADMIN_SECRET = "testsecret";
    const res = await POST(
      postJson("/api/quant/config", {
        secret: "testsecret",
        patch: {
          tuning: {
            minScore: 70,
            minRewardRisk: 2,
            maxTradesPerDay: null,
            maxConcurrentPositions: null,
            requireChainConfirm: true,
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effective.tuning.maxTradesPerDay).toBeNull();
    expect(body.effective.tuning.maxConcurrentPositions).toBeNull();
    expect(body.effective.tuning.minScore).toBe(70);
    expect(body.effective.tuning.minRewardRisk).toBe(2);
    expect(body.effective.tuning.requireChainConfirm).toBe(true);

    const onDisk = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    expect(onDisk.tuning.maxTradesPerDay).toBeNull();
    expect(onDisk.tuning.maxConcurrentPositions).toBeNull();

    // an invalid value leaves the previous (valid) value untouched
    const res2 = await POST(
      postJson("/api/quant/config", { secret: "testsecret", patch: { tuning: { minScore: 500, minRewardRisk: -1 } } }),
    );
    const body2 = await res2.json();
    expect(body2.effective.tuning.minScore).toBe(70);
    expect(body2.effective.tuning.minRewardRisk).toBe(2);
  });
});
