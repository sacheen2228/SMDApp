// tests/moapi-service.test.ts
// The MOAPI service (the local Motilal OpenAPI service, official SDK) is the
// FIRST rung of the Motilal price chain — and it is OPTIONAL.
//
//   MOAPI service → the direct Motilal REST client → the NSE path →
//   an explicit "unavailable" result
//
// THESE TESTS ARE OFFLINE: globalThis.fetch is stubbed, nothing leaves the
// process, and the module-level caches are reset around every test.
//
// What is asserted here:
//   • the service is INERT when MOAPI_SERVICE_URL is unset (not one request)
//   • the client speaks the documented contract (/health /instrument /ltp
//     /oi /depth) and the instrument master is cached for 30 minutes
//   • a 503 / a refused connection is NOT a price
//   • the FALLBACK ORDER: service first, then the direct REST client, then
//     NSE, then an explicit "unavailable"
//   • the service being DOWN or UNSET changes NOTHING about the behaviour
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  fetchServiceHealth,
  fetchServiceLTP,
  fetchServiceInstruments,
  fetchServiceOI,
  fetchServiceDepth,
  resetServiceCache,
  isServiceConfigured,
  getServiceUrl,
  INSTRUMENTS_CACHE_TTL_MS,
  SERVICE_TIMEOUT_MS,
} from "@/lib/motilal/service";
import {
  resolveMOOptionLTP,
  resolveOptionLTP,
  runQuoteChain,
  serviceStep,
  restStep,
  nseStep,
  type QuoteStep,
  type QuoteSource,
} from "@/lib/motilal/quote";
import { clearServiceLotSizes } from "@/lib/symbol-config";

const ORIGINAL_URL = process.env.MOAPI_SERVICE_URL;
const ORIGINAL_FETCH = globalThis.fetch;

let calls: string[] = [];

/** Replace globalThis.fetch with a stub. `null` from the handler = the
 *  connection was refused (the service is down). */
function stubFetch(handler: (url: string) => any) {
  calls = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? "");
    calls.push(url);
    const res = handler(url);
    if (!res) throw new Error(`network down: ${url}`);
    const status = res.status ?? 200;
    return new Response(JSON.stringify(res.body ?? {}), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as any;
}

const REF = { symbol: "SBIN", strike: 800, optionType: "CE", expiry: "2026-10-29" };

beforeEach(() => {
  delete process.env.MOAPI_SERVICE_URL;
  resetServiceCache();
  calls = [];
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.MOAPI_SERVICE_URL;
  else process.env.MOAPI_SERVICE_URL = ORIGINAL_URL;
  globalThis.fetch = ORIGINAL_FETCH;
  resetServiceCache();
  clearServiceLotSizes();
});

describe("moapi-service — the service is OPTIONAL", () => {
  test("with MOAPI_SERVICE_URL unset the service is INERT (not one request)", async () => {
    stubFetch(() => ({ body: { ok: true, ltp: 42 } }));

    expect(isServiceConfigured()).toBe(false);
    expect(getServiceUrl()).toBe("");

    expect(await fetchServiceHealth()).toBeNull();
    expect(await fetchServiceLTP("SBIN26OCT2026800CE")).toBeNull();
    expect(await fetchServiceInstruments()).toBeNull();
    expect(await fetchServiceOI("SBIN26OCT2026800CE")).toBeNull();
    expect(await fetchServiceDepth("SBIN26OCT2026800CE")).toBeNull();

    expect(calls.length).toBe(0);
  });

  test("the service timeout is short (the chain must never wait on it)", () => {
    expect(SERVICE_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    expect(SERVICE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("moapi-service — the client speaks the documented contract", () => {
  test("health / ltp / oi / depth", async () => {
    process.env.MOAPI_SERVICE_URL = "http://127.0.0.1:8781";
    stubFetch((url) => {
      if (url.includes("/health")) {
        return { body: { ok: true, authed: true, source: "moapi", ts: 1712345678 } };
      }
      if (url.includes("/ltp")) {
        return {
          body: {
            ok: true,
            ts: 1,
            tradingsymbol: "SBIN26OCT2026800CE",
            ltp: 42.5,
            source: "moapi-rest",
          },
        };
      }
      if (url.includes("/oi")) {
        return {
          body: {
            ok: true,
            ts: 1,
            tradingsymbol: "SBIN26OCT2026800CE",
            oi: 1000,
            oiChange: -50,
            source: "moapi-websocket",
          },
        };
      }
      if (url.includes("/depth")) {
        return {
          body: { ok: true, ts: 1, tradingsymbol: "SBIN26OCT2026800CE", bids: [[10, 5]], asks: [[11, 6]] },
        };
      }
      return null;
    });

    const health = await fetchServiceHealth();
    expect(health?.ok).toBe(true);
    expect(health?.authed).toBe(true);
    expect(health?.source).toBe("moapi");

    const ltp = await fetchServiceLTP("SBIN26OCT2026800CE");
    expect(ltp?.ltp).toBe(42.5);
    expect(ltp?.source).toBe("moapi-rest");
    expect(ltp?.tradingsymbol).toBe("SBIN26OCT2026800CE");

    const oi = await fetchServiceOI("SBIN26OCT2026800CE");
    expect(oi?.oi).toBe(1000);
    expect(oi?.oiChange).toBe(-50);

    const depth = await fetchServiceDepth("SBIN26OCT2026800CE");
    expect(depth?.bids[0]).toEqual([10, 5]);
    expect(depth?.asks[0]).toEqual([11, 6]);
  });

  test("the tradingsymbol is what is asked for", async () => {
    process.env.MOAPI_SERVICE_URL = "http://127.0.0.1:8781";
    stubFetch(() => ({ body: { ok: true, ts: 1, tradingsymbol: "X", ltp: 1, source: "s" } }));
    await fetchServiceLTP("SBIN26OCT2026800CE");
    expect(calls[0]).toContain("/ltp?tradingsymbol=SBIN26OCT2026800CE");
  });

  test("a 503 is NOT a price (the chain falls through)", async () => {
    process.env.MOAPI_SERVICE_URL = "http://127.0.0.1:8781";
    stubFetch(() => ({ status: 503, body: { ok: false, error: "session expired" } }));

    expect(await fetchServiceLTP("X")).toBeNull();
    expect(await fetchServiceHealth()).toBeNull();
    expect(await fetchServiceInstruments()).toBeNull();
  });

  test("a refused connection is NOT a price (the service is down)", async () => {
    process.env.MOAPI_SERVICE_URL = "http://127.0.0.1:8781";
    stubFetch(() => null); // connection refused

    expect(await fetchServiceLTP("X")).toBeNull();
    expect(await fetchServiceInstruments()).toBeNull();
  });

  test("a non-positive price is never returned as a price", async () => {
    process.env.MOAPI_SERVICE_URL = "http://127.0.0.1:8781";
    stubFetch(() => ({ body: { ok: true, ts: 1, tradingsymbol: "X", ltp: 0, source: "s" } }));
    expect(await fetchServiceLTP("X")).toBeNull();
  });

  test("the instrument master is cached for 30 minutes", async () => {
    process.env.MOAPI_SERVICE_URL = "http://127.0.0.1:8781";
    stubFetch(() => ({
      body: {
        ok: true,
        ts: 1,
        instruments: [
          {
            tradingsymbol: "SBIN26OCT2026800CE",
            exchange: "NSEFO",
            expiry: "2026-10-29",
            lotSize: 900,
            instrumentType: "OPTSTK",
            symbol: "SBIN",
            strike: 800,
            optionType: "CE",
          },
        ],
      },
    }));

    const first = await fetchServiceInstruments();
    const second = await fetchServiceInstruments();

    expect(first?.length).toBe(1);
    expect(first?.[0]?.tradingsymbol).toBe("SBIN26OCT2026800CE");
    expect(first?.[0]?.lotSize).toBe(900);
    expect(second?.length).toBe(1);

    // ONE request for two reads — the master is cached.
    expect(calls.filter((c) => c.includes("/instrument")).length).toBe(1);
    expect(INSTRUMENTS_CACHE_TTL_MS).toBe(30 * 60 * 1000);
  });
});

describe("moapi-service — the FALLBACK ORDER", () => {
  const fake = (name: QuoteSource, ok: boolean, ltp = 0): QuoteStep => ({
    name,
    run: async () => {
      order.push(name);
      return ok ? { ok: true, ltp } : { ok: false, reason: "no data" };
    },
  });
  let order: QuoteSource[] = [];

  beforeEach(() => {
    order = [];
  });

  test("service → direct REST → NSE → an explicit 'unavailable'", async () => {
    const none = await runQuoteChain(
      [fake("moapi-service", false), fake("motilal-rest", false), fake("nse", false)],
      REF
    );

    expect(order).toEqual(["moapi-service", "motilal-rest", "nse"]);
    expect(none.ltp).toBe(0);
    expect(none.source).toBe("unavailable");
    expect(none.steps.map((s) => s.source)).toEqual(["moapi-service", "motilal-rest", "nse"]);
    expect(none.steps.every((s) => s.ok === false)).toBe(true);
  });

  test("the FIRST rung that produces a price wins (the rest are not called)", async () => {
    const first = await runQuoteChain(
      [fake("moapi-service", true, 42), fake("motilal-rest", true, 99), fake("nse", true, 7)],
      REF
    );

    expect(order).toEqual(["moapi-service"]);
    expect(first.ltp).toBe(42);
    expect(first.source).toBe("moapi-service");
  });

  test("the real ladder is service → direct REST → NSE", async () => {
    expect(serviceStep.name).toBe("moapi-service");
    expect(restStep.name).toBe("motilal-rest");
    expect(nseStep.name).toBe("nse");

    const res = await resolveOptionLTP(REF, {
      serviceInstruments: async () => null,
      serviceLTP: async () => null,
      restLTP: async () => null,
      nseLTP: async () => null,
    });

    expect(res.steps.map((s) => s.source)).toEqual(["moapi-service", "motilal-rest", "nse"]);
    expect(res.ltp).toBe(0);
    expect(res.source).toBe("unavailable");
  });

  test("the service is asked BEFORE the direct Motilal REST client", async () => {
    process.env.MOAPI_SERVICE_URL = "http://127.0.0.1:8781";
    let restCalled = false;

    const res = await resolveMOOptionLTP(REF, {
      serviceInstruments: async () => [
        {
          tradingsymbol: "SBIN26OCT2026800CE",
          exchange: "NSEFO",
          expiry: "2026-10-29",
          lotSize: 900,
          instrumentType: "OPTSTK",
          symbol: "SBIN",
          strike: 800,
          optionType: "CE",
        },
      ],
      serviceLTP: async () => ({
        ok: true,
        ts: 1,
        tradingsymbol: "SBIN26OCT2026800CE",
        ltp: 55,
        source: "moapi",
      }),
      restLTP: async () => {
        restCalled = true;
        return { ltp: 99, expiry: "2026-10-29" };
      },
      underlying: async () => 1000,
    });

    expect(res.ltp).toBe(55);
    expect(res.source).toBe("moapi-service");
    expect(restCalled).toBe(false);
  });
});

describe("moapi-service — the service being DOWN or UNSET changes NOTHING", () => {
  test("the service DOWN → the next rung answers (same result as without it)", async () => {
    process.env.MOAPI_SERVICE_URL = "http://127.0.0.1:8781";
    stubFetch(() => null); // refused

    let restCalled = false;
    const res = await resolveMOOptionLTP(REF, {
      serviceInstruments: async () => fetchServiceInstruments(),
      serviceLTP: async (ts) => fetchServiceLTP(ts),
      restLTP: async () => {
        restCalled = true;
        return { ltp: 77, expiry: "2026-10-29" };
      },
      underlying: async () => 1000,
    });

    expect(res.ltp).toBe(77);
    expect(res.source).toBe("motilal-rest");
    expect(restCalled).toBe(true);
    expect(res.steps[0].source).toBe("moapi-service");
    expect(res.steps[0].ok).toBe(false);
  });

  test("the service UNSET → the next rung answers and NOT ONE request is made", async () => {
    stubFetch(() => ({ body: { ok: true, ltp: 42 } }));

    let restCalled = false;
    const res = await resolveMOOptionLTP(REF, {
      serviceInstruments: async () => fetchServiceInstruments(),
      serviceLTP: async (ts) => fetchServiceLTP(ts),
      restLTP: async () => {
        restCalled = true;
        return { ltp: 77, expiry: "2026-10-29" };
      },
      underlying: async () => 1000,
    });

    expect(res.ltp).toBe(77);
    expect(res.source).toBe("motilal-rest");
    expect(restCalled).toBe(true);
    expect(calls.length).toBe(0);
  });

  test("the service UNSET and DOWN → the SAME unavailable result", async () => {
    const withoutService = await resolveMOOptionLTP(REF, {
      serviceInstruments: async () => fetchServiceInstruments(),
      serviceLTP: async (ts) => fetchServiceLTP(ts),
      restLTP: async () => null,
      underlying: async () => 1000,
    });

    process.env.MOAPI_SERVICE_URL = "http://127.0.0.1:8781";
    stubFetch(() => null);
    const withDeadService = await resolveMOOptionLTP(REF, {
      serviceInstruments: async () => fetchServiceInstruments(),
      serviceLTP: async (ts) => fetchServiceLTP(ts),
      restLTP: async () => null,
      underlying: async () => 1000,
    });

    expect(withoutService.ltp).toBe(0);
    expect(withoutService.source).toBe("unavailable");
    expect(withDeadService.ltp).toBe(0);
    expect(withDeadService.source).toBe("unavailable");
  });
});
