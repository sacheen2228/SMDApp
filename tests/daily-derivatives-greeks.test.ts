// ═══════════════════════════════════════════════════════════════════════════
// Daily Derivatives — LIVE CHAIN GREEKS + PROVENANCE
//
// The canonical data layer (`@/lib/data-layer/chains/option-chain`) already
// computes PER-LEG Greeks — the provider's own values when it ships them,
// Black-Scholes from the provider's IV when it does not (deriveLegGreeks),
// plus the `deltaSource` label that says which one it was.
//
// The DD card used to DROP all of that in its ce/pe -> call/put mapping
// (ltp/oi/oiChange/volume/bid/ask only) and then re-derive a single ATM leg
// from the premium — so the card showed ONE greek row and ignored the live
// chain's own numbers.
//
// These tests pin that the live Greeks reach the card, that a leg WITHOUT
// greeks stays honestly unknown (never a fabricated 0), and that the report
// carries the chain's provenance (source / freshness / fallback).
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapChainStrikes } from "@/lib/DailyDerivatives";

const SRC = readFileSync(join(process.cwd(), "src/lib/DailyDerivatives.ts"), "utf-8");

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = SRC.indexOf(startMarker);
  const end = SRC.indexOf(endMarker, start + startMarker.length);
  return SRC.slice(start, end > start ? end : start + 4000);
}

describe("Daily Derivatives — the live chain's Greeks", () => {
  it("the mapping KEEPS the Greeks the data layer computed", () => {
    const out = mapChainStrikes([
      {
        strike: 24500,
        ce: {
          ltp: 120, oi: 900, oiChg: 12, volume: 5, iv: 14.2, bid: 119, ask: 121,
          delta: 0.52, gamma: 0.0011, theta: -8.4, vega: 4.5, deltaSource: "bs",
        },
        pe: null,
      },
    ]);
    const g = out[0].call!.greeks;
    expect(g).toBeDefined();
    expect(g!.delta).toBe(0.52);
    expect(g!.gamma).toBe(0.0011);
    expect(g!.theta).toBe(-8.4);
    expect(g!.vega).toBe(4.5);
    expect(g!.iv).toBe(14.2);
    expect(g!.deltaSource).toBe("bs");
  });

  it("a leg without Greeks stays undefined — never a fabricated zero", () => {
    const out = mapChainStrikes([
      {
        strike: 24500,
        ce: {
          ltp: 120, oi: 900, oiChg: 0, volume: 0, iv: null, bid: null, ask: null,
          delta: null, gamma: null, theta: null, vega: null,
        },
        pe: null,
      },
    ]);
    expect(out[0].call!.greeks).toBeUndefined();
  });

  it("a provider greek is labelled as such (provider vs bs)", () => {
    const out = mapChainStrikes([
      {
        strike: 24500,
        ce: {
          ltp: 120, oi: 900, oiChg: 0, volume: 0, iv: 13.9, bid: 119, ask: 121,
          delta: 0.48, gamma: 0.001, theta: -8, vega: 4.2, deltaSource: "provider",
        },
        pe: null,
      },
    ]);
    expect(out[0].call!.greeks!.deltaSource).toBe("provider");
  });

  it("the ATM leg reads the CHAIN's Greeks instead of re-deriving from the premium", () => {
    // The decision moved into `resolveAtmIv` (now unit-tested for real in
    // daily-derivatives-atm-iv.test.ts) — the report assembly just delegates,
    // so this block must no longer re-derive an IV from the premium itself.
    const atmBlock = sliceBetween("// ATM Greeks", "// Top OI");
    expect(atmBlock).toMatch(/resolveAtmIv/);
    expect(atmBlock).not.toMatch(/impliedVolFromPremium/);

    // ...and the helper it delegates to must be the one reading the chain.
    const start = SRC.indexOf("export function resolveAtmIv");
    expect(start).toBeGreaterThan(-1);
    const resolve = SRC.slice(start, start + 900);
    expect(resolve).toMatch(/atm\??\.call\??\.greeks/);
  });

  it("the report carries the per-strike Greeks and the chain provenance", () => {
    // per-strike Greeks on the report interface
    expect(SRC).toMatch(/greeks\??:\s*\{[^}]*strike/);
    // the chain's own provenance — which provider, how fresh, was a fallback used
    expect(SRC).toMatch(/chainFallbackUsed\??:\s*boolean/);
    expect(SRC).toMatch(/providerQuoteTime\??:\s*string\s*\|\s*null/);
    // and the report assembly fills them from the chain result
    const assembly = sliceBetween("dataSource: chainResult.source", "return report");
    expect(assembly).toMatch(/chainFallbackUsed/);
    expect(assembly).toMatch(/providerQuoteTime/);
  });

  it("the VIX falls back to the chain's ATM IV (the shared resolveVix policy), never a silent 0", () => {
    // the shared VIX policy is used — exchange VIX -> chain ATM IV -> stated estimate
    expect(SRC).toMatch(/resolveVix/);
    // and the estimate is labelled, so the UI can say "not the exchange number"
    expect(SRC).toMatch(/indiaVixSource/);
  });
});
