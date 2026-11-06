/// <reference types="bun-types" />
// Tests for marketHours.ts — IST epoch maths, holidays, send window.
// All timestamps constructed via Date.UTC so results are timezone-independent.
// Run with TZ=UTC and TZ=Asia/Kolkata — both must pass.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  isMarketOpen,
  isTelegramSendWindow,
  msUntilTelegramSendWindow,
  isTradingDay,
  getNSEHolidays,
} from "@/lib/marketHours";

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

// Friday 2026-11-06
const FRI_2026_11_06 = (utcHour: number, utcMin: number) =>
  new Date(Date.UTC(2026, 10, 6, utcHour, utcMin, 0));

// Monday 2026-11-09
const MON_2026_11_09 = (utcHour: number, utcMin: number) =>
  new Date(Date.UTC(2026, 10, 9, utcHour, utcMin, 0));

// Saturday 2026-11-07
const SAT_2026_11_07 = (utcHour: number, utcMin: number) =>
  new Date(Date.UTC(2026, 10, 7, utcHour, utcMin, 0));

// Sunday 2026-11-08
const SUN_2026_11_08 = (utcHour: number, utcMin: number) =>
  new Date(Date.UTC(2026, 10, 8, utcHour, utcMin, 0));

// IST = UTC+5:30
// Fri 09:05 IST = UTC 03:35
// Fri 09:10 IST = UTC 03:40 (send window opens)
// Fri 15:30 IST = UTC 10:00 (send window closes)
// Fri 15:31 IST = UTC 10:01 (after close)
// Mon 09:10 IST = UTC 03:40

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.NSE_HOLIDAYS;
  delete process.env.NSE_HOLIDAYS;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.NSE_HOLIDAYS;
  else process.env.NSE_HOLIDAYS = savedEnv;
  delete process.env.TELEGRAM_ALLOW_OFFHOURS;
});

describe("isMarketOpen", () => {
  it("Fri 09:05 IST → NOT open (market opens at 09:15)", () => {
    // 09:05 IST = UTC 03:35 on Friday
    expect(isMarketOpen(FRI_2026_11_06(3, 35))).toBe(false);
  });
  it("Fri 09:15 IST → open (market open time)", () => {
    // 09:15 IST = UTC 03:45 on Friday
    expect(isMarketOpen(FRI_2026_11_06(3, 45))).toBe(true);
  });
  it("Fri 09:10 IST → NOT open (market opens at 09:15)", () => {
    expect(isMarketOpen(FRI_2026_11_06(3, 40))).toBe(false);
  });
  it("Fri 15:30 IST → open (at close)", () => {
    expect(isMarketOpen(FRI_2026_11_06(10, 0))).toBe(true);
  });
  it("Fri 15:31 IST → closed (after close)", () => {
    expect(isMarketOpen(FRI_2026_11_06(10, 1))).toBe(false);
  });
  it("Sat → closed", () => {
    expect(isMarketOpen(SAT_2026_11_07(10, 0))).toBe(false);
  });
  it("Sun → closed", () => {
    expect(isMarketOpen(SUN_2026_11_08(10, 0))).toBe(false);
  });
});

describe("isTelegramSendWindow", () => {
  it("Fri 09:05 IST → NOT in send window (before 09:10)", () => {
    expect(isTelegramSendWindow(FRI_2026_11_06(3, 35))).toBe(false);
  });
  it("Fri 09:10 IST → in send window", () => {
    expect(isTelegramSendWindow(FRI_2026_11_06(3, 40))).toBe(true);
  });
  it("Fri 15:30 IST → in send window (at close)", () => {
    expect(isTelegramSendWindow(FRI_2026_11_06(10, 0))).toBe(true);
  });
  it("Fri 15:31 IST → NOT in send window", () => {
    expect(isTelegramSendWindow(FRI_2026_11_06(10, 1))).toBe(false);
  });
  it("Sat → NOT in send window", () => {
    expect(isTelegramSendWindow(SAT_2026_11_07(10, 0))).toBe(false);
  });
  it("Sun 20:00 IST → NOT in send window", () => {
    expect(isTelegramSendWindow(SUN_2026_11_08(14, 30))).toBe(false);
  });
  it("Mon 08:00 IST → NOT in send window (before 09:10)", () => {
    expect(isTelegramSendWindow(MON_2026_11_09(2, 30))).toBe(false);
  });
});

describe("msUntilTelegramSendWindow", () => {
  it("Fri 09:05 IST → wait 5 min (300000 ms)", () => {
    const ms = msUntilTelegramSendWindow(FRI_2026_11_06(3, 35));
    expect(ms).toBe(5 * 60_000);
  });
  it("Fri 09:10 IST → wait 0 ms (already open)", () => {
    const ms = msUntilTelegramSendWindow(FRI_2026_11_06(3, 40));
    expect(ms).toBe(0);
  });
  it("Fri 15:31 IST → wait until Mon 09:10 IST", () => {
    // Fri 15:31 IST = UTC 10:01 Fri
    // Mon 09:10 IST = UTC 03:40 Mon
    // Fri 10:01 UTC → Sat 00:00 UTC = 13h59m = 50340000 ms
    // Sat 00:00 UTC → Mon 00:00 UTC = 2 days = 172800000 ms
    // Mon 00:00 UTC → Mon 03:40 UTC = 3h40m = 13200000 ms
    // Total ≈ 50340000 + 172800000 + 13200000 = 236340000 ms
    // But we step by minute, so it could be up to 1 min less
    const ms = msUntilTelegramSendWindow(FRI_2026_11_06(10, 1));
    // Fri 10:01 UTC → Mon 03:40 UTC = ~2 days 17h39m = ~236340000 ms
    const expectedMin = 236340000 - 60_000;
    const expectedMax = 236340000 + 60_000;
    expect(ms).toBeGreaterThan(expectedMin);
    expect(ms).toBeLessThan(expectedMax);
  });
  it("Sat → wait until Mon 09:10 IST", () => {
    const ms = msUntilTelegramSendWindow(SAT_2026_11_07(10, 0));
    // Sat 10:00 UTC → Mon 03:40 UTC = ~2 days 17h40m = ~150000000 ms
    const expectedMin = 150000000 - 60_000;
    const expectedMax = 150000000 + 60_000;
    expect(ms).toBeGreaterThan(expectedMin);
    expect(ms).toBeLessThan(expectedMax);
  });
  it("Sun 20:00 IST → wait until Mon 09:10 IST", () => {
    // Sun 20:00 IST = UTC 14:30 Sun
    // Mon 09:10 IST = UTC 03:40 Mon
    const ms = msUntilTelegramSendWindow(SUN_2026_11_08(14, 30));
    // Sun 14:30 UTC → Mon 03:40 UTC = ~13h10m = ~47400000 ms
    const expectedMin = 47400000 - 60_000;
    const expectedMax = 47400000 + 60_000;
    expect(ms).toBeGreaterThan(expectedMin);
    expect(ms).toBeLessThan(expectedMax);
  });
  it("Mon 08:00 IST → wait until 09:10 (70 min)", () => {
    const ms = msUntilTelegramSendWindow(MON_2026_11_09(2, 30));
    expect(ms).toBe(70 * 60_000);
  });
  it("Fri 23:50 UTC → Sat in IST → wait until Mon 09:10", () => {
    // Fri 23:50 UTC = Sat 05:20 IST (Nov 7)
    expect(isTradingDay(new Date(Date.UTC(2026, 10, 6, 23, 50, 0)))).toBe(false);
    const ms = msUntilTelegramSendWindow(new Date(Date.UTC(2026, 10, 6, 23, 50, 0)));
    // Fri 23:50 UTC → Mon 03:40 UTC = ~3 days 3h50m = ~186600000 ms
    const expectedMin = 186600000 - 60_000;
    const expectedMax = 186600000 + 60_000;
    expect(ms).toBeGreaterThan(expectedMin);
    expect(ms).toBeLessThan(expectedMax);
  });
});

describe("isTradingDay with holidays", () => {
  it("holiday Monday → not a trading day", () => {
    process.env.NSE_HOLIDAYS = "2026-11-09";
    // Mon 09:10 IST on holiday → not trading day
    expect(isTradingDay(MON_2026_11_09(3, 40))).toBe(false);
    expect(isMarketOpen(MON_2026_11_09(3, 40))).toBe(false);
    expect(isTelegramSendWindow(MON_2026_11_09(3, 40))).toBe(false);
  });
  it("holiday Monday → msUntilTelegramSendWindow skips to next day", () => {
    process.env.NSE_HOLIDAYS = "2026-11-09";
    // Fri 15:31 IST → normally Mon 09:10, but Mon is holiday → Tue 09:10
    const ms = msUntilTelegramSendWindow(FRI_2026_11_06(10, 1));
    // Fri 10:01 UTC → Tue 03:40 UTC = ~3 days 17h39m = ~322740000 ms
    const expectedMin = 322740000 - 60_000;
    const expectedMax = 322740000 + 60_000;
    expect(ms).toBeGreaterThan(expectedMin);
    expect(ms).toBeLessThan(expectedMax);
  });
});

describe("NSE_HOLIDAYS env parsing", () => {
  it("parses comma-separated dates", () => {
    process.env.NSE_HOLIDAYS = "2026-11-09, 2026-12-25,2027-01-26";
    expect(getNSEHolidays()).toEqual(["2026-11-09", "2026-12-25", "2027-01-26"]);
  });
  it("empty env → empty array", () => {
    delete process.env.NSE_HOLIDAYS;
    expect(getNSEHolidays()).toEqual([]);
  });
});