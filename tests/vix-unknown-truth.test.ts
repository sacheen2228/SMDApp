/// <reference types="bun-types" />
// An UNKNOWN VIX must be reported as unknown — never as a calm market.
//
// The old code wrote `vix || 15` (and a hardcoded `vix: 15`) so a missing
// India VIX was scored as a 15-volatility market: the gamma-blast detector
// read "low VIX" and the buyer-confluence gate read the "CALM" regime
// (sizeMultiplier 1.0, minScore 60) — i.e. a missing feed made the engine
// MORE permissive, not less.
//
// Rules locked down here:
//   • a missing VIX never produces a volatility number (no 15, no 0-volatility)
//   • the gamma-blast detector reports the VIX as unknown and fires no blast
//   • the recommendation marks the expected move as unavailable
//   • the confluence gate fails closed (WAIT) instead of scoring "calm"
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { scoreExpiryGammaTheta, runFullAnalysis } from "@/lib/sdm-engine";
import { generateTradeRecommendation } from "@/lib/sdm-recommendation";
import type { SDMOptionStrike, CandleData } from "@/types/sdm";

const ROOT = join(process.cwd(), "src/lib");

function mkStrike(strike: number): SDMOptionStrike {
  return {
    strike,
    ce: { ltp: 100, oi: 1_200_000, oiChg: 15_000, volume: 500_000, iv: 14.2, delta: 0.5, theta: -0.05, gamma: 0.02, vega: 0.1 },
    pe: { ltp: 95, oi: 950_000, oiChg: -8_000, volume: 480_000, iv: 14.8, delta: -0.48, theta: -0.05, gamma: 0.02, vega: 0.1 },
  };
}

function mkCandles(): CandleData[] {
  const now = Date.now();
  const bars: CandleData[] = [];
  let close = 22300;
  for (let i = 60; i > 0; i--) {
    const open = close;
    close = open + 12 + (i % 3) * 4;
    bars.push({
      time: now - i * 5 * 60_000,
      open, high: close + 6, low: open - 4, close,
      volume: 1_200_000 + i * 1000,
    } as CandleData);
  }
  return bars;
}

const chain: SDMOptionStrike[] = [];
for (let s = 22100; s <= 22700; s += 50) chain.push(mkStrike(s));

describe("source guards — the fake VIX defaults are gone", () => {
  // Comments are stripped: the files DOCUMENT the old fake values — only
  // executable code is scanned.
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const sdmEngine = stripComments(readFileSync(join(ROOT, "sdm-engine.ts"), "utf8"));
  const sdmRec = stripComments(readFileSync(join(ROOT, "sdm-recommendation.ts"), "utf8"));

  it("sdm-engine has no `vix || 15` and no hardcoded `vix: 15`", () => {
    expect(sdmEngine).not.toMatch(/vix\s*\|\|\s*15/);
    expect(sdmEngine).not.toMatch(/vix\s*:\s*15\b/);
  });

  it("sdm-recommendation has no `vix || 15`, no `vix ?? 15` and no `atmIV || 15`", () => {
    expect(sdmRec).not.toMatch(/vix\s*(\|\||\?\?)\s*15/);
    expect(sdmRec).not.toMatch(/atmIV:[^,\n]*\|\|\s*15/);
  });
});

describe("sdm-engine — the gamma-blast detector needs a REAL VIX", () => {
  // An expiry day in the DANGER window (14:00-15:30) so the blast check runs.
  const expiry = new Date();
  const expiryStr = `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, "0")}-${String(expiry.getDate()).padStart(2, "0")}`;
  const dangerTime = new Date(`${expiryStr}T14:30:00`);

  it("reports the VIX as unknown and fires NO blast when the VIX is missing", () => {
    const r = scoreExpiryGammaTheta(chain, 22400, dangerTime, expiryStr, undefined);
    expect(r.details).toContain("VIX_KNOWN:false");
    expect(r.details).toContain("VIX:N/A");
    expect(r.details).toContain('"lowVix":false');
    expect(r.details).toContain("BLAST:false");
  });

  it("still detects a LOW VIX when the real VIX is known", () => {
    const r = scoreExpiryGammaTheta(chain, 22400, dangerTime, expiryStr, 12);
    expect(r.details).toContain("VIX_KNOWN:true");
    expect(r.details).toContain("VIX:12.0");
    expect(r.details).toContain('"lowVix":true');
  });

  it("a zero VIX is unknown too (not a real 0-volatility market)", () => {
    const r = scoreExpiryGammaTheta(chain, 22400, dangerTime, expiryStr, 0);
    expect(r.details).toContain("VIX_KNOWN:false");
    expect(r.details).toContain('"lowVix":false');
  });
});

describe("sdm-engine — runFullAnalysis never invents a VIX", () => {
  it("the greeks block reports vix as unknown (null), not 15", () => {
    const a = runFullAnalysis(chain, 22400, "2099-01-01", "NIFTY");
    expect(a.greeks.vix).toBeNull();
    expect(a.greeks.vix).not.toBe(15);
  });
});

describe("sdm-recommendation — an unknown VIX is UNKNOWN", () => {
  const expiry = new Date(Date.now() + 3 * 86_400_000).toISOString().split("T")[0];

  it("a known VIX gives a real expected move", async () => {
    const rec = await generateTradeRecommendation(
      chain, 22421.95, "NIFTY", expiry, { "5m": mkCandles() }, 14.2, "TEST", new Date().toISOString(),
    );
    expect(rec.expectedMoveAvailable).toBe(true);
    expect(rec.expectedMove).toBeGreaterThan(0);
    expect(rec.marketContext.vix).toBe(14.2);
    expect(rec.marketContext.vixAvailable).toBe(true);
  }, 40_000);

  it("a missing VIX gives NO expected move and an explicit unavailable state", async () => {
    const rec = await generateTradeRecommendation(
      chain, 22421.95, "NIFTY", expiry, { "5m": mkCandles() }, null, "TEST", new Date().toISOString(),
    );
    expect(rec.expectedMoveAvailable).toBe(false);
    expect(rec.expectedMove).toBe(0);
    expect(rec.marketContext.vixAvailable).toBe(false);
    expect(rec.marketContext.vix).not.toBe(15);
    // fail closed — a missing VIX must never unlock a trade
    expect(rec.direction).toBe("WAIT");
    expect(rec.reason).toMatch(/VIX/i);
  }, 40_000);
});
