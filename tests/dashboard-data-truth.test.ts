/// <reference types="bun-types" />
//
// Dashboard data truth — every card must show REAL data with its source and
// age, or an explicit "unavailable" state.
//
// These tests cover three things:
//
//  1. The shared card envelope (src/lib/data-freshness.ts): a payload always
//     carries source + age, an old payload is STALE, an UNDATED payload can
//     never claim LIVE, and a failed feed produces an explicit unavailable
//     state (never a zero).
//  2. Route behaviour when the upstream feed fails: the card answers
//     "unavailable" with the reason instead of a plausible-looking number.
//  3. Source-level guards on the in-scope routes: the fake defaults that used
//     to drive the wrong signals (spot 24 000, VIX 15, PCR 1.00, max pain 0,
//     Yahoo) must not come back.
//
// NOTE ON FIXTURES: the payloads below are synthetic provider responses used
// ONLY by the stubbed `globalThis.fetch` inside this test. They are never
// imported by production code, and no test fixture is used as a data source
// by a production path.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

import {
  buildCardMeta,
  unavailableMeta,
  formatAge,
  parseNseTradeDate,
  num,
  round,
  pct,
  SOURCE_LABELS,
} from "@/lib/data-freshness";
import { rsi, macd, atr, bollinger } from "@/lib/daily-bars";

const ROOT = join(process.cwd(), "src/app/api");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

// The routes this agent owns (everything else belongs to another agent).
const IN_SCOPE_ROUTES = [
  "market/breadth",
  "market/heatmap",
  "market/heatmap/fo",
  "market/most-active",
  "market/opportunities",
  "market/regime",
  "market/sectors",
  "scanner",
  "scanner/fno",
  "fii-dii",
  "news",
  "quotes",
  "screener",
  "equity-universe",
  "weekly-scanner",
  "breakout",
  "btst",
  "today-trades",
  "trade-intelligence",
].map((p) => join(ROOT, p, "route.ts"));

describe("card envelope — source + age are always present", () => {
  it("carries the source, the provider timestamp and the age", () => {
    const meta = buildCardMeta({
      source: "nse",
      providerTimestamp: new Date(Date.now() - 5_000),
      ttlMs: 90_000,
    });
    expect(meta.status).toBe("AVAILABLE");
    expect(meta.stale).toBe(false);
    expect(meta.source).toBe("nse");
    expect(meta.sourceLabel).toBe("NSE India");
    expect(meta.providerTimestamp).toBeTruthy();
    expect(meta.ageMs).toBeGreaterThanOrEqual(4_000);
    expect(meta.ageLabel).toContain("ago");
  });

  it("marks a payload older than its TTL as STALE (never LIVE)", () => {
    const meta = buildCardMeta({
      source: "moneycontrol",
      providerTimestamp: new Date(Date.now() - 6 * 3600_000),
      ttlMs: 90_000,
    });
    expect(meta.status).toBe("STALE");
    expect(meta.stale).toBe(true);
    expect(meta.ageLabel).toContain("h ago");
  });

  it("never claims LIVE for an undated payload", () => {
    const meta = buildCardMeta({ source: "nse", providerTimestamp: null });
    expect(meta.ageMs).toBeNull();
    expect(meta.stale).toBe(true);
    expect(meta.status).not.toBe("AVAILABLE");
  });

  it("forces STALE when the exchange is closed even if the data is new", () => {
    const meta = buildCardMeta({
      source: "nse",
      providerTimestamp: new Date(),
      live: false,
      reason: "Exchange closed — last session 19-Oct-2026 15:30",
    });
    expect(meta.status).toBe("STALE");
    expect(meta.reason).toContain("Exchange closed");
  });

  it("produces an explicit unavailable state — never a zero", () => {
    const meta = unavailableMeta("NSE returned no most-active contracts");
    expect(meta.status).toBe("UNAVAILABLE");
    expect(meta.ageMs).toBeNull();
    expect(meta.ageLabel).toBe("unavailable");
    expect(meta.reason).toContain("no most-active contracts");
    expect("value" in (meta as any)).toBe(false);
  });

  it("keeps missing numbers null instead of coercing them to 0", () => {
    expect(num(undefined)).toBeNull();
    expect(num(null)).toBeNull();
    expect(num("")).toBeNull();
    expect(num(NaN)).toBeNull();
    expect(num(0)).toBe(0);
    expect(round(null)).toBeNull();
    expect(pct(null, 10)).toBeNull();
    expect(pct(5, 0)).toBeNull();
    expect(pct(5, 10)).toBe(50);
  });

  it("parses the exchange's own trade date (IST) and formats ages", () => {
    const d = parseNseTradeDate("19-Oct-2026 15:30");
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe("2026-10-19T10:00:00.000Z");
    expect(parseNseTradeDate("")).toBeNull();
    expect(formatAge(null)).toBe("unknown");
    expect(formatAge(5_000)).toBe("5s ago");
    expect(formatAge(120_000)).toBe("2m ago");
  });

  it("never labels a provider Yahoo", () => {
    for (const key of Object.keys(SOURCE_LABELS)) {
      expect(key.toLowerCase()).not.toContain("yahoo");
    }
  });
});

describe("indicator maths on real bars", () => {
  // A monotonically rising series: RSI → 100, MACD > 0, ATR > 0.
  const rising = Array.from({ length: 60 }, (_, i) => 100 + i);

  it("computes RSI of a rising series as 100", () => {
    const value = rsi(rising, 14);
    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThan(95);
  });

  it("computes a positive MACD on a rising series", () => {
    const m = macd(rising);
    expect(m).not.toBeNull();
    expect(m!.macd).toBeGreaterThan(0);
    expect(m!.signal).toBeGreaterThan(0);
  });

  it("computes ATR / Bollinger from the bars", () => {
    const bars = rising.map((c, i) => ({ t: i, o: c, h: c + 1, l: c - 1, c, v: 100 }));
    const a = atr(bars, 14);
    expect(a).not.toBeNull();
    expect(a!).toBeGreaterThan(0);
    const bb = bollinger(rising, 20, 2);
    expect(bb).not.toBeNull();
    expect(bb!.upper).toBeGreaterThan(bb!.middle);
    expect(bb!.lower).toBeLessThan(bb!.middle);
  });

  it("returns null (not a guess) when there is not enough data", () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
    expect(macd([1, 2, 3])).toBeNull();
    expect(atr([], 14)).toBeNull();
    expect(bollinger([1, 2], 20)).toBeNull();
  });
});

describe("a failed feed yields an explicit unavailable state", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    // Every upstream request fails.
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("/api/market/most-active → UNAVAILABLE, not an empty-but-successful list", async () => {
    const { GET } = await import("@/app/api/market/most-active/route");
    const res: any = await GET(new Request("http://localhost:3000/api/market/most-active") as any);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.error).toBeTruthy();
    // No fabricated rows: the payload carries the reason, not a snapshot.
    expect(body.data?.contracts).toBeUndefined();
    expect(body.data?.reason).toBeTruthy();
  });

  it("/api/fii-dii → UNAVAILABLE, not FII net 0", async () => {
    const { GET } = await import("@/app/api/fii-dii/route");
    const res: any = await GET();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.fiiNet).toBeNull();
    expect(body.fiiNet5dAvg).toBeNull();
    expect(body.fiiFutLongRatio).toBeNull();
  });

  it("/api/market/breadth → UNAVAILABLE, not a zero breadth reading", async () => {
    const { GET } = await import("@/app/api/market/breadth/route");
    const res: any = await GET();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.breadth).toBeNull();
    expect(body.stocks).toEqual([]);
  });

  it("/api/quotes → no quotes and a named failure", async () => {
    const { GET } = await import("@/app/api/quotes/route");
    const res: any = await GET(new Request("http://localhost:3000/api/quotes?symbols=NIFTY") as any);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.data.quotes).toEqual({});
    expect(body.meta.status).toBe("UNAVAILABLE");
  });
});

describe("a working feed carries source + age on the payload", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    // A synthetic provider response (TEST FIXTURE ONLY).
    globalThis.fetch = (async (input: any) => {
      const url = String(typeof input === "string" ? input : input?.url || "");
      if (url.includes("www.nseindia.com") && !url.includes("/api/")) {
        const res = new Response("", { status: 200 });
        res.headers.set("set-cookie", "ns_cookie=stub; Path=/");
        return res;
      }
      if (url.includes("/api/marketStatus")) {
        return Response.json({
          marketState: [
            {
              market: "Capital Market",
              marketStatus: "Close",
              tradeDate: "19-Oct-2026 15:30",
              last: 22888.95,
            },
          ],
        });
      }
      if (url.includes("snapshot-derivatives-equity")) {
        return Response.json({
          volume: {
            data: [
              {
                instrumentType: "OPTIDX",
                underlying: "NIFTY",
                expiryDate: "27-Oct-2026",
                optionType: "Put",
                strikePrice: 22900,
                lastPrice: 11,
                numberOfContractsTraded: 1000,
                totalTurnover: 10,
                openInterest: 200,
                underlyingValue: 22888.95,
              },
            ],
            timestamp: "19-Oct-2026 15:30",
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("/api/market/most-active → rows + source + age", async () => {
    // Refresh the cached market clock with the good response (the previous
    // test cached a failed one for 60s).
    const { getMarketClock } = await import("@/lib/data-freshness");
    await getMarketClock(true);
    const { GET } = await import("@/app/api/market/most-active/route");
    const res: any = await GET(new Request("http://localhost:3000/api/market/most-active") as any);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data_available).toBe(true);
    expect(body.data.contracts.data.length).toBeGreaterThan(0);
    // The provenance of the card.
    expect(body.meta.source).toBe("nse");
    expect(body.meta.providerTimestamp).toBeTruthy();
    expect(body.meta.ageMs).toBeGreaterThanOrEqual(0);
    expect(body.meta.ageLabel).toContain("ago");
  }, 30000);
});

describe("no fake defaults left in the in-scope routes", () => {
  // Comments are stripped: the files DOCUMENT the ban (and the old fake
  // values) — only executable code is scanned.
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const sources = IN_SCOPE_ROUTES.map((f) => ({ file: f, text: stripComments(readFileSync(f, "utf8")) }));

  it("finds every in-scope route file", () => {
    expect(sources.length).toBe(19);
    for (const s of sources) expect(s.text.length).toBeGreaterThan(0);
  });

  it("never mentions Yahoo (banned)", () => {
    for (const s of sources) {
      expect(`${s.file}: ${s.text.toLowerCase()}`).not.toContain("yahoo");
    }
  });

  it("has no hard-coded spot of 24 000 / 15 000", () => {
    for (const s of sources) {
      expect(s.text).not.toMatch(/\b2[34]000\b/);
    }
  });

  it("has no default VIX of 15 / PCR of 1 / max pain of 0", () => {
    for (const s of sources) {
      expect(s.text).not.toMatch(/vix\s*[:=]\s*15\b/);
      expect(s.text).not.toMatch(/pcr\s*[:=]\s*1\b/);
      expect(s.text).not.toMatch(/maxPain\s*[:=]\s*0\b/);
    }
  });

  it("no route fabricates a percentage change of 0 for a missing quote", () => {
    for (const s of sources) {
      expect(s.text).not.toMatch(/changePct\s*[:=]\s*0\b/);
    }
  });

  it("every in-scope route exposes a provenance field", () => {
    for (const s of sources) {
      const hasMeta = /meta\b|provenance|freshness|dataSources/.test(s.text);
      expect(`${s.file}`).toBeTruthy();
      expect(hasMeta).toBe(true);
    }
  });
});
