// tests/symbol-config-lot-sizes.test.ts
// The lot-size fallback must NEVER guess. It used to return the NIFTY config
// (lot 65) for EVERY unknown symbol, so every STOCK option's ₹ amounts were
// computed with NIFTY's lot while the real lots are 15 (SBIN, old) / 750
// (SBIN, current NSE F&O contract) — the "%" of the trade was right, the ₹ was
// 4-11× wrong.
//
// The real NSE F&O lots (NewBrdLotQty, NSE F&O bhavcopy 19-Oct-2026) now live
// in symbol-config; a symbol we still do not know answers "unknown" (0 /
// null / one unit) and NEVER 65.
import { describe, test, expect } from "bun:test";
import {
  getSymbolConfig,
  getLotSize,
  getLotSizeStrict,
  hasKnownLotSize,
  setKnownLotSize,
  getKnownLotSizes,
  SYMBOL_CONFIGS,
  NSE_FO_LOT_SIZES,
  UNKNOWN_LOT_SIZE,
} from "@/lib/symbol-config";

describe("symbol-config — a known symbol answers with its REAL lot size", () => {
  test("the index lots are unchanged", () => {
    expect(getLotSize("NIFTY")).toBe(65);
    expect(getLotSize("BANKNIFTY")).toBe(30);
    expect(getLotSize("FINNIFTY")).toBe(60);
    expect(getLotSize("MIDCPNIFTY")).toBe(120);
    expect(getLotSize("SENSEX")).toBe(20);
    expect(getLotSize("BANKEX")).toBe(30);
    expect(getLotSize("NIFTYNXT50")).toBe(25);
  });

  test("a stock option answers with its NSE F&O lot, not NIFTY's 65", () => {
    expect(getLotSize("SBIN")).toBe(750);
    expect(getLotSize("TCS")).toBe(225);
    expect(getLotSize("TECHM")).toBe(600);
    expect(getLotSize("HINDALCO")).toBe(700);
    expect(getLotSize("BHARTIARTL")).toBe(475);
    expect(getLotSize("RELIANCE")).toBe(500);
  });

  test("the symbol is matched case-insensitively", () => {
    expect(getLotSize("sbin")).toBe(750);
    expect(getLotSize(" nifty ")).toBe(65);
  });

  test("a known stock is in SYMBOL_CONFIGS with its lot size", () => {
    expect(SYMBOL_CONFIGS.SBIN.lotSize).toBe(750);
    expect(SYMBOL_CONFIGS.SBIN.lotSizeKnown).toBe(true);
    expect(NSE_FO_LOT_SIZES.SBIN).toBe(750);
  });
});

describe("symbol-config — an unknown symbol NEVER inherits NIFTY's lot", () => {
  test("the config says the lot size is unknown (0), not 65", () => {
    const cfg = getSymbolConfig("NOT_A_REAL_SYMBOL");
    expect(cfg.lotSize).toBe(UNKNOWN_LOT_SIZE);
    expect(cfg.lotSize).toBe(0);
    expect(cfg.lotSize).not.toBe(65);
    expect(cfg.lotSizeKnown).toBe(false);
    expect(cfg.symbol).toBe("NOT_A_REAL_SYMBOL");
    expect(cfg.label).not.toBe("NIFTY 50");
  });

  test("the strict accessor fails closed (null)", () => {
    expect(getLotSizeStrict("NOT_A_REAL_SYMBOL")).toBeNull();
    expect(hasKnownLotSize("NOT_A_REAL_SYMBOL")).toBe(false);
    expect(getLotSizeStrict("SBIN")).toBe(750);
    expect(hasKnownLotSize("SBIN")).toBe(true);
  });

  test("the lenient accessor can never become 65 — not even through `|| 65`", () => {
    // This is the pattern the app's consumers use. With the old fallback the
    // `|| 65` never fired and every stock got a NIFTY-sized position.
    expect(getLotSize("SBIN") || 65).toBe(750);
    expect(getLotSize("NOT_A_REAL_SYMBOL") || 65).not.toBe(65);
    expect(getLotSize("NOT_A_REAL_SYMBOL")).toBe(1); // one unit → per-unit amount
  });

  test("the NIFTY fallback is gone for every kind of unknown input", () => {
    for (const sym of ["", "   ", "SBINX", "RELIANC", "nope"]) {
      expect(getSymbolConfig(sym).lotSize).not.toBe(65);
      expect(getSymbolConfig(sym).lotSize).toBe(0);
    }
  });
});

describe("symbol-config — a live-resolved lot can be injected", () => {
  test("setKnownLotSize registers a real lot for a symbol we did not know", () => {
    expect(getLotSize("MYSTOCK")).toBe(1);
    setKnownLotSize("MYSTOCK", 42);
    expect(getLotSize("MYSTOCK")).toBe(42);
    expect(getLotSizeStrict("MYSTOCK")).toBe(42);
    expect(getSymbolConfig("MYSTOCK").lotSizeKnown).toBe(true);
    expect(getKnownLotSizes().MYSTOCK).toBe(42);
  });

  test("an invalid lot is ignored (never registered as 0 or a negative)", () => {
    setKnownLotSize("BADLOT", 0);
    setKnownLotSize("BADLOT", -5);
    expect(getKnownLotSizes().BADLOT).toBeUndefined();
    expect(getLotSizeStrict("BADLOT")).toBeNull();
  });
});
