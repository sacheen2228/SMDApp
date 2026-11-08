/// <reference types="bun-types" />
// W/M expiry badge — the option-chain route serves expiries WITHOUT a `type`,
// so the OI panel's `e.type === "weekly"` check saw undefined for every row
// and rendered every badge as "M". classifyExpiryType() derives the type from
// the symbol's exchange list (or calendar), date-object based so ISO and
// "DD-MMM-YYYY" inputs both work.
import { describe, test, expect } from "bun:test";
import { classifyExpiryType, setExchangeExpiries } from "@/lib/expiry-calculator";

// Unique symbols — never a real instrument, so the exchange cache this test
// seeds cannot leak into other test files (bun runs every file in one process).
const CACHED = "BADGETEST";
const UNCACHED = "CALTESTX";

describe("classifyExpiryType — weekly vs monthly for the W/M badge", () => {
  test("exchange list: last expiry of the calendar month is monthly", () => {
    // Realistic NIFTY list: Nov 2026's monthly (last Tuesday) is holiday-shifted
    // to Mon 23-Nov (Guru Nanak Jayanti on the 24th) — the exchange publishes 23.
    setExchangeExpiries(CACHED, ["10-Nov-2026", "17-Nov-2026", "23-Nov-2026", "29-Dec-2026"]);
    expect(classifyExpiryType(CACHED, "10-Nov-2026")).toBe("weekly");
    expect(classifyExpiryType(CACHED, "17-Nov-2026")).toBe("weekly");
    expect(classifyExpiryType(CACHED, "23-Nov-2026")).toBe("monthly"); // last Nov expiry
    expect(classifyExpiryType(CACHED, "29-Dec-2026")).toBe("monthly"); // only Dec entry
  });

  test("ISO input classifies the same as DD-MMM-YYYY (format-robust)", () => {
    setExchangeExpiries(CACHED, ["10-Nov-2026", "17-Nov-2026", "23-Nov-2026", "29-Dec-2026"]);
    expect(classifyExpiryType(CACHED, "2026-11-17")).toBe("weekly");
    expect(classifyExpiryType(CACHED, "2026-11-23")).toBe("monthly");
  });

  test("no exchange cache → calendar fallback (holiday-shifted last Tuesday)", () => {
    // Uncached symbols fall back to the monthly-weekday calendar: Nov 2026's
    // last Tuesday is the 24th, but that is Guru Nanak Jayanti — the calendar
    // shifts the monthly contract back to Mon 23-Nov.
    expect(classifyExpiryType(UNCACHED, "23-Nov-2026")).toBe("monthly");
    expect(classifyExpiryType(UNCACHED, "17-Nov-2026")).toBe("weekly");
  });

  test("unparseable date → null (never a guessed badge)", () => {
    expect(classifyExpiryType(CACHED, "not-a-date")).toBeNull();
    expect(classifyExpiryType(CACHED, "")).toBeNull();
  });
});
