/// <reference types="bun-types" />
// BestTradesNow cards need the option strike to trade the setup.
// Strike MUST come from the live chain (NSE Equity / Breeze) — a price-step
// formula invents strikes that don't exist (INFY real step is not 50).

import { describe, it, expect } from "bun:test";
import { pickOptionLeg } from "@/lib/technical-analysis";

const rows = [
  { strike: 1000, ceLtp: 45.2, peLtp: 8.4 },
  { strike: 1020, ceLtp: 30.1, peLtp: 13.9 },
  { strike: 1040, ceLtp: 18.7, peLtp: 22.5 },
  { strike: 1060, ceLtp: 10.3, peLtp: 34.8 },
];

describe("pickOptionLeg", () => {
  it("LONG → CE at nearest strike to entry", () => {
    const leg = pickOptionLeg(rows, 1032.93, "LONG");
    expect(leg).toEqual({ strike: 1040, side: "CE", premium: 18.7 });
  });

  it("SHORT → PE at nearest strike to entry", () => {
    const leg = pickOptionLeg(rows, 1032.93, "SHORT");
    expect(leg).toEqual({ strike: 1040, side: "PE", premium: 22.5 });
  });

  it("picks nearest by distance, not first row", () => {
    expect(pickOptionLeg(rows, 999, "LONG")?.strike).toBe(1000);
    expect(pickOptionLeg(rows, 1061, "LONG")?.strike).toBe(1060);
  });

  it("entry exactly between strikes → lower one is fine, must be one of them", () => {
    const leg = pickOptionLeg(rows, 1030, "LONG");
    expect([1020, 1040]).toContain(leg?.strike ?? -1);
  });

  it("null/empty rows → null (honest, never a computed strike)", () => {
    expect(pickOptionLeg([], 1032, "LONG")).toBeNull();
    expect(pickOptionLeg(null as any, 1032, "LONG")).toBeNull();
  });

  it("missing/zero premium for the side → null (never ₹0 on screen)", () => {
    const noCe = [{ strike: 1040, peLtp: 22.5 }];
    expect(pickOptionLeg(noCe, 1032, "LONG")).toBeNull();
    const zeroPe = [{ strike: 1040, ceLtp: 18.7, peLtp: 0 }];
    expect(pickOptionLeg(zeroPe, 1032, "SHORT")).toBeNull();
  });

  it("invalid entry → null", () => {
    expect(pickOptionLeg(rows, 0, "LONG")).toBeNull();
    expect(pickOptionLeg(rows, NaN, "LONG")).toBeNull();
  });
});
