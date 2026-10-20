/// <reference types="bun-types" />
// A wrong lot size silently inflates EVERY ₹ amount.
//
// src/lib/symbol-config.ts now carries the REAL NSE F&O lot table (~200
// symbols) and getLotSize() answers ONE unit for a symbol it does not know
// (never NIFTY's 65). The consumers still had `getLotSize(x) || 65` /
// `?? 65` / `|| 50` tails — dead code today, but a landmine: the moment
// getLotSize() starts answering 0 (or a caller copies the pattern), a stock
// option's ₹ P&L is computed with NIFTY's lot (4-11× wrong for SBIN).
//
// The rule: the REAL lot when it is known; when it is UNKNOWN either fail
// closed (no ₹ amount at all) or use an explicitly-labelled 1-unit amount.
// Never a guessed 65.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { getLotSize, getLotSizeStrict, hasKnownLotSize } from "@/lib/symbol-config";

const ROOT = process.cwd();

/** The consumers that size a ₹ amount. */
const LOT_CONSUMERS = [
  "src/lib/sdm-backtest.ts",
  "src/lib/backtest-audit.ts",
  "src/lib/agent-engine.ts",
  "src/lib/backtest-engine.ts",
  "src/app/api/trades/today/route.ts",
  "src/lib/sdm-recommendation.ts",
  "src/lib/expiry-calculator.ts",
  "src/lib/sdm-engine.ts",
  "src/lib/intraday-scanner.ts",
];

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("no consumer guesses a lot size", () => {
  for (const file of LOT_CONSUMERS) {
    it(`${file} has no guessed-lot fallback`, () => {
      const src = stripComments(readFileSync(join(ROOT, file), "utf8"));
      // getLotSize(x) || 65 / ?? 65 / || 50
      expect(src).not.toMatch(/getLotSize\([^)]*\)\s*(\|\||\?\?)\s*(65|50|100)\b/);
      // a hardcoded NIFTY lot in a lotSize field
      expect(src).not.toMatch(/lotSize\s*[:=]\s*(65|50)\b/);
      expect(src).not.toMatch(/lot_size\s*[:=]\s*(65|50)\b/);
    });
  }
});

describe("the strict lookup is the one that is used", () => {
  it("a known symbol answers with its real lot", () => {
    expect(getLotSizeStrict("SBIN")).toBe(750);
    expect(getLotSizeStrict("NIFTY")).toBe(65);
    expect(hasKnownLotSize("SBIN")).toBe(true);
  });

  it("an unknown symbol fails closed (null), never 65", () => {
    expect(getLotSizeStrict("NOT_A_REAL_SYMBOL")).toBeNull();
    expect(getLotSize("NOT_A_REAL_SYMBOL")).toBe(1); // the honest per-unit amount
    expect(getLotSize("NOT_A_REAL_SYMBOL")).not.toBe(65);
  });
});

describe("sdm-backtest — the trade P&L needs a REAL lot", () => {
  it("a known lot produces the ₹ P&L", async () => {
    const { computeTradePnl } = await import("@/lib/sdm-backtest");
    expect(computeTradePnl(110, 100, 65)).toBe(650);
    expect(computeTradePnl(90, 100, 65)).toBe(-650);
  });

  it("an UNKNOWN lot produces NO ₹ amount (fail closed)", async () => {
    const { computeTradePnl } = await import("@/lib/sdm-backtest");
    expect(computeTradePnl(110, 100, null)).toBeNull();
    expect(computeTradePnl(90, 100, null)).toBeNull();
  });
});

describe("backtest-engine — the trade P&L needs a REAL lot", () => {
  it("a known lot produces the ₹ P&L, an unknown one produces none", async () => {
    const { computeTradePnl } = await import("@/lib/backtest-engine");
    expect(computeTradePnl(110, 100, 65)).toBe(650);
    expect(computeTradePnl(110, 100, null)).toBeNull();
  });
});

describe("the recommendation labels an unknown lot", () => {
  it("the SDM recommendation says the lot size is unknown", async () => {
    const src = readFileSync(join(ROOT, "src/lib/sdm-recommendation.ts"), "utf8");
    expect(src).toContain("lotSizeKnown");
  });
});
