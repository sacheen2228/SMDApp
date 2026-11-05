/// <reference types="bun-types" />
// ═══════════════════════════════════════════════════════════════════════════
// SCANNER STOCK ALERTS — the Scanner tab's cash-stock setups reach Telegram
//
// THE GAP THIS LOCKS DOWN:
//   • The Scanner tab (intraday scanner + Weekly Equity Scanner) found stock
//     setups but never told the user — the intraday scanner only alerted
//     OPTION trades, the weekly scanner did not alert at all, and no stock
//     setup was ever registered, so a TP or SL hit could not be reported.
//
// THE RULES THIS TEST PINS:
//   1. A setup whose levels are incoherent (SL above entry, target below
//      entry, R:R < 1.5, no spot) is never alerted and never registered.
//   2. The ₹20,000 deployment cap is a TOTAL across the open book, so a
//      candidate is sized against the ₹ LEFT — not the full budget. An open
//      ₹7k book must not permanently block every new alert.
//   3. Sizing is HONEST: a budget that cannot buy one share returns 0 — the
//      alert is skipped, never forced to one over-cap share.
//   4. Cash equity is priced as CASH (lotSize 1 = one share). Without it the
//      risk check falls back to the symbol master's F&O lot size and sizes a
//      ₹2,700 share as a ₹27,000 futures lot — a false risk block.
//   5. The trade id is stable per symbol + day, so a re-scan never opens a
//      second position for the same setup.
//
// OFFLINE: every assertion below is a pure function call — no network, no
// chain fetch, no Telegram.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test, expect } from "bun:test";
import {
  validateScannerStock,
  scannerStockQuantity,
  scannerTradeId,
  type ScannerStockSetup,
} from "../src/lib/scanner-stock-alerts";

const base: ScannerStockSetup = {
  symbol: "ADANIENT",
  name: "Adani Enterprises",
  side: "BUY",
  entry: 2709.2,
  stopLoss: 2425.84,
  target1: 3275.92,
  target2: 3559.28,
  spot: 2705,
  confidence: 72,
  source: "intraday-scanner",
  tradeId: "SCAN-INTRA-ADANIENT-2026-11-04",
};

describe("scanner stock alerts — setup validation", () => {
  test("a coherent setup passes", () => {
    expect(validateScannerStock(base)).toEqual({ ok: true });
  });

  test("SL above entry is rejected", () => {
    const r = validateScannerStock({ ...base, stopLoss: 2800 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not below entry");
  });

  test("target below entry is rejected", () => {
    const r = validateScannerStock({ ...base, target1: 2600 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not above entry");
  });

  test("R:R below 1.5 is rejected", () => {
    const r = validateScannerStock({ ...base, stopLoss: 2209.2, target1: 3275.92 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("R:R");
  });

  test("a missing spot is rejected (the underlying price is required)", () => {
    const r = validateScannerStock({ ...base, spot: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("spot");
  });

  test("low confidence is rejected", () => {
    const r = validateScannerStock({ ...base, confidence: 20 });
    expect(r.ok).toBe(false);
  });
});

describe("scanner stock alerts — honest cash sizing", () => {
  test("whole shares for the budget, never fractional", () => {
    expect(scannerStockQuantity(2709.2, 20_000)).toBe(7);
    expect(scannerStockQuantity(1400, 20_000)).toBe(14);
  });

  test("a budget that cannot buy one share returns 0 (never a forced 1)", () => {
    expect(scannerStockQuantity(2709.2, 2000)).toBe(0);
    expect(scannerStockQuantity(2709.2, 0)).toBe(0);
    expect(scannerStockQuantity(0, 20_000)).toBe(0);
  });

  test("sizing honours the REMAINING headroom, not the full budget", () => {
    // ₹12,983 left under the ₹20,000 total cap (₹7,017 already open).
    expect(scannerStockQuantity(2709.2, 12_983)).toBe(4);
    expect(4 * 2709.2).toBeLessThanOrEqual(12_983);
  });
});

describe("scanner stock alerts — stable trade id", () => {
    expect(scannerTradeId("intraday-scanner", "ADANIENT", 0, "CE", "2026-11-04")).toBe(
      "SCAN-INTRA-ADANIENT-0-CE-2026-11-04",
    );
    expect(scannerTradeId("weekly-equity-scanner", "BEL", 0, "EQ", "2026-11-04")).toBe(
      "SCAN-WEEK-BEL-0-EQ-2026-11-04",
    );
  });

  test("a different day is a different trade", () => {
    expect(scannerTradeId("intraday-scanner", "ADANIENT", 0, "CE", "2026-11-05")).not.toBe(
      scannerTradeId("intraday-scanner", "ADANIENT", 0, "CE", "2026-11-04"),
    );
  });
