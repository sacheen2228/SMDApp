/// <reference types="bun-types" />
// ═══════════════════════════════════════════════════════════════════════════
// marketHours must agree with the CANONICAL NSE holiday calendar.
//
// `src/lib/expiry-calculator.ts` `NSE_HOLIDAYS` is the single source of truth
// (AGENTS.md: "Holiday calendar consolidated"). marketHours kept a second,
// env-driven copy — `NSE_HOLIDAYS` is not set in .env, so that list was ALWAYS
// EMPTY and `isTradingDay()` returned true on real holidays.
//
// Blast radius: `sdm-chain-scanner.isMarketOpen()` kept ticking on holidays
// and `isTelegramSendWindow()` kept opening — while `getCurrentSession()`
// (which imports the canonical set) correctly reported "Non-trading day".
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  isTradingDay,
  isMarketOpen,
  isTelegramSendWindow,
  getNSEHolidays,
} from "@/lib/marketHours";
import { NSE_HOLIDAYS as CANONICAL } from "@/lib/expiry-calculator";

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

describe("marketHours honours the canonical NSE holiday calendar", () => {
  it("2026-11-24 is a real NSE holiday in the canonical set", () => {
    // Tuesday — the Oct/Nov-2026 monthly expiry was published as 23-Nov
    // because the 24th is a holiday.
    expect(CANONICAL.has("2026-11-24")).toBe(true);
  });

  it("a canonical holiday is NOT a trading day with no env var set", () => {
    // env is deleted above — the old code returned true here.
    const holiday = new Date(Date.UTC(2026, 10, 24, 6, 0, 0)); // 11:30 IST
    expect(isTradingDay(holiday)).toBe(false);
    expect(isMarketOpen(holiday)).toBe(false);
    expect(isTelegramSendWindow(holiday)).toBe(false);
  });

  it("the other canonical Nov-2026 holiday (Diwali-Balipratipada) is closed too", () => {
    const holiday = new Date(Date.UTC(2026, 10, 10, 6, 0, 0)); // 2026-11-10
    expect(isTradingDay(holiday)).toBe(false);
  });

  it("a plain weekday next to a holiday is still a trading day", () => {
    const day = new Date(Date.UTC(2026, 10, 25, 6, 0, 0)); // Wed 2026-11-25
    expect(isTradingDay(day)).toBe(true);
  });

  it("env-supplied holidays still apply (supplemental, not a replacement)", () => {
    process.env.NSE_HOLIDAYS = "2026-11-09";
    expect(isTradingDay(new Date(Date.UTC(2026, 10, 9, 3, 40, 0)))).toBe(false);
  });

  it("getNSEHolidays keeps parsing the env list for its own callers", () => {
    process.env.NSE_HOLIDAYS = "2026-11-09, 2026-12-25";
    expect(getNSEHolidays()).toEqual(["2026-11-09", "2026-12-25"]);
  });
});
