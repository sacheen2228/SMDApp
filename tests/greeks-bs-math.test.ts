/// <reference types="bun-types" />
// Black-Scholes VERIFICATION against a worked example computed independently
// (high-precision reference from math.erf), plus the degenerate-input guards.
//
// Worked example (the audit's reference case):
//   S = 22800, K = 22800, T = 7/365 y, sigma = 0.13, r = 0.07 (the default)
//   d1 = 0.083570, d2 = 0.065567
//   C  = 179.3901, P = 148.8024
//   |C - P| = |S - K*e^(-rT)| = 30.587683
//   delta_call = N(d1) = 0.533301, delta_put = N(d1) - 1 = -0.466699
//   gamma = 0.00096853, vega = 12.5525 (per 1 vol pt), theta_c = -13.9534
//
// DELTA IDENTITY NOTE: put-call parity C - P = S - K*e^(-rT) differentiates to
// delta_call - delta_put = 1 (q = 0, no dividend yield), i.e.
// delta_put - delta_call = -1 EXACTLY. The identity delta_put - delta_call =
// e^(-rT) - 1 would only hold with a cost-of-carry of 0 (q = r); under the
// r-based Black-Scholes used here it is -0.00134, NOT -1. We assert the
// correct identity and record why.
import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  calculateGreeks,
  bsPrice,
  normalCDF,
  impliedVolFromPremium,
  getRiskFreeRate,
} from "@/lib/greeks";

const ORIGINAL = process.env.RISK_FREE_RATE;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RISK_FREE_RATE;
  else process.env.RISK_FREE_RATE = ORIGINAL;
});

delete process.env.RISK_FREE_RATE; // the reference numbers assume r = 0.07

const S = 22800, K = 22800, T = 7 / 365, IV = 0.13, R = 0.07;

describe("greeks — worked example S=K=22800, T=7/365, σ=0.13, r=0.07", () => {
  it("uses r = 0.07 for the reference case", () => {
    expect(getRiskFreeRate()).toBe(R);
  });

  it("d1 and d2 match the closed-form reference", () => {
    const g = calculateGreeks(S, K, T, IV, true);
    expect(g.d1).toBeCloseTo(0.08357, 4);
    expect(g.d2).toBeCloseTo(0.065567, 4);
    // d2 = d1 - σ√T
    expect(g.d2).toBeCloseTo(g.d1 - IV * Math.sqrt(T), 10);
  });

  it("put-call parity holds: |C - P| = |S - K·e^(-rT)|", () => {
    const C = bsPrice(S, K, T, IV, true);
    const P = bsPrice(S, K, T, IV, false);
    expect(C).toBeCloseTo(179.39, 1);   // reference 179.3901
    expect(P).toBeCloseTo(148.80, 1);   // reference 148.8024
    expect(Math.abs(C - P)).toBeCloseTo(30.5877, 3);
    expect(Math.abs(C - P)).toBeCloseTo(Math.abs(S - K * Math.exp(-R * T)), 4);
  });

  it("delta identity: Δcall − Δput = 1 (q = 0)", () => {
    const c = calculateGreeks(S, K, T, IV, true);
    const p = calculateGreeks(S, K, T, IV, false);
    // Full precision deltas from the same d1: N(d1) − (N(d1) − 1) = 1 exactly.
    const rawCall = normalCDF(c.d1);
    const rawPut = normalCDF(c.d1) - 1;
    expect(rawCall - rawPut).toBeCloseTo(1, 12);
    // The rounded greeks the payload ships must still carry the identity.
    expect(c.delta - p.delta).toBeCloseTo(1, 2);
    expect(c.delta).toBeCloseTo(0.53, 2);   // reference 0.533301
    expect(p.delta).toBeCloseTo(-0.47, 2);  // reference -0.466699
    // And e^(-rT) - 1 is NOT the identity here (it is the q = r case) — pin
    // the actual number so nobody "fixes" the test to match it.
    expect(Math.exp(-R * T) - 1).toBeCloseTo(-0.00134157, 6);
    expect(rawCall - rawPut).not.toBeCloseTo(Math.exp(-R * T) - 1, 3);
  });

  it("gamma / vega / theta match the reference", () => {
    const c = calculateGreeks(S, K, T, IV, true);
    // unrounded reference γ = 0.00096853; the payload rounds gamma to 4dp
    expect(Math.abs(c.gamma - 0.00096853)).toBeLessThan(0.00005);
    expect(c.gamma).toBe(0.001);
    expect(c.vega).toBeCloseTo(12.55, 1);
    expect(c.theta).toBeCloseTo(-13.95, 1);
    const p = calculateGreeks(S, K, T, IV, false);
    expect(p.vega).toBeCloseTo(12.55, 1);
    expect(p.theta).toBeCloseTo(-9.59, 1);
  });

  it("an IV round-trip from the model price returns the input IV", () => {
    const C = bsPrice(S, K, T, IV, true);
    expect(impliedVolFromPremium(C, S, K, T, true)).toBeCloseTo(IV, 4);
  });
});

describe("normalCDF — Abramowitz-Stegun vs known values (±0.001)", () => {
  const known: Array<[number, number]> = [
    [0, 0.5],
    [1, 0.84134475],
    [-1, 0.15865525],
    [1.96, 0.97500210],
    [-1.645, 0.04998491],
    [2, 0.97724987],
    [-2, 0.02275013],
    [3.5, 0.99976733],
  ];
  for (const [x, want] of known) {
    it(`N(${x}) ≈ ${want}`, () => {
      expect(Math.abs(normalCDF(x) - want)).toBeLessThan(0.001);
    });
  }
  it("is symmetric and bounded", () => {
    expect(normalCDF(1.234) + normalCDF(-1.234)).toBeCloseTo(1, 9);
    expect(normalCDF(-50)).toBeGreaterThanOrEqual(0);
    expect(normalCDF(50)).toBeLessThanOrEqual(1);
  });
});

describe("greeks — degenerate inputs never propagate NaN", () => {
  const allFinite = (g: { delta: number; theta: number; gamma: number; vega: number; d1: number; d2: number }) => {
    for (const v of [g.delta, g.theta, g.gamma, g.vega, g.d1, g.d2]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  };

  it("IV = 0 → zeros (no greeks), not NaN", () => {
    const g = calculateGreeks(S, K, T, 0, true);
    expect(g).toEqual({ delta: 0, theta: 0, gamma: 0, vega: 0, d1: 0, d2: 0 });
    allFinite(g);
  });

  it("IV = 0 → bsPrice returns intrinsic (no time value), not NaN", () => {
    expect(bsPrice(22900, K, T, 0, true)).toBe(100);
    expect(bsPrice(22700, K, T, 0, false)).toBe(100);
    expect(bsPrice(S, K, T, 0, true)).toBe(0);
  });

  it("T = 0 → finite degenerate values (never NaN)", () => {
    const g = calculateGreeks(S, K, 0, IV, true);
    allFinite(g);
    expect(Number.isNaN(g.delta)).toBe(false);
  });

  it("T = 0 → bsPrice returns intrinsic", () => {
    expect(bsPrice(22900, K, 0, IV, true)).toBe(100);
  });

  it("spot = 0 → zeros (used to be gamma = 0/0 = NaN)", () => {
    const g = calculateGreeks(0, K, T, IV, true);
    allFinite(g);
    expect(g).toEqual({ delta: 0, theta: 0, gamma: 0, vega: 0, d1: 0, d2: 0 });
  });

  it("strike = 0 → zeros (used to be a delta of 1)", () => {
    const g = calculateGreeks(S, 0, T, IV, true);
    allFinite(g);
    expect(g.delta).toBe(0);
  });

  it("NaN / negative spot, strike, T or IV → zeros", () => {
    for (const g of [
      calculateGreeks(NaN, K, T, IV, true),
      calculateGreeks(S, NaN, T, IV, false),
      calculateGreeks(S, K, NaN, IV, true),
      calculateGreeks(S, K, T, NaN, true),
      calculateGreeks(S, K, -1, IV, true),
      calculateGreeks(-S, K, T, IV, true),
      calculateGreeks(S, K, T, -0.13, true),
    ]) {
      allFinite(g);
      expect(g).toEqual({ delta: 0, theta: 0, gamma: 0, vega: 0, d1: 0, d2: 0 });
    }
  });

  it("bsPrice never returns NaN for garbage inputs", () => {
    for (const v of [
      bsPrice(0, K, T, IV, true),
      bsPrice(S, 0, T, IV, false),
      bsPrice(S, K, NaN, IV, true),
      bsPrice(S, K, T, NaN, true),
      bsPrice(S, K, -1, IV, false),
    ]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("impliedVolFromPremium refuses rather than inventing an IV", () => {
    expect(impliedVolFromPremium(NaN, S, K, T, true)).toBeNull();
    expect(impliedVolFromPremium(0, S, K, T, true)).toBeNull();
    expect(impliedVolFromPremium(150, 0, K, T, true)).toBeNull();
    expect(impliedVolFromPremium(150, S, K, 0, true)).toBeNull();
    // a premium below discounted intrinsic (a put well below intrinsic)
    expect(impliedVolFromPremium(1, S, 30000, T, false)).toBeNull();
  });
});

describe("greeks — one CDF implementation, one rate", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/greeks.ts"), "utf8");

  it("the A&S coefficient block exists exactly once", () => {
    expect(src.split("0.254829592").length - 1).toBe(1);
    expect(src.split("function normalCDF").length - 1).toBe(1);
    // the typo'd a2 (-0.284496791) that shipped in one of the three copies
    expect(src).not.toContain("-0.284496791");
  });

  it("calculateGreeks and bsPrice share the same CDF", () => {
    expect(src).toContain("const cdf = normalCDF;");
    expect(src).toContain("const normCdf = normalCDF;");
  });
});
