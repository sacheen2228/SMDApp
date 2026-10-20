// tests/moapi-plausibility-guard.test.ts
// A Motilal premium is only usable when we can PROVE it is the premium of
// the contract the trade is in. A premium from another expiry, another
// strike, or a price that is not below the underlying is REJECTED — never
// used, never displayed. That is the guard that lets the MO path into the
// TP/SL monitor (src/lib/tiger-monitor.ts) without the monitor ever firing a
// false TP/SL on a mis-resolved contract.
//
// THESE TESTS ARE OFFLINE: globalThis.fetch is stubbed and the underlying
// resolver is replaced with a local function.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  isPlausibleOptionPrice,
  normalizeExpiry,
  findServiceContract,
  resolveMOOptionLTP,
  __setUnderlyingResolverForTests,
} from "@/lib/motilal/quote";
import { resetServiceCache } from "@/lib/motilal/service";
import { clearServiceLotSizes } from "@/lib/symbol-config";
import { fetchLTP } from "@/lib/tiger-monitor";

const ORIGINAL_URL = process.env.MOAPI_SERVICE_URL;
const ORIGINAL_FETCH = globalThis.fetch;

let calls: string[] = [];

const UNDERLYING = 1000;

const GOOD = {
  premium: 120,
  underlyingPrice: UNDERLYING,
  expectedStrike: 800,
  expectedOptionType: "CE",
  expectedExpiry: "2026-10-29",
  actualStrike: 800,
  actualOptionType: "CE",
  actualExpiry: "2026-10-29",
};

const INSTRUMENTS = [
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
];

/** A stubbed service: /instrument + /ltp. `ltp` is what the service quotes. */
function stubService(ltp: number) {
  calls = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? "");
    calls.push(url);
    if (url.includes("/instrument")) {
      return new Response(JSON.stringify({ ok: true, ts: 1, instruments: INSTRUMENTS }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/ltp")) {
      return new Response(
        JSON.stringify({ ok: true, ts: 1, tradingsymbol: "SBIN26OCT2026800CE", ltp, source: "moapi" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ ok: false, error: "unknown endpoint" }), { status: 404 });
  }) as any;
}

beforeEach(() => {
  delete process.env.MOAPI_SERVICE_URL;
  resetServiceCache();
  calls = [];
  __setUnderlyingResolverForTests(async () => UNDERLYING);
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.MOAPI_SERVICE_URL;
  else process.env.MOAPI_SERVICE_URL = ORIGINAL_URL;
  globalThis.fetch = ORIGINAL_FETCH;
  resetServiceCache();
  clearServiceLotSizes();
  __setUnderlyingResolverForTests(null);
});

describe("moapi plausibility — the guard itself", () => {
  test("a good premium is accepted", () => {
    const result = isPlausibleOptionPrice(GOOD);
    expect(result.ok).toBe(true);
  });

  test("a premium that is NOT below the underlying is rejected", () => {
    const atUnderlying = isPlausibleOptionPrice({ ...GOOD, premium: UNDERLYING });
    expect(atUnderlying.ok).toBe(false);
    expect(atUnderlying.reason).toContain("underlying");

    const aboveUnderlying = isPlausibleOptionPrice({ ...GOOD, premium: UNDERLYING + 1 });
    expect(aboveUnderlying.ok).toBe(false);
    expect(aboveUnderlying.reason).toContain("underlying");

    // a sane premium is still fine
    expect(isPlausibleOptionPrice({ ...GOOD, premium: UNDERLYING - 1 }).ok).toBe(true);
  });

  test("a premium from the WRONG expiry is rejected", () => {
    const result = isPlausibleOptionPrice({ ...GOOD, actualExpiry: "2026-11-26" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("expiry mismatch");
  });

  test("a premium from the wrong strike is rejected", () => {
    const result = isPlausibleOptionPrice({ ...GOOD, actualStrike: 700 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("strike mismatch");
  });

  test("a premium of the wrong option type is rejected", () => {
    const result = isPlausibleOptionPrice({ ...GOOD, actualOptionType: "PE" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("option type mismatch");
  });

  test("a non-positive premium is rejected", () => {
    expect(isPlausibleOptionPrice({ ...GOOD, premium: 0 }).ok).toBe(false);
    expect(isPlausibleOptionPrice({ ...GOOD, premium: -5 }).ok).toBe(false);
    expect(isPlausibleOptionPrice({ ...GOOD, premium: Number.NaN }).ok).toBe(false);
  });

  test("an UNKNOWN underlying is rejected (fail closed)", () => {
    const result = isPlausibleOptionPrice({ ...GOOD, underlyingPrice: 0 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("underlying");

    const missing = isPlausibleOptionPrice({ ...GOOD, underlyingPrice: undefined });
    expect(missing.ok).toBe(false);
  });

  test("an UNKNOWN trade expiry is rejected (fail closed)", () => {
    const result = isPlausibleOptionPrice({ ...GOOD, expectedExpiry: undefined });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("expiry");

    const unparseable = isPlausibleOptionPrice({ ...GOOD, expectedExpiry: "sometime soon" });
    expect(unparseable.ok).toBe(false);
  });
});

describe("moapi plausibility — the expiry formats", () => {
  test("every common expiry format normalises to YYYY-MM-DD", () => {
    expect(normalizeExpiry("2026-10-29")).toBe("2026-10-29");
    expect(normalizeExpiry("29-Oct-2026")).toBe("2026-10-29");
    expect(normalizeExpiry("29 OCT 2026")).toBe("2026-10-29");
    expect(normalizeExpiry("20261029")).toBe("2026-10-29");
    expect(normalizeExpiry("not a date")).toBeNull();
    expect(normalizeExpiry("")).toBeNull();
    expect(normalizeExpiry(undefined)).toBeNull();
  });

  test("the service contract is found by symbol + strike + type + expiry", () => {
    const found = findServiceContract(INSTRUMENTS, {
      symbol: "SBIN",
      strike: 800,
      optionType: "CE",
      expiry: "2026-10-29",
    });
    expect(found?.tradingsymbol).toBe("SBIN26OCT2026800CE");

    const wrongExpiry = findServiceContract(INSTRUMENTS, {
      symbol: "SBIN",
      strike: 800,
      optionType: "CE",
      expiry: "2026-11-26",
    });
    expect(wrongExpiry).toBeNull();
  });
});

describe("moapi plausibility — the MO path in the TP/SL monitor", () => {
  test("a good MO premium IS used by the monitor", async () => {
    process.env.MOAPI_SERVICE_URL = "http://127.0.0.1:8781";
    stubService(120);

    const ltp = await fetchLTP("SBIN", 800, "CE", "2026-10-29", {
      breezeChain: async () => 0,
      nseChain: async () => 0,
    });

    expect(ltp).toBe(120);
    expect(calls.some((c) => c.includes("/ltp"))).toBe(true);
  });

  test("a premium that fails the guard is NEVER used (the monitor falls through)", async () => {
    process.env.MOAPI_SERVICE_URL = "http://127.0.0.1:8781";
    stubService(5000); // >= the underlying (1000) → implausible

    const withFallback = await fetchLTP("SBIN", 800, "CE", "2026-10-29", {
      breezeChain: async () => 42,
      nseChain: async () => 0,
    });
    expect(withFallback).toBe(42); // the existing behaviour, not the bad price

    const withoutFallback = await fetchLTP("SBIN", 800, "CE", "2026-10-29", {
      breezeChain: async () => 0,
      nseChain: async () => 0,
    });
    expect(withoutFallback).toBe(0); // "LTP feed unavailable" — never a bad price
  });

  test("a premium for the WRONG expiry is NEVER used", async () => {
    process.env.MOAPI_SERVICE_URL = "http://127.0.0.1:8781";
    stubService(120);

    // The trade is a 26-Nov contract; the service master only has 29-Oct.
    const ltp = await fetchLTP("SBIN", 800, "CE", "2026-11-26", {
      breezeChain: async () => 0,
      nseChain: async () => 0,
    });

    expect(ltp).toBe(0);
  });

  test("the monitor passes the trade's expiry to the price resolver", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/tiger-monitor.ts"), "utf8");
    expect(src).toContain("t.expiry");
  });
});

describe("moapi plausibility — the service being DOWN or UNSET changes NOTHING", () => {
  test("the service UNSET → the monitor answers exactly as before (no request at all)", async () => {
    globalThis.fetch = (async () => {
      calls.push("unexpected");
      return new Response("{}", { status: 500 });
    }) as any;

    const ltp = await fetchLTP("SBIN", 800, "CE", "2026-10-29", {
      breezeChain: async () => 42,
      nseChain: async () => 0,
    });

    expect(ltp).toBe(42);
    expect(calls.length).toBe(0);
  });

  test("the service DOWN → the monitor answers exactly as before", async () => {
    process.env.MOAPI_SERVICE_URL = "http://127.0.0.1:8781";
    globalThis.fetch = (async (input: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? "");
      calls.push(url);
      throw new Error(`network down: ${url}`);
    }) as any;

    const ltp = await fetchLTP("SBIN", 800, "CE", "2026-10-29", {
      breezeChain: async () => 42,
      nseChain: async () => 0,
    });

    expect(ltp).toBe(42);
  });

  test("the MO path returns 'unavailable' when nothing produced a price", async () => {
    const result = await resolveMOOptionLTP(
      { symbol: "SBIN", strike: 800, optionType: "CE", expiry: "2026-10-29" },
      {
        serviceInstruments: async () => INSTRUMENTS,
        serviceLTP: async () => null,
        restLTP: async () => null,
        underlying: async () => UNDERLYING,
      }
    );

    expect(result.ltp).toBe(0);
    expect(result.source).toBe("unavailable");
    expect(result.steps.map((s) => s.source)).toEqual(["moapi-service", "motilal-rest"]);
  });
});
