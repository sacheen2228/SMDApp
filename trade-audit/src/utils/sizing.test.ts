import { describe, expect, it } from "bun:test";
import {
  computeClosePnl,
  defaultQuantity,
  estimateFees,
} from "./sizing";

describe("computeClosePnl", () => {
  it("multiplies point P&L by quantity (NIFTY 1-lot win)", () => {
    const r = computeClosePnl({
      isLong: true,
      entryPrice: 137,
      exitPrice: 170,
      quantity: 65,
      fees: 0,
      stopLoss: 105,
    });
    expect(r.grossPnl).toBeCloseTo(33 * 65, 6); // 2145
    expect(r.netPnl).toBeCloseTo(2145, 6);
  });

  it("handles short-side P&L (PE bought is still long premium; bearish equity short)", () => {
    const r = computeClosePnl({
      isLong: false,
      entryPrice: 441,
      exitPrice: 430,
      quantity: 113, // ₹50k deployment
      fees: 0,
      stopLoss: 450,
    });
    expect(r.grossPnl).toBeCloseTo(11 * 113, 6);
  });

  it("keeps R-multiple size-independent", () => {
    const one = computeClosePnl({
      isLong: true, entryPrice: 137, exitPrice: 170, quantity: 1, fees: 0, stopLoss: 105,
    });
    const lot = computeClosePnl({
      isLong: true, entryPrice: 137, exitPrice: 170, quantity: 65, fees: 0, stopLoss: 105,
    });
    expect(one.rMultiple).toBeCloseTo(lot.rMultiple!,  6);
    expect(lot.rMultiple).toBeGreaterThan(1);
  });

  it("subtracts fees from net and uses invested capital for ROI", () => {
    const r = computeClosePnl({
      isLong: true, entryPrice: 8.4, exitPrice: 10.6, quantity: 65, fees: 40, stopLoss: 6.5,
    });
    expect(r.grossPnl).toBeCloseTo(2.2 * 65, 6); // 143
    expect(r.netPnl).toBeCloseTo(103, 6);
    expect(r.roiPct).toBeCloseTo((103 / (8.4 * 65)) * 100, 4);
  });

  it("guards against zero quantity / zero risk", () => {
    const r = computeClosePnl({
      isLong: true, entryPrice: 100, exitPrice: 110, quantity: 0, fees: 0, stopLoss: 100,
    });
    expect(r.grossPnl).toBeCloseTo(10, 6); // qty 0 → treated as 1
    expect(r.rMultiple).toBe(0); // zero risk
  });
});

describe("estimateFees", () => {
  it("is positive and scales with turnover", () => {
    const small = estimateFees(10, 12, 65);
    const big = estimateFees(1000, 1100, 65);
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small);
  });

  it("covers flat brokerage floor even on tiny trades", () => {
    expect(estimateFees(8, 8.5, 1)).toBeGreaterThanOrEqual(40);
  });
});

describe("defaultQuantity", () => {
  it("fits as many index-option lots as the ₹20k max budget allows", () => {
    // NIFTY @137 × 65 lot = ₹8,905 → 2 lots = 130 qty (2 lots = ₹17,810 ≤ 20k)
    expect(defaultQuantity("OPTIONS", "NIFTY", 137)).toBe(130);
    // NIFTY @8.4 × 65 = ₹546/lot → 36 lots = 2340 qty
    expect(defaultQuantity("OPTIONS", "NIFTY", 8.4)).toBe(65 * 36);
    // BANKNIFTY @200 × 30 = ₹6,000 → 3 lots = 90 qty
    expect(defaultQuantity("OPTIONS", "BANKNIFTY", 200)).toBe(90);
    // SENSEX @540 × 20 = ₹10,800 → 1 lot (2 lots = ₹21,600 > 20k)
    expect(defaultQuantity("OPTIONS", "SENSEX", 540)).toBe(20);
    expect(defaultQuantity("FUTURES", "NIFTY", 22500)).toBe(65);
  });

  it("applies the same budget to stock options (lot unknown → units)", () => {
    // RELIANCE @250 → floor(20000/250) = 80 units
    expect(defaultQuantity("OPTIONS", "RELIANCE", 250)).toBe(80);
    expect(defaultQuantity("OPTIONS", "TCS", 50)).toBe(400);
  });

  it("sizes equity by ₹20k budget", () => {
    expect(defaultQuantity("EQUITY", "WIPRO", 183)).toBe(109); // floor(20000/183)
    expect(defaultQuantity("EQUITY", "ULTRACEMCO", 11025)).toBe(1); // min 1
  });

  it("respects AUDIT_TRADE_BUDGET override", () => {
    process.env.AUDIT_TRADE_BUDGET = "40000";
    // NIFTY @137 × 65 = 8905 → 4 lots = 260
    expect(defaultQuantity("OPTIONS", "NIFTY", 137)).toBe(260);
    delete process.env.AUDIT_TRADE_BUDGET;
  });
});
