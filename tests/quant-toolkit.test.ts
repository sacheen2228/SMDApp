/// <reference types="bun-types" />
// Quant toolkit — pure math, honest unavailability, scorecard verdicts.

import { describe, it, expect } from "bun:test";
import {
  impliedForward,
  expectedMove,
  firstPassageBaseline,
  thetaGammaBreakeven,
  riskNeutralMass,
  skew,
  realizedVol,
  varianceRiskPremium,
  vwapZ,
  bbStats,
  sizingAndExpectancy,
  callDebitSpread,
  scorecard,
  timingCheck,
  analyzeQuant,
  type QuantStrike,
  type Candle5,
} from "@/lib/quant-toolkit";

// ─── Builders ─────────────────────────────────────────────────────

function leg(o: Partial<QuantLegShape> = {}): QuantStrike["ce"] {
  return {
    ltp: o.ltp ?? 100, iv: o.iv ?? 15, delta: o.delta ?? 0.5, gamma: o.gamma ?? 0.0005,
    theta: o.theta ?? -5, vega: o.vega ?? 20, oi: o.oi ?? 100000, oiChg: o.oiChg ?? 0,
    volume: o.volume ?? 50000, bid: o.bid, ask: o.ask,
  };
}
interface QuantLegShape {
  ltp: number; iv: number; delta: number; gamma: number; theta: number; vega: number;
  oi: number; oiChg: number; volume: number; bid?: number; ask?: number;
}

/** Constant-IV BS-ish synthetic chain around spot (not real BS — parity/BL tests only need consistency). */
function chain(spot: number, opts: { step?: number; n?: number; putIvBump?: number; callMid?: (k: number) => number } = {}): QuantStrike[] {
  const step = opts.step ?? 50;
  const n = opts.n ?? 11;
  const out: QuantStrike[] = [];
  for (let i = -Math.floor(n / 2); i <= Math.floor(n / 2); i++) {
    const k = Math.round(spot / step) * step + i * step;
    const m = Math.abs(k - spot);
    const callPx = Math.max(2, 120 - m * 0.5 + (opts.callMid ? opts.callMid(k) : 0));
    const putPx = Math.max(2, 120 - m * 0.5 + (spot - k) * 0 + (k < spot ? m * 0.0 : 0));
    const putIv = 15 + (opts.putIvBump && k < spot ? opts.putIvBump : 0);
    out.push({
      strike: k,
      ce: leg({ ltp: callPx, iv: 15, bid: callPx - 0.5, ask: callPx + 0.5 }),
      pe: leg({ ltp: putPx, iv: putIv, bid: putPx - 0.5, ask: putPx + 0.5 }),
    });
  }
  return out;
}

function bars(spec: Array<[number, number]>, startPx = 25000): Candle5[] {
  // spec: [close, volume] pairs; synthetic 5m bars
  let t = Date.UTC(2026, 10, 13, 4, 0, 0);
  let px = startPx;
  return spec.map(([c, v]) => {
    const o = px;
    px = c;
    const bar: Candle5 = {
      time: t, open: o, close: c,
      high: Math.max(o, c) * 1.0005, low: Math.min(o, c) * 0.9995, volume: v,
    };
    t += 5 * 60 * 1000;
    return bar;
  });
}

// ─── A. Forward ───────────────────────────────────────────────────

describe("impliedForward", () => {
  it("recovers F ≈ K + (C−P) at the parity strike", () => {
    const strikes: QuantStrike[] = [
      { strike: 25100, ce: leg({ ltp: 100, bid: 99.5, ask: 100.5 }), pe: leg({ ltp: 100, bid: 99.5, ask: 100.5 }) },
      { strike: 25150, ce: leg({ ltp: 90, bid: 89.5, ask: 90.5 }), pe: leg({ ltp: 102, bid: 101.5, ask: 102.5 }) },
      { strike: 25200, ce: leg({ ltp: 80, bid: 79.5, ask: 80.5 }), pe: leg({ ltp: 112, bid: 111.5, ask: 112.5 }) },
    ];
    const r = impliedForward(strikes, 25144, 0.065, 3 / 365);
    expect(r.available).toBe(true);
    // min |C-P| = 0 at 25100 → F ≈ 25100 + e^{rT}·0 = 25100
    expect(r.value!.f).toBeCloseTo(25100, 0);
    expect(r.value!.k).toBe(25100);
    expect(r.value!.basis).toBeCloseTo(-44, 0);
  });

  it("unavailable without strikes/spot/tte", () => {
    expect(impliedForward([], 25000, 0.06, 0.01).available).toBe(false);
    expect(impliedForward(chain(25000), 0, 0.06, 0.01).available).toBe(false);
    expect(impliedForward(chain(25000), 25000, 0.06, 0).available).toBe(false);
  });
});

// ─── D. EM + first passage ────────────────────────────────────────

describe("expectedMove + firstPassageBaseline", () => {
  it("EM matches the formula F·σ·√(h/94500)", () => {
    const r = expectedMove(25000, 15.8, 30);
    expect(r.available).toBe(true);
    const expectEm = 25000 * 0.158 * Math.sqrt(30 / (252 * 375));
    expect(r.value!.em).toBeCloseTo(expectEm, 4);
  });

  it("first passage a/(a+b): equal distances → 0.5, 2:1 target → 1/3", () => {
    expect(firstPassageBaseline(30, 30).value!.p).toBe(0.5);
    expect(firstPassageBaseline(30, 60).value!.p).toBeCloseTo(1 / 3, 10);
    expect(firstPassageBaseline(-1, 30).available).toBe(false);
  });
});

// ─── E. Theta-gamma breakeven ─────────────────────────────────────

describe("thetaGammaBreakeven", () => {
  it("dF = sqrt(2|θ|dt/Γ)", () => {
    // θ = -5/day, Γ = 0.0005, dt = 0.25 day → sqrt(2·5·0.25/0.0005) = sqrt(5000) ≈ 70.7
    const r = thetaGammaBreakeven(0.0005, 5, 0.25);
    expect(r.value!.dF).toBeCloseTo(Math.sqrt(5000), 2);
    expect(thetaGammaBreakeven(0, 5, 0.25).available).toBe(false);
    expect(thetaGammaBreakeven(0.0005, 0, 0.25).available).toBe(false);
  });
});

// ─── F. Breeden-Litzenberger ──────────────────────────────────────

describe("riskNeutralMass", () => {
  it("mass between walls is in [0,1]-ish and counts negative densities", () => {
    const r = riskNeutralMass(chain(25144, { step: 50, n: 21 }), 0.065, 3 / 365, 24950, 25350);
    expect(r.available).toBe(true);
    expect(r.value!.mass).toBeGreaterThan(0);
    expect(r.value!.mass).toBeLessThan(2);
    expect(r.value!.densities.length).toBeGreaterThan(5);
  });

  it("unavailable with <3 strikes", () => {
    expect(riskNeutralMass(chain(25000).slice(0, 2), 0.065, 0.01, 24800, 25200).available).toBe(false);
  });
});

// ─── G. Skew / RV / VRP ───────────────────────────────────────────

describe("skew + realizedVol + varianceRiskPremium", () => {
  it("skew = put IV (−1%) − call IV (+1%)", () => {
    const r = skew(chain(25144, { putIvBump: 3 }), 25144, 1);
    expect(r.available).toBe(true);
    expect(r.value!.skewIv).toBeGreaterThan(0);
    expect(r.value!.putIv - r.value!.callIv).toBeCloseTo(r.value!.skewIv, 10);
  });

  it("RV from 5m log returns, VRP verdicts", () => {
    // rising series with steady step → small RV
    const closes = Array.from({ length: 40 }, (_, i) => 25000 * (1 + 0.0001 * i));
    const rv = realizedVol(closes);
    expect(rv.available).toBe(true);
    const vrp = varianceRiskPremium(15.8, rv.value!.rvPct);
    expect(vrp.available).toBe(true);
    expect(vrp.value!.vrp).toBeGreaterThan(0);
    expect(["cheap", "fair", "expensive"]).toContain(vrp.value!.verdict);
    expect(realizedVol(closes.slice(0, 10)).available).toBe(false);
  });
});

// ─── J. VWAP z + BB stats ─────────────────────────────────────────

describe("vwapZ + bbStats", () => {
  it("z reflects distance from VWAP", () => {
    const bs = Array.from({ length: 30 }, (_, i) => [25000 + i * 5, 1000] as [number, number]);
    const r = vwapZ(bars(bs));
    expect(r.available).toBe(true);
    expect(r.value!.last).toBe(25145);
    expect(Math.abs(r.value!.z)).toBeGreaterThan(0);
    expect(vwapZ([]).available).toBe(false);
  });

  it("BB %B extremes and squeeze percentile", () => {
    // trending up → %B near 1
    const up = Array.from({ length: 60 }, (_, i) => [25000 + i * 20, 1000] as [number, number]);
    const r = bbStats(bars(up));
    expect(r.available).toBe(true);
    expect(r.value!.percentB).toBeGreaterThan(0.7);
    // Squeeze = narrow NOW vs wider history: 40 trending bars (wide bands) then 20 flat bars
    const flat = [
      ...Array.from({ length: 40 }, (_, i) => [25000 + i * 20, 1000] as [number, number]),
      ...Array.from({ length: 20 }, () => [25800, 1000] as [number, number]),
    ];
    const rf = bbStats(bars(flat));
    expect(rf.available).toBe(true);
    expect(rf.value!.squeeze).toBe(true);
    expect(bbStats(bars(up).slice(0, 15)).available).toBe(false);
  });
});

// ─── K/L. Sizing + debit spread ───────────────────────────────────

describe("sizingAndExpectancy + callDebitSpread", () => {
  it("lots floor + breakeven p*", () => {
    // capital 250000, risk 1% → ₹2500 budget; stop 30 pts × Δ0.5 × lot 75 = 1125+75 slippage = 1200/lot → 2 lots
    const r = sizingAndExpectancy({ capital: 250000, riskPct: 1, stopPoints: 30, targetPoints: 60, deltaAbs: 0.5, lotSize: 75, slippagePerLot: 75 });
    expect(r.value!.lots).toBe(2);
    expect(r.value!.rw).toBe(2);
    expect(r.value!.breakevenP).toBeGreaterThan(0);
    expect(r.value!.breakevenP).toBeLessThan(1);
    // unaffordable → 0 lots, never 1
    const r2 = sizingAndExpectancy({ capital: 1000, riskPct: 1, stopPoints: 30, targetPoints: 60, deltaAbs: 0.5, lotSize: 75 });
    expect(r2.value!.lots).toBe(0);
    expect(sizingAndExpectancy({ capital: -1, riskPct: 1, stopPoints: 30, targetPoints: 60, deltaAbs: 0.5, lotSize: 75 }).available).toBe(false);
  });

  it("debit spread geometry", () => {
    const cs = [
      { strike: 25100, ce: leg({ ltp: 100, bid: 99, ask: 101 }), pe: leg({}) },
      { strike: 25200, ce: leg({ ltp: 60, bid: 59, ask: 61 }), pe: leg({}) },
    ];
    const r = callDebitSpread(cs, 25100, 25200, 75);
    expect(r.value!.netDebit).toBe(40);
    expect(r.value!.maxLoss).toBe(3000);
    expect(r.value!.maxProfit).toBe(4500);
    expect(r.value!.breakeven).toBe(25140);
    expect(callDebitSpread(cs, 25200, 25100, 75).available).toBe(false);
  });
});

// ─── Scorecard + timing ───────────────────────────────────────────

describe("scorecard", () => {
  const strongBull = {
    flowBias: "bull" as const,
    trendTf: "up" as const,
    triggerTf: "up" as const,
    vwapSide5m: "above" as const,
    bbRegime: "trending" as const,
    oiWalls: { supportK: 25000, resistanceK: 25400, spotBetweenWalls: true },
    rnMass: { mass: 0.55, negativeCount: 0 },
    chgOiBuildup: "long_buildup" as const,
    pcrTrend: "rising" as const,
    greeksVrp: { verdict: "cheap" as const, thetaBeOk: true },
    crossIndexAgreement: "agree" as const,
    liquidityCost: "good" as const,
    timingOk: true,
    spotDistToWallPct: 0.6,
    smcScore: 2 as const,
    smcTrend: "UP" as const,
  };

  it("strong bull confluence → BUY CE with every row scored", () => {
    const r = scorecard(strongBull);
    expect(r.verdict).toBe("BUY_CE");
    // 10 factors (the SMC layer is the 10th) × 2 points = 20 possible.
    expect(r.rows).toHaveLength(10);
    expect(r.maxTotal).toBe(20);
    expect(r.rows.every((x) => x.score !== null)).toBe(true);
    expect(r.total).toBeGreaterThanOrEqual(11);
    expect(r.confidence).toBe("High");
  });

  it("missing factors cost points — the denominator is the FULL scale", () => {
    // The old denominator excluded unavailable factors, so LESS evidence
    // produced a BETTER ratio (8/14 scorable read as 57% instead of 40%).
    const full = scorecard(strongBull);
    const degraded = scorecard({ ...strongBull, crossIndexAgreement: "unknown", liquidityCost: "unknown", flowBias: "unknown" });
    expect(degraded.maxTotal).toBe(full.maxTotal);
    expect(degraded.total).toBeLessThan(full.total);
    // The RATIO must fall with the evidence — that is the regression guard.
    expect(degraded.total / degraded.maxTotal).toBeLessThan(full.total / full.maxTotal);
    // Degrade enough and the setup stops being a trade.
    const tooThin = scorecard({
      ...strongBull,
      crossIndexAgreement: "unknown", liquidityCost: "unknown", flowBias: "unknown",
      trendTf: "range", triggerTf: "range", vwapSide5m: "unknown", bbRegime: "unknown",
      greeksVrp: { verdict: null, thetaBeOk: null }, timingOk: null, smcScore: null,
    });
    expect(tooThin.verdict).toBe("SKIP");
  });

  it("all-unknown → SKIP with honest null rows", () => {
    const r = scorecard({
      ...strongBull,
      flowBias: "unknown", trendTf: "unknown", triggerTf: "unknown", vwapSide5m: "unknown",
      bbRegime: "unknown", oiWalls: { supportK: null, resistanceK: null, spotBetweenWalls: null },
      rnMass: { mass: null, negativeCount: 0 }, chgOiBuildup: "unknown", pcrTrend: "unknown",
      greeksVrp: { verdict: null, thetaBeOk: null }, crossIndexAgreement: "unknown",
      liquidityCost: "unknown", timingOk: null, smcScore: null, smcTrend: null,
    });
    expect(r.verdict).toBe("SKIP");
    expect(r.rows.every((x) => x.score === null)).toBe(true);
    expect(r.total).toBe(0);
    expect(r.maxTotal).toBe(20);
  });

  it("opposing layers → SKIP; wall proximity → SKIP", () => {
    expect(scorecard({ ...strongBull, triggerTf: "down" }).verdict).toBe("SKIP");
    expect(scorecard({ ...strongBull, spotDistToWallPct: 0.1 }).verdict).toBe("SKIP");
  });

  it("wall-proximity gate uses the wall OPPOSING the trade direction", () => {
    // A long is invalidated by the SUPPORT below, not by the resistance it
    // is aiming at. The old gate compared the NEAREST wall, so a long could
    // be blocked for sitting near its own target.
    const nearResistance = scorecard({
      ...strongBull,
      spotDistToWallPct: 0.05,          // nearest wall = resistance (above)
      spotDistToSupportPct: 1.5,        // support is far → not invalidating
      spotDistToResistancePct: 0.05,
    });
    expect(nearResistance.verdict).toBe("BUY_CE");

    const nearSupport = scorecard({
      ...strongBull,
      spotDistToWallPct: 0.05,
      spotDistToSupportPct: 0.05,       // support is right underfoot → invalid
      spotDistToResistancePct: 1.5,
    });
    expect(nearSupport.verdict).toBe("SKIP");
  });

  it("bear confluence → BUY PE", () => {
    const r = scorecard({
      ...strongBull,
      trendTf: "down", triggerTf: "down", vwapSide5m: "below",
      chgOiBuildup: "short_buildup", pcrTrend: "falling", flowBias: "bear",
      // The SMC structure must not oppose the short, or the trade trigger
      // veto fires (that is the SMC TRADE TRIGGER, tested separately).
      smcTrend: "DOWN",
    });
    expect(r.verdict).toBe("BUY_PE");
  });
});

describe("timingCheck", () => {
  it("enforces windows, first 15m, lunch, loss caps", () => {
    expect(timingCheck(10 * 60, false, 0).ok).toBe(true);
    expect(timingCheck(9 * 60 + 20, false, 0).ok).toBe(false); // first 15m
    expect(timingCheck(12 * 60 + 30, false, 0).ok).toBe(false); // lunch
    expect(timingCheck(15 * 60, false, 0).ok).toBe(false); // after windows
    expect(timingCheck(10 * 60, true, 0).ok).toBe(false); // loss cap
    expect(timingCheck(10 * 60, false, 3).ok).toBe(false); // 3 straight losses
  });
});

// ─── analyzeQuant orchestrator ────────────────────────────────────

describe("analyzeQuant", () => {
  const candles = Array.from({ length: 60 }, (_, i) => ({
    open: 25100 + i * 5, high: 25105 + i * 5, low: 25098 + i * 5,
    close: 25102 + i * 5, volume: 50000,
  }));

  it("full inputs → available block with scorecard + honest reasons", () => {
    const q = analyzeQuant(chain(25144, { step: 50, n: 21 }), {
      spot: 25144, expiryDate: "17-Nov-2026", symbol: "NIFTY",
      vix: 15.8, candles, nowMin: 10 * 60 + 30,
      spotChangePct: 0.25, riskState: { consecutiveLosses: 0, dailyLossPct: 0 },
    });
    expect(q.available).toBe(true);
    expect(q.forward).not.toBeNull();
    expect(q.expectedMove).not.toBeNull();
    expect(q.rvPct).not.toBeNull();
    expect(q.walls).not.toBeNull();
    expect(q.timing.ok).toBe(true);
    expect(q.scorecard).not.toBeNull();
    expect(q.scorecard!.rows).toHaveLength(10);
    expect(q.scorecard!.maxTotal).toBe(20);
    expect(q.quantReasons.length).toBeGreaterThan(2);
  });

  it("no candles → RV/BB/VWAP unavailable, scorecard SKIPs honestly", () => {
    const q = analyzeQuant(chain(25144), {
      spot: 25144, expiryDate: "17-Nov-2026", nowMin: 10 * 60,
    });
    expect(q.rvPct).toBeNull();
    expect(q.bb).toBeNull();
    expect(q.vwapZ).toBeNull();
    expect(q.scorecard!.verdict).toBe("SKIP");
    expect(q.unavailableReasons.some((x) => x.includes("candles"))).toBe(true);
  });

  it("lunch window → timing blocked + reason surfaced", () => {
    const q = analyzeQuant(chain(25144), {
      spot: 25144, expiryDate: "17-Nov-2026", candles, nowMin: 12 * 60 + 30,
    });
    expect(q.timing.ok).toBe(false);
    expect(q.timing.reason).toContain("12:00");
  });

  it("walls are SIDE-CHECKED: support below spot, resistance above", () => {
    // Build a chain where the highest-OI CE sits BELOW spot and the
    // highest-OI PE sits ABOVE spot — the old code sorted the two by price
    // and labelled them support/resistance regardless of side, so a
    // "support" could sit above spot (unreachable) and a "resistance" below.
    const spot = 25144;
    const strikes: QuantStrike[] = [
      { strike: 25100, ce: leg({ ltp: 120, oi: 900000 }), pe: leg({ ltp: 40, oi: 100000 }) },
      { strike: 25150, ce: leg({ ltp: 110, oi: 200000 }), pe: leg({ ltp: 50, oi: 800000 }) },
      { strike: 25200, ce: leg({ ltp: 100, oi: 150000 }), pe: leg({ ltp: 60, oi: 120000 }) },
    ];
    const q = analyzeQuant(strikes, {
      spot, expiryDate: "17-Nov-2026", candles, nowMin: 10 * 60 + 30,
    });
    expect(q.walls).not.toBeNull();
    // Support = PE wall BELOW spot (25100) — the PE OI peak at 25150 is
    // ABOVE spot, so it can never act as support.
    expect(q.walls!.supportK).toBe(25100);
    // Resistance = CE wall ABOVE spot — the highest-OI CE above spot is
    // 25150 (OI 200k), NOT the 25100 peak (OI 900k, below spot) and not
    // 25200 (OI 150k, lower than 25150).
    expect(q.walls!.resistanceK).toBe(25150);
    expect(q.walls!.supportK!).toBeLessThan(spot);
    expect(q.walls!.resistanceK!).toBeGreaterThan(spot);
    expect(q.walls!.spotBetweenWalls).toBe(true);
  });

  it("a one-sided chain reports the missing side honestly (null, not a fake wall)", () => {
    const spot = 25144;
    // Every CE ABOVE spot carries zero OI → there is no resistance wall.
    // The CE at 25100 has huge OI but it is BELOW spot — it must never be
    // promoted to "resistance".
    const strikes: QuantStrike[] = [
      { strike: 25100, ce: leg({ ltp: 120, oi: 900000 }), pe: leg({ ltp: 40, oi: 100000 }) },
      { strike: 25150, ce: leg({ ltp: 110, oi: 0 }), pe: leg({ ltp: 50, oi: 100000 }) },
      { strike: 25200, ce: leg({ ltp: 100, oi: 0 }), pe: leg({ ltp: 60, oi: 100000 }) },
    ];
    const q = analyzeQuant(strikes, {
      spot, expiryDate: "17-Nov-2026", candles, nowMin: 10 * 60 + 30,
    });
    expect(q.walls).not.toBeNull();
    // No CE wall above spot → resistance is unknown, NOT the 25100 peak.
    expect(q.walls!.resistanceK).toBeNull();
    expect(q.walls!.supportK).toBe(25100);
    // "Between walls" is false when a side is missing — it must not claim
    // a band that does not exist.
    expect(q.walls!.spotBetweenWalls).toBe(false);
    // RN mass needs BOTH sides — without them it is honestly unavailable.
    expect(q.rnMass).toBeNull();
    expect(q.unavailableReasons.some((x) => x.includes("RN mass"))).toBe(true);
  });
});
