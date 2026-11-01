import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

// CRITICAL isolation test for the UNIVERSAL_QUANT_V1 namespace:
// the quant engine must stay a pure paper-trading engine — no broker order
// placement, no other engine's senders, no deprecated chain fetchers, no
// randomness outside the id helper, and never an option-SELL direction.

const QUANT_DIR = join(process.cwd(), "src", "lib", "quant");

function quantFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts")) out.push(p);
    }
  };
  walk(QUANT_DIR);
  return out;
}

const rel = (p: string) => p.replace(process.cwd() + "/", "");

/** Strip // and /* *​/ comments so scans judge CODE, not prose. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("quant isolation — forbidden imports/calls", () => {
  const files = quantFiles();

  test("namespace is non-empty (guard so this test cannot silently pass)", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  test("no broker order placement: no icici-breeze/orders import, no placeOrder anywhere", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/icici-breeze\/orders/);
      expect(src).not.toContain("placeOrder");
      expect(src).not.toContain("place_option_order");
      expect(src).not.toContain("getOrderMargin");
      expect(src).not.toContain("modifyOrder");
      expect(src).not.toContain("cancelOrder");
    }
  });

  test("no sendTradeAlert import (telegram senders stay outside the engine)", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/sendTradeAlert/);
      expect(src).not.toMatch(/from\s+["']@?\/?lib\/telegram["']/);
      expect(src).not.toMatch(/from\s+["']@?\/?lib\/telegramSend["']/);
    }
  });

  test("no fetchLiveOptionChain import (deprecated fake generator)", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toContain("fetchLiveOptionChain");
      expect(src).not.toContain("option-chain-data");
    }
  });

  test("no Yahoo anywhere", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src.toLowerCase()).not.toContain("yahoo");
    }
  });

  test("Math.random appears ONLY inside qid() in quant-types.ts", () => {
    const offenders = files.filter((f) => code(readFileSync(f, "utf8")).includes("Math.random("));
    expect(offenders.map(rel)).toEqual(["src/lib/quant/quant-types.ts"]);
    // and inside that file it is inside the qid helper only
    const src = code(readFileSync(join(QUANT_DIR, "quant-types.ts"), "utf8"));
    const qidIdx = src.indexOf("export function qid");
    expect(qidIdx).toBeGreaterThan(-1);
    for (const m of src.matchAll(/Math\.random\(/g)) {
      expect(m.index!).toBeGreaterThan(qidIdx);
      expect(m.index! - qidIdx).toBeLessThan(400); // within the helper body
    }
  });

  test("SELL_CE/SELL_PE never appear as an eligible direction (rejection strings only)", () => {
    // After stripping comments, no quant file may contain these literals at
    // all: the direction union is BUY_CE|BUY_PE|BUY|SELL and no evaluator,
    // selector or rejection string ever produces an option SELL.
    const filesWithType = files.filter((f) => {
      const src = code(readFileSync(f, "utf8"));
      return src.includes("SELL_CE") || src.includes("SELL_PE");
    });
    expect(filesWithType.map(rel)).toEqual([]);

    // The strategy selector must never emit a SELL direction: scan its output
    // space by running the evaluators over a broad regime × feature matrix.
    const ctx = require(join(process.cwd(), "src/lib/quant/quant-strategy-selector.ts"));
    const base = {
      close: 100, vwap: 100, vwapDevPct: 0, ema9: 100, ema20: 100, ema50: 100,
      atr14: 1, realizedVol: 10, sessionHigh: 101, sessionLow: 99,
      prevDayHigh: 104, prevDayLow: 96, prevDayClose: 100,
      openRangeHigh: 100.5, openRangeLow: 99.5, rangeCompression: 0.5,
      volumeExpansion: 1.0, trendScore: 0.2, gapPct: 0, expectedMovePct: 0.8,
      vix: 14, candleCount: 60, lastCandleTs: null,
    };
    const variants = [
      base,
      { ...base, trendScore: -0.9, volumeExpansion: 3, vwapDevPct: -2 },
      { ...base, trendScore: 0.9, volumeExpansion: 0.2, vwapDevPct: 2.5 },
      { ...base, trendScore: null, vwapDevPct: null },
    ];
    const regimes = [
      "TRENDING_UP", "TRENDING_DOWN", "RANGE_BOUND", "HIGH_VOLATILITY",
      "LOW_VOLATILITY", "BREAKOUT", "EXPIRY_VOLATILE", "UNCERTAIN",
    ];
    for (const regime of regimes) {
      for (const f of variants) {
        for (const isExpiryDay of [true, false]) {
          for (const s of ctx.evaluateStrategies(f, { regime, confidence: 50, measurements: {}, reasons: [] }, { isExpiryDay, symbol: "NIFTY" })) {
            expect(["BUY_CE", "BUY_PE"]).toContain(s.direction);
          }
        }
      }
    }
  });

  test("quant files never import from another engine's internals", () => {
    const forbidden = [
      "sdm-engine", "sdm-recommendation", "agent-brain", "signal-veto",
      "master-bot-engine", "btst-scanner", "zero-hero", "zeroHero",
      "smart-money", "intraday-scanner", "morningSignalGenerator",
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const frag of forbidden) expect(src).not.toContain(frag);
    }
  });

  test("deterministic purity: quant pure modules never call Date.now()/new Date()", () => {
    // Pure modules (regime, features, strategy selector, signal engine,
    // strike selector, risk manager, paper execution) must take ts/nowMs
    // parameters instead of reading the clock.
    const pureModules = [
      "quant-market-regime.ts",
      "quant-features.ts",
      "quant-strategy-selector.ts",
      "quant-signal-engine.ts",
      "quant-risk-manager.ts",
      "quant-paper-execution.ts",
    ];
    for (const name of pureModules) {
      const src = code(readFileSync(join(QUANT_DIR, name), "utf8"));
      expect(src).not.toContain("Date.now()");
      expect(src).not.toContain("new Date(");
    }
  });
});
