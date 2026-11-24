/// <reference types="bun-types" />
// TDD for the institutional-positioning date fixes.
//
// `participantOI.date` is stored as DDMMYYYY TEXT, so:
//   * `orderBy: { date: 'desc' }` returns the STRING max (30102026 = 30 Oct)
//     instead of the newest date (23112026 = 23 Nov) — a ~3.5 week old row
//     was served as "today";
//   * `allDates.sort().reverse()` put that string-max first, so
//     buildChanges() read the wrong "previous day" / 5-day / 20-day rows;
//   * `dateLabel: todayLabel` stamped the stale row with TODAY's label
//     ("Nov 24, 2026" over 30-Oct data) — the DD panel shows this verbatim.

import { describe, test, expect } from "bun:test";
import {
  sortDatesNewestFirst,
  ddmmyyyyToLabel,
  latestParticipantDate,
} from "@/lib/institutional-positioning-engine";

describe("sortDatesNewestFirst — DDMMYYYY must not be string-sorted", () => {
  test("picks chronological order, not lexicographic (30-Oct vs 23-Nov)", () => {
    const dates = ["30102026", "29102026", "23112026", "20112026", "19112026"];
    expect(sortDatesNewestFirst(dates)).toEqual([
      "23112026",
      "20112026",
      "19112026",
      "30102026",
      "29102026",
    ]);
  });

  test("string sort would have put 30102026 first — this must not happen", () => {
    const dates = ["30102026", "23112026"];
    expect(sortDatesNewestFirst(dates)[0]).toBe("23112026");
  });

  test("already-newest-first input is a no-op", () => {
    const dates = ["23112026", "20112026", "19112026"];
    expect(sortDatesNewestFirst(dates)).toEqual(dates);
  });

  test("garbage dates are dropped, never crash", () => {
    expect(sortDatesNewestFirst(["garbage", "30102026", ""])).toEqual(["30102026"]);
  });

  test("empty input → empty output", () => {
    expect(sortDatesNewestFirst([])).toEqual([]);
  });
});

describe("ddmmyyyyToLabel — the label must describe the DATA date", () => {
  test("formats the row's own date, not today", () => {
    expect(ddmmyyyyToLabel("23112026")).toBe("Nov 23, 2026");
    expect(ddmmyyyyToLabel("30102026")).toBe("Oct 30, 2026");
    expect(ddmmyyyyToLabel("01012027")).toBe("Jan 01, 2027"); // day padded, same as todayLabel
  });

  test("pads the day the way the old todayLabel did", () => {
    expect(ddmmyyyyToLabel("05032026")).toBe("Mar 05, 2026");
  });

  test("garbage → empty string (caller falls back, never a wrong claim)", () => {
    expect(ddmmyyyyToLabel("garbage")).toBe("");
    expect(ddmmyyyyToLabel("")).toBe("");
    expect(ddmmyyyyToLabel("32132026")).toBe(""); // 32 Dec — invalid
  });
});

describe("latestParticipantDate (regression guard for the last-resort branch)", () => {
  test("the live DB shape: string-max is NOT the newest", () => {
    const rows = [
      { date: "30102026" },
      { date: "29102026" },
      { date: "23112026" },
      { date: "20112026" },
    ];
    expect(latestParticipantDate(rows)).toBe("23112026");
  });
});
