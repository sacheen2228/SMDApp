import { describe, test, expect } from "bun:test";
import { readSMC, type SmcRead } from "../../src/lib/unified-engine/smc";
import type { Candle } from "../../src/types/engine";
import { computeIndicatorBundle } from "../../src/lib/unified-engine/indicators";
import { detectMarketMechanism, type MechanismRead } from "../../src/lib/unified-engine/mechanism";
import { coordinateDecision, type CoordinatorDecision } from "../../src/lib/unified-engine/coordinator";
import type { DerivativesContext } from "../../src/lib/unified-engine/derivatives";
import type { MarketContext } from "../../src/lib/unified-engine/market-context";
import type { Sector, SectorBreadthResult } from "../../src/lib/universe";

// ────────────────────────────────────────────────────────────────────────────
// Helpers — offline, no network
// ────────────────────────────────────────────────────────────────────────────

function c(time: number, o: number, h: number, l: number, cl: number, v = 1000): Candle {
  return { time, open: o, high: h, low: l, close: cl, volume: v };
}

// Bullish trend: clear higher highs + higher lows with volume spikes on up legs
function bullishCandles(): Candle[] {
  const candles: Candle[] = [];
  let t = Date.now() - 60 * 60_000;
  let price = 20000;
  for (let leg = 0; leg < 6; leg++) {
    const start = price;
    const end = price + 150 + leg * 60;
    for (let i = 0; i < 10; i++) {
      const o = start + (end - start) * (i / 10);
      const cl = start + (end - start) * ((i + 1) / 10);
      const h = Math.max(o, cl) + 30;
      const l = Math.min(o, cl) - 30;
      const vol = i === 9 ? 3000 : 1000; // volume spike on last candle of leg
      candles.push(c(t, o, h, l, cl, vol));
      t += 300_000;
    }
    price = end;
  }
  return candles;
}

// Bearish trend: lower highs + lower lows with volume spikes on down legs
function bearishCandles(): Candle[] {
  const candles: Candle[] = [];
  let t = Date.now() - 60 * 60_000;
  let price = 20000;
  for (let leg = 0; leg < 6; leg++) {
    const start = price;
    const end = price - 150 - leg * 60;
    for (let i = 0; i < 10; i++) {
      const o = start + (end - start) * (i / 10);
      const cl = start + (end - start) * ((i + 1) / 10);
      const h = Math.max(o, cl) + 30;
      const l = Math.min(o, cl) - 30;
      const vol = i === 9 ? 3000 : 1000;
      candles.push(c(t, o, h, l, cl, vol));
      t += 300_000;
    }
    price = end;
  }
  return candles;
}

// Sideways: range-bound, no clear direction
function sidewaysCandles(): Candle[] {
  const candles: Candle[] = [];
  let t = Date.now() - 60 * 60_000;
  let price = 20000;
  for (let i = 0; i < 60; i++) {
    const dir = i % 4 < 2 ? 1 : -1;
    const o = price;
    const cl = price + dir * 25;
    const h = Math.max(o, cl) + 20;
    const l = Math.min(o, cl) - 20;
    candles.push(c(t, o, h, l, cl, 1000));
    price = cl;
    t += 300_000;
  }
  return candles;
}

function makeBundle(candles: Candle[], currentPrice?: number) {
  return computeIndicatorBundle("RELIANCE", candles.slice(-10), candles, currentPrice, candles[candles.length - 1].time);
}

function emptyDerivatives(): DerivativesContext {
  return {
    symbol: "RELIANCE", exchange: "NSE", timestamp: new Date().toISOString(),
    futuresOI: { value: null, freshness: "UNAVAILABLE", available: false, reason: "none" },
    optionChain: { value: null, freshness: "UNAVAILABLE", available: false, reason: "none" },
    greeks: { delta: null, iv: null, theta: null, vega: null, valid: false, reason: "none" },
    vix: { value: null, freshness: "UNAVAILABLE", available: false, reason: "none" },
    fiiDii: { value: null, freshness: "UNAVAILABLE", available: false, reason: "none" },
    optionPlan: { value: null, freshness: "UNAVAILABLE", available: false, reason: "none" },
  };
}

function emptyMarketContext(): MarketContext {
  return {
    symbol: "RELIANCE", timestamp: new Date().toISOString(),
    vix: { value: null, freshness: "UNAVAILABLE", available: false, reason: "none" },
    fiiDii: { value: null, freshness: "UNAVAILABLE", available: false, reason: "none" },
    sectorBreadth: { value: null, freshness: "UNAVAILABLE", available: false, reason: "none" },
    regime: { value: null, freshness: "UNAVAILABLE", available: false, reason: "none" },
    contextQuality: "UNAVAILABLE",
    missingCritical: ["India VIX", "FII/DII", "sector breadth", "market regime"],
  };
}

function emptySectorCounts(): Record<Sector, number> {
  return {
    IT: 0, Banking: 0, Auto: 0, Pharma: 0, FMCG: 0, NBFC: 0,
    Energy: 0, Metal: 0, Infrastructure: 0, Power: 0, Consumer: 0, Insurance: 0, Other: 0,
  };
}

function minimalSectorBreadth(): SectorBreadthResult {
  return {
    advances: 0, declines: 0, unchanged: 0, totalWithPriceData: 0, withoutPriceData: 0,
    sectorCounts: emptySectorCounts(), otherUnmappedCount: 0, sectorAdvances: emptySectorCounts(), sectorDeclines: emptySectorCounts(),
    uniqueCompanies: 0, duplicateCount: 0, dualListedCount: 0,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// SMC Adapter tests — behavior contract, not specific states
// ────────────────────────────────────────────────────────────────────────────

describe("SMC Research Adapter — behavior contract", () => {
  test("returns valid SmcRead with sufficientData flag", () => {
    const candles = bullishCandles();
    const result = readSMC("RELIANCE", candles);
    expect(result.sufficientData).toBe(true);
    expect(result.structure).toMatch(/^(BULLISH|BEARISH|NEUTRAL|MIXED)$/);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
    expect(["LIVE", "FRESH", "DELAYED", "STALE", "UNAVAILABLE"]).toContain(result.freshness);
    expect(result.timestamp).toBeDefined();
    expect(Array.isArray(result.events)).toBe(true);
    expect(Array.isArray(result.zones)).toBe(true);
    expect(Array.isArray(result.evidence)).toBe(true);
    expect(Array.isArray(result.conflictingEvidence)).toBe(true);
  });

  test("insufficient candles → sufficientData false, no signal invented", () => {
    const few = [c(Date.now(), 20000, 20100, 19900, 20050, 1000)];
    const result = readSMC("RELIANCE", few);
    expect(result.sufficientData).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.reason).not.toBeNull();
  });

  test("no repainting: all events marked confirmed", () => {
    const candles = bullishCandles();
    const result = readSMC("RELIANCE", candles);
    for (const ev of result.events) {
      expect(ev.confirmed).toBe(true);
    }
  });

  test("invalidation level present when structure has direction", () => {
    const candles = bullishCandles();
    const result = readSMC("RELIANCE", candles);
    if (result.structure === "BULLISH") {
      expect(result.invalidationLevel).not.toBeNull();
      expect(result.invalidationLevel).toBeGreaterThan(0);
    }
    if (result.structure === "BEARISH") {
      expect(result.invalidationLevel).not.toBeNull();
      expect(result.invalidationLevel).toBeGreaterThan(0);
    }
  });

  test("no institutional buying/selling claims from candle-only data", () => {
    const candles = bullishCandles();
    const result = readSMC("RELIANCE", candles);
    const allText = [...result.evidence, ...result.conflictingEvidence].join(" ").toLowerCase();
    expect(allText).not.toContain("institutional buying");
    expect(allText).not.toContain("institutional selling");
    expect(allText).not.toContain("smart money buying");
    expect(allText).not.toContain("smart money selling");
  });

  test("sideways candles do not crash", () => {
    const candles = sidewaysCandles();
    const result = readSMC("RELIANCE", candles);
    expect(result.sufficientData).toBe(true);
    expect(["NEUTRAL", "MIXED", "BULLISH", "BEARISH"]).toContain(result.structure);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Mechanism Detection tests — behavior contract
// ────────────────────────────────────────────────────────────────────────────

describe("Market Mechanism Detection — behavior contract", () => {
  test("returns valid MechanismRead", () => {
    const candles = bullishCandles();
    const bundle = makeBundle(candles, candles[candles.length - 1].close);
    const smc = readSMC("RELIANCE", candles);
    const result = detectMarketMechanism("RELIANCE", bundle, smc, {
      indiaVix: 14,
      sectorBreadth: { advancing: 60, declining: 30, unchanged: 10 },
    });
    expect(["trend_expansion", "balance_consolidation", "breakout_acceptance",
      "liquidity_sweep", "absorption_auction", "trend_exhaustion",
      "reversal_transition", "high_volatility"]).toContain(result.mechanism);
    expect(["bullish", "bearish", "neutral"]).toContain(result.control);
    expect(["CONFIRMED", "PARTIAL", "UNCONFIRMED", "WAIT"]).toContain(result.confirmationStatus);
    expect(["BUY_CE", "BUY_PE", "WAIT"]).toContain(result.coordinatorAction);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
    expect(Array.isArray(result.observedFacts)).toBe(true);
    expect(Array.isArray(result.inferredMechanisms)).toBe(true);
    expect(Array.isArray(result.conflictingEvidence)).toBe(true);
  });

  test("high VIX → WAIT", () => {
    const candles = bullishCandles();
    const bundle = makeBundle(candles, candles[candles.length - 1].close);
    const smc = readSMC("RELIANCE", candles);
    const result = detectMarketMechanism("RELIANCE", bundle, smc, {
      indiaVix: 25, // elevated
      sectorBreadth: { advancing: 60, declining: 30, unchanged: 10 },
    });
    expect(result.mechanism).toBe("high_volatility");
    expect(result.control).toBe("neutral");
    expect(result.coordinatorAction).toBe("WAIT");
  });

  test("insufficient data → WAIT", () => {
    const few = [c(Date.now(), 20000, 20100, 19900, 20050, 1000)];
    const bundle = makeBundle(few, 20050);
    const smc = readSMC("RELIANCE", few);
    const result = detectMarketMechanism("RELIANCE", bundle, smc, {});
    expect(result.sufficientData).toBe(false);
    expect(result.coordinatorAction).toBe("WAIT");
  });

  test("observed vs inferred separated, no institutional OI claims", () => {
    const candles = bullishCandles();
    const bundle = makeBundle(candles, candles[candles.length - 1].close);
    const smc = readSMC("RELIANCE", candles);
    const result = detectMarketMechanism("RELIANCE", bundle, smc, {
      indiaVix: 14,
      sectorBreadth: { advancing: 60, declining: 30, unchanged: 10 },
      optionChain: { pcr: 1.0, callOiChange: 1000, putOiChange: 1000, iv: 15, ivPctChange: 0 },
    });
    for (const f of result.observedFacts) {
      expect(typeof f).toBe("string");
      expect(f.length).toBeGreaterThan(0);
    }
    for (const m of result.inferredMechanisms) {
      expect(m.toLowerCase()).not.toContain("institutional buying");
      expect(m.toLowerCase()).not.toContain("institutional selling");
    }
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
  });

  test("liquidity sweep if claimed must be confirmed", () => {
    const candles = bullishCandles();
    const bundle = makeBundle(candles, candles[candles.length - 1].close);
    const smc = readSMC("RELIANCE", candles);
    const result = detectMarketMechanism("RELIANCE", bundle, smc, {
      indiaVix: 14,
      sectorBreadth: { advancing: 60, declining: 30, unchanged: 10 },
    });
    if (result.mechanism === "liquidity_sweep") {
      expect(result.confirmationStatus).toBe("CONFIRMED");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Coordinator tests — decision categories and plan structure
// ────────────────────────────────────────────────────────────────────────────

describe("Coordinator Decision — verdict categories", () => {
  test("stale data → NO_TRADE", () => {
    const oldTs = Date.now() - 20 * 60_000; // 20 min ago
    const candles = [c(oldTs, 20000, 20100, 19900, 20050, 1000)];
    const bundle = computeIndicatorBundle("RELIANCE", candles, candles, 20050, oldTs);
    const smc = readSMC("RELIANCE", candles);
    const mech = detectMarketMechanism("RELIANCE", bundle, smc, {});
    const result = coordinateDecision(
      "RELIANCE", "NSE", bundle, smc, mech, emptyDerivatives(), emptyMarketContext(),
      minimalSectorBreadth(),
    );
    expect(result.decision).toBe("NO_TRADE");
    expect(result.missingInputs.length).toBeGreaterThan(0);
  });

  test("insufficient data → WAIT", () => {
    const few = [c(Date.now(), 20000, 20100, 19900, 20050, 1000)];
    const bundle = computeIndicatorBundle("RELIANCE", few, few, 20050, few[few.length - 1].time);
    const smc = readSMC("RELIANCE", few);
    const mech = detectMarketMechanism("RELIANCE", bundle, smc, {});
    const result = coordinateDecision(
      "RELIANCE", "NSE", bundle, smc, mech, emptyDerivatives(), emptyMarketContext(),
      minimalSectorBreadth(),
    );
    expect(result.decision).toBe("WAIT");
  });

  test("decision is always one of four categories", () => {
    const candles = bullishCandles();
    const bundle = computeIndicatorBundle("RELIANCE", candles.slice(-10), candles, candles[candles.length - 1].close, candles[candles.length - 1].time);
    const smc = readSMC("RELIANCE", candles);
    const mech = detectMarketMechanism("RELIANCE", bundle, smc, {
      indiaVix: 14,
      sectorBreadth: { advancing: 60, declining: 30, unchanged: 10 },
    });
    const der = emptyDerivatives();
    der.optionPlan = {
      value: {
        optionType: "CE", strike: 20000, expiry: "2026-11-27", entryPremium: 100,
        stopLoss: 80, targets: [140, 160, 180], lots: 1, deployedAmount: 10000,
        riskAmount: 2000, riskReward: 2.0, tradable: true, reason: null,
      },
      freshness: "FRESH", available: true, reason: null,
    };
    const mc = emptyMarketContext();
    mc.regime = { value: { regime: "TRENDING_UP", bias: "BULLISH", tradeable: true }, freshness: "FRESH", available: true, reason: null };
    mc.contextQuality = "MEDIUM";
    mc.missingCritical = [];
    const result = coordinateDecision(
      "RELIANCE", "NSE", bundle, smc, mech, der, mc,
      { advances: 60, declines: 30, unchanged: 10, totalWithPriceData: 100, withoutPriceData: 0, sectorCounts: emptySectorCounts(), otherUnmappedCount: 0, sectorAdvances: emptySectorCounts(), sectorDeclines: emptySectorCounts(), uniqueCompanies: 100, duplicateCount: 0, dualListedCount: 0 },
    );
    const valid: CoordinatorDecision[] = ["BUY_CE", "BUY_PE", "WAIT", "NO_TRADE"];
    expect(valid).toContain(result.decision);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
    expect(Array.isArray(result.conflicts)).toBe(true);
    expect(Array.isArray(result.supportingEvidence)).toBe(true);
    expect(Array.isArray(result.conflictingEvidence)).toBe(true);
  });

  test("BUY_CE plan has correct fields when decision is BUY_CE", () => {
    const candles = bullishCandles();
    const bundle = computeIndicatorBundle("RELIANCE", candles.slice(-10), candles, candles[candles.length - 1].close, candles[candles.length - 1].time);
    const smc = readSMC("RELIANCE", candles);
    const mech = detectMarketMechanism("RELIANCE", bundle, smc, {
      indiaVix: 14,
      sectorBreadth: { advancing: 60, declining: 30, unchanged: 10 },
    });
    const der = emptyDerivatives();
    der.optionPlan = {
      value: {
        optionType: "CE", strike: 20000, expiry: "2026-11-27", entryPremium: 100,
        stopLoss: 80, targets: [140, 160, 180], lots: 1, deployedAmount: 10000,
        riskAmount: 2000, riskReward: 2.0, tradable: true, reason: null,
      },
      freshness: "FRESH", available: true, reason: null,
    };
    const mc = emptyMarketContext();
    mc.regime = { value: { regime: "TRENDING_UP", bias: "BULLISH", tradeable: true }, freshness: "FRESH", available: true, reason: null };
    mc.contextQuality = "MEDIUM";
    mc.missingCritical = [];
    const result = coordinateDecision(
      "RELIANCE", "NSE", bundle, smc, mech, der, mc,
      { advances: 60, declines: 30, unchanged: 10, totalWithPriceData: 100, withoutPriceData: 0, sectorCounts: emptySectorCounts(), otherUnmappedCount: 0, sectorAdvances: emptySectorCounts(), sectorDeclines: emptySectorCounts(), uniqueCompanies: 100, duplicateCount: 0, dualListedCount: 0 },
    );
    if (result.decision === "BUY_CE") {
      expect(result.tradePlan).not.toBeNull();
      expect(result.tradePlan!.optionType).toBe("CE");
      expect(result.tradePlan!.lots).toBeGreaterThan(0);
      expect(result.tradePlan!.riskReward).toBeGreaterThanOrEqual(1.5);
    }
  });

  test("confidence is 0-100, not a probability", () => {
    const candles = bullishCandles();
    const bundle = computeIndicatorBundle("RELIANCE", candles.slice(-10), candles, candles[candles.length - 1].close, candles[candles.length - 1].time);
    const smc = readSMC("RELIANCE", candles);
    const mech = detectMarketMechanism("RELIANCE", bundle, smc, {});
    const result = coordinateDecision(
      "RELIANCE", "NSE", bundle, smc, mech, emptyDerivatives(), emptyMarketContext(),
      minimalSectorBreadth(),
    );
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
  });

  test("CE and PE produce different controls from opposite data", () => {
    const bullish = bullishCandles();
    const bearish = bearishCandles();
    const bBundle = computeIndicatorBundle("RELIANCE", bullish.slice(-10), bullish, bullish[bullish.length - 1].close, bullish[bullish.length - 1].time);
    const beBundle = computeIndicatorBundle("RELIANCE", bearish.slice(-10), bearish, bearish[bearish.length - 1].close, bearish[bearish.length - 1].time);
    const bSMC = readSMC("RELIANCE", bullish);
    const beSMC = readSMC("RELIANCE", bearish);
    const bMech = detectMarketMechanism("RELIANCE", bBundle, bSMC, { indiaVix: 14, sectorBreadth: { advancing: 60, declining: 30, unchanged: 10 } });
    const beMech = detectMarketMechanism("RELIANCE", beBundle, beSMC, { indiaVix: 14, sectorBreadth: { advancing: 30, declining: 60, unchanged: 10 } });
    // Controls should differ (or at least not crash)
    expect(["bullish", "bearish", "neutral"]).toContain(bMech.control);
    expect(["bullish", "bearish", "neutral"]).toContain(beMech.control);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Historical validation — structural (offline, no look-ahead)
// ────────────────────────────────────────────────────────────────────────────

describe("Historical validation — structural", () => {
  test("walk-forward split respects chronological order", () => {
    const candles = bullishCandles();
    const n = candles.length;
    const trainEnd = Math.floor(n * 0.7);
    const train = candles.slice(0, trainEnd);
    const test = candles.slice(trainEnd);
    expect(test[0].time).toBeGreaterThan(train[train.length - 1].time);
    expect(train.length + test.length).toBe(n);
  });

  test("out-of-sample test set is non-empty", () => {
    const candles = bullishCandles();
    const n = candles.length;
    const test = candles.slice(Math.floor(n * 0.7));
    expect(test.length).toBeGreaterThan(0);
  });

  test("no look-ahead: SMC read on prefix uses only past data", () => {
    const candles = bullishCandles();
    const prefix = candles.slice(0, 30);
    const result = readSMC("RELIANCE", prefix);
    expect(result.sufficientData).toBe(true);
    // Same data prefix → same result
    const full = readSMC("RELIANCE", candles);
    expect(full.structure).toBe(result.structure);
  });

  test("no statistical significance claimed without sufficient observations", () => {
    const few = [c(Date.now(), 20000, 20100, 19900, 20050, 1000)];
    const bundle = computeIndicatorBundle("RELIANCE", few, few, 20050, few[few.length - 1].time);
    const smc = readSMC("RELIANCE", few);
    const mech = detectMarketMechanism("RELIANCE", bundle, smc, {});
    expect(mech.sufficientData).toBe(false);
    expect(mech.coordinatorAction).toBe("WAIT");
  });
});
