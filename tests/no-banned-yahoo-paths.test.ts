/// <reference types="bun-types" />
// Yahoo is BANNED by the data policy (AGENTS.md): every price in this app
// must come from the exchange (NSE/BSE), the broker (Breeze/Motilal) or the
// chain's own records — never from a third-party aggregator.
//
// The last two data paths (historical-data.ts, trade-backtest-engine.ts) and
// the provider registry still carried it:
//
//   • historical-data.ts   → Breeze → YAHOO daily candles
//   • trade-backtest-engine → YAHOO candles for the spot replay
//   • market-data-manager  → a "yahoo" provider in the fallback tree
//   • api-freshness.ts     → a "yahoo-finance" reliability score
//   • agent-brain.ts       → a Yahoo probe in diagnose_data_source
//   • option-chain/route.ts→ a Yahoo daily-candle fallback (daily bars in a
//                             5-minute array — a timeframe substitution)
//
// These tests lock the removal down.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();

/** Comments are stripped: the files DOCUMENT the ban (and the old paths). */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const DATA_PATHS = [
  "src/lib/historical-data.ts",
  "src/lib/trade-backtest-engine.ts",
  "src/lib/market-data-manager.ts",
  "src/lib/api-freshness.ts",
  "src/lib/agent-brain.ts",
  "src/lib/trade-validator.ts",
  "src/app/api/option-chain/route.ts",
];

describe("Yahoo is out of every data path", () => {
  for (const file of DATA_PATHS) {
    it(`${file} never calls Yahoo`, () => {
      const src = stripComments(readFileSync(join(ROOT, file), "utf8"));
      expect(src).not.toMatch(/finance\.yahoo\.com/);
      expect(src).not.toMatch(/query1\.finance/);
      expect(src).not.toMatch(/yahoo-finance/);
    });
  }

  it("the provider tree has NO yahoo entry", () => {
    const src = stripComments(readFileSync(join(ROOT, "src/lib/market-data-manager.ts"), "utf8"));
    // the priority lists
    expect(src).not.toMatch(/PROVIDER_PRIORITY[^=]*=[^;]*yahoo/);
    expect(src).not.toMatch(/MCX_PROVIDER_PRIORITY[^=]*=[^;]*yahoo/);
    // the provider switch
    expect(src).not.toMatch(/case\s+"yahoo"/);
  });

  it("the agent never probes Yahoo", () => {
    const src = stripComments(readFileSync(join(ROOT, "src/lib/agent-brain.ts"), "utf8"));
    expect(src).not.toMatch(/finance\.yahoo\.com/);
    expect(src).not.toMatch(/yahoo/);
  });

  it("the option chain route has no Yahoo candle fallback", () => {
    const src = stripComments(readFileSync(join(ROOT, "src/app/api/option-chain/route.ts"), "utf8"));
    expect(src).not.toMatch(/yahoo/i);
  });
});

describe("the free NSE sources replaced Yahoo", () => {
  it("historical-data falls back to the exchange's own DAILY history", () => {
    const src = readFileSync(join(ROOT, "src/lib/historical-data.ts"), "utf8");
    expect(src).toContain("getNSEHistoricalData");
    // a daily series is never served for an intraday request
    expect(src).toContain("DAILY_INTERVALS");
  });

  it("the trade backtest replays the exchange's own daily history", () => {
    const src = readFileSync(join(ROOT, "src/lib/trade-backtest-engine.ts"), "utf8");
    expect(src).toContain("getNSEHistoricalData");
    expect(src).toContain("fetchBreezeIntradayCandles");
  });
});
