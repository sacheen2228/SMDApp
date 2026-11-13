// index-futures-candles.test.ts — expiry resolution from the Breeze master (offline).
import { describe, test, expect } from "bun:test";
import {
  ddmmyyyyToIso,
  pickNearestFuturesExpiry,
  isIndexSymbol,
} from "../src/lib/index-futures-candles";

const master = [
  {}, // 0
  {}, // 1
  {}, // 2
  {}, // 3 MCX
  {
    "FUT-NIFTY-23-Nov-2026": "t1",
    "FUT-NIFTY-29-Dec-2026": "t2",
    "FUT-CNXBAN-23-Nov-2026": "t3",
    "FUT-NIFFIN-23-Nov-2026": "t4",
    "OPT-NIFTY-23-Nov-2026-25000-CE": "opt",
  }, // 4 NFO
  {
    "FUT-BSESEN-26-Nov-2026": "b1",
    "FUT-BANKEX-26-Nov-2026": "b2",
  }, // 5 BFO
];

// Pin "now" to 13-Nov-2026 IST so 23-Nov is the nearest future.
const NOW = Date.parse("2026-11-13T08:00:00Z"); // 13:30 IST

describe("ddmmyyyyToIso", () => {
  test("parses DD-MMM-YYYY", () => {
    expect(ddmmyyyyToIso("23-Nov-2026")).toBe("2026-11-23");
    expect(ddmmyyyyToIso("01-Dec-2026")).toBe("2026-12-01");
    expect(ddmmyyyyToIso("bad")).toBeNull();
  });
});

describe("isIndexSymbol", () => {
  test("accepts the six indices, rejects stocks", () => {
    expect(isIndexSymbol("NIFTY")).toBe(true);
    expect(isIndexSymbol("banknifty")).toBe(true);
    expect(isIndexSymbol("SENSEX")).toBe(true);
    expect(isIndexSymbol("RELIANCE")).toBe(false);
  });
});

describe("pickNearestFuturesExpiry", () => {
  test("nearest live NIFTY future (skips expired, ignores OPT- keys)", () => {
    expect(pickNearestFuturesExpiry(master, "NIFTY", NOW)).toBe("2026-11-23");
  });
  test("BANKNIFTY uses CNXBAN code", () => {
    expect(pickNearestFuturesExpiry(master, "BANKNIFTY", NOW)).toBe("2026-11-23");
  });
  test("FINNIFTY uses NIFFIN code", () => {
    expect(pickNearestFuturesExpiry(master, "FINNIFTY", NOW)).toBe("2026-11-23");
  });
  test("SENSEX from BFO list", () => {
    expect(pickNearestFuturesExpiry(master, "SENSEX", NOW)).toBe("2026-11-26");
  });
  test("unknown symbol / empty master → null", () => {
    expect(pickNearestFuturesExpiry(master, "RELIANCE", NOW)).toBeNull();
    expect(pickNearestFuturesExpiry([], "NIFTY", NOW)).toBeNull();
  });
  test("expired future is skipped", () => {
    // Only an expired contract listed → null
    const expired = [{ "FUT-NIFTY-01-Jan-2020": "x" }];
    expect(pickNearestFuturesExpiry(expired, "NIFTY", NOW)).toBeNull();
  });
});
