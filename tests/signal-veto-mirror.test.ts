// tests/signal-veto-mirror.test.ts
// The veto must read the plan side from the LEVEL GEOMETRY, not from the action
// string. A bought PE can carry a MIRRORED (bearish) plan — stop ABOVE the
// entry, targets BELOW it — exactly like the live monitors infer it
// (activeTradeTracker.planSide, hermes/paper-worker.detectPaperHit).
//
// The old veto assumed long geometry for every BUY, so it hard-blocked every
// legitimate bearish option plan ("stop 49.25 not above entry 41.05") and
// measured the R:R on the wrong side.
//
// These tests lock down the FIX and prove the hard gates did not move:
//   • a mirrored PE with R:R 2.0 → PASS
//   • a mirrored PE with R:R 1.0 → BLOCK (R:R gate)
//   • a long plan with R:R 1.0   → BLOCK (R:R gate)
//   • the calibrated-confidence floor, the fail-closed rules, the expiry-day
//     block, the delta/OTM blocks, the BTST exemption and the 13:00 cutoff
//     are all unchanged.
import { describe, test, expect } from "bun:test";
import { evaluateSignalVeto, vetoPlanSide, type VetoInput } from "@/lib/signal-veto";
import { GATE_CONFIG } from "@/lib/agent-brain-gate";

// 2026-07-15 10:05 IST — before the 13:00 option-buy cutoff
const AT = Date.parse("2026-07-15T10:05:00+05:30");

/** The LIVE mirrored PE plan (20-Oct-2026): stop ABOVE the entry, targets BELOW. */
const MIRRORED_PE: VetoInput = {
  nowMs: AT,
  symbol: "TCS",
  action: "BUY PE",
  optionType: "PE",
  entry: 41.05,
  stopLoss: 49.25, // above the entry → mirrored/short plan
  tp1: 24.65, // 41.05 - 16.40 → R:R 2.0
  confidence: 75, // 75 × 0.9 = 67.5 → 68 calibrated → above the 65 floor
};

/** The LIVE long-style CE plan: stop BELOW the entry, target ABOVE. */
const LONG_CE: VetoInput = {
  nowMs: AT,
  symbol: "ULTRACEMCO",
  action: "BUY CE",
  optionType: "CE",
  entry: 164.9,
  stopLoss: 131.9,
  tp1: 230.85, // +65.95 on a 33 risk → R:R 2.0
  confidence: 75,
};

describe("veto — the plan side comes from the levels, not the action string", () => {
  test("vetoPlanSide reads the stop-vs-entry geometry", () => {
    expect(vetoPlanSide(41.05, 49.25)).toBe("SHORT"); // stop above → mirrored
    expect(vetoPlanSide(100, 90)).toBe("LONG"); // stop below → long
    expect(vetoPlanSide(100, 100)).toBeNull(); // degenerate → fail closed
    expect(vetoPlanSide(NaN, 90)).toBeNull();
    expect(vetoPlanSide(100, NaN)).toBeNull();
  });

  test("a mirrored PE with R:R 2.0 PASSES (it used to be hard-blocked)", () => {
    const r = evaluateSignalVeto(MIRRORED_PE);
    expect(r.verdict).toBe("PASS");
    expect(r.hardFail).toBe(false);
    expect(r.suppress).toBe(false);
    expect(r.sizeFactor).toBe(1);
    expect(r.fails).toHaveLength(0);
    expect(r.reasons).toHaveLength(0);
  });

  test("a mirrored PE with R:R 1.0 still BLOCKS", () => {
    // entry 41.05, stop 49.25 (risk 8.20), target 32.85 (reward 8.20) → R:R 1.0
    const r = evaluateSignalVeto({ ...MIRRORED_PE, tp1: 32.85 });
    expect(r.verdict).toBe("BLOCK");
    expect(r.hardFail).toBe(true);
    expect(r.suppress).toBe(true);
    expect(r.sizeFactor).toBe(0);
    expect(r.reasons.join(" ")).toMatch(/R:R 1\.00 < 1\.5/);
  });

  test("a long plan with R:R 1.0 still BLOCKS", () => {
    // entry 100, stop 90 (risk 10), target 110 (reward 10) → R:R 1.0
    const r = evaluateSignalVeto({
      ...LONG_CE, symbol: "NIFTY", optionType: "CE", entry: 100, stopLoss: 90, tp1: 110,
    });
    expect(r.verdict).toBe("BLOCK");
    expect(r.hardFail).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/R:R 1\.00 < 1\.5/);
  });

  test("a long-style plan with R:R 2.0 still PASSES", () => {
    const r = evaluateSignalVeto(LONG_CE);
    expect(r.verdict).toBe("PASS");
    expect(r.sizeFactor).toBe(1);
  });

  test("a long-style PE (stop below, target above) still PASSES", () => {
    // The SDM engine builds a LONG plan for a PE — the letter does not decide.
    const r = evaluateSignalVeto({
      ...MIRRORED_PE, entry: 43.35, stopLoss: 36.85, tp1: 49.85, // R:R 1.0 → blocked
    });
    expect(r.verdict).toBe("BLOCK"); // R:R 1.0 → the R:R gate, not the geometry
    const ok = evaluateSignalVeto({
      ...MIRRORED_PE, entry: 43.35, stopLoss: 36.85, tp1: 56.35, // R:R 2.0
    });
    expect(ok.verdict).toBe("PASS");
  });

  test("a stop that is not on ONE side of the entry fails closed", () => {
    const r = evaluateSignalVeto({ ...MIRRORED_PE, stopLoss: 41.05 });
    expect(r.verdict).toBe("BLOCK");
    expect(r.hardFail).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/not on one side of entry/);
  });

  test("a mirrored plan whose target sits on the wrong side is blocked", () => {
    // stop above the entry (mirrored) but the target above too → incoherent
    const r = evaluateSignalVeto({ ...MIRRORED_PE, tp1: 60 });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/R:R/);
  });
});

describe("veto — the other hard gates did not move", () => {
  test("the floor still applies to the CALIBRATED number (warning, not a block)", () => {
    const r = evaluateSignalVeto({ ...MIRRORED_PE, confidence: 70 }); // 70 × 0.9 = 63
    expect(r.verdict).toBe("WARN");
    expect(r.hardFail).toBe(false);
    expect(r.sizeFactor).toBe(0.5);
    expect(r.calibratedConfidence).toBe(63);
    expect(r.statedConfidence).toBe(70);
    expect(r.reasons.join(" ")).toMatch(/calibrated confidence 63%/);
  });

  test("a measured band still lets a stated number pass without lowering the floor", () => {
    const r = evaluateSignalVeto({
      ...MIRRORED_PE, confidence: 70, calibrationBand: { realizedHitPct: 80, n: 40 },
    });
    expect(r.calibratedConfidence).toBe(80);
    expect(r.verdict).toBe("PASS");
  });

  test("a missing stop / target / entry still fails closed", () => {
    expect(evaluateSignalVeto({ ...MIRRORED_PE, stopLoss: undefined }).verdict).toBe("BLOCK");
    expect(evaluateSignalVeto({ ...MIRRORED_PE, tp1: undefined }).verdict).toBe("BLOCK");
    expect(evaluateSignalVeto({ ...MIRRORED_PE, entry: undefined }).verdict).toBe("BLOCK");
  });

  test("expiry-day index option still blocks (ISO)", () => {
    const r = evaluateSignalVeto({ ...MIRRORED_PE, symbol: "NIFTY", expiry: "2026-07-15" });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/expiry-day/);
  });

  test("expiry-day index option still blocks (Breeze DD-MMM-YYYY)", () => {
    const r = evaluateSignalVeto({ ...MIRRORED_PE, symbol: "NIFTY", expiry: "15-Jul-2026" });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/expiry-day/);
  });

  test("a deep-OTM lottery ticket still blocks (delta + strike distance)", () => {
    const r = evaluateSignalVeto({
      ...MIRRORED_PE, symbol: "NIFTY", strike: 24600, spot: 25150,
      expiry: "2026-12-03", entry: 1, stopLoss: 1.2, tp1: 0.5,
    });
    expect(r.verdict).toBe("BLOCK");
    expect(r.hardFail).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/delta|steps/);
  });

  test("the 13:00 option-buy cutoff still blocks (mirrored plans included)", () => {
    const after = Date.parse("2026-07-15T13:30:00+05:30");
    const r = evaluateSignalVeto({ ...MIRRORED_PE, nowMs: after });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/13:00 IST/);
  });

  test("BTST stays exempt — even with a mirrored plan", () => {
    const r = evaluateSignalVeto({
      ...MIRRORED_PE, source: "BTST", symbol: "RELIANCE", optionType: undefined,
      entry: 2800, stopLoss: 2850, tp1: 2700,
    });
    expect(r.verdict).toBe("PASS");
    expect(r.fails).toHaveLength(0);
  });

  test("the minimum R:R gate is still the configured one", () => {
    expect(GATE_CONFIG.minOptionRR).toBe(1.5);
    // R:R exactly 1.5 → allowed (the gate is "below 1.5 blocks")
    // NIFTY (lot 65) at ₹100 = ₹6,500 → inside the ₹20,000 per-trade budget.
    const r = evaluateSignalVeto({ ...MIRRORED_PE, symbol: "NIFTY", entry: 100, stopLoss: 110, tp1: 85 });
    expect(r.verdict).toBe("PASS");
    const bad = evaluateSignalVeto({ ...MIRRORED_PE, symbol: "NIFTY", entry: 100, stopLoss: 110, tp1: 85.01 });
    expect(bad.verdict).toBe("BLOCK");
  });
});
