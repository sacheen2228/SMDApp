/// <reference types="bun-types" />
// buildOptionsSummary — honest per-stock options summary. Previously the
// scanner printed "PCR 1.00 | OI 0 | OI Chg +0 | IV 20.0%" from hardcoded
// defaults when no chain was available (fake data presented as real).

import { describe, it, expect } from "bun:test";
import { buildOptionsSummary } from "@/lib/intraday-scanner";
import type { OptionChainSnapshot, OptionChainStrike } from "@/lib/auction-types";

function strike(s: number, ceOi: number, peOi: number): OptionChainStrike {
  return {
    strike: s,
    expiry: "27-Oct-2026",
    ce: {
      ltp: 30.4, volume: 700, oi: ceOi, oiChange: 200, iv: 14.9,
      bid: 0, ask: 0, bidQty: 0, askQty: 0,
      delta: 0.5, gamma: 0, theta: 0, vega: 0, spread: 0, spreadPct: 0,
    },
    pe: {
      ltp: 33.2, volume: 400, oi: peOi, oiChange: -50, iv: 15.1,
      bid: 0, ask: 0, bidQty: 0, askQty: 0,
      delta: -0.5, gamma: 0, theta: 0, vega: 0, spread: 0, spreadPct: 0,
    },
  } as OptionChainStrike;
}

function snap(over: Partial<OptionChainSnapshot> = {}): OptionChainSnapshot {
  return {
    symbol: "ICICIBANK",
    spot: 1321.7,
    atmStrike: 1320,
    expiry: "27-Oct-2026",
    strikes: [strike(1300, 1000, 2000), strike(1320, 3000, 1500)],
    callOiMap: new Map([[1300, 1000], [1320, 3000]]),
    putOiMap: new Map([[1300, 2000], [1320, 1500]]),
    callOiChangeMap: new Map([[1300, 120], [1320, 200]]),
    putOiChangeMap: new Map([[1300, -80], [1320, -50]]),
    callVolumeMap: new Map([[1300, 500], [1320, 700]]),
    putVolumeMap: new Map([[1300, 300], [1320, 400]]),
    maxPain: 1320,
    pcr: 3500 / 4000,
    ivRank: 48.2,
    ivPercentile: 48.2,
    atmIV: 15.1,
    ivSkew: 0.02,
    ...over,
  };
}

describe("buildOptionsSummary", () => {
  it("labels a missing chain honestly — no fake PCR/IV defaults", () => {
    const s = buildOptionsSummary(null);
    expect(s).toBe("Options: chain unavailable");
    expect(s).not.toContain("1.00");
    expect(s).not.toContain("20.0");
  });

  it("renders real PCR, OI, OI change and ATM IV when a chain exists", () => {
    const s = buildOptionsSummary(snap());
    expect(s).toContain("PCR 0.88"); // putOi 3500 / callOi 4000 = 0.875 → 0.88
    expect(s).toContain("IV 15.1%");
    expect(s).toContain("MaxPain 1320");
    expect(s).toMatch(/OI Chg \+\d/); // callChg 320 + putChg −130 = +190
  });

  it("shows PCR N/A (never 1.00) when OI totals are zero", () => {
    const s = buildOptionsSummary(
      snap({
        callOiMap: new Map([[1300, 0], [1320, 0]]),
        putOiMap: new Map([[1300, 0], [1320, 0]]),
        callOiChangeMap: new Map([[1300, 0], [1320, 0]]),
        putOiChangeMap: new Map([[1300, 0], [1320, 0]]),
        pcr: 0,
        atmIV: 0,
      })
    );
    expect(s).toContain("PCR N/A");
    expect(s).not.toContain("PCR 1.00");
    expect(s).toContain("IV N/A");
  });
});
