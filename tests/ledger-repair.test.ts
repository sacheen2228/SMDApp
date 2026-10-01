/// <reference types="bun-types" />
// ledger-repair — pure helpers for correcting corrupt closed-trade rows with
// real exchange closes. Offline tests against the exact corruption patterns
// found in the sidecar (placeholder exits, wrong-contract cleanup premiums,
// swapped SL/TP1 on long-premium PE rows).

import { describe, it, expect } from "bun:test";
import {
  isInvertedLongLevels,
  fixInvertedLongLevels,
  longPnl,
  rMultiple,
  effExitDate,
  chooseContractExpiry,
  exitNeedsRepair,
  roiPct,
} from "@/lib/ledger-repair";

describe("isInvertedLongLevels / fixInvertedLongLevels", () => {
  it("detects SL-above-entry + TP1-below-entry (the swapped PE rows)", () => {
    // ZERO_HERO_AI-NIFTY-24150-PE-20260713 as recorded
    expect(isInvertedLongLevels(51.9, 63.32, 40.48)).toBe(true);
    expect(isInvertedLongLevels(39.6, 48.31, 30.89)).toBe(true);
  });

  it("accepts correct long levels (SL below entry, TP above)", () => {
    expect(isInvertedLongLevels(22.75, 17.745, 27.755)).toBe(false);
    expect(isInvertedLongLevels(9.4, 7.33, 11.47)).toBe(false);
  });

  it("returns false on missing/invalid inputs", () => {
    expect(isInvertedLongLevels(51.9, null, 40.48)).toBe(false);
    expect(isInvertedLongLevels(51.9, 63.32, null)).toBe(false);
    expect(isInvertedLongLevels(0, 63.32, 40.48)).toBe(false);
    expect(isInvertedLongLevels(51.9, NaN, 40.48)).toBe(false);
  });

  it("swaps the pair back — risk band magnitude identical", () => {
    const fix = fixInvertedLongLevels(51.9, 63.32, 40.48);
    expect(fix.swapped).toBe(true);
    expect(fix.stopLoss).toBe(40.48); // SL now below entry
    expect(fix.tp1).toBe(63.32); // TP now above entry
    // risk distance unchanged: 51.9 − 40.48 === 63.32 − 51.9
    expect(51.9 - fix.stopLoss).toBeCloseTo(fix.tp1 - 51.9, 6);
  });
});

describe("longPnl — long premium, qty 1", () => {
  it("computes exit − entry (the sign the swapped rows got wrong)", () => {
    expect(longPnl(51.9, 160.75)).toEqual({ gross: 108.85, net: 108.85 });
    expect(longPnl(3.9, 59.55).net).toBeCloseTo(55.65, 6);
    expect(longPnl(1416.2, 1417.9).net).toBeCloseTo(1.7, 6);
  });

  it("subtracts fees and guards garbage", () => {
    expect(longPnl(100, 120, 2).net).toBe(18);
    expect(longPnl(100, 120, NaN).net).toBe(20);
    expect(longPnl(100, 120, -5).net).toBe(20);
  });
});

describe("rMultiple", () => {
  it("uses risk = entry − SL (positive for correct long SL)", () => {
    // exit 160.75, entry 51.9, corrected SL 40.48 → +9.53R (recorded −9.53R)
    expect(rMultiple(51.9, 160.75, 40.48)).toBeCloseTo(9.53, 2);
  });
  it("null when SL missing or on the wrong side", () => {
    expect(rMultiple(51.9, 160.75, null)).toBeNull();
    expect(rMultiple(51.9, 160.75, 63.32)).toBeNull(); // SL above entry → risk ≤ 0
  });
});

describe("effExitDate — contract cannot exit after expiry", () => {
  it("clamps cleanup dates after expiry back to expiry day", () => {
    expect(effExitDate("2026-07-14", "2026-07-17")).toBe("2026-07-14");
    expect(effExitDate("2026-07-21", "2026-07-17")).toBe("2026-07-17"); // still alive
    expect(effExitDate("2026-07-21", "2026-07-21")).toBe("2026-07-21");
  });
});

describe("chooseContractExpiry — first listed expiry on/after creation", () => {
  const july = ["2026-07-14", "2026-07-21", "2026-07-28", "2026-08-04"];
  it("picks the trade's real contract", () => {
    expect(chooseContractExpiry(july, "2026-07-13")).toBe("2026-07-14");
    expect(chooseContractExpiry(july, "2026-07-14")).toBe("2026-07-14");
    expect(chooseContractExpiry(july, "2026-07-15")).toBe("2026-07-21");
    expect(chooseContractExpiry(july, "2026-07-17")).toBe("2026-07-21");
  });
  it("null when nothing listed on/after creation", () => {
    expect(chooseContractExpiry(["2026-07-14"], "2026-07-15")).toBeNull();
    expect(chooseContractExpiry([], "2026-07-15")).toBeNull();
    expect(chooseContractExpiry(["garbage"], "2026-07-15")).toBeNull();
  });
});

describe("exitNeedsRepair — placeholder and wrong-contract stamps", () => {
  it("flags the 4 BTST placeholder exits", () => {
    expect(exitNeedsRepair(100, 1417.9, 1416.2)).toBe(true);
    expect(exitNeedsRepair(1, 5301, 5315.5)).toBe(true);
    expect(exitNeedsRepair(3000, 4625.8, 4579.4)).toBe(true);
    expect(exitNeedsRepair(10, 1188, 1168)).toBe(true);
  });
  it("flags wrong-contract option exits", () => {
    expect(exitNeedsRepair(160.75, 92.5, 51.9)).toBe(true); // next-week premium
    expect(exitNeedsRepair(134.75, 42.75, 39.6)).toBe(true);
  });
  it("keeps rows already matching the real close", () => {
    expect(exitNeedsRepair(92.5, 92.5, 51.9)).toBe(false);
    expect(exitNeedsRepair(1417.9, 1417.9, 1416.2)).toBe(false);
    expect(exitNeedsRepair(1418.5, 1417.9, 1416.2)).toBe(false); // ₹0.6 noise < ₹1
    expect(exitNeedsRepair(1437.9, 1417.9, 1416.2)).toBe(false); // 1.4% < 2%
    expect(exitNeedsRepair(1448, 1417.9, 1416.2)).toBe(true); // >2%
  });
  it("never repairs without real data", () => {
    expect(exitNeedsRepair(100, NaN, 1416.2)).toBe(false);
    expect(exitNeedsRepair(100, 0, 1416.2)).toBe(false);
    expect(exitNeedsRepair(null, 92.5, 51.9)).toBe(true); // missing always repairable
  });
});

describe("roiPct", () => {
  it("net as % of entry", () => {
    expect(roiPct(51.9, 108.85)).toBeCloseTo(209.73, 1);
    expect(roiPct(0, 10)).toBe(0);
  });
});
