import { afterEach, describe, expect, test } from "bun:test";
import { fetchFiiDiiData, _resetFiiDiiCacheForTests } from "@/lib/fii-dii";

// fetchFiiDiiData used to await NSE FIRST (3×10s retries + backoff ≈ 33s)
// before starting MrChartist. One slow NSE minute pinned /api/fii-dii on
// the 15s provider timeout even though MrChartist answers in ~100ms.

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  _resetFiiDiiCacheForTests();
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchFiiDiiData — slow NSE must not block MrChartist", () => {
  test("resolves from MrChartist while NSE is still retrying", async () => {
    let nseHits = 0;
    let mcHits = 0;

    globalThis.fetch = (async (input: any) => {
      const url = String(input?.url ?? input);
      if (url.includes("nseindia")) {
        nseHits++;
        // Simulate the live failure mode: every NSE call burns its full
        // AbortSignal budget (10s) then retries.
        await new Promise((r) => setTimeout(r, 10_000));
        throw new Error("The operation was aborted due to timeout");
      }
      if (url.includes("fii-diidata.mrchartist.com/api/data")) {
        mcHits++;
        return jsonRes({
          fii_net: 1234,
          dii_net: -567,
          fii_buy: 100,
          fii_sell: 200,
          dii_buy: 300,
          dii_sell: 400,
          date: "20-Nov-2026",
        });
      }
      if (url.includes("fii-diidata.mrchartist.com/api/history")) {
        return jsonRes([]);
      }
      if (url.includes("nsearchives")) {
        return new Response("not found", { status: 404 });
      }
      // Cookie warm-up / anything else — fail fast, never hang the test.
      return new Response("", { status: 403 });
    }) as typeof fetch;

    const t0 = Date.now();
    const result = await fetchFiiDiiData();
    const elapsed = Date.now() - t0;

    expect(result.available).toBe(true);
    expect(result.latest.source).toBe("mrchartist");
    expect(result.latest.fiiNet).toBe(1234);
    expect(mcHits).toBeGreaterThanOrEqual(1);
    // Must not wait out NSE's 10s×3 retry ladder (or the 15s provider cap).
    expect(elapsed).toBeLessThan(5_000);
    // NSE was still in-flight when we resolved — we only raced it.
    expect(nseHits).toBeGreaterThanOrEqual(1);
  }, 15_000);

  test("prefers NSE when it answers quickly", async () => {
    globalThis.fetch = (async (input: any) => {
      const url = String(input?.url ?? input);
      if (url.includes("nseindia.in/api/fiidiiTradeReact")) {
        return jsonRes([
          { category: "FII", buyValue: "10", sellValue: "20", netValue: "-10", date: "20-Nov-2026" },
          { category: "DII", buyValue: "30", sellValue: "5", netValue: "25", date: "20-Nov-2026" },
        ]);
      }
      if (url.includes("nseindia")) {
        return new Response("", { status: 403 });
      }
      if (url.includes("fii-diidata.mrchartist.com/api/data")) {
        return jsonRes({
          fii_net: 999,
          dii_net: 1,
          fii_buy: 0,
          fii_sell: 0,
          dii_buy: 0,
          dii_sell: 0,
          date: "20-Nov-2026",
        });
      }
      if (url.includes("fii-diidata.mrchartist.com/api/history")) {
        return jsonRes([]);
      }
      if (url.includes("nsearchives")) {
        return new Response("nf", { status: 404 });
      }
      return new Response("", { status: 403 });
    }) as typeof fetch;

    const result = await fetchFiiDiiData();
    expect(result.available).toBe(true);
    expect(result.latest.source).toBe("nse");
    expect(result.latest.fiiNet).toBe(-10);
    expect(result.latest.diiNet).toBe(25);
  }, 10_000);
});
