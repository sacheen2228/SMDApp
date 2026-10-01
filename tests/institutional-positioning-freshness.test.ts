/// <reference types="bun-types" />
// TDD for the daily institutional-positioning reliability helpers:
// IST date stamping, DB freshness query, watchdog latest-date selection.

import { describe, test, expect } from "bun:test";
import {
  todayDDMMYYYYIST,
  latestParticipantDate,
  positioningFreshness,
} from "@/lib/institutional-positioning-engine";

describe("todayDDMMYYYYIST", () => {
  test("mid-IST time returns that IST calendar date", () => {
    // 2026-09-29 12:00 UTC = 17:30 IST Sep 29
    expect(todayDDMMYYYYIST(new Date("2026-09-29T12:00:00Z"))).toBe("29092026");
  });

  test("uses IST not UTC — early-UTC after IST midnight still same day", () => {
    // 2026-09-28 19:00 UTC = Sep 29 00:30 IST (UTC date differs!)
    expect(todayDDMMYYYYIST(new Date("2026-09-28T19:00:00Z"))).toBe("29092026");
    // 2026-09-29 00:30 UTC = Sep 29 06:00 IST
    expect(todayDDMMYYYYIST(new Date("2026-09-29T00:30:00Z"))).toBe("29092026");
    // 2026-09-27 19:00 UTC = Sep 28 00:30 IST
    expect(todayDDMMYYYYIST(new Date("2026-09-27T19:00:00Z"))).toBe("28092026");
  });

  test("default arg = now, always 8 digits", () => {
    expect(todayDDMMYYYYIST()).toMatch(/^\d{8}$/);
  });
});

describe("latestParticipantDate — DDMMYYYY sorts wrong as strings", () => {
  test("picks the chronologically newest date, not string-max", () => {
    const rows = [
      { date: "31082026" }, // Aug 31 — STRING max
      { date: "29092026" }, // Sep 29 — actual newest
      { date: "28092026" },
    ];
    expect(latestParticipantDate(rows)).toBe("29092026");
  });

  test("single row / empty / garbage", () => {
    expect(latestParticipantDate([{ date: "07072026" }])).toBe("07072026");
    expect(latestParticipantDate([])).toBeNull();
    expect(latestParticipantDate([{ date: "garbage" }])).toBeNull();
    expect(latestParticipantDate([{ date: "garbage" }, { date: "15072026" }])).toBe("15072026");
  });
});

describe("positioningFreshness — watchdog verdict", () => {
  test("fresh only when latest DB date == today", () => {
    expect(positioningFreshness("29092026", "29092026")).toBe("fresh");
  });
  test("missing when stale or no data at all", () => {
    expect(positioningFreshness("28092026", "29092026")).toBe("missing");
    expect(positioningFreshness(null, "29092026")).toBe("missing");
    expect(positioningFreshness("31082026", "29092026")).toBe("missing");
  });
});
