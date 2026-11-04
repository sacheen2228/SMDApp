import { describe, test, expect } from "bun:test";
import { evaluateSignalVeto, type VetoInput } from "@/lib/signal-veto";

// 2026-07-15 10:05 IST — before the 13:00 option-buy cutoff
const AT = Date.parse("2026-07-15T10:05:00+05:30");

const base: VetoInput = {
  nowMs: AT,
  symbol: "NIFTY",
  action: "BUY CE",
  optionType: "CE",
  strike: 25200,
  // The premium must be AFFORDABLE under the per-trade deployment cap: the
  // veto now blocks a candidate whose ₹ deployment (entry × lot size × lots)
  // does not fit GATE_CONFIG.tradeBudget. 1 NIFTY lot (65) at ₹150 = ₹9,750 ✓.
  // (₹350 × 65 = ₹22,750 was over the ₹20,000 cap → the candidate could not
  //  be traded at all, so the deployment gate blocks it.)
  entry: 150,
  stopLoss: 120,
  tp1: 210,
  confidence: 75, // 75 stated → 68 calibrated (×0.9 haircut) → above the 65 floor
};

describe("signal-veto (hybrid overlay — old brain generates, new brain only blocks/warns)", () => {
  test("passes a sound option signal", () => {
    const r = evaluateSignalVeto(base);
    expect(r.verdict).toBe("PASS");
    expect(r.sizeFactor).toBe(1);
    expect(r.reasons).toHaveLength(0);
    expect(r.statedConfidence).toBe(75);
    expect(r.calibratedConfidence).toBe(68);
  });

  test("the floor applies to the CALIBRATED number, not the stated one", () => {
    const r = evaluateSignalVeto({ ...base, confidence: 70 }); // 70 × 0.9 = 63 → below 65
    expect(r.verdict).toBe("WARN");
    expect(r.calibratedConfidence).toBe(63);
    expect(r.statedConfidence).toBe(70);
    expect(r.reasons.join(" ")).toMatch(/calibrated confidence 63%/);
  });

  test("a measured band lets a stated number pass without lowering the floor", () => {
    const r = evaluateSignalVeto({ ...base, confidence: 70, calibrationBand: { realizedHitPct: 80, n: 40 } });
    expect(r.calibratedConfidence).toBe(80);
    expect(r.verdict).toBe("PASS");
  });

  test("blocks option R:R below 1.5", () => {
    const r = evaluateSignalVeto({ ...base, tp1: 180 }); // (180-150)/30 = 1.0
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/R:R/);
    expect(r.sizeFactor).toBe(0);
  });

  test("blocks stop at or above entry", () => {
    const r = evaluateSignalVeto({ ...base, stopLoss: 150 });
    expect(r.verdict).toBe("BLOCK");
    expect(r.sizeFactor).toBe(0);
  });

  test("warns on low confidence but does not block (hybrid)", () => {
    const r = evaluateSignalVeto({ ...base, confidence: 40 });
    expect(r.verdict).toBe("WARN");
    expect(r.sizeFactor).toBe(0.5);
    expect(r.reasons.join(" ")).toMatch(/confidence/);
  });

  test("blocks expiry-day index option (ISO)", () => {
    // base.nowMs = 2026-07-15 10:05 IST — pin expiry to that same IST day.
    const r = evaluateSignalVeto({ ...base, expiry: "2026-07-15" });
    expect(r.verdict).toBe("BLOCK");
    expect(r.sizeFactor).toBe(0);
  });

  test("blocks expiry-day index option (Breeze DD-MMM-YYYY — the production format)", () => {
    // THE BUG: "15-Jul-2026".slice(0,10) = "15-Jul-202" never equalled
    // "2026-07-15", so the hard gate never fired for real Breeze trades.
    const r = evaluateSignalVeto({ ...base, expiry: "15-Jul-2026" });
    expect(r.verdict).toBe("BLOCK");
    expect(r.sizeFactor).toBe(0);
    expect(r.reasons.join(" ")).toMatch(/expiry-day/);
  });

  test("passes equity signal — no option checks", () => {
    const r = evaluateSignalVeto({
      ...base,
      symbol: "RELIANCE",
      optionType: undefined,
      strike: undefined,
      tp1: 2900,
      entry: 2800,
      stopLoss: 2750,
      expiry: undefined,
    });
    expect(r.verdict).toBe("PASS");
    expect(r.sizeFactor).toBe(1);
  });

  test("blocks equity with bad R:R", () => {
    const r = evaluateSignalVeto({
      ...base,
      symbol: "RELIANCE",
      optionType: undefined,
      strike: undefined,
      tp1: 2810,
      entry: 2800,
      stopLoss: 2750,
      expiry: undefined,
    }); // rr = 10/50 = 0.2
    expect(r.verdict).toBe("BLOCK");
    expect(r.sizeFactor).toBe(0);
  });

  test("BLOCKS a deep-OTM lottery ticket (hard safety gate)", () => {
    const r = evaluateSignalVeto({
      ...base,
      spot: 25150,
      expiry: "2026-12-03",
      entry: 1, strike: 25600, stopLoss: 0.5, tp1: 3, confidence: 90,
    }); // deep OTM near-expiry, |delta| ≈ 0
    expect(r.verdict).toBe("BLOCK");
    expect(r.hardFail).toBe(true);
    expect(r.suppress).toBe(true);
    expect(r.sizeFactor).toBe(0);
    expect(r.reasons.join(" ")).toMatch(/delta/);
  });

  test("BLOCKS more than 3 steps OTM (hard safety gate)", () => {
    const r = evaluateSignalVeto({ ...base, strike: 25400, spot: 25150 }); // 6 steps OTM
    expect(r.verdict).toBe("BLOCK");
    expect(r.hardFail).toBe(true);
    expect(r.suppress).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/steps/);
  });
});
