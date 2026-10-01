/// <reference types="bun-types" />
// closeYesterdayBTST planning — the square-off must price each row with ITS
// real next-trading-day close, never "whatever close today happens to have"
// (that's what produced the Jul-20/Sep-11 mass-stamp corruption) and a row
// whose day-1 close failed must still get the day-1 close on day-2 retry.

import { describe, it, expect } from "bun:test";
import { planBtstSquareOff } from "@/lib/btst-scanner";

describe("planBtstSquareOff", () => {
  it("never touches trades created today", () => {
    expect(planBtstSquareOff("20261001", "20261001")).toEqual({
      skip: true,
      probeFrom: "2026-10-02",
    });
    // created "later" than today (clock skew) also skipped
    expect(planBtstSquareOff("20261002", "20261001").skip).toBe(true);
  });

  it("yesterday's rows probe from today (normal square-off)", () => {
    expect(planBtstSquareOff("20260930", "20261001")).toEqual({
      skip: false,
      probeFrom: "2026-10-01",
    });
  });

  it("stale rows probe from THEIR next day, not from today", () => {
    // Jul-13 created, still open Sep-11 → must price Jul-14, not Sep-11
    expect(planBtstSquareOff("20260713", "20260911")).toEqual({
      skip: false,
      probeFrom: "2026-07-14",
    });
  });
});
