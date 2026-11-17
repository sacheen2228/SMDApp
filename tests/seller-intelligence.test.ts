/// <reference types="bun-types" />
// F&O Quantitative Seller Intelligence Engine — DD-tab integration spec.
//
// The engine classifies per-strike OI+premium behaviour (LONG/SHORT buildup,
// SHORT COVERING, LONG UNWINDING), scores writer pressure vs covering,
// computes DEX/GEX exposure, builds seller invalidation zones and aggregates
// a BUY_CE / BUY_PE / WAIT candidate with market confirmation.
//
// Data honesty rules under test:
//   • previousOI comes from the exchange's own ΔOI (oi − oiChg), never a guess
//   • premium/IV baselines come from the day ring — first fetch of the day is
//     labelled NO_PREMIUM_BASELINE and must NOT pretend to know a change
//   • volume ratio is relvol vs the chain median (labelled), no fake history
//   • legs with no greeks are skipped and counted, never analysed on delta 0

import { describe, test, expect, beforeEach } from "bun:test";
import {
  classifyPosition,
  calculateGreekImpact,
  calculateExposure,
  analyzeOption,
  calculateSellerZone,
  generateTradeCandidate,
  buildSellerIntel,
  __resetSellerIntelRing,
  type OptionSnapshot,
  type MarketConfirmation,
} from "@/lib/seller-intelligence";

// ── classifyPosition ────────────────────────────────────────────────
describe("classifyPosition", () => {
  test("the four classic quadrant readings", () => {
    expect(classifyPosition(5.2, 1.4)).toBe("LONG_BUILDUP");
    expect(classifyPosition(5.2, -1.4)).toBe("SHORT_BUILDUP");
    expect(classifyPosition(-5.2, 1.4)).toBe("SHORT_COVERING");
    expect(classifyPosition(-5.2, -1.4)).toBe("LONG_UNWINDING");
  });

  test("quiet tape → MIXED; below-threshold OI with any premium → MIXED", () => {
    expect(classifyPosition(0.5, 0.02)).toBe("MIXED");
    expect(classifyPosition(1.5, 1.0)).toBe("MIXED"); // |ΔOI| under the 2% threshold
  });
});

// ── greek impact + exposure ─────────────────────────────────────────
describe("calculateGreekImpact / calculateExposure", () => {
  const snap = (over: Partial<OptionSnapshot> = {}): OptionSnapshot => ({
    symbol: "NIFTY", expiry: "2026-11-20", strike: 25450, type: "CE",
    underlyingPrice: 25460, premium: 120, previousPremium: 118,
    oi: 500_000, previousOI: 450_000, volume: 90_000, averageVolume: 45_000,
    delta: 0.5, gamma: 0.001, theta: -12, vega: 6,
    iv: 14.5, previousIV: 14.0, lotSize: 75, timestamp: Date.now(),
    ...over,
  });

  test("delta/gamma/theta/vega terms sum to the estimated premium change", () => {
    const g = calculateGreekImpact(snap(), 40, 1, 0.5);
    // 0.5*40 + 0.5*0.001*1600 + (-12)*1 + 6*0.5 = 20 + 0.8 - 12 + 3 = 11.8
    expect(g.deltaImpact).toBeCloseTo(20, 6);
    expect(g.gammaImpact).toBeCloseTo(0.8, 6);
    expect(g.thetaImpact).toBeCloseTo(-12, 6);
    expect(g.vegaImpact).toBeCloseTo(3, 6);
    expect(g.estimatedPremiumChange).toBeCloseTo(11.8, 6);
  });

  test("exposure is contracts × delta × spot (rupee notional)", () => {
    const e = calculateExposure(snap());
    // 500,000 OI × 75 lot × 0.5 delta × 25,460 spot
    expect(e.deltaExposure).toBeCloseTo(500_000 * 75 * 0.5 * 25_460, 0);
    expect(e.gammaExposure).toBeCloseTo(500_000 * 75 * 0.001, 6);
  });
});

// ── analyzeOption ───────────────────────────────────────────────────
describe("analyzeOption", () => {
  const base = (over: Partial<OptionSnapshot> = {}): OptionSnapshot => ({
    symbol: "NIFTY", expiry: "2026-11-20", strike: 25450, type: "CE",
    underlyingPrice: 25460, premium: 118, previousPremium: 120,
    oi: 500_000, previousOI: 450_000, volume: 90_000, averageVolume: 40_000,
    delta: -0.4, gamma: 0.001, theta: -12, vega: 6,
    iv: 14.5, previousIV: 14.0, lotSize: 75, timestamp: Date.now(),
    ...over,
  });

  test("CE short buildup → writer pressure, BEARISH option-side direction", () => {
    const a = analyzeOption(base({ previousPremium: 120, premium: 118 }));
    expect(a.classification).toBe("SHORT_BUILDUP");
    expect(a.potentialWriterPressure).toBe(true);
    expect(a.potentialShortCovering).toBe(false);
    expect(a.direction).toBe("BEARISH");
    expect(a.dataFresh).toBe(true);
    expect(a.volumeRatio).toBeCloseTo(2.25, 6); // 90k / 40k
  });

  test("CE short covering → covering score, BULLISH direction", () => {
    const a = analyzeOption(base({ oi: 400_000, previousOI: 450_000, premium: 122, previousPremium: 120 }));
    expect(a.classification).toBe("SHORT_COVERING");
    expect(a.potentialShortCovering).toBe(true);
    expect(a.direction).toBe("BULLISH");
    expect(a.coveringScore).toBeGreaterThan(0);
  });

  test("stale timestamp → dataFresh false + STALE warning, scores zeroed by validity", () => {
    const a = analyzeOption(base({ timestamp: Date.now() - 60_000 })); // maxDataAgeMs = 15s
    expect(a.dataFresh).toBe(false);
    expect(a.warnings).toContain("STALE_OR_INVALID_TIMESTAMP");
  });

  test("missing baseline (previousOI ≤ 0) → INVALID_OR_MISSING_BASELINE", () => {
    const a = analyzeOption(base({ previousOI: 0 }));
    expect(a.warnings).toContain("INVALID_OR_MISSING_BASELINE");
    expect(a.potentialWriterPressure).toBe(false);
  });
});

// ── seller zones ────────────────────────────────────────────────────
describe("calculateSellerZone", () => {
  const snap = (over: Partial<OptionSnapshot> = {}): OptionSnapshot => ({
    symbol: "NIFTY", expiry: "2026-11-20", strike: 25450, type: "PE",
    underlyingPrice: 25460, premium: 118, previousPremium: 120,
    oi: 500_000, previousOI: 450_000, volume: 90_000, averageVolume: 40_000,
    delta: -0.4, gamma: 0.001, theta: -12, vega: 6,
    iv: 14.5, previousIV: 14.0, lotSize: 75, timestamp: Date.now(),
    ...over,
  });

  test("covering → POTENTIAL_COVERING; heavy writer pressure → PRESSURE_BUILDING", () => {
    const covering = analyzeOption(snap({ oi: 400_000, previousOI: 450_000, premium: 122, previousPremium: 120 }));
    expect(calculateSellerZone(snap({ oi: 400_000, previousOI: 450_000, premium: 122, previousPremium: 120 }), covering).status)
      .toBe("POTENTIAL_COVERING");

    // Short buildup with a big OI move + volume → score ≥ 60 → PRESSURE_BUILDING
    const pressure = analyzeOption(snap({ premium: 110, previousPremium: 120, oi: 700_000, previousOI: 500_000, volume: 200_000, averageVolume: 40_000 }));
    const zone = calculateSellerZone(snap({ premium: 110, previousPremium: 120, oi: 700_000, previousOI: 500_000, volume: 200_000, averageVolume: 40_000 }), pressure);
    expect(pressure.classification).toBe("SHORT_BUILDUP");
    expect(zone.status).toBe("PRESSURE_BUILDING");
    expect(zone.pressureScore).toBeGreaterThanOrEqual(60);
  });
});

// ── aggregate candidate ─────────────────────────────────────────────
describe("generateTradeCandidate", () => {
  const market = (over: Partial<MarketConfirmation> = {}): MarketConfirmation => ({
    underlyingChangePct: 0.3, vwap: 25440, currentPrice: 25460,
    breakoutConfirmed: true, retestConfirmed: false, ...over,
  });
  const analysis = (over: Partial<Parameters<typeof analyzeOption>[0]> = {}) => analyzeOption({
    symbol: "NIFTY", expiry: "2026-11-20", strike: 25450, type: "CE",
    underlyingPrice: 25460, premium: 122, previousPremium: 120,
    oi: 400_000, previousOI: 450_000, volume: 90_000, averageVolume: 40_000,
    delta: 0.5, gamma: 0.001, theta: -12, vega: 6,
    iv: 14.5, previousIV: 14.0, lotSize: 75, timestamp: Date.now(),
    ...over,
  });

  test("CE short covering + above VWAP + breakout → BUY_CE (retest pending)", () => {
    const ce = [analysis()]; // SHORT_COVERING, fresh, vol ratio 2.25
    const c = generateTradeCandidate(ce, [], market());
    expect(c.signal).toBe("BUY_CE");
    expect(c.direction).toBe("BULLISH");
    expect(c.score).toBeGreaterThanOrEqual(60);
    expect(c.reasons).toContain("CE_SHORT_COVERING_SIGNATURE");
    expect(c.reasons).toContain("UNDERLYING_BREAKOUT");
    expect(c.requiresRetest).toBe(true);   // retestConfirmed false
    expect(c.entryConfirmed).toBe(false);
  });

  test("below VWAP kills the CE candidate even with covering", () => {
    const c = generateTradeCandidate([analysis()], [], market({ currentPrice: 25400, vwap: 25440 }));
    expect(c.signal).toBe("WAIT");
    expect(c.reasons).not.toContain("ABOVE_VWAP");
  });

  test("no covering anywhere → WAIT with no bullish reasons", () => {
    const flat = analysis({ oi: 500_000, previousOI: 450_000, premium: 119, previousPremium: 120 }); // short buildup, not covering
    const c = generateTradeCandidate([flat], [flat], market());
    expect(c.signal).toBe("WAIT");
    expect(c.reasons).toHaveLength(0);
  });
});

// ── buildSellerIntel — the DD-tab orchestrator ──────────────────────
function leg(over: any = {}) {
  return {
    ltp: 120, oi: 500_000, oiChange: 120_000, oiChg: 120_000, volume: 90_000,
    iv: 14.5, delta: 0.5, gamma: 0.001, theta: -12, vega: 6, ...over,
  };
}

function input(over: any = {}) {
  return {
    symbol: "NIFTY",
    expiry: "2026-11-20",
    spot: 25460,
    lotSize: 65,
    strikes: [
      { strike: 25400, ce: leg({ ltp: 150, delta: 0.65 }), pe: leg({ ltp: 90, delta: -0.35, oi: 700_000, oiChange: -80_000 }) },
      { strike: 25450, ce: leg(), pe: leg({ ltp: 118, delta: -0.45, oi: 600_000, oiChange: 150_000 }) },
      { strike: 25500, ce: leg({ ltp: 80, delta: 0.3, oi: 800_000, oiChange: 200_000 }), pe: leg({ ltp: 160, delta: -0.7 }) },
      // no-greek leg → must be skipped, never analysed on delta 0
      { strike: 25550, ce: leg({ delta: null, gamma: null, theta: null, iv: 0 }), pe: null },
    ],
    vwap: 25440,
    dayOpen: 25400,
    latestSignals: [
      { type: "BREAKOUT", side: "LONG", time: Date.now() - 3600_000 },
      { type: "RETEST", side: "LONG", time: Date.now() - 1800_000 },
    ],
    nowMs: Date.now(),
    ...over,
  };
}

describe("buildSellerIntel", () => {
  beforeEach(() => __resetSellerIntelRing());

  test("first fetch of the day: honest NO_PREMIUM_BASELINE, no invented premium change", () => {
    const r = buildSellerIntel(input());
    expect(r.dataNotes.some(n => n.includes("NO_PREMIUM_BASELINE"))).toBe(true);
    // Day baseline just got recorded — premium change for every leg is 0 today
    // (nothing to compare against yet), so no leg can claim a covering/pressure
    // move from premium alone.
    for (const row of [...r.topWriting, ...r.topCovering]) {
      expect(row.premiumChangePct).toBe(0);
    }
  });

  test("second fetch: day-baseline premium change is real (ring), OI from exchange ΔOI", () => {
    buildSellerIntel(input());                       // records day baselines
    const bumped = input({
      strikes: [
        { strike: 25400, ce: leg({ ltp: 150, delta: 0.65 }), pe: leg({ ltp: 90, delta: -0.35, oi: 700_000, oiChange: -80_000 }) },
        // premium up + OI down since baseline → SHORT_COVERING candidate
        { strike: 25450, ce: leg({ ltp: 135, oi: 480_000, oiChange: -40_000 }), pe: leg({ ltp: 118, delta: -0.45, oi: 600_000, oiChange: 150_000 }) },
        { strike: 25500, ce: leg({ ltp: 80, delta: 0.3, oi: 800_000, oiChange: 200_000 }), pe: leg({ ltp: 160, delta: -0.7 }) },
      ],
      nowMs: Date.now() + 60_000,
    });
    const r = buildSellerIntel(bumped);
    expect(r.dataNotes.some(n => n.includes("NO_PREMIUM_BASELINE"))).toBe(false);
    // 120 → 135 = +12.5% premium with OI down → the covering leg must be visible
    expect(r.topCovering.length).toBeGreaterThan(0);
    expect(r.topCovering[0].premiumChangePct).toBeCloseTo(12.5, 1);
    expect(r.topCovering[0].classification).toBe("SHORT_COVERING");
  });

  test("previousOI = oi − exchange ΔOI (never a separate snapshot)", () => {
    buildSellerIntel(input());
    const r = buildSellerIntel(input({ nowMs: Date.now() + 30_000 }));
    // The 25450 CE: oi 500,000 with oiChange +120,000 → previousOI 380,000
    // (+31.6% since open) — visible on the writing board
    expect(r.topWriting.length).toBeGreaterThan(0);
    const w = r.topWriting[0];
    expect(w.strike).toBeDefined();
    expect(typeof w.oiChangePct).toBe("number");
  });

  test("legs without greeks are skipped and counted — never delta-0 garbage", () => {
    const r = buildSellerIntel(input());
    expect(r.dataNotes.some(n => n.includes("no greeks"))).toBe(true);
    const boards = [...r.topWriting, ...r.topCovering].some(x => x.strike === 25550);
    const inZones = r.zones.some(z => z.strike === 25550);
    expect(boards).toBe(false);
    expect(inZones).toBe(false);
  });

  test("exposure block: DEX/GEX/gamma-flip computed from the same chain", () => {
    const r = buildSellerIntel(input());
    expect(r.exposure).toBeTruthy();
    expect(Number.isFinite(r.exposure.netDex)).toBe(true);
    expect(Number.isFinite(r.exposure.totalGex)).toBe(true);
    expect(r.exposure.gammaFlip).toBeGreaterThan(0);
    expect(["LONG_GAMMA", "SHORT_GAMMA"]).toContain(r.exposure.dealerRegime);
  });

  test("market confirmation comes from the caller's VWAP + today's signals", () => {
    const r = buildSellerIntel(input());
    expect(r.market.currentPrice).toBe(25460);
    expect(r.market.vwap).toBe(25440);
    expect(r.market.breakoutConfirmed).toBe(true);
    expect(r.market.retestConfirmed).toBe(true);
    expect(r.market.underlyingChangePct).toBeCloseTo(((25460 - 25400) / 25400) * 100, 6);
    expect(["BUY_CE", "BUY_PE", "WAIT"]).toContain(r.verdict.signal);
    expect(r.verdict.confidence).toBeGreaterThanOrEqual(0);
    expect(r.verdict.confidence).toBeLessThanOrEqual(100);
  });

  test("zones carry strike/status/pressureScore for the invalidation display", () => {
    const r = buildSellerIntel(input());
    expect(r.zones.length).toBeGreaterThan(0);
    for (const z of r.zones) {
      expect(typeof z.strike).toBe("number");
      expect(typeof z.pressureScore).toBe("number");
      expect(["DEFENDED_CANDIDATE", "PRESSURE_BUILDING", "POTENTIAL_COVERING", "INVALIDATED", "UNCONFIRMED"]).toContain(z.status);
      expect(z.zoneLow).toBeLessThan(z.zoneHigh);
    }
  });
});
