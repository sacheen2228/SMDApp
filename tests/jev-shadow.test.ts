// Jev shadow-mode tests — safety, classification, client errors, no production influence
// Jev must never register trades, send Telegram, or override validators.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  getJevConfig,
  isJevCallable,
  isJevProductionInfluenceAllowed,
  redactSecrets,
} from "../src/lib/jev/config";
import {
  callJev,
  buildJevRequest,
  DEFAULT_JEV_QUESTIONS,
  type JevResponseBody,
} from "../src/lib/jev/client";
import { buildJevContext, type JevNormalizedContext } from "../src/lib/jev/context";
import {
  classifyJevAnswers,
  emptyClassification,
} from "../src/lib/jev/classifier";
import {
  runJevShadowEvaluation,
  recordJevShadowAwaited,
  normalizeOptionCall,
  agreements,
  assertShadowIsInert,
  type ShadowRecord,
} from "../src/lib/jev/shadow";
import type { HermesContext } from "../src/lib/hermes/types";
import {
  rejectOptionSelling,
  isOptionSelling,
} from "../src/lib/trade-validator-gate";

// ── Helpers ─────────────────────────────────────────────────────────────

function setEnv(overrides: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function okResponse(direction: string, extra: Partial<Record<string, any>> = {}): JevResponseBody {
  return {
    model: "jev-latest",
    answers: {
      data_quality: { type: "choice", choice: extra.dataQuality ?? "HIGH", confidence: 0.9 },
      directional_bias: { type: "choice", choice: direction, confidence: extra.confidence ?? 80 },
      regime: { type: "choice", choice: extra.regime ?? "RANGE", confidence: 0.8 },
      confluence_quality: { type: "score", score: extra.confluence ?? 70, confidence: 0.7 },
      conflict_flag: { type: "noul", noul: extra.conflict ?? 0.1 },
    },
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

function fetchOnce(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

function fetchReject(err: any): typeof fetch {
  return (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

function minimalHermesCtx(overrides: Partial<HermesContext> = {}): HermesContext {
  const base: HermesContext = {
    timestamp: new Date().toISOString(),
    symbol: "NIFTY",
    mode: "TRADE",
    marketStatus: "MARKET_OPEN",
    exchange: "NSE",
    instrument: "index",
    spot: {
      value: {
        price: 23450,
        change: 50,
        changePct: 0.21,
        prevClose: 23400,
        open: 23410,
        high: 23500,
        low: 23380,
        volume: 1_000_000,
      },
      source: "nse",
      timestamp: new Date().toISOString(),
      ageMs: 1000,
      freshness: "FRESH",
      status: "SUCCESS",
      delayed: false,
      fallbackUsed: false,
    },
    optionChain: {
      value: {
        symbol: "NIFTY",
        spot: 23450,
        atmStrike: 23450,
        expiry: "2026-09-25",
        daysToExpiry: 2,
        strikes: [
          {
            strike: 23450,
            ce: {
              ltp: 120, bid: 119, ask: 121, spread: 2, quoteQuality: "COMPLETE",
              volume: 50000, oi: 200000, oiChange: 5000, iv: 12,
              delta: 0.5, gamma: 0.002, theta: -8, vega: 10, rho: 0.01,
            },
            pe: {
              ltp: 110, bid: 109, ask: 111, spread: 2, quoteQuality: "COMPLETE",
              volume: 45000, oi: 180000, oiChange: -2000, iv: 12.5,
              delta: -0.48, gamma: 0.002, theta: -7.5, vega: 9.5, rho: -0.01,
            },
          },
        ],
        totalCallOI: 5000000,
        totalPutOI: 4500000,
        callOiChange: 10000,
        putOiChange: 20000,
        pcrOI: 0.9,
        pcrVolume: 1.1,
        maxPain: 23400,
        callWall: 23600,
        putWall: 23300,
        gammaWall: 23500,
        gammaFlip: 23420,
        expectedMove: 200,
        vix: 12,
        futuresPrice: 23470,
      },
      source: "nse",
      timestamp: new Date().toISOString(),
      ageMs: 500,
      freshness: "FRESH",
      status: "SUCCESS",
      delayed: false,
      fallbackUsed: false,
    },
    vix: {
      value: 12,
      source: "nse",
      timestamp: new Date().toISOString(),
      ageMs: 60000,
      freshness: "FRESH",
      status: "SUCCESS",
      delayed: false,
      fallbackUsed: false,
    },
    fiiDII: {
      value: { fiiNet: 1000, diiNet: -500, fiiBias: "NEUTRAL", dataDate: "2026-09-23", publishedAt: "2026-09-23" },
      source: "nse",
      timestamp: new Date().toISOString(),
      ageMs: 3600000,
      freshness: "FRESH",
      status: "SUCCESS",
      delayed: false,
      fallbackUsed: false,
    },
    news: {
      value: { sentiment: "NEUTRAL", headlines: ["Sample"] } as any,
      source: "rss",
      timestamp: new Date().toISOString(),
      ageMs: 600000,
      freshness: "FRESH",
      status: "SUCCESS",
      delayed: false,
      fallbackUsed: false,
    },
    regime: {
      value: { regime: "RANGE", bias: "NEUTRAL" } as any,
      source: "internal",
      timestamp: new Date().toISOString(),
      ageMs: 1000,
      freshness: "FRESH",
      status: "SUCCESS",
      delayed: false,
      fallbackUsed: false,
    },
    marketStructure: {
      value: {
        trend: "SIDEWAYS",
        swingHigh: 23550,
        swingLow: 23300,
        supportLevels: [23300],
        resistanceLevels: [23550],
        lastEvent: "NONE",
        pdh: 23480,
        pdl: 23320,
      },
      source: "internal",
      timestamp: new Date().toISOString(),
      ageMs: 5000,
      freshness: "FRESH",
      status: "SUCCESS",
      delayed: false,
      fallbackUsed: false,
    },
    greeks: {
      value: { delta: 0.5, gamma: 0.002, theta: -8, vega: 10, iv: 12 },
      source: "bs",
      timestamp: new Date().toISOString(),
      ageMs: 1000,
      freshness: "FRESH",
      status: "SUCCESS",
      delayed: false,
      fallbackUsed: false,
    },
    gamma: {
      value: {
        detected: true,
        confidence: 70,
        dealerBias: "POSITIVE",
        squeezePotential: 10,
        gammaWallStrike: 23500,
        gammaWallType: "CALL",
        estimatedGEX: 1000,
        regime: "POSITIVE",
      },
      source: "internal",
      timestamp: new Date().toISOString(),
      ageMs: 1000,
      freshness: "FRESH",
      status: "SUCCESS",
      delayed: false,
      fallbackUsed: false,
    },
    volume: {
      value: {
        poc: 23440,
        vah: 23500,
        val: 23380,
        cumulativeDelta: 100,
        totalVolume: 5_000_000,
        avgVolume: 4_000_000,
        absorptionLevels: [],
        exhaustionSignals: [],
      },
      source: "internal",
      timestamp: new Date().toISOString(),
      ageMs: 1000,
      freshness: "FRESH",
      status: "SUCCESS",
      delayed: false,
      fallbackUsed: false,
    },
    expiryLiquidity: {
      value: {} as any,
      source: "internal",
      timestamp: new Date().toISOString(),
      ageMs: 1000,
      freshness: "FRESH",
      status: "SUCCESS",
      delayed: false,
      fallbackUsed: false,
    },
    backtestResults: {
      value: {} as any,
      source: "internal",
      timestamp: new Date().toISOString(),
      ageMs: 1000,
      freshness: "FRESH",
      status: "SUCCESS",
      delayed: false,
      fallbackUsed: false,
    },
    ...overrides,
  };
  return base;
}

function emptyCtxQuality(): JevNormalizedContext {
  const ctx = buildJevContext({
    ...minimalHermesCtx(),
    spot: {
      value: { price: 0, change: 0, changePct: 0, prevClose: 0, open: 0, high: 0, low: 0, volume: 0 },
      source: "none",
      timestamp: new Date().toISOString(),
      ageMs: 999999,
      freshness: "UNAVAILABLE",
      status: "ERROR",
      delayed: true,
      fallbackUsed: false,
      error: "missing",
    },
    optionChain: {
      value: null as any,
      source: "none",
      timestamp: new Date().toISOString(),
      ageMs: 999999,
      freshness: "UNAVAILABLE",
      status: "ERROR",
      delayed: true,
      fallbackUsed: false,
      error: "missing",
    },
  });
  return ctx;
}

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "JEV_ENABLED",
  "JEV_SHADOW_MODE",
  "TYPESAFE_API_KEY",
  "JEV_TIMEOUT_MS",
  "JEV_MODEL",
  "JEV_BASE_URL",
  "NEXT_PUBLIC_TYPESAFE_API_KEY",
];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  setEnv({
    JEV_ENABLED: "true",
    JEV_SHADOW_MODE: "true",
    TYPESAFE_API_KEY: "test-secret-key-abc123",
    JEV_TIMEOUT_MS: "2000",
    NEXT_PUBLIC_TYPESAFE_API_KEY: undefined,
  });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ═══════════════════════════════════════════════════════════════
// 1. CONFIG / SECURITY
// ═══════════════════════════════════════════════════════════════

describe("Jev config & security", () => {
  it("defaults shadow mode on and production influence off", () => {
    expect(isJevProductionInfluenceAllowed()).toBe(false);
    const cfg = getJevConfig();
    expect(cfg.shadowMode).toBe(true);
    expect(cfg.model).toBe("jev-latest");
  });

  it("isJevCallable requires enabled + key", () => {
    expect(isJevCallable()).toBe(true);
    process.env.JEV_ENABLED = "false";
    expect(isJevCallable()).toBe(false);
    process.env.JEV_ENABLED = "true";
    process.env.TYPESAFE_API_KEY = "";
    expect(isJevCallable()).toBe(false);
  });

  it("never exposes NEXT_PUBLIC_TYPESAFE_API_KEY path", () => {
    process.env.NEXT_PUBLIC_TYPESAFE_API_KEY = "leaked";
    process.env.TYPESAFE_API_KEY = undefined;
    delete process.env.TYPESAFE_API_KEY;
    expect(getJevConfig().apiKey).toBeNull();
    expect(isJevCallable()).toBe(false);
  });

  it("redacts API key from messages", () => {
    process.env.TYPESAFE_API_KEY = "super-secret-key-999";
    const msg = redactSecrets("failed with Bearer super-secret-key-999 and key super-secret-key-999");
    expect(msg).not.toContain("super-secret-key-999");
    expect(msg).toContain("[REDACTED]");
  });

  it("buildJevRequest puts key only in Authorization header (server body has no key)", () => {
    const req = buildJevRequest({ hello: "world" }, DEFAULT_JEV_QUESTIONS, getJevConfig());
    expect(req.headers.Authorization).toContain("Bearer test-secret-key-abc123");
    expect(req.body).not.toContain("test-secret-key-abc123");
    expect(req.body).toContain("jev-latest");
    const parsed = JSON.parse(req.body);
    expect(parsed.state).toBeTypeOf("string");
    expect(parsed.questions.directional_bias).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. CLIENT ERRORS
// ═══════════════════════════════════════════════════════════════

describe("Jev client errors", () => {
  it("MISSING_KEY when key absent", async () => {
    process.env.TYPESAFE_API_KEY = "";
    delete process.env.TYPESAFE_API_KEY;
    const res = await callJev("state");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("MISSING_KEY");
  });

  it("DISABLED when JEV_ENABLED=false", async () => {
    process.env.JEV_ENABLED = "false";
    const res = await callJev("state");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("DISABLED");
  });

  it("HTTP_401 on invalid key", async () => {
    const res = await callJev("state", { fetchImpl: fetchOnce({ error: "unauthorized" }, 401) });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("HTTP_401");
      expect(res.message).not.toContain("test-secret-key-abc123");
    }
  });

  it("HTTP_429 on rate limit", async () => {
    const res = await callJev("state", { fetchImpl: fetchOnce({ error: "rate" }, 429) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("HTTP_429");
  });

  it("HTTP_5XX on server error", async () => {
    const res = await callJev("state", { fetchImpl: fetchOnce({ error: "boom" }, 503) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("HTTP_5XX");
  });

  it("MALFORMED_RESPONSE on invalid JSON", async () => {
    const res = await callJev("state", { fetchImpl: fetchOnce("not-json") });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("MALFORMED_RESPONSE");
  });

  it("MALFORMED_RESPONSE when answers map missing", async () => {
    const res = await callJev("state", { fetchImpl: fetchOnce({ model: "jev-latest" }) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("MALFORMED_RESPONSE");
  });

  it("TIMEOUT on abort", async () => {
    const res = await callJev("state", {
      fetchImpl: fetchReject(Object.assign(new Error("The operation timed out"), { name: "TimeoutError" })),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("TIMEOUT");
  });

  it("NETWORK on generic failure", async () => {
    const res = await callJev("state", { fetchImpl: fetchReject(new Error("ECONNREFUSED")) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("NETWORK");
  });

  it("valid response parses answers", async () => {
    const res = await callJev("state", { fetchImpl: fetchOnce(okResponse("BUY_CE")) });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.body.model).toBe("jev-latest");
      expect((res.body.answers.directional_bias as any).choice).toBe("BUY_CE");
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. CONTEXT BUILDER — no fabrication
// ═══════════════════════════════════════════════════════════════

describe("Jev context builder", () => {
  it("maps available fields from Hermes context", () => {
    const ctx = buildJevContext(minimalHermesCtx());
    expect(ctx.schemaVersion).toBe("jev-context-v1");
    expect(ctx.spot.price).toBe(23450);
    expect(ctx.optionChain.available).toBe(true);
    expect(ctx.optionChain.pcrOI).toBe(0.9);
    expect(ctx.greeks.available).toBe(true);
    expect(ctx.structure.trend).toBe("SIDEWAYS");
    expect(ctx.quality.overall).toBe("HIGH");
    expect(ctx.constraints.some((c) => /Never SELL/i.test(c))).toBe(true);
  });

  it("does not fabricate missing spot/chain as zeros with AVAILABLE", () => {
    const ctx = buildJevContext({
      ...minimalHermesCtx(),
      spot: {
        value: { price: 0, change: 0, changePct: 0, prevClose: 0, open: 0, high: 0, low: 0, volume: 0 },
        source: "none",
        timestamp: new Date().toISOString(),
        ageMs: 999999,
        freshness: "UNAVAILABLE",
        status: "ERROR",
        delayed: true,
        fallbackUsed: false,
      },
      optionChain: {
        value: null as any,
        source: "none",
        timestamp: new Date().toISOString(),
        ageMs: 999999,
        freshness: "UNAVAILABLE",
        status: "ERROR",
        delayed: true,
        fallbackUsed: false,
      },
    });
    expect(ctx.spot.price).toBeNull();
    expect(ctx.spot.meta.availability).toBe("UNAVAILABLE");
    expect(ctx.optionChain.available).toBe(false);
    expect(ctx.quality.criticalFieldsMissing).toContain("spot");
    expect(ctx.quality.criticalFieldsMissing).toContain("option_chain");
    expect(["LOW", "INSUFFICIENT"]).toContain(ctx.quality.overall);
  });

  it("marks greeks unavailable when freshness UNAVAILABLE", () => {
    const ctx = buildJevContext({
      ...minimalHermesCtx(),
      greeks: {
        value: { delta: 0.5, gamma: 0.002, theta: -8, vega: 10, iv: 12 },
        source: "bs",
        timestamp: new Date().toISOString(),
        ageMs: 999999,
        freshness: "UNAVAILABLE",
        status: "ERROR",
        delayed: true,
        fallbackUsed: false,
      },
    });
    expect(ctx.greeks.available).toBe(false);
    expect(ctx.greeks.delta).toBeNull();
    expect(ctx.quality.criticalFieldsMissing).toContain("greeks");
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. CLASSIFIER
// ═══════════════════════════════════════════════════════════════

describe("Jev classifier", () => {
  const goodCtx = () => buildJevContext(minimalHermesCtx());

  it("BUY_CE candidate classification", () => {
    const c = classifyJevAnswers(okResponse("BUY_CE"), goodCtx());
    expect(c.call).toBe("BUY_CE");
    expect(c.reasonCode).toBe("JEV_BUY_CE");
    expect(c.shadow).toBe(true);
  });

  it("BUY_PE candidate classification", () => {
    const c = classifyJevAnswers(okResponse("BUY_PE"), goodCtx());
    expect(c.call).toBe("BUY_PE");
    expect(c.reasonCode).toBe("JEV_BUY_PE");
  });

  it("NO_TRADE candidate classification", () => {
    const c = classifyJevAnswers(okResponse("NO_TRADE"), goodCtx());
    expect(c.call).toBe("NO_TRADE");
    expect(c.reasonCode).toBe("JEV_NO_TRADE");
  });

  it("rejects SELL direction → NO_TRADE", () => {
    for (const raw of ["SELL_CE", "SELL_PE", "SELL", "SHORT_CALL"]) {
      const c = classifyJevAnswers(okResponse(raw), goodCtx());
      expect(c.call).toBe("NO_TRADE");
      expect(["JEV_SELL_REJECTED", "JEV_MALFORMED"]).toContain(c.reasonCode);
    }
  });

  it("NO_TRADE when market closed", () => {
    const ctx = buildJevContext(minimalHermesCtx({ marketStatus: "MARKET_CLOSED" }));
    const c = classifyJevAnswers(okResponse("BUY_CE"), ctx);
    expect(c.call).toBe("NO_TRADE");
    expect(c.reasonCode).toBe("JEV_MARKET_CLOSED");
  });

  it("NO_TRADE when data quality insufficient", () => {
    const c = classifyJevAnswers(okResponse("BUY_CE", { dataQuality: "INSUFFICIENT" }), goodCtx());
    expect(c.call).toBe("NO_TRADE");
    expect(c.reasonCode).toBe("JEV_DATA_QUALITY_LOW");
  });

  it("NO_TRADE when conflict flag high", () => {
    const c = classifyJevAnswers(okResponse("BUY_CE", { conflict: 0.9 }), goodCtx());
    expect(c.call).toBe("NO_TRADE");
    expect(c.reasonCode).toBe("JEV_CONFLICT");
  });

  it("NO_TRADE when confidence below threshold", () => {
    const c = classifyJevAnswers(okResponse("BUY_CE", { confidence: 10 }), goodCtx());
    expect(c.call).toBe("NO_TRADE");
    expect(c.reasonCode).toBe("JEV_LOW_CONFIDENCE");
  });

  it("NO_TRADE when context quality insufficient", () => {
    const c = classifyJevAnswers(okResponse("BUY_CE"), emptyCtxQuality());
    expect(c.call).toBe("NO_TRADE");
    expect(c.reasonCode).toBe("JEV_INSUFFICIENT_DATA");
  });

  it("malformed missing direction → NO_TRADE", () => {
    const body: JevResponseBody = { model: "jev-latest", answers: {} };
    const c = classifyJevAnswers(body, goodCtx());
    expect(c.call).toBe("NO_TRADE");
    expect(c.reasonCode).toBe("JEV_MALFORMED");
  });

  it("emptyClassification never returns SELL", () => {
    const c = emptyClassification("NO_TRADE", "JEV_CALL_FAILED", "x");
    expect(["BUY_CE", "BUY_PE", "NO_TRADE"]).toContain(c.call);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. SHADOW MODE — cannot change production / execute
// ═══════════════════════════════════════════════════════════════

describe("Jev shadow mode safety", () => {
  it("skips when disabled and leaves production decision intact", async () => {
    process.env.JEV_ENABLED = "false";
    const rec = await runJevShadowEvaluation({
      source: "HERMES",
      symbol: "NIFTY",
      productionDecision: "BUY_CE",
    });
    expect(rec.productionDecision).toBe("BUY_CE");
    expect(rec.jevStatus).toBe("SKIPPED");
    expect(rec.jevSkipReason).toBe("JEV_ENABLED=false");
    assertShadowIsInert(rec);
  });

  it("skips when key missing", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const rec = await runJevShadowEvaluation({
      source: "HERMES",
      symbol: "NIFTY",
      productionDecision: "NO_TRADE",
    });
    expect(rec.jevStatus).toBe("SKIPPED");
    expect(rec.jevSkipReason).toMatch(/key/i);
    expect(rec.productionDecision).toBe("NO_TRADE");
  });

  it("records agreement without mutating productionDecision when Jev disagrees", async () => {
    const hermesCtx = minimalHermesCtx();
    const rec = await runJevShadowEvaluation(
      {
        source: "HERMES",
        symbol: "NIFTY",
        productionDecision: "NO_TRADE",
        hermesDecision: {
          decision: "NO_TRADE",
          score: 0,
          grade: "F",
          confidence: 0,
          marketRegime: "RANGE",
          dataHealth: 50,
          timestamp: new Date().toISOString(),
        },
      },
      hermesCtx,
      fetchOnce(okResponse("BUY_CE", { confidence: 90 }))
    );
    expect(rec.productionDecision).toBe("NO_TRADE");
    expect(rec.jevCall).toBe("BUY_CE");
    expect(rec.agreesWithProduction).toBe(false);
    expect(rec.shadowMode).toBe(true);
    expect(rec.productionInfluenceAllowed).toBe(false);
    assertShadowIsInert(rec);
  });

  it("records agreement when Jev matches production", async () => {
    const rec = await runJevShadowEvaluation(
      {
        source: "HERMES",
        symbol: "NIFTY",
        productionDecision: "BUY_PE",
      },
      minimalHermesCtx(),
      fetchOnce(okResponse("BUY_PE"))
    );
    expect(rec.agreesWithProduction).toBe(true);
    expect(rec.jevCall).toBe("BUY_PE");
    assertShadowIsInert(rec);
  });

  it("handles Jev unavailable without breaking — production decision unchanged", async () => {
    const rec = await runJevShadowEvaluation(
      { source: "HERMES", symbol: "NIFTY", productionDecision: "BUY_CE" },
      minimalHermesCtx(),
      fetchReject(new Error("ECONNREFUSED"))
    );
    expect(rec.productionDecision).toBe("BUY_CE");
    expect(rec.jevStatus).toBe("ERROR");
    expect(rec.jevErrorCode).toBe("NETWORK");
    assertShadowIsInert(rec);
  });

  it("pipeline path with insufficient context does not call Jev and stays NO_TRADE", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const rec = await runJevShadowEvaluation(
      {
        source: "AGENT_PIPELINE",
        symbol: "NIFTY",
        productionDecision: "NO_TRADE",
        grokDirection: "NO_TRADE",
      },
      undefined,
      fetchImpl
    );
    expect(called).toBe(false);
    expect(rec.jevCall).toBe("NO_TRADE");
    expect(rec.productionDecision).toBe("NO_TRADE");
    assertShadowIsInert(rec);
  });

  it("normalizeOptionCall maps SELL options to NO_TRADE for comparison only", () => {
    expect(normalizeOptionCall("SELL_CE")).toBe("NO_TRADE");
    expect(normalizeOptionCall("SELL_PE")).toBe("NO_TRADE");
    expect(normalizeOptionCall("BUY_CE")).toBe("BUY_CE");
    expect(normalizeOptionCall("RESEARCH_ONLY")).toBe("NO_TRADE");
  });

  it("agreements helper compares normalized calls", () => {
    const a = agreements("BUY_CE", "BUY_CE", "BUY_CE");
    expect(a.agreesWithProduction).toBe(true);
    expect(a.agreesWithGrok).toBe(true);
    const b = agreements("BUY_PE", "BUY_CE", "NO_TRADE");
    expect(b.agreesWithProduction).toBe(false);
    expect(b.agreesWithGrok).toBe(false);
  });

  it("recordJevShadowAwaited writes inert record (integration)", async () => {
    const rec = await recordJevShadowAwaited(
      { source: "HERMES", symbol: "BANKNIFTY", productionDecision: "NO_TRADE" },
      minimalHermesCtx({ symbol: "BANKNIFTY" }),
      fetchOnce(okResponse("NO_TRADE"))
    );
    assertShadowIsInert(rec);
    expect(rec.source).toBe("HERMES");
    expect(rec.note).toMatch(/Shadow only/i);
  });

  it("isJevProductionInfluenceAllowed always false in Phase 1", () => {
    process.env.JEV_ENABLED = "true";
    process.env.JEV_SHADOW_MODE = "false";
    expect(isJevProductionInfluenceAllowed()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. JEV CANNOT TOUCH SAFETY SURFACES (module isolation)
// ═══════════════════════════════════════════════════════════════

describe("Jev isolation from trade safety modules", () => {
  it("jev modules do not import trade registration / lock / telegram", async () => {
    const { readdirSync, readFileSync, statSync } = await import("fs");
    const { join } = await import("path");
    const root = join(process.cwd(), "src", "lib", "jev");
    const forbidden = [
      "activeTradeTracker",
      "active-trade-lock",
      "telegram-alerts",
      "telegram.ts",
      "trade-validator-gate",
      "signalTracker",
      "tiger-monitor",
      "registerTrade",
      "addTrade",
      "sendTPSLAlert",
      "sendTradeAlert",
      "sendTelegram",
    ];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const token of forbidden) {
        expect(src.includes(token)).toBe(false);
      }
    }
  });

  it("Final Validator still rejects option selling independently of Jev", () => {
    expect(isOptionSelling("SELL_CE", undefined, "CALL")).toBe(true);
    expect(rejectOptionSelling("SELL_CE", undefined, "CALL")).toBeTruthy();
    expect(rejectOptionSelling("BUY_CE", undefined, "CALL")).toBeNull();
    expect(rejectOptionSelling(undefined, "STRADDLE")).toBeTruthy();
    // Direction without instrument is not an option-sell check by itself
    expect(isOptionSelling("SELL_CE")).toBe(false);
    expect(rejectOptionSelling("SELL_CE")).toBeNull();
  });
});
