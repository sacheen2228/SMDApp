// ═══════════════════════════════════════════════════════════════════════════
// HERMES PAPER WORKER — the same side-aware geometry as the live monitors.
//
// Live payload (20-Oct-2026): TCS 2460 PE @ ₹41.05, SL ₹49.25, T1 ₹24.65.
// A mirrored bearish plan has its stop ABOVE the entry and its targets BELOW.
// The paper worker used a long-only test (price <= stop) → a false SL at the
// entry, and long-only TP2/TP3 → a mirrored PE could never reach its 2nd/3rd
// target.  It also closed a stopped-out trade at `highestPremium` (the MFE),
// so the journal showed a stop-out as a profit.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "bun:test";
import { detectPaperHit, paperExitPrice, paperPnlPoints } from "@/lib/hermes/paper-worker";

const PE_TRADE: any = {
  signalId: "ps-test-pe", underlying: "TCS", decision: "BUY_PE", optionType: "PE",
  strike: 2460, entryPrice: 41.05, stopLoss: 49.25,
  target1: 24.65, target2: 16.4, target3: 8.2,
  quantity: 1, status: "OPEN", highestPremium: 41.05, lowestPremium: 41.05,
};

const CE_TRADE: any = {
  signalId: "ps-test-ce", underlying: "ULTRACEMCO", decision: "BUY_CE", optionType: "CE",
  strike: 10600, entryPrice: 164.9, stopLoss: 131.9,
  target1: 230.85, target2: 263.85, target3: 296.8,
  quantity: 1, status: "OPEN", highestPremium: 164.9, lowestPremium: 164.9,
};

describe("paper worker — mirrored PE plan", () => {
  it("does not stop out a PE while the price is below its stop", () => {
    expect(detectPaperHit(PE_TRADE, 41.05)).toBeNull();  // at the entry
    expect(detectPaperHit(PE_TRADE, 45)).toBeNull();      // still below the stop
  });

  it("stops a PE when the price RISES to the stop", () => {
    expect(detectPaperHit(PE_TRADE, 49.25)).toBe("SL_HIT");
    expect(detectPaperHit(PE_TRADE, 52)).toBe("SL_HIT");
  });

  it("fires TP1 when the price FALLS to the target", () => {
    expect(detectPaperHit(PE_TRADE, 24.65)).toBe("TP1_HIT");
    expect(detectPaperHit(PE_TRADE, 24)).toBe("TP1_HIT");
  });

  it("walks the TP2/TP3 ladder downwards for a PE", () => {
    const afterTp1 = { ...PE_TRADE, status: "TP1_HIT", stopLoss: 41.05 };
    expect(detectPaperHit(afterTp1, 16.4)).toBe("TP2_HIT");
    const afterTp2 = { ...afterTp1, status: "TP2_HIT" };
    expect(detectPaperHit(afterTp2, 8.2)).toBe("TP3_HIT");
  });

  it("keeps the long-side ladder for a CE", () => {
    expect(detectPaperHit(CE_TRADE, 131.5)).toBe("SL_HIT");
    expect(detectPaperHit(CE_TRADE, 230.85)).toBe("TP1_HIT");
    expect(detectPaperHit(CE_TRADE, 164.9)).toBeNull();
  });
});

describe("paper worker — the exit price and the P&L sign", () => {
  it("a stop-out exits at the stop, or worse on a gap", () => {
    expect(paperExitPrice(PE_TRADE, "SL_HIT", 49.25)).toBe(49.25);
    expect(paperExitPrice(PE_TRADE, "SL_HIT", 51.4)).toBe(51.4);   // gapped up
    expect(paperExitPrice(CE_TRADE, "SL_HIT", 131.9)).toBe(131.9);
    expect(paperExitPrice(CE_TRADE, "SL_HIT", 128.2)).toBe(128.2); // gapped down
  });

  it("a stop-out is a LOSS and a target hit is a GAIN (both sides)", () => {
    expect(paperPnlPoints(PE_TRADE, 49.25)).toBeCloseTo(-8.2, 5);
    expect(paperPnlPoints(PE_TRADE, 24.65)).toBeCloseTo(16.4, 5);
    expect(paperPnlPoints(CE_TRADE, 131.9)).toBeCloseTo(-33, 5);
    expect(paperPnlPoints(CE_TRADE, 230.85)).toBeCloseTo(65.95, 5);
  });
});
