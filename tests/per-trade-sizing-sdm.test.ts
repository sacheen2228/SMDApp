/// <reference types="bun-types" />
// THE PER-TRADE MODEL — the sizing the live dashboard shows.
//
// The P0: /api/sdm-signal returned positionSizing {lots: 0} because the
// recommendation engine sized on "₹1,00,000 × 1% risk" (and a "5% of capital"
// notional cap) while the account is ₹25,000 and the rule is
// "risk = 20% of the amount DEPLOYED, ≤ ₹20,000 deployed per trade".
//
// This test drives the REAL engine (sdm-recommendation.ts) with a synthetic
// NIFTY chain — no network, no DB.

import { describe, test, expect } from "bun:test";
import {
  generateTradeRecommendation,
  buildHouseLevels,
  houseRR,
} from "@/lib/sdm-recommendation";
import { positionSize, GATE_CONFIG } from "@/lib/agent-brain-gate";
import { buildOptionPlan } from "@/lib/option-plan";
import type { SDMOptionStrike } from "@/types/sdm";

// ── A synthetic NIFTY chain around spot 22,900 (ATM premium ₹169.90) ──
const ATM_STRIKE = 22900;
const SPOT = 22888.95;
const ATM_PREMIUM = 169.9;
const NIFTY_LOT = 65; // the real NIFTY lot (symbol-config)

function makeChain(atmPremium: number = ATM_PREMIUM): SDMOptionStrike[] {
  const rows: SDMOptionStrike[] = [];
  for (let i = -10; i <= 10; i++) {
    const strike = ATM_STRIKE + i * 50;
    const d = Math.abs(strike - ATM_STRIKE) / 50;
    const ce = Math.max(2, atmPremium - d * 45);
    const pe = Math.max(2, atmPremium + d * 40);
    rows.push({
      strike,
      ce: {
        ltp: ce, bid: ce - 0.05, ask: ce + 0.05,
        oi: Math.max(20000, 120000 - d * 9000), oiChg: 15000, volume: 250000, iv: 13.5,
        delta: Math.max(0.02, Math.min(0.98, 0.55 - d * 0.05)),
        theta: -12, gamma: 0.0011, vega: 60,
      },
      pe: {
        ltp: pe, bid: pe - 0.05, ask: pe + 0.05,
        oi: Math.max(30000, 180000 - d * 12000), oiChg: 12000, volume: 230000, iv: 14.5,
        delta: Math.max(0.02, Math.min(0.98, 0.5 + d * 0.05)),
        theta: -11, gamma: 0.001, vega: 58,
      },
    });
  }
  return rows;
}

/** A steady uptrend so the quality score clears the gate (grade ≥ C). */
function makeCandles(n = 60): any[] {
  const out: any[] = [];
  let price = SPOT - 120;
  for (let i = 0; i < n; i++) {
    price += 2.2;
    out.push({
      time: Date.now() - (n - i) * 300_000,
      open: price - 1.5, high: price + 3, low: price - 3, close: price,
      volume: 120_000 + (i % 7) * 9000,
    });
  }
  return out;
}

describe("per-trade model — the house plan", () => {
  test("the stop is a rupee risk (20% of the deployed amount) and the targets are 2R/3R/4R", () => {
    const levels = buildHouseLevels({
      entry: 169.9,
      isCall: true,
      symbol: "NIFTY",
      lotSize: NIFTY_LOT,
    });
    expect(levels.error).toBe("");
    expect(levels.plan).not.toBeNull();

    const plan = levels.plan!;
    // FIXED ₹2,000 risk cap (20% of ₹11,043 deployed would be ₹2,209) → /65 units
    expect(plan.riskPoints).toBeCloseTo(2_000 / NIFTY_LOT, 1);
    expect(plan.riskAmount).toBeCloseTo(2_000, 0);
    expect(plan.stopLoss).toBeCloseTo(169.9 - plan.riskPoints, 1);
    // the ladder: TP1 2R, TP2 3R, TP3 4R
    expect(plan.targets[0]).toBeCloseTo(169.9 + 2 * plan.riskPoints, 1);
    expect(plan.targets[1]).toBeCloseTo(169.9 + 3 * plan.riskPoints, 1);
    expect(plan.targets[2]).toBeCloseTo(169.9 + 4 * plan.riskPoints, 1);
    expect(plan.rr).toBeCloseTo(2, 2);
    expect(houseRR(169.9, true)).toBeCloseTo(2, 5);
  });

  test("the deployed amount never exceeds the ₹20,000 per-trade cap", () => {
    const plan = buildOptionPlan({
      symbol: "NIFTY",
      optionType: "CE",
      entryPremium: 169.9,
      lotSize: NIFTY_LOT,
    })!;
    expect(plan.deployed).toBeLessThanOrEqual(GATE_CONFIG.tradeBudget);
    expect(plan.lots).toBe(1);            // ₹11,043 per lot → 1 lot fits, 2 do not
    expect(plan.deployed).toBeCloseTo(169.9 * NIFTY_LOT, 0);
  });
});

describe("per-trade model — the /api/sdm-signal sizing", () => {
  test("the recommendation sizes 1 lot with the REAL rupee risk (not 0 lots)", async () => {
    const chain = makeChain();
    const expiry = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
    const rec = await generateTradeRecommendation(
      chain,
      SPOT,
      "NIFTY",
      expiry,
      { "5m": makeCandles() },
      14.7,
      "test",
      new Date().toISOString(),
    );

    expect(rec.positionSizing.lots).toBe(1);
    expect(rec.positionSizing.quantity).toBe(NIFTY_LOT);
    // the rupee risk = the FIXED ₹2,000 cap (20% of one lot would be ₹2,209);
    // the stop is rounded to the ₹0.05 tick grid, so the risk moves by ≤ 1 tick
    expect(rec.positionSizing.riskAmount).toBeGreaterThan(2_000 - 70);
    expect(rec.positionSizing.riskAmount).toBeLessThan(2_000 + 70);
    expect(rec.positionSizing.maxLoss).toBeCloseTo(rec.positionSizing.riskAmount, 0);
    // the deployment stays inside the per-trade cap
    expect(rec.positionSizing.positionValue).toBeLessThanOrEqual(GATE_CONFIG.tradeBudget);
    // and the levels are the house ladder (2R / 3R / 4R of the rupee-risk stop)
    const r = rec.positionSizing.riskAmount / NIFTY_LOT;
    expect(rec.sl).toBeCloseTo(ATM_PREMIUM - r, 0);
    expect(rec.tp1).toBeCloseTo(ATM_PREMIUM + 2 * r, 0);
    expect(rec.tp2).toBeCloseTo(ATM_PREMIUM + 3 * r, 0);
    expect(rec.tp3).toBeCloseTo(ATM_PREMIUM + 4 * r, 0);
  });

  test("the sizing never exceeds the per-trade cap, whatever the premium", async () => {
    // A cheap contract: 1 lot fits many times over — the cap still holds.
    const chain = makeChain(20);
    const expiry = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
    const rec = await generateTradeRecommendation(
      chain, SPOT, "NIFTY", expiry, { "5m": makeCandles() }, 14.7, "test", new Date().toISOString(),
    );
    expect(rec.positionSizing.positionValue).toBeLessThanOrEqual(GATE_CONFIG.tradeBudget);
    expect(rec.positionSizing.riskAmount).toBeLessThanOrEqual(GATE_CONFIG.tradeBudget * 0.2 + 1);
  });
});

describe("per-trade model — positionSize() is the only sizing model", () => {
  test("lots = min(risk-limited, affordable from the deployment cap)", () => {
    // 1 NIFTY lot at ₹100 with a 20% stop (₹20 risk/lot = ₹1,300 per lot)
    const ps = positionSize({
      capital: GATE_CONFIG.capital,
      entry: 100,
      sl: 80,
      lotSize: NIFTY_LOT,
    });
    // risk budget = FIXED ₹2,000 → 1 lot by risk; affordable = 3 lots
    expect(ps.lots).toBe(1);
    expect(ps.qty).toBe(NIFTY_LOT);
    expect(ps.maxLoss).toBeCloseTo(1300, 0);
    expect(ps.capitalRequired).toBeCloseTo(100 * NIFTY_LOT, 0);
  });

  test("an unaffordable contract is 0 lots — never a 1-lot trade", () => {
    const ps = positionSize({
      capital: GATE_CONFIG.capital,
      entry: 300,
      sl: 280,                            // ₹1,300 risk/lot → inside the ₹2,000 cap
      lotSize: NIFTY_LOT,
    });
    expect(ps.lots).toBe(1);              // ₹19,500 per lot → exactly 1 lot fits
    const ps2 = positionSize({
      capital: GATE_CONFIG.capital,
      entry: 400,
      sl: 320,
      lotSize: NIFTY_LOT,
    });
    expect(ps2.lots).toBe(0);             // ₹26,000 per lot → over the cap
    expect(ps2.ok).toBe(false);
  });
});
