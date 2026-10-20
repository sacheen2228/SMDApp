import { describe, expect, it } from "bun:test";
import {
  computeClosePnl,
  defaultQuantity,
  estimateFees,
  inferPlanSide,
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

// ═══════════════════════════════════════════════════════════════════════
// PLAN GEOMETRY — the side comes from the levels, never from the letter.
//
// A bought PE can carry a MIRRORED (bearish) plan: stop ABOVE the entry,
// targets BELOW it. The old long-only P&L booked such a stop-out as a WIN
// (the app journal said −₹533 while the ledger said +₹533).
describe("computeClosePnl — the plan side is read from the geometry", () => {
  const MIRRORED_PE = { entryPrice: 41.05, stopLoss: 49.25, tp1: 24.65, quantity: 65 };

  it("infers the side from the stop vs the entry", () => {
    expect(inferPlanSide({ entryPrice: 41.05, stopLoss: 49.25 })).toBe("SHORT");
    expect(inferPlanSide({ entryPrice: 100, stopLoss: 90 })).toBe("LONG");
    // no usable stop → the target breaks the tie
    expect(inferPlanSide({ entryPrice: 100, stopLoss: 0, tp1: 130 })).toBe("LONG");
    expect(inferPlanSide({ entryPrice: 100, stopLoss: 0, tp1: 80 })).toBe("SHORT");
    // no usable levels at all → the caller's flag
    expect(inferPlanSide({ entryPrice: 100, isLong: false })).toBe("SHORT");
    expect(inferPlanSide({ entryPrice: 100, isLong: true })).toBe("LONG");
  });

  it("a mirrored PE stop-out is a LOSS, never a win", () => {
    const r = computeClosePnl({
      isLong: true, // the caller still believed "BUY = long"
      ...MIRRORED_PE,
      exitPrice: 49.25, // the stop
      fees: 0,
    });
    expect(r.side).toBe("SHORT");
    expect(r.grossPnl).toBeCloseTo(-8.2 * 65, 6); // −₹533
    expect(r.netPnl).toBeCloseTo(-8.2 * 65, 6);
    expect(r.netPnl).toBeLessThan(0);
    expect(r.rMultiple).toBeCloseTo(-1, 2);
  });

  it("a mirrored PE target hit is a GAIN", () => {
    const r = computeClosePnl({
      isLong: true,
      ...MIRRORED_PE,
      exitPrice: 24.65, // TP1
      fees: 0,
    });
    expect(r.side).toBe("SHORT");
    expect(r.grossPnl).toBeCloseTo(16.4 * 65, 6); // +₹1066
    expect(r.netPnl).toBeGreaterThan(0);
    expect(r.rMultiple).toBeCloseTo(2, 2);
  });

  it("a long-style PE (stop below, target above) keeps the long maths", () => {
    const r = computeClosePnl({
      isLong: true, entryPrice: 43.35, stopLoss: 36.85, tp1: 49.85,
      exitPrice: 36.85, quantity: 225, fees: 0,
    });
    expect(r.side).toBe("LONG");
    expect(r.grossPnl).toBeCloseTo(-6.5 * 225, 6);
  });

  it("an inverted plan can never book its stop-out as a win", () => {
    // entry 440.55, stop 67.59 (below), target 178.06 (below) — the ZERO_HERO
    // rows that were booked as a ₹24,242 "profit" on a stop-out.
    const r = computeClosePnl({
      isLong: false, entryPrice: 440.55, stopLoss: 67.59, tp1: 178.06,
      exitPrice: 67.59, quantity: 65, fees: 0,
    });
    expect(r.side).toBe("LONG");
    expect(r.grossPnl).toBeCloseTo((67.59 - 440.55) * 65, 6);
    expect(r.netPnl).toBeLessThan(0);
  });

  it("keeps the R-multiple size-independent on a mirrored plan", () => {
    const one = computeClosePnl({
      isLong: true, ...MIRRORED_PE, exitPrice: 24.65, quantity: 1, fees: 0,
    });
    const lot = computeClosePnl({
      isLong: true, ...MIRRORED_PE, exitPrice: 24.65, quantity: 65, fees: 0,
    });
    expect(one.rMultiple).toBeCloseTo(lot.rMultiple!, 6);
    expect(lot.rMultiple).toBeCloseTo(2, 2);
  });

  it("an explicit side wins over the geometry", () => {
    const r = computeClosePnl({
      side: "SHORT", entryPrice: 100, stopLoss: 90, tp1: 130,
      exitPrice: 110, quantity: 1, fees: 0,
    });
    expect(r.side).toBe("SHORT");
    expect(r.grossPnl).toBeCloseTo(-10, 6);
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
