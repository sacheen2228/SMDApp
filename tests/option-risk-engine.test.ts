import { describe, it, expect } from "bun:test";
import { runOptionRiskEngine, type OptionRiskInput } from "@/lib/zero-hero/option-risk-engine";
import type { CanonicalMarketSnapshot } from "@/lib/market/canonical";
import type { SDMOptionStrike } from "@/types/sdm";
import type { SMCCandidate } from "@/lib/smc-engine";

// ── Fixture builders ──────────────────────────────────────────────
function makeSnapshot(over: Partial<CanonicalMarketSnapshot> = {}): CanonicalMarketSnapshot {
  return {
    schema_version: 1,
    feature_version: 1,
    engine_version: "1.0.0",
    snapshotId: "NIFTY-test",
    symbol: "NIFTY",
    timestamp: "2026-07-14T09:15:00Z",
    spot: 25000,
    futures: 25010,
    indiaVix: 13,
    pcrOi: 1,
    pcrVol: 1,
    maxPain: 25000,
    iv: 15,
    atr: 200,
    vwap: 24980,
    volume: 1_000_000,
    breadth: { advancers: 20, decliners: 10 },
    optionChain: [],
    smcEvents: [],
    volumeProfile: null,
    aiScores: {},
    features: {},
    ...over,
  };
}

function makeCandidate(over: Partial<SMCCandidate> = {}): SMCCandidate {
  return {
    strike: 25000,
    type: "CE",
    entry: 100,
    sl: 80,
    tp1: 120,
    tp2: 140,
    tp3: 160,
    rr: 2,
    confidence: 80,
    confidenceLabel: "HIGH",
    qualityGrade: "B",
    qualityScore: 80,
    positionSize: { lots: 1, quantity: 65, capitalUsed: 6500, maxLoss: 1300, maxGain: 2600, riskPercent: 1 },
    reasons: ["test"],
    rejectedFilters: [],
    ...over,
  };
}

function makeChain(over: Partial<NonNullable<SDMOptionStrike["ce"]>> = {}): SDMOptionStrike[] {
  return [
    {
      strike: 25000,
      ce: {
        ltp: 100,
        oi: 2_000_000,
        oiChg: 0,
        volume: 2_000_000,
        iv: 15,
        delta: 0.5,
        theta: -2,
        gamma: 0.001,
        vega: 0.1,
        bid: 98,
        ask: 102,
        ...over,
      },
      pe: {
        ltp: 90,
        oi: 1_000_000,
        oiChg: 0,
        volume: 1_000_000,
        iv: 16,
        delta: -0.5,
        theta: -1.5,
        gamma: 0.001,
        vega: 0.1,
        bid: 88,
        ask: 92,
      },
    },
  ];
}

function base(over: Partial<OptionRiskInput> = {}): OptionRiskInput {
  return {
    candidate: makeCandidate(),
    snapshot: makeSnapshot(),
    optionChain: makeChain(),
    daysToExpiry: 3,
    ...over,
  };
}

// ── Tests ─────────────────────────────────────────────────────────
describe("Option Risk Engine — happy path", () => {
  it("passes with healthy option (health >= 80, no reject)", () => {
    const r = runOptionRiskEngine(base());
    expect(r.rejectReason).toBeUndefined();
    expect(r.optionHealth).toBeGreaterThanOrEqual(80);
    expect(r.thetaBurn).toBe("LOW");
    expect(r.gammaBlast).toBe("LOW");
    expect(r.expectedMove).toBeGreaterThan(0);
  });

  it("thetaScore, gammaScore, premiumSurvival are 0-100", () => {
    const r = runOptionRiskEngine(base());
    expect(r.thetaScore).toBeGreaterThanOrEqual(0);
    expect(r.thetaScore).toBeLessThanOrEqual(100);
    expect(r.gammaScore).toBeGreaterThanOrEqual(0);
    expect(r.gammaScore).toBeLessThanOrEqual(100);
    expect(r.premiumSurvival).toBeGreaterThanOrEqual(0);
    expect(r.premiumSurvival).toBeLessThanOrEqual(100);
  });
});

describe("Theta Decay classification", () => {
  it("flags EXTREME theta decay and rejects", () => {
    const chain = makeChain({ theta: -12 }); // 12% of premium(100)
    const r = runOptionRiskEngine(base({ optionChain: chain }));
    expect(r.thetaBurn).toBe("EXTREME");
    expect(r.rejectReason).toContain("theta decay");
  });

  it("classifies LOW theta (<3%)", () => {
    const r = runOptionRiskEngine(base({ optionChain: makeChain({ theta: -2 }) }));
    expect(r.thetaBurn).toBe("LOW");
  });

  it("classifies MEDIUM theta (3-5%)", () => {
    const r = runOptionRiskEngine(base({ optionChain: makeChain({ theta: -4 }) }));
    expect(r.thetaBurn).toBe("MEDIUM");
  });

  it("classifies HIGH theta (5-8%)", () => {
    const r = runOptionRiskEngine(base({ optionChain: makeChain({ theta: -6 }) }));
    expect(r.thetaBurn).toBe("HIGH");
  });
});

describe("Gamma Blast classification + hard reject", () => {
  it("HIGH gamma without structure confirmation rejects", () => {
    // intensity = 0.005*1000*0.4(3dte)*1(atm)*1(atr) = 2 => HIGH
    const chain = makeChain({ gamma: 0.005 });
    const r = runOptionRiskEngine(base({ optionChain: chain }));
    expect(r.gammaBlast).toBe("HIGH");
    expect(r.rejectReason).toContain("high gamma blast without structure");
  });

  it("HIGH gamma WITH full structure confirmation does NOT gamma-reject", () => {
    const chain = makeChain({ gamma: 0.015, iv: 15 }); // dte7 => intensity 2.25 => HIGH
    const r = runOptionRiskEngine(
      base({
        optionChain: chain,
        daysToExpiry: 7,
        trendConfirmed: true,
        bosConfirmed: true,
        chochConfirmed: true,
        volumeConfirmed: true,
      })
    );
    expect(r.gammaBlast).toBe("HIGH");
    expect(r.rejectReason).toBeUndefined();
  });

  it("LOW gamma stays LOW", () => {
    const r = runOptionRiskEngine(base({ optionChain: makeChain({ gamma: 0.001 }) }));
    expect(r.gammaBlast).toBe("LOW");
  });

  it("EXTREME gamma without structure rejects", () => {
    const chain = makeChain({ gamma: 0.02 }); // intensity 8 => EXTREME
    const r = runOptionRiskEngine(base({ optionChain: chain }));
    expect(r.gammaBlast).toBe("EXTREME");
    expect(r.rejectReason).toContain("high gamma blast without structure");
  });
});

describe("Expected Move + target feasibility", () => {
  it("rejects when TP1 underlying move exceeds expected move multiple", () => {
    const chain = makeChain({ iv: 5 }); // small IV => small expected move
    const cand = makeCandidate({ entry: 100, tp1: 200 }); // big premium target
    const r = runOptionRiskEngine(base({ optionChain: chain, candidate: cand }));
    expect(r.rejectReason).toContain("target exceeds expected move");
  });

  it("expected move scales with IV at fixed expiry", () => {
    const a = runOptionRiskEngine(base({ optionChain: makeChain({ iv: 30 }), daysToExpiry: 7 }));
    const b = runOptionRiskEngine(base({ optionChain: makeChain({ iv: 15 }), daysToExpiry: 7 }));
    expect(a.expectedMove).toBeGreaterThan(b.expectedMove);
  });

  it("expected move scales with sqrt(days) at fixed IV", () => {
    const a = runOptionRiskEngine(base({ optionChain: makeChain({ iv: 15 }), daysToExpiry: 7 }));
    const b = runOptionRiskEngine(base({ optionChain: makeChain({ iv: 15 }), daysToExpiry: 1 }));
    expect(a.expectedMove).toBeGreaterThan(b.expectedMove);
  });
});

describe("IV Crush detector", () => {
  it("returns low risk for normal IV without event window and with edge", () => {
    const r = runOptionRiskEngine(base({ optionChain: makeChain({ iv: 15 }), indiaVix: 13 }));
    expect(r.ivCrushRisk).toBeLessThan(20);
  });

  it("returns high risk for high IV + event window + no directional edge", () => {
    const cand = makeCandidate({ confidence: 40 });
    const r = runOptionRiskEngine(
      base({ optionChain: makeChain({ iv: 30 }), indiaVix: 25, candidate: cand, daysToExpiry: 1 })
    );
    expect(r.ivCrushRisk).toBeGreaterThan(60);
  });
});

describe("Dealer Gamma State", () => {
  function chainWith(gammaCE: number, oiCE: number, gammaPE: number, oiPE: number): SDMOptionStrike[] {
    const legs = (g: number, o: number, isCall: boolean) =>
      [25000, 25100, 25200].map((strike) => ({
        strike,
        ...(isCall
          ? {
              ce: { ltp: 100, oi: o, oiChg: 0, volume: o, iv: 15, delta: 0.5, theta: -2, gamma: g, vega: 0.1, bid: 98, ask: 102 },
            }
          : {
              pe: { ltp: 90, oi: o, oiChg: 0, volume: o, iv: 15, delta: -0.5, theta: -2, gamma: g, vega: 0.1, bid: 88, ask: 92 },
            }),
      }));
    return [...legs(gammaCE, oiCE, true), ...legs(gammaPE, oiPE, false)];
  }

  it("SHORT when customers long calls (call gamma*oi dominates)", () => {
    const r = runOptionRiskEngine(base({ optionChain: chainWith(0.002, 2_000_000, 0.002, 100_000) }));
    expect(r.dealerGammaState).toBe("SHORT");
  });

  it("LONG when customers long puts (put gamma*oi dominates)", () => {
    const r = runOptionRiskEngine(base({ optionChain: chainWith(0.002, 100_000, 0.002, 2_000_000) }));
    expect(r.dealerGammaState).toBe("LONG");
  });

  it("NEUTRAL when balanced", () => {
    const r = runOptionRiskEngine(base({ optionChain: chainWith(0.002, 1_000_000, 0.002, 1_000_000) }));
    expect(r.dealerGammaState).toBe("NEUTRAL");
  });
});

describe("Health hard reject", () => {
  it("rejects when option health < 80", () => {
    const chain = makeChain({ theta: -4, gamma: 0.005, iv: 28, oi: 10_000, volume: 10_000 });
    const r = runOptionRiskEngine(base({ optionChain: chain, indiaVix: 25 }));
    expect(r.optionHealth).toBeLessThan(80);
    expect(r.rejectReason).toContain("option health");
  });
});

describe("Determinism / replayability", () => {
  it("produces identical output across runs (pure of inputs)", () => {
    const input = base({ optionChain: makeChain(), snapshot: makeSnapshot(), candidate: makeCandidate() });
    const a = runOptionRiskEngine(input);
    const b = runOptionRiskEngine(JSON.parse(JSON.stringify(input)));
    expect(a).toEqual(b);
  });
});
