/// <reference types="bun-types" />
// The risk-free rate is an ASSUMPTION — it must be named, configurable and
// visible, never a silent constant buried in the Black-Scholes maths.
//
// It used to be `const RISK_FREE_RATE = 0.07` (and a second `const r = 0.07`
// inside calculateGreeks) — two independent hardcoded copies that nobody could
// change and nobody could see. Every delta/theta/gamma/vega in the app
// carried 7% invisibly.
import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  calculateGreeks,
  bsPrice,
  getRiskFreeRate,
  getGreeksAssumptions,
  DEFAULT_RISK_FREE_RATE,
} from "@/lib/greeks";

const ORIGINAL = process.env.RISK_FREE_RATE;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RISK_FREE_RATE;
  else process.env.RISK_FREE_RATE = ORIGINAL;
});

describe("greeks — the risk-free rate is explicit and configurable", () => {
  it("has a named default constant", () => {
    expect(DEFAULT_RISK_FREE_RATE).toBe(0.07);
  });

  it("uses the documented default when the env var is absent", () => {
    delete process.env.RISK_FREE_RATE;
    expect(getRiskFreeRate()).toBe(DEFAULT_RISK_FREE_RATE);
    expect(getGreeksAssumptions().riskFreeRateSource).toBe("default");
  });

  it("honours the RISK_FREE_RATE env var", () => {
    process.env.RISK_FREE_RATE = "0.065";
    expect(getRiskFreeRate()).toBe(0.065);
    const a = getGreeksAssumptions();
    expect(a.riskFreeRate).toBe(0.065);
    expect(a.riskFreeRateSource).toBe("env:RISK_FREE_RATE");
    expect(a.model).toBe("Black-Scholes-Merton");
    expect(a.note).toContain("6.50%");
  });

  it("falls back to the default for a broken env value (never a silent 0)", () => {
    for (const bad of ["", "abc", "-0.1", "0"]) {
      process.env.RISK_FREE_RATE = bad;
      expect(getRiskFreeRate()).toBe(DEFAULT_RISK_FREE_RATE);
    }
  });

  it("the maths actually follows the configured rate", () => {
    delete process.env.RISK_FREE_RATE;
    const atDefault = calculateGreeks(100, 100, 0.25, 0.2, true);
    process.env.RISK_FREE_RATE = "0.04";
    const atLower = calculateGreeks(100, 100, 0.25, 0.2, true);
    expect(atLower.d1).not.toBeCloseTo(atDefault.d1, 6);
    // d1 = (ln(S/K) + (r + σ²/2)T) / (σ√T) — a LOWER r gives a lower d1 and
    // therefore a lower ATM call delta.
    expect(atLower.delta).toBeLessThan(atDefault.delta);
  });

  it("bsPrice follows the configured rate too", () => {
    delete process.env.RISK_FREE_RATE;
    const p1 = bsPrice(100, 100, 0.25, 0.2, true);
    process.env.RISK_FREE_RATE = "0.04";
    const p2 = bsPrice(100, 100, 0.25, 0.2, true);
    expect(p2).not.toBeCloseTo(p1, 6);
  });
});

describe("greeks — no hardcoded rate is left inside the maths", () => {
  // Comments are stripped: the file DOCUMENTs the old constant.
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const src = stripComments(readFileSync(join(process.cwd(), "src/lib/greeks.ts"), "utf8"));

  it("has no literal 0.07 rate in the formulas", () => {
    expect(src).not.toMatch(/const\s+r\s*=\s*0\.0\d/);
    // the ONLY 0.07 allowed is the named, documented constant
    expect(src).not.toMatch(/(?<!DEFAULT_)RISK_FREE_RATE\s*=\s*0\.0\d/);
    expect(src).toContain("export const DEFAULT_RISK_FREE_RATE = 0.07;");
  });

  it("the greeks consumers surface the assumptions in their payload", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/option-chain/route.ts"), "utf8");
    expect(route.includes("getGreeksAssumptions")).toBe(true);
    expect(route.includes("assumptions")).toBe(true);
  });
});
