/// <reference types="bun-types" />
// Regression: Buyer Confluence Gate (sdm-recommendation.ts ~line 1074) referenced
// pcr/maxPain/spotPrice/atmIV OUT OF SCOPE (TDZ / undefined) — /api/sdm-signal
// crashed with "Cannot access 'pcr' before initialization" whenever direction
// resolved to CALL/PUT (session open + confidence above threshold).
// Bug was pre-existing and only surfaced when the gate actually executed.

import { describe, it, expect } from "bun:test";
import { generateTradeRecommendation } from "@/lib/sdm-recommendation";
import type { SDMOptionStrike, CandleData } from "@/types/sdm";

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
    close = open + 12 + (i % 3) * 4; // steady uptrend
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

describe("sdm-recommendation — buyer confluence gate scope fix", () => {
  it("does not crash with ReferenceError/TZD when direction is CALL", async () => {
    const expiry = new Date(Date.now() + 3 * 86_400_000).toISOString().split("T")[0];
    const rec = await generateTradeRecommendation(
      chain,
      22421.95,
      "NIFTY",
      expiry,
      { "5m": mkCandles() },
      14.2,
      "TEST",
      new Date().toISOString(),
      "CALL" // force the CALL branch so the confluence gate executes
    );
    expect(rec).toBeTruthy();
    expect(typeof rec.confidence).toBe("number");
    expect(rec.marketContext).toBeTruthy();
    // pcr + maxPain must be REAL computed values now in scope for the gate
    expect(rec.marketContext.pcr).toBeGreaterThan(0);
    expect(rec.marketContext.maxPain).toBeGreaterThan(0);
  }, 30_000);
});
