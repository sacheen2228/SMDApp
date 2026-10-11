/// <reference types="bun-types" />
// TDD for the DOM universe-scan gate: on a non-trading day NSE publishes no
// new equity OI, so scanning ~150 symbols would burn ~150 calls to re-read
// Friday's close. The scan must return [] immediately.

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Force the calendar to report a non-trading day BEFORE dom-analysis is
// imported, so its isTradingDay() call sees the stub.
const tradingDay = { value: false };
mock.module("@/lib/expiry-liquidity/market-session-config", () => ({
  isTradingDay: () => tradingDay.value,
  getTradingSession: () => "CLOSED",
  isWeekend: () => true,
  isHoliday: () => false,
}));

const { runDOMAnalysis } = await import("@/lib/dom-analysis");

describe("runDOMAnalysis trading-day gate", () => {
  beforeEach(() => { tradingDay.value = false; });

  test("returns [] immediately on a non-trading day", async () => {
    const t0 = Date.now();
    const out = await runDOMAnalysis();
    const elapsed = Date.now() - t0;

    expect(out).toEqual([]);
    // A real universe scan takes many seconds. If the gate were missing this
    // would hang until every provider timed out.
    expect(elapsed).toBeLessThan(1000);
  });

  test("honours an already-aborted signal without scanning", async () => {
    tradingDay.value = true; // force the code past the calendar gate
    const controller = new AbortController();
    controller.abort();

    const t0 = Date.now();
    const out = await runDOMAnalysis(controller.signal);
    const elapsed = Date.now() - t0;

    // Either the calendar gate or the abort check must stop it; both must be
    // fast, and neither may return partial fabricated rows.
    expect(Array.isArray(out)).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  });
});
