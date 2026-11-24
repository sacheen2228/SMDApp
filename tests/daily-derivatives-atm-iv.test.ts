// ═══════════════════════════════════════════════════════════════════════════
// Daily Derivatives — ATM IV must have exactly ONE unit: PERCENT.
//
// Regression (9797df9): the card gained a new branch that reads the live
// chain's own ATM greeks — whose `iv` is already PERCENT (14.2 = 14.2%) —
// while the report assembly still did `atmIV * 100` (correct only for the
// old `impliedVolFromPremium` path, which returns a DECIMAL). Result: the
// ATM IV tile printed 1686% / 1967% whenever the chain shipped greeks.
//
// Same root cause made `atmGreeks.iv` inconsistent: 0.163 (decimal) on the
// implied path vs 16.86 (percent) on the provider/bs path.
//
// These tests pin: one unit out (percent), never re-scaled, and the greeks
// payload agrees with the headline number.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "bun:test";
import { resolveAtmIv, daysToExpiryFor, type OptionStrike } from "@/lib/DailyDerivatives";

const chainLeg = (iv: number, deltaSource: "provider" | "bs") => ({
  ltp: 270,
  oi: 1000,
  oiChange: 10,
  volume: 5,
  bid: 269,
  ask: 271,
  greeks: { delta: 0.5, gamma: 0.001, theta: -10, vega: 5, iv, deltaSource },
});

describe("resolveAtmIv — percent in, percent out", () => {
  it("a chain IV that is already percent is NOT multiplied by 100 again", () => {
    const atm: OptionStrike = { strike: 25350, call: chainLeg(16.86, "bs") };
    const out = resolveAtmIv({ atm, spot: 25349, T: 8 / 365 });

    expect(out.atmGreeksSource).toBe("bs");
    // 1686 would be the double-scaled bug; 16.86 is the chain's own number.
    expect(out.atmIV).toBeCloseTo(16.86, 2);
    expect(out.atmIV).toBeLessThan(100);
  });

  it("a provider IV is passed through untouched", () => {
    const atm: OptionStrike = { strike: 25350, call: chainLeg(19.67, "provider") };
    const out = resolveAtmIv({ atm, spot: 25349, T: 3 / 365 });

    expect(out.atmGreeksSource).toBe("provider");
    expect(out.atmIV).toBeCloseTo(19.67, 2);
  });

  it("the implied fallback reports PERCENT and agrees with atmGreeks.iv", () => {
    // No chain greeks → BS-from-premium. impliedVolFromPremium returns a
    // decimal (0.16 = 16%), so the card must scale it exactly once.
    const atm: OptionStrike = { strike: 25350, call: { ...chainLeg(0, "bs"), greeks: undefined } };
    const out = resolveAtmIv({ atm, spot: 25350, T: 8 / 365 });

    expect(out.atmGreeksSource).toBe("implied");
    // decimal would be < 1; double-scaled would be huge. Percent sits between.
    expect(out.atmIV).toBeGreaterThan(1);
    expect(out.atmIV).toBeLessThan(100);
    // the headline number and the greeks payload are the SAME unit
    expect(out.atmGreeks!.iv).toBeCloseTo(out.atmIV, 6);
  });

  it("an absent ATM leg stays 0 with a null source — never a fabricated IV", () => {
    const out = resolveAtmIv({ atm: undefined, spot: 25350, T: 8 / 365 });
    expect(out.atmIV).toBe(0);
    expect(out.atmGreeksSource).toBeNull();
    expect(out.atmGreeks).toBeUndefined();
  });
});

describe("daysToExpiryFor — calendar days, not a rounded-up fraction", () => {
  // parseExpiryDateLoose stamps expiry at 15:30 IST (10:00 UTC).
  const expiry = new Date(Date.UTC(2026, 11, 1, 10, 0, 0)); // 01-Dec-2026 15:30 IST

  it("counts calendar-date difference, not ceil() of the raw fraction", () => {
    // 24-Nov 14:11 IST = 08:41 UTC → raw 7.06 days. ceil() wrongly said 8.
    const now = new Date(Date.UTC(2026, 10, 24, 8, 41, 0));
    expect(daysToExpiryFor(expiry, now)).toBe(7);
  });

  it("is 1 the day before expiry, whatever the hour", () => {
    expect(daysToExpiryFor(expiry, new Date(Date.UTC(2026, 10, 30, 4, 45, 0)))).toBe(1);
    // after 15:30 IST on the day before — still 1 day, not 0
    expect(daysToExpiryFor(expiry, new Date(Date.UTC(2026, 10, 30, 12, 0, 0)))).toBe(1);
  });

  it("is 0 on expiry day (never 1), and clamps after expiry", () => {
    expect(daysToExpiryFor(expiry, new Date(Date.UTC(2026, 11, 1, 4, 45, 0)))).toBe(0);
    expect(daysToExpiryFor(expiry, new Date(Date.UTC(2026, 11, 1, 11, 0, 0)))).toBe(0);
    expect(daysToExpiryFor(expiry, new Date(Date.UTC(2026, 11, 3, 4, 45, 0)))).toBe(0);
  });

  it("stays non-negative for a missing expiry", () => {
    expect(daysToExpiryFor(null, new Date())).toBe(0);
  });
});
