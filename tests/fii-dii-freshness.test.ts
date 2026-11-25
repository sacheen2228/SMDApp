/// <reference types="bun-types" />
// TDD for the FII/DII session-date gate.
//
// THE BUG THIS LOCKS DOWN: `fetchFiiDiiData()` used
//   `const latest = nseLatest || mcLatest || {...}`
// — the MrChartist fallback was accepted with NO date check. When NSE was
// rate-limited (403/429) the card served a 5-day-old row (20-Nov-2026) as
// "today's" FII/DII flow, and the 5-minute cache froze it.
//
// THE RULE: the latest published figures belong to the EXPECTED session
// (today after the ~18:00 IST publication, else the previous session). A
// snapshot from an older session is never served as the current flow.

import { describe, test, expect } from "bun:test";
import {
  fiiDiiExpectedSession,
  isFiiDiiDateAcceptable,
  selectFiiDiiLatest,
  parseFiiDiiDate,
  fiiDiiPublishedAtIso,
  type FiiDiiSnapshot,
} from "@/lib/fii-dii";
import { isTradingDayIso, previousTradingDayIso } from "@/lib/expiry-calculator";

function snap(date: string, source: FiiDiiSnapshot["source"], fiiNet = 4479.08): FiiDiiSnapshot {
  return {
    fiiNet,
    diiNet: 4018.72,
    fiiBuy: 24309.87,
    fiiSell: 19830.79,
    diiBuy: 22379.82,
    diiSell: 18361.1,
    date,
    source,
  };
}

// 2026-11-25 is a Wednesday, a normal trading day.
// 2026-11-26 is a Thursday (normal).
// 2026-11-28/29 are a Saturday/Sunday.
// 2026-11-24 is a Tuesday but an NSE holiday (see NSE_HOLIDAYS).
const AT_2026_11_25_12_00_IST = new Date("2026-11-25T06:30:00Z"); // 12:00 IST
const AT_2026_11_25_19_00_IST = new Date("2026-11-25T13:30:00Z"); // 19:00 IST
const AT_2026_11_26_09_00_IST = new Date("2026-11-26T03:30:00Z"); // 09:00 IST
const AT_2026_11_28_10_00_IST = new Date("2026-11-28T04:30:00Z"); // Saturday
const AT_2026_11_24_10_00_IST = new Date("2026-11-24T04:30:00Z"); // NSE holiday

describe("trading-day helpers (canonical NSE_HOLIDAYS)", () => {
  test("isTradingDayIso follows the canonical holiday set", () => {
    expect(isTradingDayIso("2026-11-25")).toBe(true);
    expect(isTradingDayIso("2026-11-28")).toBe(false); // Saturday
    expect(isTradingDayIso("2026-11-29")).toBe(false); // Sunday
    expect(isTradingDayIso("2026-11-24")).toBe(false); // NSE holiday
    expect(isTradingDayIso("2026-11-10")).toBe(false); // Diwali
    expect(isTradingDayIso("garbage")).toBe(false);
  });

  test("previousTradingDayIso skips the weekend and the holiday", () => {
    expect(previousTradingDayIso("2026-11-25")).toBe("2026-11-23"); // Mon (24th = holiday)
    expect(previousTradingDayIso("2026-11-28")).toBe("2026-11-27"); // Sat → Fri
    expect(previousTradingDayIso("2026-11-24")).toBe("2026-11-23");
    expect(previousTradingDayIso("bad")).toBeNull();
  });
});

describe("fiiDiiExpectedSession — which session's figures are current", () => {
  test("before the 18:00 IST publication it is the PREVIOUS session", () => {
    expect(fiiDiiExpectedSession(AT_2026_11_25_12_00_IST)).toBe("2026-11-23");
  });

  test("after the publication it is the same day", () => {
    expect(fiiDiiExpectedSession(AT_2026_11_25_19_00_IST)).toBe("2026-11-25");
  });

  test("the next morning it is still the previous session (today not published yet)", () => {
    expect(fiiDiiExpectedSession(AT_2026_11_26_09_00_IST)).toBe("2026-11-25");
  });

  test("on a weekend it is the last session before today", () => {
    expect(fiiDiiExpectedSession(AT_2026_11_28_10_00_IST)).toBe("2026-11-27");
  });

  test("on an NSE holiday it is the last session before it", () => {
    expect(fiiDiiExpectedSession(AT_2026_11_24_10_00_IST)).toBe("2026-11-23");
  });
});

describe("isFiiDiiDateAcceptable — the stale-fallback gate", () => {
  test("the expected session is acceptable", () => {
    expect(isFiiDiiDateAcceptable("25-Nov-2026", "2026-11-25")).toBe(true);
    expect(isFiiDiiDateAcceptable("2026-11-25", "2026-11-25")).toBe(true);
  });

  test("the session before it is acceptable (delayed publication)", () => {
    expect(isFiiDiiDateAcceptable("24-Nov-2026", "2026-11-25")).toBe(true);
  });

  test("a 5-day-old row is REJECTED (the bug on the card)", () => {
    expect(isFiiDiiDateAcceptable("20-Nov-2026", "2026-11-25")).toBe(false);
    expect(isFiiDiiDateAcceptable("19-Nov-2026", "2026-11-25")).toBe(false);
  });

  test("unparseable / empty / future dates are rejected", () => {
    expect(isFiiDiiDateAcceptable("", "2026-11-25")).toBe(false);
    expect(isFiiDiiDateAcceptable("garbage", "2026-11-25")).toBe(false);
    expect(isFiiDiiDateAcceptable("26-Nov-2026", "2026-11-25")).toBe(false);
  });
});

describe("selectFiiDiiLatest — priority + freshness together", () => {
  const expected = "2026-11-25";

  test("NSE live wins over the artifact and the fallback", () => {
    const out = selectFiiDiiLatest(
      [snap("25-Nov-2026", "nse", 4479.08), snap("25-Nov-2026", "nse-eod", 4479.08), snap("25-Nov-2026", "mrchartist", 4479.08)],
      expected,
    );
    expect(out.snapshot?.source).toBe("nse");
  });

  test("the NSE EOD artifact wins over the fallback when NSE live is blocked", () => {
    const out = selectFiiDiiLatest(
      [null, snap("25-Nov-2026", "nse-eod", 4479.08), snap("25-Nov-2026", "mrchartist", 4479.08)],
      expected,
    );
    expect(out.snapshot?.source).toBe("nse-eod");
    expect(out.snapshot?.fiiNet).toBe(4479.08);
  });

  test("a STALE fallback is rejected even when it is the only answer", () => {
    const out = selectFiiDiiLatest([null, snap("20-Nov-2026", "mrchartist", 10308.42)], expected);
    expect(out.snapshot).toBeNull();
    expect(out.rejected).toEqual([{ source: "mrchartist", date: "20-Nov-2026" }]);
  });

  test("a stale fallback never outranks a same-session artifact", () => {
    const out = selectFiiDiiLatest(
      [snap("20-Nov-2026", "mrchartist", 10308.42), snap("25-Nov-2026", "nse-eod", 4479.08)],
      expected,
    );
    expect(out.snapshot?.source).toBe("nse-eod");
    expect(out.snapshot?.fiiNet).toBe(4479.08);
  });

  test("nothing at all → no snapshot", () => {
    expect(selectFiiDiiLatest([null, null], expected).snapshot).toBeNull();
  });

  test("the newest acceptable date wins; the priority order breaks ties", () => {
    const out = selectFiiDiiLatest(
      [snap("24-Nov-2026", "mrchartist", 1), snap("25-Nov-2026", "nse-eod", 2)],
      expected,
    );
    expect(out.snapshot?.date).toBe("25-Nov-2026");
  });
});

describe("date parsing helpers", () => {
  test("parses both provider formats", () => {
    expect(parseFiiDiiDate("25-Nov-2026")).not.toBeNull();
    expect(parseFiiDiiDate("2026-11-25")).not.toBeNull();
    expect(parseFiiDiiDate("2026-11-25")).toBe(parseFiiDiiDate("25-Nov-2026"));
    expect(parseFiiDiiDate("25-Xxx-2026")).toBeNull();
    expect(parseFiiDiiDate("")).toBeNull();
  });

  test("the publication stamp is 18:00 IST of the snapshot date", () => {
    expect(fiiDiiPublishedAtIso("25-Nov-2026")).toBe("2026-11-25T18:00:00+05:30");
    expect(fiiDiiPublishedAtIso("2026-11-25")).toBe("2026-11-25T18:00:00+05:30");
    expect(fiiDiiPublishedAtIso("")).toBeNull();
  });
});
