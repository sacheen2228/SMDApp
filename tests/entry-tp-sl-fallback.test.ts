// entry-tp-sl-fallback.test.ts — remediation R2 (audit defect D-1 residue)
//
// The deprecated entryTPSLEngine (zero-hero-ai) falls back to a "structural 50%
// stop" when buildOptionPlan returns null (reachable for junk premiums where the
// 8-tick noise floor >= the premium, e.g. a ₹0.35 deep-OTM option).
//
// The old fallback mirrored the PE branch:
//   stopLoss = entry * (1 + 0.5)  → stop ABOVE the entry with targets ABOVE it
// That is incoherent plan geometry (stop and targets on the same side): every
// side-aware monitor reads it as SHORT while the ladder pays out as long.
//
// Long-option geometry applies to BOTH letters (R1): a bought option loses when
// the premium falls — stop BELOW entry, targets ABOVE — CE and PE identical.
import { describe, test, expect } from "bun:test";
import { entryTPSLEngine } from "@/lib/zero-hero-ai/entry-tp-sl-engine";

const base = {
  spot: 24000,
  strike: 23500,
  delta: -0.2,
  gamma: 0.01,
  theta: -12,
  atr: 80,
  daysToExpiry: 0,
  bias: "BEARISH" as const,
  expected_move: 120,
  instrument: "NIFTY",
  expiry_mode: "ZERO_HERO" as const,
  lotSize: 65,
};

// ₹0.35 premium: the min-stop floor (8 × ₹0.05 = ₹0.40) >= entry →
// buildOptionPlan returns null → the fallback path runs.
describe("entryTPSLEngine fallback — long-option geometry for both letters", () => {
  test("PE fallback puts the stop BELOW entry with targets above (no mirror)", () => {
    const out = entryTPSLEngine({ ...base, optionType: "PE", entryPremium: 0.35 });
    expect(out.stopLoss).toBeLessThan(out.entry);   // old code: 0.53 > 0.35 (mirrored)
    expect(out.target).toBeGreaterThan(out.entry);
    for (const t of out.targets) expect(t).toBeGreaterThan(out.entry);
    expect(out.stopLoss).toBeGreaterThan(0);
  });

  test("CE and PE fallbacks produce IDENTICAL geometry", () => {
    const ce = entryTPSLEngine({ ...base, optionType: "CE", entryPremium: 0.35 });
    const pe = entryTPSLEngine({ ...base, optionType: "PE", entryPremium: 0.35 });
    expect(pe.stopLoss).toBe(ce.stopLoss);
    expect(pe.target).toBe(ce.target);
    expect(pe.targets).toEqual(ce.targets);
  });

  test("fallback ladder stays coherent: stop < entry < TP1 < TP2 < TP3", () => {
    const out = entryTPSLEngine({ ...base, optionType: "PE", entryPremium: 0.35 });
    expect(out.stopLoss).toBeLessThan(out.entry);
    const ladder = [out.entry, ...out.targets];
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]).toBeGreaterThan(ladder[i - 1]);
    }
  });
});
