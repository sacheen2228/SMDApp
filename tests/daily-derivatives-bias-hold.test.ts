/// <reference types="bun-types" />
// Preferred-side hysteresis (stop PE/CE ★ flip-flop) + data-driven hold time
// (EMA cross / OI / greeks / seller stop — not a static table).

import { describe, test, expect, beforeEach } from "bun:test";
import {
  resolvePreferredSide,
  resolvePlanDecision,
  computeHoldTime,
  estimateHoldTime,
  __resetPreferredLocksForTests,
  __resetPlanSnapshotsForTests,
  __resetPlanDecisionLocksForTests,
  type EmaBarState,
} from "@/lib/DailyDerivatives";

const T0 = 1_793_950_000_000;

beforeEach(() => {
  __resetPreferredLocksForTests();
  __resetPlanSnapshotsForTests();
  __resetPlanDecisionLocksForTests();
});

describe("preferredSide hysteresis — the ★ must not flip PE↔CE every poll", () => {
  test("first directional vote confirms immediately", () => {
    const r = resolvePreferredSide("NIFTY", "CALL", T0);
    expect(r.side).toBe("CALL");
    expect(r.status).toBe("confirmed");
  });

  test("repeating the same side keeps it confirmed", () => {
    resolvePreferredSide("NIFTY", "CALL", T0);
    const r = resolvePreferredSide("NIFTY", "CALL", T0 + 15_000);
    expect(r.side).toBe("CALL");
    expect(r.status).toBe("confirmed");
  });

  test("one opposing poll does NOT flip (pending only)", () => {
    resolvePreferredSide("NIFTY", "CALL", T0);
    const r = resolvePreferredSide("NIFTY", "PUT", T0 + 15_000);
    expect(r.side).toBe("CALL");
    expect(r.status).toBe("pending");
    expect(r.pending).toBe("PUT");
  });

  test("flip needs both count≥2 AND min persistence", () => {
    resolvePreferredSide("NIFTY", "CALL", T0);
    resolvePreferredSide("NIFTY", "PUT", T0 + 15_000);
    const early = resolvePreferredSide("NIFTY", "PUT", T0 + 30_000);
    expect(early.side).toBe("CALL");
    expect(early.status).toBe("pending");

    const late = resolvePreferredSide("NIFTY", "PUT", T0 + 2 * 60_000 + 16_000);
    expect(late.side).toBe("PUT");
    expect(late.status).toBe("confirmed");
  });

  test("a different opposing poll resets the pending streak", () => {
    resolvePreferredSide("NIFTY", "CALL", T0);
    resolvePreferredSide("NIFTY", "PUT", T0 + 15_000);
    const r = resolvePreferredSide("NIFTY", "CALL", T0 + 30_000);
    expect(r.side).toBe("CALL");
    expect(r.status).toBe("confirmed");
    expect(r.pending).toBeNull();
  });

  test("NEUTRAL holds the confirmed side (does not clear the ★)", () => {
    resolvePreferredSide("NIFTY", "CALL", T0);
    const r = resolvePreferredSide("NIFTY", null, T0 + 15_000);
    expect(r.side).toBe("CALL");
    expect(r.status).toBe("confirmed");
  });

  test("NEUTRAL with no prior confirmation stays none", () => {
    const r = resolvePreferredSide("NIFTY", null, T0);
    expect(r.side).toBeNull();
    expect(r.status).toBe("none");
  });

  test("symbols are independent", () => {
    resolvePreferredSide("NIFTY", "CALL", T0);
    const s = resolvePreferredSide("SENSEX", "PUT", T0);
    expect(s.side).toBe("PUT");
    expect(s.status).toBe("confirmed");
  });
});

// ── computeHoldTime — live EMA / OI / greeks / seller stop ──────────

function ema(over: Partial<EmaBarState> = {}): EmaBarState {
  return {
    trend: "UP",
    adx: 28,
    plusDI: 22,
    minusDI: 10,
    emaFast: 25720,
    emaSlow: 25680,
    atr: 40,
    gapAtr: 1.0,
    ...over,
  };
}

describe("computeHoldTime — EMA cross drives the window", () => {
  test("aligned trend + strong ADX extends toward the TP ladder", () => {
    const r = computeHoldTime({
      daysToExpiry: 6,
      setup: "BREAKOUT LONG @ 25943 (68)",
      optionType: "CE",
      ema: ema({ trend: "UP", adx: 30, gapAtr: 0.8 }),
      delta: 0.55,
      entry: 250,
      stopLoss: 200,
    });
    expect(r.minutesHigh).toBeGreaterThan(240);
    expect(r.reasons.join(" ")).toMatch(/trend aligned/i);
    expect(r.reasons.join(" ")).toMatch(/ADX/);
  });

  test("EMA against the option side caps the hold short", () => {
    const r = computeHoldTime({
      daysToExpiry: 6,
      setup: "PULLBACK LONG @ 25700 (70)",
      optionType: "CE",
      ema: ema({ trend: "DOWN", adx: 22, gapAtr: 0.4 }),
      delta: 0.55,
      entry: 250,
      stopLoss: 200,
    });
    expect(r.minutesHigh).toBeLessThanOrEqual(90);
    expect(r.reasons.join(" ")).toMatch(/against option side/i);
  });

  test("flat EMA cross (chop) shortens the hold", () => {
    const r = computeHoldTime({
      daysToExpiry: 6,
      optionType: "PE",
      ema: ema({ trend: "NONE", adx: 12, gapAtr: 0.05 }),
      delta: 0.5,
      entry: 220,
      stopLoss: 180,
    });
    expect(r.minutesHigh).toBeLessThanOrEqual(90);
    expect(r.reasons.join(" ")).toMatch(/flat EMA|chop/i);
  });

  test("missing EMA falls back to the DTE base (no crash)", () => {
    const r = computeHoldTime({ daysToExpiry: 6, optionType: "CE" });
    expect(r.minutesLow).toBeGreaterThanOrEqual(60);
    expect(r.reasons.join(" ")).toMatch(/unavailable/i);
  });
});

describe("computeHoldTime — OI wall + unwinding", () => {
  test("defended wall in the TP path caps the hold", () => {
    const r = computeHoldTime({
      daysToExpiry: 6,
      setup: "BREAKOUT LONG @ 25943 (68)",
      optionType: "CE",
      ema: ema({ trend: "UP", adx: 30 }),
      delta: 0.55,
      wall: { strike: 25900, oi: 600000, oiChange: 20000 },
      entry: 250,
      stopLoss: 200,
    });
    expect(r.minutesHigh).toBeLessThanOrEqual(120);
    expect(r.reasons.join(" ")).toMatch(/wall 25900/i);
  });

  test("heavy unwinding of this leg shortens the hold", () => {
    const r = computeHoldTime({
      daysToExpiry: 6,
      optionType: "CE",
      ema: ema({ trend: "UP", adx: 30 }),
      delta: 0.55,
      oiChange: -8000,
      entry: 250,
      stopLoss: 200,
    });
    expect(r.minutesHigh).toBeLessThanOrEqual(150);
    expect(r.reasons.join(" ")).toMatch(/unwinding/i);
  });
});

describe("computeHoldTime — greeks (delta + theta)", () => {
  test("lottery delta caps at 90 min", () => {
    const r = computeHoldTime({
      daysToExpiry: 6,
      optionType: "CE",
      ema: ema({ trend: "UP", adx: 30 }),
      delta: 0.18,
      entry: 40,
      stopLoss: 34,
    });
    expect(r.minutesHigh).toBeLessThanOrEqual(90);
    expect(r.reasons.join(" ")).toMatch(/lottery/i);
  });

  test("heavy theta (% of premium) shortens the hold", () => {
    const r = computeHoldTime({
      daysToExpiry: 6,
      optionType: "PE",
      ema: ema({ trend: "DOWN", adx: 26 }),
      delta: 0.5,
      theta: -12,
      entry: 100,
      stopLoss: 80,
    });
    expect(r.minutesHigh).toBeLessThanOrEqual(120);
    expect(r.reasons.join(" ")).toMatch(/decay|θ/i);
  });
});

describe("computeHoldTime — seller stop geometry", () => {
  test("tight stop (≤12% of entry) caps the hold", () => {
    const r = computeHoldTime({
      daysToExpiry: 6,
      optionType: "CE",
      ema: ema({ trend: "UP", adx: 20, gapAtr: 0.2 }),
      delta: 0.5,
      entry: 250,
      stopLoss: 230,
    });
    expect(r.minutesHigh).toBeLessThanOrEqual(90);
    expect(r.reasons.join(" ")).toMatch(/tight/i);
  });

  test("wide stop notes room before SL (does not force short)", () => {
    const r = computeHoldTime({
      daysToExpiry: 6,
      setup: "RETEST LONG @ 25700 (80)",
      optionType: "CE",
      ema: ema({ trend: "UP", adx: 28, gapAtr: 0.5 }),
      delta: 0.55,
      entry: 250,
      stopLoss: 175,
    });
    expect(r.reasons.join(" ")).toMatch(/room before SL/i);
    expect(r.minutesHigh).toBeGreaterThan(200);
  });
});

describe("computeHoldTime — DTE + setup floors still apply", () => {
  test("expiry day is short even with a clean trend", () => {
    const r = computeHoldTime({
      daysToExpiry: 0,
      optionType: "CE",
      ema: ema({ trend: "UP", adx: 35 }),
      delta: 0.55,
      entry: 100,
      stopLoss: 85,
    });
    expect(r.minutesLow).toBeLessThanOrEqual(30);
    expect(r.minutesHigh).toBeLessThanOrEqual(90);
    expect(r.reasons.join(" ")).toMatch(/expiry day/i);
  });

  test("FAKEOUT is always capped ≤90 min even with aligned trend", () => {
    const r = computeHoldTime({
      daysToExpiry: 6,
      setup: "FAKEOUT LONG @ 25668 (100)",
      optionType: "CE",
      ema: ema({ trend: "UP", adx: 32, gapAtr: 0.9 }),
      delta: 0.55,
      entry: 250,
      stopLoss: 200,
    });
    expect(r.minutesHigh).toBeLessThanOrEqual(90);
    expect(r.reasons.join(" ")).toMatch(/trap\/reversal/i);
  });
});

describe("estimateHoldTime — back-compat wrapper", () => {
  test("still returns a window string from DTE + setup", () => {
    expect(estimateHoldTime({ daysToExpiry: 0 })).toMatch(/min/);
    expect(estimateHoldTime({ daysToExpiry: 6, setup: "FAKEOUT SHORT" })).toMatch(/min|h/);
  });
});

// ── evaluatePlanTrade — TAKE / WAIT / NO on every card ──────────────

import {
  evaluatePlanTrade,
  computeConfluence,
  evaluateLegLiquidity,
  MAX_SPREAD_PCT,
  REQUIRED_CONFLUENCE_GROUPS,
  LIQUIDITY_UNVERIFIED_POLICY,
} from "@/lib/DailyDerivatives";

// Rich baseline: ≥3 independent evidence GROUPS aligned (pro confluence gate)
// and a real (tight) option book so the liquidity gate is GOOD, not UNVERIFIED.
// Individual tests override one group at a time to hit soft WAIT paths.
const base = {
  optionType: "CE" as const,
  tradable: true,
  lots: 2,
  rr: 2.0,
  entry: 250,
  stopLoss: 200,
  preferredSide: "CALL" as "CALL" | "PUT" | null,
  preferredStatus: "confirmed" as const,
  targetReach: [] as any[],
  sellerSignal: "BUY_CE" as "BUY_CE" | "BUY_PE" | "WAIT" | null,
  marketOpen: true,
  cvdVerdict: "BULLISH",
  ema: {
    trend: "UP" as const,
    adx: 28,
    plusDI: 22,
    minusDI: 14,
    emaFast: 25790,
    emaSlow: 25760,
    atr: 45,
    gapAtr: 0.8,
  },
  sellerCtx: {
    requiresRetest: false,
    entryConfirmed: true,
    score: 60,
    dealerBias: "BULLISH",
    dealerRegime: "SHORT_GAMMA",
    netDex: 5000,
    spot: 25785,
    vwap: 25700,
    priceAboveVwap: true,
  },
  bid: 249,
  ask: 251,
  chainFreshness: "LIVE",
};

describe("evaluatePlanTrade — hard NO (fail closed)", () => {
  test("0 lots → NO", () => {
    const r = evaluatePlanTrade({ ...base, lots: 0, tradable: false });
    expect(r.decision).toBe("NO");
    expect(r.label).toBe("NO TRADE");
    expect(r.reasons.join(" ")).toMatch(/0 lots|ladder/i);
  });

  test("R:R below 1.5 does NOT gate (RR is reported, not a hard NO)", () => {
    const r = evaluatePlanTrade({ ...base, rr: 1.2 });
    expect(r.decision).toBe("TAKE");
    expect(r.reasons.join(" ")).toMatch(/ladder valid/i);
  });

  test("stop above entry → NO", () => {
    const r = evaluatePlanTrade({ ...base, entry: 200, stopLoss: 250 });
    expect(r.decision).toBe("NO");
    expect(r.reasons.join(" ")).toMatch(/stop not below/i);
  });

  test("market closed → NO", () => {
    const r = evaluatePlanTrade({ ...base, marketOpen: false });
    expect(r.decision).toBe("NO");
    expect(r.reasons.join(" ")).toMatch(/market closed/i);
  });
});

describe("evaluatePlanTrade — soft WAIT", () => {
  test("against confirmed ★ bias → WAIT", () => {
    const r = evaluatePlanTrade({
      ...base,
      preferredSide: "PUT",
      preferredStatus: "confirmed",
    });
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/against ★ PE/i);
  });

  test("aligned with ★ → TAKE", () => {
    const r = evaluatePlanTrade({
      ...base,
      preferredSide: "CALL",
      preferredStatus: "confirmed",
    });
    expect(r.decision).toBe("TAKE");
    expect(r.reasons.join(" ")).toMatch(/aligned with ★ CE/i);
  });

  test("TP1 walled → WAIT", () => {
    const r = evaluatePlanTrade({
      ...base,
      targetReach: [
        { target: 379, requiredSpot: 25971, achievable: false, note: "call wall 25800 in the way", wall: { strike: 25800, oi: 110000, oiChange: 40000, side: "call" as const } },
      ],
    });
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/TP1 blocked/i);
  });

  test("TP1 clear → TAKE (neutral ★, other channels carry confluence)", () => {
    const r = evaluatePlanTrade({
      ...base,
      preferredSide: null,
      preferredStatus: "none",
      targetReach: [
        { target: 379, requiredSpot: 25971, achievable: true },
      ],
    });
    expect(r.decision).toBe("TAKE");
    expect(r.reasons.join(" ")).toMatch(/TP1 clear/i);
    expect(r.reasons.join(" ")).toMatch(/neutral bias/i);
  });

  test("seller intel opposite side → WAIT", () => {
    const r = evaluatePlanTrade({ ...base, sellerSignal: "BUY_PE" });
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/BUY_PE/);
  });

  test("seller intel WAIT alone does NOT block (volatile default)", () => {
    const r = evaluatePlanTrade({ ...base, sellerSignal: "WAIT" });
    expect(r.decision).toBe("TAKE");
    expect(r.reasons.join(" ")).toMatch(/neutral \(WAIT/i);
  });

  test("seller agrees → still TAKE with note", () => {
    const r = evaluatePlanTrade({ ...base, sellerSignal: "BUY_CE" });
    expect(r.decision).toBe("TAKE");
    expect(r.reasons.join(" ")).toMatch(/seller intel agrees/i);
  });

  test("pending ★ on the other side → WAIT for this side", () => {
    const r = evaluatePlanTrade({
      ...base,
      preferredSide: "CALL",
      preferredStatus: "pending",
      // this card is PE — wait, optionType is CE base. Flip:
      optionType: "PE",
    });
    // preferred CALL pending, this is PE → WAIT
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/pending|other side/i);
  });
});


// ── resolvePlanDecision — sticky TAKE (no 1-min flicker) ─────────────

describe("resolvePlanDecision — TAKE must not drop on one mixed poll", () => {
  test("first TAKE confirms immediately", () => {
    const r = resolvePlanDecision("NIFTY", "PE", "TAKE", T0);
    expect(r.decision).toBe("TAKE");
    expect(r.status).toBe("confirmed");
  });

  test("one raw WAIT keeps the confirmed TAKE (pending only)", () => {
    resolvePlanDecision("NIFTY", "PE", "TAKE", T0);
    const r = resolvePlanDecision("NIFTY", "PE", "WAIT", T0 + 60_000);
    expect(r.decision).toBe("TAKE");
    expect(r.status).toBe("pending");
    expect(r.pending).toBe("WAIT");
  });

  test("TAKE survives several mixed WAITs within 2 minutes", () => {
    resolvePlanDecision("NIFTY", "PE", "TAKE", T0);
    resolvePlanDecision("NIFTY", "PE", "WAIT", T0 + 30_000);
    const r = resolvePlanDecision("NIFTY", "PE", "WAIT", T0 + 90_000);
    expect(r.decision).toBe("TAKE");
    expect(r.status).toBe("pending");
  });

  test("drop needs count≥2 AND persistence≥2min", () => {
    resolvePlanDecision("NIFTY", "PE", "TAKE", T0);
    resolvePlanDecision("NIFTY", "PE", "WAIT", T0 + 15_000);
    const early = resolvePlanDecision("NIFTY", "PE", "WAIT", T0 + 30_000);
    expect(early.decision).toBe("TAKE");

    const late = resolvePlanDecision("NIFTY", "PE", "WAIT", T0 + 2 * 60_000 + 16_000);
    expect(late.decision).toBe("WAIT");
    expect(late.status).toBe("confirmed");
  });

  test("a raw TAKE mid-pending resets the drop streak", () => {
    resolvePlanDecision("NIFTY", "PE", "TAKE", T0);
    resolvePlanDecision("NIFTY", "PE", "WAIT", T0 + 15_000);
    const r = resolvePlanDecision("NIFTY", "PE", "TAKE", T0 + 30_000);
    expect(r.decision).toBe("TAKE");
    expect(r.status).toBe("confirmed");
    expect(r.pending).toBeNull();
  });

  test("hard NO applies immediately (no wait)", () => {
    resolvePlanDecision("NIFTY", "PE", "TAKE", T0);
    const r = resolvePlanDecision("NIFTY", "PE", "NO", T0 + 1_000);
    expect(r.decision).toBe("NO");
    expect(r.status).toBe("confirmed");
  });

  test("CE and PE locks are independent", () => {
    resolvePlanDecision("NIFTY", "PE", "TAKE", T0);
    const ce = resolvePlanDecision("NIFTY", "CE", "WAIT", T0);
    expect(ce.decision).toBe("WAIT");
    const pe = resolvePlanDecision("NIFTY", "PE", "TAKE", T0 + 1_000);
    expect(pe.decision).toBe("TAKE");
  });
});

describe("evaluatePlanTrade — greeks / EMA / leg-OI / CVD quality gates", () => {
  test("lottery delta < 0.30 → WAIT", () => {
    const r = evaluatePlanTrade({ ...base, delta: 0.18 });
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/lottery delta/i);
  });

  test("healthy ATM delta ≥ 0.30 does not block", () => {
    const r = evaluatePlanTrade({ ...base, delta: 0.47 });
    expect(r.decision).toBe("TAKE");
    expect(r.reasons.join(" ")).toMatch(/\|delta\| 0\.47/);
  });

  test("EMA against CE (DOWN) → WAIT", () => {
    const r = evaluatePlanTrade({
      ...base,
      ema: { trend: "DOWN", adx: 30, plusDI: 10, minusDI: 22, emaFast: 1, emaSlow: 2, atr: 40, gapAtr: 0.5 },
    });
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/against CE/i);
  });

  test("EMA with CE (UP) → TAKE with trend note", () => {
    const r = evaluatePlanTrade({
      ...base,
      ema: { trend: "UP", adx: 30, plusDI: 22, minusDI: 10, emaFast: 2, emaSlow: 1, atr: 40, gapAtr: 0.5 },
    });
    expect(r.decision).toBe("TAKE");
    expect(r.reasons.join(" ")).toMatch(/trend with the option/i);
  });

  test("heavy leg unwinding ΔOI ≤ -5000 → WAIT", () => {
    const r = evaluatePlanTrade({ ...base, oiChange: -8000 });
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/unwinding/i);
  });

  test("leg building ΔOI → TAKE with note", () => {
    const r = evaluatePlanTrade({ ...base, oiChange: 12000 });
    expect(r.decision).toBe("TAKE");
    expect(r.reasons.join(" ")).toMatch(/building/i);
  });

  test("θ ≥4% of premium/day → WAIT", () => {
    const r = evaluatePlanTrade({ ...base, theta: -12, entry: 250 });
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/decay outruns/i);
  });

  test("mild θ does not block", () => {
    const r = evaluatePlanTrade({ ...base, theta: -3, entry: 250 });
    expect(r.decision).toBe("TAKE");
  });

  test("CVD BEARISH against CE → WAIT", () => {
    const r = evaluatePlanTrade({ ...base, cvdVerdict: "BEARISH" });
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/flow against CE/i);
  });

  test("CVD BULLISH with CE → TAKE with flow note", () => {
    const r = evaluatePlanTrade({ ...base, cvdVerdict: "BULLISH" });
    expect(r.decision).toBe("TAKE");
    expect(r.reasons.join(" ")).toMatch(/flow with CE/i);
  });

  test("CVD NEUTRAL never blocks", () => {
    const r = evaluatePlanTrade({ ...base, cvdVerdict: "NEUTRAL" });
    expect(r.decision).toBe("TAKE");
  });

  test("CVD unavailable (null) never blocks", () => {
    const r = evaluatePlanTrade({ ...base, cvdVerdict: null });
    expect(r.decision).toBe("TAKE");
  });
});

// ── assessChop / lastBarRvol — live volume + sideways trap ──────────

import { assessChop, lastBarRvol, countEmaCrosses } from "@/lib/DailyDerivatives";

function bar(o: {
  close: number; high?: number; low?: number; volume?: number;
}): { time: number; open: number; high: number; low: number; close: number; volume: number } {
  const c = o.close;
  return {
    time: 0,
    open: c,
    high: o.high ?? c + 5,
    low: o.low ?? c - 5,
    close: c,
    volume: o.volume ?? 1000,
  };
}

describe("lastBarRvol — honest null, never a fake 1.0", () => {
  test("thin history → null", () => {
    const candles = Array.from({ length: 5 }, (_, i) => bar({ close: 100 + i }));
    expect(lastBarRvol(candles, 20)).toBeNull();
  });

  test("computes last / avg prior", () => {
    const candles = [
      ...Array.from({ length: 20 }, () => bar({ close: 100, volume: 1000 })),
      bar({ close: 101, volume: 2000 }),
    ];
    const r = lastBarRvol(candles, 20);
    expect(r).toBeCloseTo(2.0, 5);
  });

  test("zero volumes → null", () => {
    const candles = [
      ...Array.from({ length: 20 }, () => bar({ close: 100, volume: 0 })),
      bar({ close: 101, volume: 0 }),
    ];
    expect(lastBarRvol(candles, 20)).toBeNull();
  });
});

describe("assessChop — live conditions, no fabrication", () => {
  test("dead RVOL + soft ADX → hard CHOP", () => {
    // Steady mild uptrend (few EMA crosses) + soft ADX + dead volume.
    const r = assessChop({
      ema: ema({ trend: "UP", adx: 18, gapAtr: 0.25 }),
      candles: Array.from({ length: 40 }, (_, i) =>
        bar({ close: 100 + i * 0.3, high: 100 + i * 0.3 + 2, low: 100 + i * 0.3 - 2 }),
      ),
      rvol: 0.4,
    });
    expect(r.chop).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/dead volume/i);
    expect(r.rvol).toBe(0.4);
  });

  test("whipsaw crosses + low ADX → hard CHOP", () => {
    // Alternating closes force EMA9/15 sign flips
    const candles = Array.from({ length: 40 }, (_, i) =>
      bar({ close: i % 2 === 0 ? 100 + (i % 4) : 98 + (i % 4), high: 110, low: 90 }),
    );
    const r = assessChop({
      ema: ema({ trend: "NONE", adx: 14, gapAtr: 0.08 }),
      candles,
      rvol: 1.0,
    });
    expect(r.chop).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(70);
  });

  test("conviction RVOL reduces chop score (does not force chop)", () => {
    const r = assessChop({
      ema: ema({ trend: "UP", adx: 30, gapAtr: 0.4 }),
      candles: Array.from({ length: 40 }, (_, i) => bar({ close: 100 + i * 2, high: 100 + i * 2 + 3, low: 100 + i * 2 - 3 })),
      rvol: 1.8,
    });
    expect(r.chop).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/conviction volume/i);
  });

  test("thin RVOL soft-adds to chop score", () => {
    const trendingish = assessChop({
      ema: ema({ trend: "UP", adx: 24, gapAtr: 0.3 }),
      candles: Array.from({ length: 40 }, (_, i) => bar({ close: 100 + i, high: 100 + i + 2, low: 100 + i - 2 })),
      rvol: 0.7,
    });
    const same = assessChop({
      ema: ema({ trend: "UP", adx: 24, gapAtr: 0.3 }),
      candles: Array.from({ length: 40 }, (_, i) => bar({ close: 100 + i, high: 100 + i + 2, low: 100 + i - 2 })),
      rvol: 1.3,
    });
    expect(trendingish.score).toBeGreaterThan(same.score);
    expect(trendingish.reasons.join(" ")).toMatch(/thin tape|below average/i);
  });

  test("no candles → assessChop still pure (empty = not hard-chop forced)", () => {
    const r = assessChop({ ema: null, candles: [], rvol: null });
    // no evidence either way — score 0, chop false (caller passes null report)
    expect(r.chop).toBe(false);
    expect(r.rvol).toBeNull();
  });

  test("evaluatePlanTrade WAITs on chop", () => {
    const r = evaluatePlanTrade({
      ...base,
      chop: true,
      chopAssessment: {
        chop: true,
        score: 72,
        reasons: ["chop score 72/100 — sideways regime", "RVOL 0.55x — thin tape"],
        rvol: 0.55,
      },
    });
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/chop score 72/i);
  });

  test("evaluatePlanTrade TAKEs when not chop and notes regime", () => {
    const r = evaluatePlanTrade({
      ...base,
      chop: false,
      chopAssessment: {
        chop: false,
        score: 22,
        reasons: ["chop score 22/100 — trending enough"],
        rvol: 1.6,
      },
    });
    expect(r.decision).toBe("TAKE");
    expect(r.reasons.join(" ")).toMatch(/trending enough/i);
  });
});

describe("evaluatePlanTrade — Seller Intelligence context (live fields only)", () => {
  test("AWAITING_RETEST → WAIT", () => {
    const r = evaluatePlanTrade({
      ...base,
      sellerCtx: { requiresRetest: true, entryConfirmed: false, score: 55 },
    });
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/AWAITING_RETEST/i);
  });

  test("entry confirmed does not block; notes on TAKE", () => {
    const r = evaluatePlanTrade({
      ...base,
      sellerCtx: { requiresRetest: false, entryConfirmed: true, score: 62, dealerBias: "BULLISH", dealerRegime: "SHORT_GAMMA", netDex: 4000 },
    });
    expect(r.decision).toBe("TAKE");
    expect(r.reasons.join(" ")).toMatch(/retest ✓/i);
    expect(r.reasons.join(" ")).toMatch(/dealer bias BULLISH — with CE/i);
    expect(r.reasons.join(" ")).toMatch(/net DEX call-delta/i);
  });

  test("dealer BEARISH against CE → WAIT", () => {
    const r = evaluatePlanTrade({
      ...base,
      sellerCtx: { dealerBias: "BEARISH", dealerRegime: "LONG_GAMMA", priceAboveVwap: true, vwap: 25795, spot: 25785 },
    });
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/dealer .*BEARISH — GEX flow against CE/i);
  });

  test("dealer BULLISH with CE does not block", () => {
    const r = evaluatePlanTrade({
      ...base,
      sellerCtx: { dealerBias: "BULLISH", dealerRegime: "SHORT_GAMMA", priceAboveVwap: true, vwap: 25700, spot: 25785 },
    });
    expect(r.decision).toBe("TAKE");
  });

  test("price below VWAP against CE → WAIT", () => {
    const r = evaluatePlanTrade({
      ...base,
      sellerCtx: { priceAboveVwap: false, vwap: 25795, spot: 25785 },
    });
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/below VWAP/i);
  });

  test("price above VWAP against PE → WAIT", () => {
    const r = evaluatePlanTrade({
      ...base,
      optionType: "PE",
      preferredSide: null,
      preferredStatus: "none",
      sellerCtx: { priceAboveVwap: true, vwap: 25795, spot: 25785 },
    });
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/above VWAP/i);
  });

  test("missing sellerCtx / null VWAP never blocks", () => {
    const r = evaluatePlanTrade({ ...base, sellerCtx: null });
    expect(r.decision).toBe("TAKE");
    const r2 = evaluatePlanTrade({
      ...base,
      sellerCtx: { priceAboveVwap: null, vwap: null, spot: 25785 },
    });
    expect(r2.decision).toBe("TAKE");
  });

  test("neutral dealer + no retest → TAKE with optional score note", () => {
    const r = evaluatePlanTrade({
      ...base,
      sellerCtx: {
        requiresRetest: false,
        entryConfirmed: false,
        score: 12,
        dealerBias: "NEUTRAL",
        dealerRegime: "UNKNOWN",
        netDex: 0,
        priceAboveVwap: true,
        vwap: 25700,
        spot: 25785,
      },
    });
    expect(r.decision).toBe("TAKE");
  });
});

// ── Pro confluence gate — ≥3 independent evidence GROUPS ──────────────
// Correlated indicators collapse into one group: dealer GEX + net DEX +
// seller intel all come from the SAME chain snapshot, and EMA + VWAP are
// both price structure. Counting them as separate votes overstated the
// evidence — the gate counts GROUPS.

describe("computeConfluence — evidence groups (no correlated double-count)", () => {
  test("rich CE baseline → 4 groups all CALL, pass", () => {
    const c = computeConfluence(base);
    expect(c.aligned).toBe(4);
    expect(c.cast).toBe(4);
    expect(c.pass).toBe(true);
    expect(c.required).toBe(REQUIRED_CONFLUENCE_GROUPS);
    expect(c.required).toBe(3);
    expect(c.groups.map((g) => g.name)).toEqual([
      "Price structure",
      "Options positioning",
      "Order flow",
      "Directional bias",
    ]);
    expect(c.groups[0].members.map((m) => m.name)).toEqual(["EMA", "VWAP"]);
    expect(c.groups[1].members.map((m) => m.name)).toEqual([
      "dealer GEX",
      "net DEX",
      "seller intel",
    ]);
    expect(c.groups[2].members.map((m) => m.name)).toEqual(["CVD"]);
    expect(c.groups[3].members.map((m) => m.name)).toEqual(["★ bias"]);
  });

  test("4 correlated CALL indicators in 2 groups → still FAIL (≥3 groups)", () => {
    const c = computeConfluence({
      ...base,
      preferredSide: null,
      preferredStatus: "none",
      cvdVerdict: null,
      sellerCtx: { priceAboveVwap: true, vwap: 25700, spot: 25785 },
    });
    // Raw indicators: EMA + VWAP + seller intel = 3 CALL (plus dealer/DEX nulled)
    expect(c.channels.length).toBeGreaterThanOrEqual(3);
    // ...but they sit in only 2 groups (price structure + options positioning)
    expect(c.aligned).toBe(2);
    expect(c.cast).toBe(2);
    expect(c.pass).toBe(false);
  });

  test("conflicted group abstains (dealer GEX bearish vs net DEX positive)", () => {
    const c = computeConfluence({
      ...base,
      sellerSignal: "WAIT",
      sellerCtx: {
        ...base.sellerCtx,
        dealerBias: "BEARISH",
        dealerRegime: "LONG_GAMMA",
        netDex: 5000,
      },
    });
    const g = c.groups.find((x) => x.name === "Options positioning")!;
    expect(g.state).toBe("CONFLICTED");
    expect(g.vote).toBeNull();
    // Price structure + order flow + bias still align → 3 groups pass
    expect(c.aligned).toBe(3);
    expect(c.cast).toBe(4);
    expect(c.pass).toBe(true);
  });

  test("price-structure group abstains when EMA and VWAP disagree", () => {
    const c = computeConfluence({
      ...base,
      sellerCtx: { ...base.sellerCtx, priceAboveVwap: false },
    });
    const g = c.groups.find((x) => x.name === "Price structure")!;
    expect(g.state).toBe("CONFLICTED");
    expect(g.vote).toBeNull();
    // options positioning + flow + bias = 3 groups
    expect(c.aligned).toBe(3);
    expect(c.cast).toBe(4);
    expect(c.pass).toBe(true);
  });

  test("sparse input (no directional data) → 0/0, fail closed", () => {
    const c = computeConfluence({
      optionType: "CE",
      tradable: true,
      lots: 1,
      rr: 2,
      entry: 100,
      stopLoss: 80,
      marketOpen: true,
    });
    expect(c.aligned).toBe(0);
    expect(c.cast).toBe(0);
    expect(c.pass).toBe(false);
    expect(c.groups.every((g) => g.state === "NO_DATA")).toBe(true);
  });

  test("opposing side never aligns (PE against a CALL tape)", () => {
    const c = computeConfluence({ ...base, optionType: "PE" });
    expect(c.aligned).toBe(0);
    expect(c.cast).toBe(4);
    expect(c.pass).toBe(false);
  });

  test("NEUTRAL CVD / WAIT seller never fabricate a vote", () => {
    const c = computeConfluence({
      ...base,
      cvdVerdict: "NEUTRAL",
      sellerSignal: "WAIT",
      sellerCtx: null,
    });
    // ★ bias + EMA only — order flow and options positioning have no data
    expect(c.aligned).toBe(2);
    expect(c.cast).toBe(2);
    expect(c.pass).toBe(false);
    expect(c.groups.find((g) => g.name === "Order flow")!.state).toBe("NO_DATA");
    expect(c.groups.find((g) => g.name === "Options positioning")!.state).toBe("NO_DATA");
  });
});

describe("evaluateLegLiquidity — GOOD / WIDE / UNVERIFIED", () => {
  test("tight book → GOOD with the real spread", () => {
    const r = evaluateLegLiquidity(248, 252);
    expect(r.state).toBe("GOOD");
    expect(r.spreadPct).toBeCloseTo((4 / 250) * 100, 6);
  });

  test("wide book → WIDE", () => {
    const r = evaluateLegLiquidity(100, 120);
    expect(r.state).toBe("WIDE");
    expect(r.spreadPct).toBeCloseTo((20 / 110) * 100, 6);
  });

  test("missing book → UNVERIFIED, spread NEVER invented", () => {
    for (const [b, a] of [[null, null], [0, 0], [undefined, undefined]] as any[]) {
      const r = evaluateLegLiquidity(b, a);
      expect(r.state).toBe("UNVERIFIED");
      expect(r.spreadPct).toBeNull();
    }
  });

  test("crossed book → UNVERIFIED (no negative spread)", () => {
    const r = evaluateLegLiquidity(120, 100);
    expect(r.state).toBe("UNVERIFIED");
    expect(r.spreadPct).toBeNull();
  });
});

describe("evaluatePlanTrade — confluence + liquidity gates", () => {
  test("no evidence at all → WAIT with honest reason", () => {
    const r = evaluatePlanTrade({
      ...base,
      preferredSide: null,
      preferredStatus: "none",
      cvdVerdict: null,
      ema: null,
      sellerSignal: null,
      sellerCtx: null,
    });
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/no evidence groups/i);
    expect(r.confluence?.pass).toBe(false);
  });

  test("2 groups aligned → WAIT need 1 more group", () => {
    const r = evaluatePlanTrade({
      ...base,
      preferredSide: "CALL",
      preferredStatus: "confirmed",
      cvdVerdict: "BULLISH",
      ema: null,
      sellerSignal: null,
      sellerCtx: null,
    });
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/confluence 2\/2 groups — need 1 more independent group/i);
    expect(r.confluence?.aligned).toBe(2);
  });

  test("≥3 groups aligned → TAKE with confluence note", () => {
    const r = evaluatePlanTrade(base);
    expect(r.decision).toBe("TAKE");
    expect(r.reasons.join(" ")).toMatch(/confluence 4\/4 groups — pro gate ≥3/i);
    expect(r.confluence?.pass).toBe(true);
  });

  test("wide spread (>8% mid) → WAIT, liquidity WIDE", () => {
    const r = evaluatePlanTrade({ ...base, bid: 100, ask: 120 });
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).toMatch(/spread .*exit cost/i);
    expect(r.liquidity?.state).toBe("WIDE");
  });

  test("tight spread → TAKE, liquidity GOOD", () => {
    const r = evaluatePlanTrade({ ...base, bid: 248, ask: 252 });
    expect(r.decision).toBe("TAKE");
    expect(r.liquidity?.state).toBe("GOOD");
  });

  test("no book on a LIVE chain → UNVERIFIED, WAIT, spread not invented", () => {
    const r = evaluatePlanTrade({ ...base, bid: null, ask: null });
    expect(r.liquidity?.state).toBe("UNVERIFIED");
    expect(r.liquidity?.spreadPct).toBeNull();
    if (LIQUIDITY_UNVERIFIED_POLICY === "wait") {
      expect(r.decision).toBe("WAIT");
      expect(r.reasons.join(" ")).toMatch(/liquidity UNVERIFIED/i);
    }
    const r2 = evaluatePlanTrade({ ...base, bid: 0, ask: 0 });
    expect(r2.liquidity?.state).toBe("UNVERIFIED");
    expect(r2.liquidity?.spreadPct).toBeNull();
  });

  test("no book on a STALE chain → UNVERIFIED caveat, no invented spread", () => {
    const r = evaluatePlanTrade({
      ...base,
      bid: null,
      ask: null,
      chainFreshness: "STALE",
    });
    expect(r.liquidity?.state).toBe("UNVERIFIED");
    expect(r.liquidity?.spreadPct).toBeNull();
    expect(r.reasons.join(" ")).toMatch(/liquidity UNVERIFIED/i);
  });

  test("MAX_SPREAD_PCT is 8", () => {
    expect(MAX_SPREAD_PCT).toBe(8);
  });

  test("REQUIRED_CONFLUENCE_GROUPS is 3", () => {
    expect(REQUIRED_CONFLUENCE_GROUPS).toBe(3);
  });
});
