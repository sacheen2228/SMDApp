/// <reference types="bun-types" />
// findBarForDate — NSE historical ranges clamp across session boundaries
// ([Sun 00:00, Mon 00:00] returns Monday's bar), so getDailyRange must pick
// the row whose mtimestamp is the TARGET date, not data[0]. Without this,
// weekend/holiday probes silently returned the next session's close.

import { describe, it, expect } from "bun:test";
import { findBarForDate } from "@/lib/trade-validator";

const bar = (date: string, close: number) => ({ mtimestamp: date, chClosingPrice: close });

describe("findBarForDate — exact session match only", () => {
  it("finds the target row among clamped range rows", () => {
    const rows = [bar("26-Jul-2026", 0), bar("27-Jul-2026", 7414)];
    expect(findBarForDate(rows, "2026-07-27")).toBe(rows[1]);
  });

  it("returns null when the range contains only other sessions", () => {
    const rows = [bar("27-Jul-2026", 7414)];
    expect(findBarForDate(rows, "2026-07-26")).toBeNull(); // Sunday target
  });

  it("returns null for empty input", () => {
    expect(findBarForDate([], "2026-07-27")).toBeNull();
  });

  it("accepts ISO-shaped timestamps too", () => {
    const rows = [{ mtimestamp: "2026-07-27", chClosingPrice: 10 }];
    expect(findBarForDate(rows, "2026-07-27")).toBe(rows[0]);
  });

  it("ignores rows with unparseable dates", () => {
    const rows = [{ mtimestamp: "", chClosingPrice: 1 }, bar("27-Jul-2026", 2)];
    expect(findBarForDate(rows, "2026-07-27")).toBe(rows[1]);
  });
});
