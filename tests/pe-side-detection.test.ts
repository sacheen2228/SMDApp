import { describe, test, expect } from "bun:test";

// A PE plan is MIRRORED: stop ABOVE the entry, targets BELOW it.
// The old long-only test (price <= stop) fired a false SL the moment a PE opened.
describe("PE side-aware SL/TP detection", () => {
  test("a PE does not trigger an SL while the price is BELOW the stop", async () => {
    const { detectPlanHit } = await import("@/lib/agents/trade-monitor");
    const pe = {
      id: "pe1", symbol: "SBIN", side: "BUY", instrument: "SBIN 970 PE", strike: 970,
      optionType: "PE", entry: 8.5, sl: 10.2, tp1: 5.1, tp2: 3.4, tp3: 1.7,
      status: "ACTIVE", sentAt: new Date().toISOString(), source: "test", exchange: "NFO",
    } as any;
    // price 8.50 → below the 10.20 stop → NOT a stop (it is at the entry)
    expect(detectPlanHit(pe, 8.5)).toBeNull();
    // price 10.50 → above the stop → stop hit
    expect(detectPlanHit(pe, 10.5)).toBe("SL_HIT");
    // price 5.00 → below TP1 5.10 → TP1 hit
    expect(detectPlanHit(pe, 5.0)).toBe("TP1_HIT");
  });

  test("a CE keeps the long-side logic", async () => {
    const { detectPlanHit } = await import("@/lib/agents/trade-monitor");
    const ce = {
      id: "ce1", symbol: "HCLTECH", side: "BUY", instrument: "HCLTECH 1380 CE", strike: 1380,
      optionType: "CE", entry: 18.8, sl: 15.05, tp1: 26.3, tp2: 30.1, tp3: 33.85,
      status: "ACTIVE", sentAt: new Date().toISOString(), source: "test", exchange: "NFO",
    } as any;
    expect(detectPlanHit(ce, 14.9)).toBe("SL_HIT");
    expect(detectPlanHit(ce, 26.5)).toBe("TP1_HIT");
    expect(detectPlanHit(ce, 20)).toBeNull();
  });
});
