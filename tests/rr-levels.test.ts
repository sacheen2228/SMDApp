/// <reference types="bun-types" />
// Display-truth R:R: the opportunities API emitted entry/sl/tp1 from one
// source and rr from the scanner's internal setup — values disagreed on the
// dashboard (INFY showed 1:1.13 while its own levels implied 1.43).
// rr must always be derived from the SAME numbers that are displayed.

import { describe, it, expect } from "bun:test";
import { rrFromLevels } from "@/lib/technical-analysis";

describe("rrFromLevels", () => {
  it("long setup: reward/risk from displayed levels", () => {
    expect(rrFromLevels(100, 95, 110)).toBe(2);
  });

  it("works for short-shaped levels via absolute distances", () => {
    expect(rrFromLevels(100, 105, 90)).toBe(2);
  });

  it("matches the dashboard INFY case (1032.93 / 981.22 / 1106.7)", () => {
    expect(rrFromLevels(1032.93, 981.22, 1106.7)).toBe(1.43);
  });

  it("rounds to 2dp", () => {
    expect(rrFromLevels(2295.03, 2222.53, 2410.9)).toBe(1.6);
  });

  it("degenerate inputs → 0 (never NaN/Infinity)", () => {
    expect(rrFromLevels(100, 100, 110)).toBe(0); // zero risk
    expect(rrFromLevels(100, 95, 0)).toBe(0); // missing target
    expect(rrFromLevels(0, 95, 110)).toBe(0); // missing entry
  });
});
