/// <reference types="bun-types" />
// Expiry-day date comparison — THE BUG THAT LET EXPIRY-DAY TRADES THROUGH.
//
// Production expiry strings are Breeze/NSE format ("03-Nov-2026"). The old
// gate did `String(expiry).slice(0, 10) === todayISO`, which compared
// "03-Nov-202" against "2026-11-03" — the hard expiry-day block NEVER fired
// for real trades. isExpiryToday parses every format and compares IST days.
import { describe, test, expect } from "bun:test";
import {
  isExpiryToday,
  parseExpiryDate,
  parseExpiryDateLoose,
} from "@/lib/greeks";

// 2026-11-03 11:00 IST (Tuesday — NIFTY weekly expiry under current SEBI rules)
const TUE_11IST = Date.parse("2026-11-03T11:00:00+05:30");
const WED_11IST = Date.parse("2026-11-04T11:00:00+05:30");
const MON_11IST = Date.parse("2026-11-02T11:00:00+05:30");

describe("isExpiryToday — Breeze / ISO / dd-mm-yyyy, IST calendar days", () => {
  test("Breeze format on the same IST day → true (the production bug)", () => {
    expect(isExpiryToday("03-Nov-2026", new Date(TUE_11IST))).toBe(true);
  });

  test("ISO on the same IST day → true", () => {
    expect(isExpiryToday("2026-11-03", new Date(TUE_11IST))).toBe(true);
  });

  test("dd-mm-yyyy on the same IST day → true", () => {
    expect(isExpiryToday("03-11-2026", new Date(TUE_11IST))).toBe(true);
  });

  test("Breeze on a different day → false", () => {
    expect(isExpiryToday("03-Nov-2026", new Date(WED_11IST))).toBe(false);
    expect(isExpiryToday("03-Nov-2026", new Date(MON_11IST))).toBe(false);
  });

  test("the OLD slice(0,10) comparison is what failed — document it", () => {
    // This is the exact production comparison that never matched.
    const breeze = "03-Nov-2026";
    const todayISO = new Date(TUE_11IST).toISOString().slice(0, 10);
    expect(breeze.slice(0, 10)).toBe("03-Nov-202");
    expect(breeze.slice(0, 10)).not.toBe(todayISO);
    // …while the fixed helper agrees with the calendar.
    expect(isExpiryToday(breeze, new Date(TUE_11IST))).toBe(true);
  });

  test("unparseable / empty → false (same as the old silent miss)", () => {
    expect(isExpiryToday("", new Date(TUE_11IST))).toBe(false);
    expect(isExpiryToday(null, new Date(TUE_11IST))).toBe(false);
    expect(isExpiryToday(undefined, new Date(TUE_11IST))).toBe(false);
    expect(isExpiryToday("not-a-date", new Date(TUE_11IST))).toBe(false);
  });

  test("IST day boundary: 00:30 IST on expiry day still counts", () => {
    // 2026-11-03 00:30 IST = 2026-11-02 19:00 UTC — UTC date is the 2nd,
    // IST date is the 3rd. The gate must use IST.
    const justAfterMidnightIst = Date.parse("2026-11-03T00:30:00+05:30");
    expect(isExpiryToday("03-Nov-2026", new Date(justAfterMidnightIst))).toBe(true);
    // …and the UTC slice would have said the 2nd.
    expect(new Date(justAfterMidnightIst).toISOString().slice(0, 10)).toBe("2026-11-02");
  });
});

describe("parseExpiryDate / parseExpiryDateLoose", () => {
  test("parseExpiryDate handles Breeze and ISO", () => {
    const b = parseExpiryDate("03-Nov-2026", new Date(TUE_11IST));
    expect(b).not.toBeNull();
    expect(b!.toISOString().slice(0, 10)).toBe("2026-11-03");
    const i = parseExpiryDate("2026-11-03", new Date(TUE_11IST));
    expect(i).not.toBeNull();
    expect(i!.toISOString().slice(0, 10)).toBe("2026-11-03");
  });

  test("parseExpiryDateLoose does NOT drop yesterday (no 12h gate)", () => {
    const yesterday = parseExpiryDateLoose("02-Nov-2026", new Date(TUE_11IST));
    expect(yesterday).not.toBeNull();
    // parseExpiryDate refuses expired >12h ago — that is correct for pricing,
    // wrong for days-to-expiry / calendar math.
    const strict = parseExpiryDate("02-Nov-2026", new Date(TUE_11IST));
    expect(strict).toBeNull();
  });
});
