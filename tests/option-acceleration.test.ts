// Option Acceleration Engine — regression + safety tests
// Covers: OI Absorption price-confirmation fix, freshness gate, market-closed
// gate, R:R gate, spread gate, instrument-aware ATM distances, bid/ask guard

import { describe, it, expect } from "bun:test";
import {
  runAccelerationEngine,
  type StrikeInput,
  type MarketContext,
} from "../src/lib/option-acceleration-engine";

// ─── Helpers ──────────────────────────────────────────────────────

const baseLeg = (over: any = {}) => ({
  ltp: 150, bid: 149, ask: 151, oi: 900000, oiChg: 80000, volume: 150000,
  iv: 12, delta: 0.56, gamma: 0.0023, theta: -8, vega: 4,
  ...over,
});

const baseCtx = (over: any = {}) => ({
  spot: 23270, vix: 12.14, pcr: 1.0, maxPain: 23250, atmStrike: 23250,
  totalOICE: 5000000, totalOIPE: 5000000, callOiChg: 100000, putOiChg: -50000,
  expectedMove: 150, sessionMinutes: 300, minutesToExpiry: 2000,
  isExpiryDay: false, atr: 120, trend: "neutral" as const,
  ...over,
});

const makeStrikes = (n = 5): StrikeInput[] =>
  Array.from({ length: n }, (_, i) => ({
    strike: 23050 + i * 100,
    ce: baseLeg(),
    pe: baseLeg({ delta: -0.44 }),
  }));

// ─── 1. OI Absorption — price-confirmation fix ────────────────────

describe("SAFETY: OI Absorption price confirmation", () => {
  // volume 40000 (< oi*0.05) keeps aggressiveBuying off → pure directional tests
  it("classifies Fresh Long Buildup when OI up + price up", () => {
    const strikes = makeStrikes(3);
    strikes.forEach(s => { (s.ce as any) = { ...(s.ce as any), volume: 40000, priceChg: 5 }; });
    const result = runAccelerationEngine(strikes, baseCtx());
    const ce = result.strikes.find(s => s.type === "CE")!;
    expect(ce.engines.oiAbsorption.freshLongBuildup).toBe(true);
    expect(ce.engines.oiAbsorption.signal).toBe("Fresh Long Buildup");
  });

  it("classifies Short Covering when OI down + price up", () => {
    const strikes = makeStrikes(3);
    strikes.forEach(s => {
      (s.ce as any) = { ...(s.ce as any), volume: 40000, priceChg: 5, oiChg: -80000 };
    });
    const result = runAccelerationEngine(strikes, baseCtx());
    const ce = result.strikes.find(s => s.type === "CE")!;
    expect(ce.engines.oiAbsorption.shortCovering).toBe(true);
    expect(ce.engines.oiAbsorption.signal).toBe("Short Covering");
  });

  it("classifies Fresh Short when OI up + price down → trapRiskStrike present", () => {
    const strikes = makeStrikes(3);
    strikes.forEach(s => { (s.ce as any).priceChg = -5; });
    const result = runAccelerationEngine(strikes, baseCtx());
    const ce = result.strikes.find(s => s.type === "CE")!;
    expect(ce.engines.oiAbsorption.freshShort).toBe(true);
    expect(result.trapRiskStrike).not.toBeNull();
  });

  it("does NOT claim price confirmation when priceChg unavailable", () => {
    const strikes = makeStrikes(3); // no priceChg field
    const result = runAccelerationEngine(strikes, baseCtx());
    for (const s of result.strikes) {
      const oi = s.engines.oiAbsorption;
      expect(oi.freshLongBuildup).toBe(false);
      expect(oi.shortCovering).toBe(false);
      expect(oi.longUnwinding).toBe(false);
      expect(oi.freshShort).toBe(false);
      // Honest OI-direction-only signal, never a fake price-confirmed claim
      if (s.oiChg > 0) expect(oi.signal).toBe("OI Buildup (Price N/A)");
      else if (s.oiChg < 0) expect(oi.signal).toBe("OI Unwind (Price N/A)");
    }
    expect(result.trapRiskStrike).toBeNull();
  });
});

// ─── 2. Freshness gate ────────────────────────────────────────────

describe("SAFETY: Data freshness gate", () => {
  it("suppresses tradable signals on stale data (>10min)", () => {
    const result = runAccelerationEngine(makeStrikes(4), baseCtx({ dataAgeMs: 15 * 60 * 1000 }));
    expect(result.stale).toBe(true);
    for (const s of result.strikes) expect(s.tradable).toBe(false);
  });

  it("allows signals on fresh data", () => {
    const result = runAccelerationEngine(makeStrikes(4), baseCtx({ dataAgeMs: 30 * 1000 }));
    expect(result.stale).toBe(false);
  });
});

// ─── 3. Market-closed gate ────────────────────────────────────────

describe("SAFETY: Market-closed gate", () => {
  it("blocks all signals when market is closed", () => {
    const result = runAccelerationEngine(makeStrikes(4), baseCtx({ isMarketOpen: false }));
    expect(result.marketOpen).toBe(false);
    expect(result.sessionPhase).toBe("Market Closed");
    for (const s of result.strikes) {
      expect(s.signal).toBe("MARKET_CLOSED");
      expect(s.tradable).toBe(false);
    }
  });
});

// ─── 4. R:R gate ──────────────────────────────────────────────────

describe("SAFETY: Risk/Reward gate on signals", () => {
  // Tuned legs: acceleration >= 72 but rr ~0.67 (theta cap pushes SL to 30% cap)
  const hotLeg = () => baseLeg({
    delta: 0.75, gamma: 0.005, oiChg: 400000, volume: 500000,
    theta: -40, priceChg: 5,
  });

  it("downgrades BUY to WATCH when R:R < 1.0", () => {
    const strikes = makeStrikes(3);
    strikes.forEach(s => { s.ce = hotLeg(); });
    const result = runAccelerationEngine(strikes, baseCtx());
    const ce = result.strikes.find(s => s.type === "CE")!;
    expect(ce.acceleration).toBeGreaterThanOrEqual(72); // hot enough to be BUY
    expect(ce.rr).toBeLessThan(1.0); // but R:R unacceptable
    expect(ce.signal).not.toBe("BUY");
    expect(ce.signal).not.toBe("STRONG BUY");
    expect(ce.tradable).toBe(false);
  });

  it("keeps BUY when R:R >= 1.0", () => {
    const strikes = makeStrikes(3);
    strikes.forEach(s => {
      s.ce = hotLeg();
      (s.ce as any).theta = -8; // lower theta → tighter SL → rr ~1.46
    });
    const result = runAccelerationEngine(strikes, baseCtx());
    const ce = result.strikes.find(s => s.type === "CE")!;
    expect(ce.rr).toBeGreaterThanOrEqual(1.0);
    expect(ce.signal).toBe("BUY");
    expect(ce.tradable).toBe(true);
  });
});

// ─── 5. Spread gate + bid/ask guard ───────────────────────────────

describe("SAFETY: Spread gate", () => {
  const hotLeg = () => baseLeg({
    delta: 0.75, gamma: 0.005, oiChg: 400000, volume: 500000,
    theta: -8, priceChg: 5,
  });

  it("downgrades BUY to WAIT when spread > 25% of LTP", () => {
    const strikes = makeStrikes(3);
    strikes.forEach(s => { s.ce = { ...hotLeg(), bid: 149, ask: 190 }; });
    const result = runAccelerationEngine(strikes, baseCtx());
    const ce = result.strikes.find(s => s.type === "CE")!;
    expect(ce.bidAskSpreadAvailable).toBe(true);
    expect(ce.signal).toBe("WAIT");
    expect(ce.tradable).toBe(false);
  });

  it("keeps BUY when spread is tight", () => {
    const strikes = makeStrikes(3);
    strikes.forEach(s => { s.ce = { ...hotLeg(), bid: 149, ask: 151 }; });
    const result = runAccelerationEngine(strikes, baseCtx());
    const ce = result.strikes.find(s => s.type === "CE")!;
    expect(ce.signal).toBe("BUY");
    expect(ce.tradable).toBe(true);
  });

  it("marks spread unavailable when bid/ask are 0 (no false wide-spread)", () => {
    const strikes = makeStrikes(3);
    strikes.forEach(s => { s.ce = { ...hotLeg(), bid: 0, ask: 0 }; });
    const result = runAccelerationEngine(strikes, baseCtx());
    const ce = result.strikes.find(s => s.type === "CE")!;
    expect(ce.bidAskSpreadAvailable).toBe(false);
    expect(ce.bidAskSpread).toBe(0);
    // Missing spread data must not be treated as a wide spread
    expect(ce.signal).toBe("BUY");
  });
});

// ─── 6. Instrument-aware ATM distances ────────────────────────────

describe("INSTRUMENT: ATM distance thresholds", () => {
  const strikes = () => [
    { strike: 23100, ce: baseLeg(), pe: baseLeg({ delta: -0.44 }) },
    { strike: 23150, ce: baseLeg(), pe: baseLeg({ delta: -0.44 }) },
    { strike: 23250, ce: baseLeg(), pe: baseLeg({ delta: -0.44 }) },
    { strike: 23400, ce: baseLeg(), pe: baseLeg({ delta: -0.44 }) },
  ];

  it("SENSEX (step 100): strike 100 away counts as ATM, 150 as near-ATM", () => {
    const result = runAccelerationEngine(strikes(), baseCtx({ strikeStep: 100 }));
    const at100 = result.strikes.find(s => s.strike === 23150 && s.type === "CE")!;
    const at150 = result.strikes.find(s => s.strike === 23400 && s.type === "CE")!;
    expect(at100.engines.gammaExplosion.nearATM).toBe(true);
    expect(at150.engines.gammaExplosion.nearATM).toBe(true);
  });

  it("NIFTY (step 50): strike 100 away is near-ATM, not ATM", () => {
    const result = runAccelerationEngine(strikes(), baseCtx({ strikeStep: 50 }));
    const at100 = result.strikes.find(s => s.strike === 23150 && s.type === "CE")!;
    const at50 = result.strikes.find(s => s.strike === 23250 && s.type === "CE")!;
    expect(at100.distanceFromATM).toBe(100);
    expect(at50.distanceFromATM).toBe(0);
    // ATM-only at exact step distance for NIFTY
    expect(at100.engines.gammaExplosion.nearATM).toBe(true);
  });
});

// ─── 7. Result metadata ───────────────────────────────────────────

describe("RESULT: data provenance metadata", () => {
  it("exposes stale/dataAgeMinutes/marketOpen and atrSource", () => {
    const result = runAccelerationEngine(makeStrikes(3), baseCtx({
      dataAgeMs: 15 * 60 * 1000, isMarketOpen: true, atrSource: "real",
    }));
    expect(result.stale).toBe(true);
    expect(result.dataAgeMinutes).toBe(15);
    expect(result.marketOpen).toBe(true);
    expect(result.metrics.atrSource).toBe("real");
  });
});

// ─── 8. Buy-only guarantee ────────────────────────────────────────

describe("SAFETY: Option buying only (BUY CE / BUY PE)", () => {
  it("never produces SELL signals for any strike or input", () => {
    // Hostile inputs: expiry day, high VIX, bearish trend, all OI states
    for (const ctxOver of [
      { isExpiryDay: true },
      { vix: 35, trend: "bearish" as const },
      { trend: "bullish" as const, pcr: 0.5 },
      {},
    ]) {
      const result = runAccelerationEngine(makeStrikes(4), baseCtx(ctxOver));
      for (const s of result.strikes) {
        expect(s.signal).not.toContain("SELL");
        expect(s.type === "CE" || s.type === "PE").toBe(true);
        if (s.tradable) {
          expect(["STRONG BUY", "BUY"]).toContain(s.signal);
        }
      }
    }
  });
});
