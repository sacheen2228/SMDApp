// tests/moapi-lot-size.test.ts
// The lot size is the number every ₹ amount is multiplied by — a wrong lot
// silently inflates (or deflates) every rupee in a trade.
//
// THE MERGE ORDER (one authority, three rungs):
//   1. THE SERVICE'S INSTRUMENT MASTER — the live exchange contract list
//      (the MOAPI service's /instrument endpoint)
//   2. THE STATIC TABLE — the NSE F&O bhavcopy snapshot in symbol-config
//   3. A LIVE-PUSHED LOT — setKnownLotSize()
//   4. UNKNOWN (0) — fail closed, NEVER NIFTY's 65 for a stock
//
// THESE TESTS ARE OFFLINE: globalThis.fetch is stubbed and the service lots
// are cleared after every test (the module state is shared by the whole test
// run).
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import {
  getLotSize,
  getLotSizeStrict,
  hasKnownLotSize,
  getSymbolConfig,
  setKnownLotSize,
  getKnownLotSizes,
  applyServiceInstruments,
  setServiceLotSizes,
  getServiceLotSizes,
  clearServiceLotSizes,
  getLotSizeSource,
} from "@/lib/symbol-config";
import { fetchServiceInstruments, resetServiceCache } from "@/lib/motilal/service";

const ORIGINAL_URL = process.env.MOAPI_SERVICE_URL;
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  delete process.env.MOAPI_SERVICE_URL;
  resetServiceCache();
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.MOAPI_SERVICE_URL;
  else process.env.MOAPI_SERVICE_URL = ORIGINAL_URL;
  globalThis.fetch = ORIGINAL_FETCH;
  resetServiceCache();
  clearServiceLotSizes();
});

describe("moapi lot size — the merge order", () => {
  test("1. the service's instrument master WINS over the static table", () => {
    // The static table says SBIN is 750 (the NSE bhavcopy).
    expect(getLotSize("SBIN")).toBe(750);

    applyServiceInstruments([
      { symbol: "SBIN", lotSize: 900, instrumentType: "OPTSTK", optionType: "CE" },
    ]);

    expect(getLotSize("SBIN")).toBe(900);
    expect(getLotSizeStrict("SBIN")).toBe(900);
    expect(hasKnownLotSize("SBIN")).toBe(true);
    expect(getLotSizeSource("SBIN")).toBe("service");
  });

  test("2. the static table is the second rung", () => {
    // The service master does not know TCS → the static table answers.
    applyServiceInstruments([
      { symbol: "SBIN", lotSize: 900, instrumentType: "OPTSTK", optionType: "CE" },
    ]);

    expect(getLotSize("TCS")).toBe(225);
    expect(getLotSizeSource("TCS")).toBe("static");
    expect(getLotSize("NIFTY")).toBe(65);
  });

  test("3. a live-pushed lot is the third rung", () => {
    setKnownLotSize("MYSTOCK", 42);
    expect(getLotSize("MYSTOCK")).toBe(42);
    expect(getLotSizeSource("MYSTOCK")).toBe("live");
  });

  test("4. an unknown symbol is UNKNOWN — never NIFTY's 65", () => {
    applyServiceInstruments([
      { symbol: "SBIN", lotSize: 900, instrumentType: "OPTSTK", optionType: "CE" },
    ]);

    const cfg = getSymbolConfig("NOT_A_REAL_SYMBOL");
    expect(cfg.lotSize).toBe(0);
    expect(cfg.lotSizeKnown).toBe(false);
    expect(cfg.lotSize).not.toBe(65);
    expect(getLotSizeStrict("NOT_A_REAL_SYMBOL")).toBeNull();
    expect(hasKnownLotSize("NOT_A_REAL_SYMBOL")).toBe(false);
    expect(getLotSize("NOT_A_REAL_SYMBOL")).toBe(1); // the honest per-unit amount
    expect(getLotSize("NOT_A_REAL_SYMBOL")).not.toBe(65);
    expect(getLotSizeSource("NOT_A_REAL_SYMBOL")).toBe("unknown");
  });
});

describe("moapi lot size — the master is filtered, never trusted blindly", () => {
  test("a cash row (MO reports lot 1 for every equity) never overwrites the real lot", () => {
    expect(getLotSize("RELIANCE")).toBe(500);

    applyServiceInstruments([{ symbol: "RELIANCE", lotSize: 1, instrumentType: "EQ" }]);

    expect(getLotSize("RELIANCE")).toBe(500); // the static table's real lot
    expect(getLotSizeSource("RELIANCE")).toBe("static");
  });

  test("an option row wins over a future row for the same underlying", () => {
    applyServiceInstruments([
      { symbol: "INFY", lotSize: 100, instrumentType: "FUTSTK" },
      { symbol: "INFY", lotSize: 400, instrumentType: "OPTSTK", optionType: "CE" },
    ]);

    expect(getLotSize("INFY")).toBe(400);
  });

  test("a broken master never registers a 0 or a negative lot", () => {
    applyServiceInstruments([
      { symbol: "BADLOT", lotSize: 0, instrumentType: "OPTSTK", optionType: "CE" },
      { symbol: "NEGLOT", lotSize: -5, instrumentType: "OPTSTK", optionType: "CE" },
      { symbol: "NANLOT", lotSize: Number.NaN, instrumentType: "OPTSTK", optionType: "CE" },
    ]);

    expect(getServiceLotSizes().BADLOT).toBeUndefined();
    expect(getServiceLotSizes().NEGLOT).toBeUndefined();
    expect(getServiceLotSizes().NANLOT).toBeUndefined();
    expect(getLotSizeStrict("BADLOT")).toBeNull();
    expect(getLotSize("BADLOT")).not.toBe(65);
  });

  test("the master can add a symbol the static table does not know", () => {
    applyServiceInstruments([
      { symbol: "NEWSYMBOL", lotSize: 375, instrumentType: "OPTSTK", optionType: "CE" },
    ]);

    expect(getLotSize("NEWSYMBOL")).toBe(375);
    expect(getLotSizeStrict("NEWSYMBOL")).toBe(375);
    expect(getLotSizeSource("NEWSYMBOL")).toBe("service");
  });
});

describe("moapi lot size — the existing contract is intact", () => {
  test("setKnownLotSize / getKnownLotSizes still work exactly as before", () => {
    setKnownLotSize("MYSTOCK", 42);
    expect(getKnownLotSizes().MYSTOCK).toBe(42);
    expect(getLotSize("MYSTOCK")).toBe(42);

    setKnownLotSize("BADLOT2", 0);
    setKnownLotSize("BADLOT2", -5);
    expect(getKnownLotSizes().BADLOT2).toBeUndefined();
  });

  test("the service master is a SEPARATE map (it never pollutes getKnownLotSizes)", () => {
    applyServiceInstruments([
      { symbol: "OTHERSTOCK", lotSize: 10, instrumentType: "OPTSTK", optionType: "CE" },
    ]);

    expect(getServiceLotSizes().OTHERSTOCK).toBe(10);
    expect(getKnownLotSizes().OTHERSTOCK).toBeUndefined();
  });

  test("clearing the service lots falls back to the static table", () => {
    applyServiceInstruments([
      { symbol: "SBIN", lotSize: 900, instrumentType: "OPTSTK", optionType: "CE" },
    ]);
    expect(getLotSize("SBIN")).toBe(900);

    clearServiceLotSizes();

    expect(getLotSize("SBIN")).toBe(750); // the static table again
    expect(getLotSizeSource("SBIN")).toBe("static");
  });
});

describe("moapi lot size — the service's instrument master feeds the lot sizes", () => {
  test("fetching the master registers the lots (the merge order in action)", async () => {
    process.env.MOAPI_SERVICE_URL = "http://127.0.0.1:8781";
    globalThis.fetch = (async (input: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? "");
      if (!url.includes("/instrument")) return new Response("{}", { status: 404 });
      return new Response(
        JSON.stringify({
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
            {
              tradingsymbol: "NIFTY26OCT202626000CE",
              exchange: "NSEFO",
              expiry: "2026-10-29",
              lotSize: 75,
              instrumentType: "OPTIDX",
              symbol: "NIFTY",
              strike: 26000,
              optionType: "CE",
            },
            {
              // a cash row — MO reports lot 1 for every equity scrip
              tradingsymbol: "",
              exchange: "NSE",
              expiry: "",
              lotSize: 1,
              instrumentType: "EQ",
              symbol: "RELIANCE",
              strike: 0,
              optionType: "",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as any;

    const instruments = await fetchServiceInstruments();
    expect(instruments?.length).toBe(3);

    // The service master is the FIRST rung — it wins over the static table.
    expect(getLotSize("SBIN")).toBe(900);
    expect(getLotSize("NIFTY")).toBe(75);
    expect(getLotSizeSource("NIFTY")).toBe("service");

    // The cash row did NOT overwrite RELIANCE's real lot.
    expect(getLotSize("RELIANCE")).toBe(500);
  });
});

describe("moapi lot size — a lot revision never moves a symbol's lot", () => {
  test("the MAJORITY lot wins (one stale contract cannot move it)", () => {
    applyServiceInstruments([
      { symbol: "OLDSTOCK", lotSize: 25, instrumentType: "OPTSTK", optionType: "CE" },
      { symbol: "OLDSTOCK", lotSize: 400, instrumentType: "OPTSTK", optionType: "CE" },
      { symbol: "OLDSTOCK", lotSize: 400, instrumentType: "OPTSTK", optionType: "PE" },
      { symbol: "OLDSTOCK", lotSize: 400, instrumentType: "OPTSTK", optionType: "CE" },
    ]);

    expect(getLotSize("OLDSTOCK")).toBe(400);
  });

  test("an option lot wins over a future lot", () => {
    applyServiceInstruments([
      { symbol: "MIXED", lotSize: 100, instrumentType: "FUTSTK" },
      { symbol: "MIXED", lotSize: 400, instrumentType: "OPTSTK", optionType: "CE" },
    ]);

    expect(getLotSize("MIXED")).toBe(400);
  });
});
