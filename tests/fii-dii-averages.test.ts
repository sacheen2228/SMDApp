/// <reference types="bun-types" />
// TDD: the 5-day FII/DII averages must use the NEWEST rows.
//
// The provider (fii-diidata.mrchartist.com/api/history) returns rows
// NEWEST-FIRST (verified live 2026-11-24: first=20-Nov-2026, last=31-Jul-2026).
// `history.slice(-5)` therefore averaged the OLDEST five rows — the reported
// fiiNet5dAvg was -1710 (September) while the true newest-5 average was +8730.

import { describe, test, expect } from "bun:test";
import { sortHistoryNewestFirst, fiveDayAverages, type FiiDiiDay } from "@/lib/fii-dii";

function row(date: string, fiiNet: number, diiNet: number): FiiDiiDay {
  return {
    date,
    fiiBuy: 0,
    fiiSell: 0,
    fiiNet,
    diiBuy: 0,
    diiSell: 0,
    diiNet,
  };
}

/** Newest-first the way the provider actually ships it. */
function providerOrderFixture(): FiiDiiDay[] {
  const rows: FiiDiiDay[] = [];
  // 60 trading-ish days, newest first: 20-Nov-2026 backwards
  const days = [
    "20-Nov-2026", "13-Nov-2026", "12-Nov-2026", "11-Nov-2026", "09-Nov-2026",
    "06-Nov-2026", "05-Nov-2026", "04-Nov-2026", "03-Nov-2026", "02-Nov-2026",
    "31-Oct-2026", "30-Oct-2026", "29-Oct-2026", "28-Oct-2026", "27-Oct-2026",
    "24-Oct-2026", "23-Oct-2026", "22-Oct-2026", "21-Oct-2026", "20-Oct-2026",
    "17-Oct-2026", "16-Oct-2026", "15-Oct-2026", "14-Oct-2026", "13-Oct-2026",
    "10-Oct-2026", "09-Oct-2026", "08-Oct-2026", "07-Oct-2026", "06-Oct-2026",
    "03-Oct-2026", "02-Oct-2026", "01-Oct-2026", "30-Sep-2026", "29-Sep-2026",
    "26-Sep-2026", "25-Sep-2026", "24-Sep-2026", "23-Sep-2026", "22-Sep-2026",
    "19-Sep-2026", "18-Sep-2026", "17-Sep-2026", "16-Sep-2026", "15-Sep-2026",
    "12-Sep-2026", "11-Sep-2026", "10-Sep-2026", "09-Sep-2026", "08-Sep-2026",
    "05-Sep-2026", "04-Sep-2026", "03-Sep-2026", "02-Sep-2026", "01-Sep-2026",
    "29-Aug-2026", "28-Aug-2026", "27-Aug-2026", "26-Aug-2026", "25-Aug-2026",
  ];
  for (const d of days) {
    // newest five → +1000 each; oldest five → -2000 each; the rest → 0
    const idx = days.indexOf(d);
    const fiiNet = idx < 5 ? 1000 : idx >= days.length - 5 ? -2000 : 0;
    const diiNet = idx < 5 ? 500 : idx >= days.length - 5 ? -800 : 0;
    rows.push(row(d, fiiNet, diiNet));
  }
  return rows;
}

describe("sortHistoryNewestFirst — DD-MMM-YYYY, provider ships newest-first", () => {
  test("provider (newest-first) input stays newest-first", () => {
    const sorted = sortHistoryNewestFirst(providerOrderFixture());
    expect(sorted[0].date).toBe("20-Nov-2026");
    expect(sorted[sorted.length - 1].date).toBe("25-Aug-2026");
  });

  test("oldest-first input is reordered to newest-first (order must not matter)", () => {
    const asc = providerOrderFixture().slice().reverse();
    const sorted = sortHistoryNewestFirst(asc);
    expect(sorted[0].date).toBe("20-Nov-2026");
    expect(sorted[sorted.length - 1].date).toBe("25-Aug-2026");
  });

  test("month names are not string-compared (Oct must sort after Nov)", () => {
    const sorted = sortHistoryNewestFirst([
      row("01-Oct-2026", 0, 0),
      row("01-Nov-2026", 0, 0),
      row("01-Dec-2026", 0, 0),
    ]);
    expect(sorted.map((r) => r.date)).toEqual([
      "01-Dec-2026",
      "01-Nov-2026",
      "01-Oct-2026",
    ]);
  });

  test("unparseable dates never throw and keep their relative tail order", () => {
    const sorted = sortHistoryNewestFirst([
      row("garbage", 0, 0),
      row("01-Nov-2026", 0, 0),
      row("", 0, 0),
    ]);
    expect(sorted).toHaveLength(3);
    expect(sorted[0].date).toBe("01-Nov-2026");
  });

  test("empty input → empty output", () => {
    expect(sortHistoryNewestFirst([])).toEqual([]);
  });
});

describe("fiveDayAverages — newest five rows, not the oldest five", () => {
  test("newest-first fixture averages the newest five (+1000 / +500)", () => {
    const avg = fiveDayAverages(providerOrderFixture());
    expect(avg.fiiNet5dAvg).toBe(1000);
    expect(avg.diiNet5dAvg).toBe(500);
  });

  test("same rows oldest-first give the same answer", () => {
    const avg = fiveDayAverages(providerOrderFixture().slice().reverse());
    expect(avg.fiiNet5dAvg).toBe(1000);
    expect(avg.diiNet5dAvg).toBe(500);
  });

  test("fewer than 5 rows → undefined, never a fabricated 0 average", () => {
    const avg = fiveDayAverages([
      row("20-Nov-2026", 999, 999),
      row("19-Nov-2026", 999, 999),
    ]);
    expect(avg.fiiNet5dAvg).toBeUndefined();
    expect(avg.diiNet5dAvg).toBeUndefined();
  });

  test("exactly 5 rows → defined", () => {
    const avg = fiveDayAverages([
      row("20-Nov-2026", 1, 1),
      row("19-Nov-2026", 2, 2),
      row("18-Nov-2026", 3, 3),
      row("17-Nov-2026", 4, 4),
      row("16-Nov-2026", 5, 5),
    ]);
    expect(avg.fiiNet5dAvg).toBe(3);
    expect(avg.diiNet5dAvg).toBe(3);
  });

  test("empty history → undefined", () => {
    expect(fiveDayAverages([]).fiiNet5dAvg).toBeUndefined();
  });

  test("regression: the old slice(-5) answer must NOT be returned", () => {
    // oldest five are -2000 each → the buggy code returned -2000
    const avg = fiveDayAverages(providerOrderFixture());
    expect(avg.fiiNet5dAvg).not.toBe(-2000);
    expect(avg.fiiNet5dAvg).toBeGreaterThan(0);
  });
});
