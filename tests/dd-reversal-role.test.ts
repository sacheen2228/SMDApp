/// <reference types="bun-types" />
// DD tab — the REVERSAL option-BUYER role.
//
// The Daily Derivatives card used to judge a card as a TREND buyer
// (EMA against → WAIT, CVD, chop, ≥3 confluence groups). It now plays the
// desk's role: evaluate a REVERSAL trade as an option BUYER.
//
// The maths comes from the modules already in the repo (greeks.ts for
// Black-Scholes, option-plan.ts for sizing, tech-read.ts for structure) —
// this file only pins the ROLE's behaviour:
//   • checklist a–h, ≥4 of a–g AND h = YES
//   • 1σ expected move, target realism, underlying R:R ≥ 2
//   • strike gates: |Δ| 0.40–0.75 · θ ≤6% of premium over the hold
//     · hold-time break-even ≤50% of the 1σ · option R:R ≥1.5 · ≥1 lot
//   • writer stop zone + trap check
//   • MISSING inputs are UNKNOWN — never a Yes, never a fabricated number

import { describe, test, expect } from "bun:test";
import {
  evaluateReversalRole,
  evaluatePlanTrade,
  type ReversalRoleInput,
} from "@/lib/DailyDerivatives";

const SPOT = 25000;

/**
 * A clean bullish reversal at support:
 *   level 24 960 · stop 24 950 · target 25 100  (underlying R:R = 2.0)
 *   1σ over a 0.25-day hold = 25 000 × 0.14 × √(0.25/252) ≈ 110 pts
 *   → the target is ~91% of one sigma (stretch, not a skip).
 */
function bullishReversal(over: Partial<ReversalRoleInput> = {}): ReversalRoleInput {
  return {
    optionType: "CE",
    spot: SPOT,
    setupType: "REVERSAL",
    level: 24960,
    target: 25100,
    stop: 24950,
    iv: 0.14,
    ivSource: "nse-vix",
    daysToExpiry: 5,
    holdDays: 0.25,
    prevHigh: 25100,
    prevLow: 24850,
    prevClose: 24980,
    vwap: 24990,
    callWall: 25300,
    putWall: 24600,
    callWallOiChange: -3000,
    putWallOiChange: 6000,
    pcr: 1.35,
    pcrTrend: "UP",
    structure: {
      trend: "DOWN",
      event: "CHOCH_UP",
      eventBarsAgo: 1,
      lastHigh: 25100,
      lastLow: 24850,
    },
    sweeps: [{ kind: "SWEEP_LOW_RECLAIM", level: 24960, barsAgo: 1, bias: "BULLISH" }],
    lastCandle: { o: 24940, h: 24985, l: 24930, c: 24980, v: 1200 },
    atr: 40,
    dailyTrend: "RANGE",
    minutesSinceOpen: 95,
    expiryDay: false,
    lotSize: 65,
    deployedBudget: 45000,
    candidates: [
      // ATM — passes every gate (option R:R ≈ 1.5).
      { strike: 25000, premium: 180, iv: 0.14, delta: 0.53, theta: -18.8 },
      // 1 step OTM — the better option R:R (the stop leaves intrinsic value).
      { strike: 25050, premium: 145, iv: 0.14, delta: 0.47, theta: -18.0 },
      // A lottery ticket — must never be recommended.
      { strike: 25100, premium: 95, iv: 0.14, delta: 0.3, theta: -16.0 },
    ],
    ...over,
  };
}

describe("DD role — the reversal checklist (a–h)", () => {
  // The score counts a–g only (max 7); (h) is a separate gate — it must be
  // YES for the trade, but it never inflates the score.
  const scoreYes = (r: { checks: { id: string; state: string }[] }) =>
    r.checks.filter((c) => c.id !== "h" && c.state === "YES").length;

  test("a clean bullish reversal scores 4+ and passes", () => {
    const r = evaluateReversalRole(bullishReversal());
    expect(r.score).toBe(scoreYes(r));
    expect(r.score).toBeGreaterThanOrEqual(4);
    expect(r.pass).toBe(true);
    expect(r.bottomLine).toBe("TAKE");
  });

  test("every check carries a reason and a state — never a silent Yes", () => {
    const r = evaluateReversalRole(bullishReversal());
    for (const c of r.checks) {
      expect(["YES", "NO", "UNKNOWN"]).toContain(c.state);
      expect(c.reason.length).toBeGreaterThan(0);
    }
    expect(r.checks.map((c) => c.id)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  test("UNKNOWN inputs never count as a Yes", () => {
    const bare = evaluateReversalRole(
      bullishReversal({
        structure: null,
        sweeps: [],
        pcr: null,
        pcrTrend: null,
        dailyTrend: null,
        vwap: null,
        prevHigh: null,
        prevLow: null,
        prevClose: null,
      }),
    );
    const yes = scoreYes(bare);
    expect(bare.score).toBe(yes);
    expect(bare.checks.some((c) => c.state === "UNKNOWN")).toBe(true);
  });

  test("the first 15 minutes of the session are a NO for (h)", () => {
    const r = evaluateReversalRole(bullishReversal({ minutesSinceOpen: 5 }));
    const h = r.checks.find((c) => c.id === "h")!;
    expect(h.state).toBe("NO");
    expect(r.pass).toBe(false);
    expect(r.bottomLine).toBe("SKIP");
  });

  test("an expiry day is a NO for (h) — event risk", () => {
    const r = evaluateReversalRole(bullishReversal({ expiryDay: true }));
    expect(r.checks.find((c) => c.id === "h")!.state).toBe("NO");
    expect(r.bottomLine).toBe("SKIP");
  });

  test("an unknown session clock is UNKNOWN, not a Yes", () => {
    const r = evaluateReversalRole(bullishReversal({ minutesSinceOpen: null }));
    expect(r.checks.find((c) => c.id === "h")!.state).toBe("UNKNOWN");
  });

  test("a bearish CHoCH against a bullish reversal is a NO for (b)", () => {
    const r = evaluateReversalRole(
      bullishReversal({
        structure: { trend: "UP", event: "CHOCH_DOWN", eventBarsAgo: 1, lastHigh: 25100, lastLow: 24850 },
      }),
    );
    expect(r.checks.find((c) => c.id === "b")!.state).toBe("NO");
  });
});

describe("DD role — expected move, realism and the trade gates", () => {
  test("the 1σ move and the target realism are real numbers", () => {
    const r = evaluateReversalRole(bullishReversal());
    // 25 000 × 0.14 × √(0.25/252) ≈ 110.2 pts
    expect(r.expectedMovePoints).not.toBeNull();
    expect(r.expectedMovePoints!).toBeGreaterThan(100);
    expect(r.expectedMovePoints!).toBeLessThan(120);
    expect(r.targetPoints).toBe(100);
    expect(r.underlyingRR).toBeCloseTo(2, 5);
    expect(r.targetVsExpectedMovePct).toBeGreaterThan(80);
    expect(r.targetVsExpectedMovePct!).toBeLessThan(100);
  });

  test("no IV → no expected move and no invented realism claim", () => {
    const r = evaluateReversalRole(bullishReversal({ iv: null }));
    expect(r.expectedMovePoints).toBeNull();
    expect(r.targetVsExpectedMovePct).toBeNull();
  });

  test("a target beyond one sigma is a SKIP", () => {
    const r = evaluateReversalRole(bullishReversal({ target: 25300 }));
    expect(r.targetVsExpectedMovePct!).toBeGreaterThan(100);
    expect(r.bottomLine).toBe("SKIP");
    expect(r.skipReasons.join(" ")).toMatch(/sigma/i);
  });

  test("an underlying R:R below 2 is a SKIP", () => {
    const r = evaluateReversalRole(bullishReversal({ target: 25080, stop: 24950 }));
    expect(r.underlyingRR!).toBeLessThan(2);
    expect(r.bottomLine).toBe("SKIP");
  });

  test("without a reversal setup the role says SKIP", () => {
    const r = evaluateReversalRole(bullishReversal({ setupType: "BREAKOUT" }));
    expect(r.bottomLine).toBe("SKIP");
    expect(r.skipReasons.join(" ")).toMatch(/reversal setup/i);
  });
});

describe("DD role — the strike gates", () => {
  test("a passing strike is recommended and every gate is reported", () => {
    const r = evaluateReversalRole(bullishReversal());
    expect(r.recommended).not.toBeNull();
    const best = r.rows
      .filter((row) => row.passed)
      .sort((a, b) => (b.optionRR ?? 0) - (a.optionRR ?? 0))[0];
    expect(r.recommended!.strike).toBe(best.strike);
    expect(r.recommended!.failedGates).toEqual([]);
    expect(r.recommended!.lots).toBeGreaterThanOrEqual(1);
    expect(r.recommended!.optionRR!).toBeGreaterThanOrEqual(1.5);
    expect(Math.abs(r.recommended!.delta!)).toBeGreaterThanOrEqual(0.4);
    expect(Math.abs(r.recommended!.delta!)).toBeLessThanOrEqual(0.75);
  });

  test("a lottery delta is rejected — the gates are never relaxed", () => {
    const r = evaluateReversalRole(bullishReversal());
    const lottery = r.rows.find((row) => row.strike === 25100)!;
    expect(lottery.passed).toBe(false);
    expect(lottery.failedGates).toContain("delta");
  });

  test("an option R:R below 1.5 is reported but not a failed gate (data-driven R:R)", () => {
    const r = evaluateReversalRole(bullishReversal({ target: 25050, stop: 24800 }));
    const atm = r.rows.find((row) => row.strike === 25000)!;
    expect(atm.optionRR!).toBeLessThan(1.5);
    // RR is surfaced for the trader, not used as a rejection gate.
    expect(atm.failedGates).not.toContain("rr");
  });

  test("a theta cost above 6% of the premium over the hold is rejected", () => {
    const r = evaluateReversalRole(
      bullishReversal({
        candidates: [{ strike: 25000, premium: 180, iv: 0.14, delta: 0.53, theta: -120 }],
      }),
    );
    const row = r.rows[0];
    expect(row.thetaCostPct!).toBeGreaterThan(6);
    expect(row.failedGates).toContain("theta");
  });

  test("the hold-time break-even is reported as a % of the 1σ move", () => {
    const r = evaluateReversalRole(bullishReversal());
    const atm = r.rows.find((row) => row.strike === 25000)!;
    expect(atm.bePctExpectedMove).not.toBeNull();
    expect(atm.bePctExpectedMove!).toBeGreaterThan(0);
    expect(atm.bePctExpectedMove!).toBeLessThanOrEqual(50);
  });

  test("a strike that does not fit the budget is 0 lots — never a trade", () => {
    const r = evaluateReversalRole(
      bullishReversal({
        candidates: [{ strike: 25000, premium: 900, iv: 0.14, delta: 0.53, theta: -18.8 }],
        deployedBudget: 20000,
      }),
    );
    const row = r.rows[0];
    expect(row.lots).toBe(0);
    expect(row.failedGates).toContain("size");
  });

  test("among near-best R:R strikes the one closest to delta 0.55 wins", () => {
    const r = evaluateReversalRole(
      bullishReversal({
        candidates: [
          { strike: 25000, premium: 170, iv: 0.14, delta: 0.48, theta: -18.8 },
          { strike: 25050, premium: 142, iv: 0.14, delta: 0.6, theta: -18.0 },
        ],
      }),
    );
    expect(r.recommended).not.toBeNull();
    expect(r.recommended!.strike).toBe(25050);
  });
});

describe("DD role — writer stop zone + trap check", () => {
  test("the writer stop zone solves the 2× premium level and shows the delta approximation", () => {
    const r = evaluateReversalRole(
      bullishReversal({
        callWall: 25300,
        callWallPremium: 200,
        callWallIv: 0.14,
        putWall: 24600,
        putWallPremium: 40,
        putWallIv: 0.14,
      }),
    );
    const callZone = r.writerZones.find((z) => z.side === "CALL")!;
    expect(callZone).toBeDefined();
    expect(callZone.stopLevel).not.toBeNull();
    expect(callZone.stopLevel!).toBeGreaterThan(callZone.strike);
    expect(callZone.deltaApprox).not.toBeNull();
  });

  test("a sweep that closed back inside is a TRAP (the reversal setup itself)", () => {
    const r = evaluateReversalRole(bullishReversal());
    expect(r.levelState.classification).toBe("TRAP");
  });

  test("a close beyond the level with the OI there falling is a REAL BREAKOUT — the idea is invalid", () => {
    const r = evaluateReversalRole(
      bullishReversal({
        sweeps: [],
        lastCandle: { o: 24980, h: 24985, l: 24920, c: 24930, v: 2400 },
        putWallOiChange: -9000,
      }),
    );
    expect(r.levelState.classification).toBe("REAL_BREAKOUT");
    expect(r.bottomLine).toBe("SKIP");
  });
});

describe("DD role — wired into the card verdict", () => {
  test("the service reads the previous session + the HTF bias from the card's OWN candles", async () => {
    const { DailyDerivativesService } = await import("@/lib/DailyDerivatives");
    const svc: any = new (DailyDerivativesService as any)();
    const mk = (day: string, base: number, n: number) => {
      const out: any[] = [];
      for (let i = 0; i < n; i++) {
        const mins = 9 * 60 + 15 + i * 5;
        const hh = String(Math.floor(mins / 60)).padStart(2, "0");
        const mm = String(mins % 60).padStart(2, "0");
        out.push({
          time: new Date(`${day}T${hh}:${mm}:00+05:30`).toISOString(),
          open: base + i,
          high: base + i + 3,
          low: base + i - 3,
          close: base + i + 1,
          volume: 1000,
        });
      }
      return out;
    };
    const candles = [...mk("2026-11-24", 25000, 20), ...mk("2026-11-25", 25100, 20)];
    const ctx = await svc.buildReversalContext({
      underlying: "NIFTY",
      candles,
      ema: { atr: 25 },
      marketOpen: true,
    });
    // The previous session's H/L/C — the pivots the role's check (a) needs.
    expect(ctx.prevHigh).toBe(25122);
    expect(ctx.prevLow).toBe(25097);
    expect(ctx.prevClose).toBe(25120);
    // The higher-timeframe read — with its source labelled (never a bare claim).
    expect(ctx.dailyTrend).toBe("UP");
    expect(ctx.dailyTrendSource).toMatch(/multi-session drift/);
    // The last CLOSED 5-minute bar.
    expect(ctx.lastCandle).not.toBeNull();
    expect(ctx.lastCandle!.c).toBe(25120);
  });

  test("a SKIP role makes the card WAIT and exposes the role result", () => {
    const r = evaluatePlanTrade({
      optionType: "CE",
      tradable: true,
      lots: 2,
      rr: 2,
      entry: 180,
      stopLoss: 160,
      marketOpen: true,
      reversal: bullishReversal({ minutesSinceOpen: 3 }),
    });
    expect(r.decision).toBe("WAIT");
    expect(r.reversal).toBeDefined();
    expect(r.reversal!.bottomLine).toBe("SKIP");
    expect(r.reasons.join(" ")).toMatch(/session|15 min/i);
  });

  test("without a role input the verdict is unchanged (the role is opt-in)", () => {
    const r = evaluatePlanTrade({
      optionType: "CE",
      tradable: true,
      lots: 2,
      rr: 2,
      entry: 180,
      stopLoss: 160,
      marketOpen: true,
    });
    // The legacy path still governs (no evidence groups → the confluence gate
    // waits) and the role never runs, so no role reason can appear.
    expect(r.decision).toBe("WAIT");
    expect(r.reasons.join(" ")).not.toMatch(/reversal role/i);
    expect(r.reversal).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Regression guards for the bugs found while auditing the role.
// ─────────────────────────────────────────────────────────────────────────
describe("DD role — scope of the reversal gate", () => {
  test("a NON-reversal setup is not gated by the role (it would pin every card to WAIT)", () => {
    const r = evaluateReversalRole(bullishReversal({ setupType: "BREAKOUT" }));
    expect(r.applicable).toBe(false);
    expect(r.setupType).toBe("BREAKOUT");
    // The role says "not my call" — it must not dress the breakout geometry up
    // as a reversal failure.
    expect(r.skipReasons.join(" ")).toMatch(/not a reversal setup/i);
    expect(r.skipReasons.join(" ")).not.toMatch(/checklist \d+\/7/);
    expect(r.skipReasons.join(" ")).not.toMatch(/session\/event check/);
  });

  test("a REVERSAL / FAKEOUT setup IS applicable and gated by the checklist", () => {
    expect(evaluateReversalRole(bullishReversal({ setupType: "REVERSAL" })).applicable).toBe(true);
    expect(evaluateReversalRole(bullishReversal({ setupType: "FAKEOUT" })).applicable).toBe(true);
    // Same card, but the session gate fails → the role SKIPs.
    const gated = evaluateReversalRole(bullishReversal({ setupType: "REVERSAL", minutesSinceOpen: 3 }));
    expect(gated.applicable).toBe(true);
    expect(gated.bottomLine).toBe("SKIP");
    expect(gated.skipReasons.join(" ")).toMatch(/session\/event check/);
  });

  test("evaluatePlanTrade does NOT let a non-applicable role gate the card", () => {
    const r = evaluatePlanTrade({
      optionType: "CE",
      tradable: true,
      lots: 1,
      rr: 2,
      entry: 180,
      stopLoss: 160,
      marketOpen: true,
      reversal: bullishReversal({ setupType: "BREAKOUT" }),
    });
    // The role is exposed, but its "not a reversal setup" verdict must not be
    // the reason the card waits — the legacy confluence gate governs.
    expect(r.reversal).toBeDefined();
    expect(r.reversal!.applicable).toBe(false);
    expect(r.reasons.join(" ")).not.toMatch(/not a reversal setup/i);
  });
});

describe("DD role — never gate on a fabricated IV", () => {
  test("no index IV → the 1σ-vs-target gate stays unknown, but the leg still prices", () => {
    const r = evaluateReversalRole(bullishReversal({ iv: null }));
    expect(r.expectedMovePoints).toBeNull();
    expect(r.targetVsExpectedMovePct).toBeNull();
    // The per-leg chain IV still drives the strike maths (BE vs the leg's own 1σ).
    const atm = r.rows.find((x) => x.strike === 25000)!;
    expect(atm.bePctExpectedMove).not.toBeNull();
    expect(Number.isFinite(atm.bePctExpectedMove!)).toBe(true);
  });
});

describe("DD role — the trap classification", () => {
  test("a close beyond the level AGAINST the trade is never called a TRAP", () => {
    // Bullish reversal at 24 960; the last 5m candle closed at 24 900 (below).
    const r = evaluateReversalRole(
      bullishReversal({
        sweeps: [{ kind: "SWEEP_LOW_RECLAIM", level: 24960, barsAgo: 1, bias: "BULLISH" }],
        lastCandle: { o: 24970, h: 24985, l: 24890, c: 24900, v: 1200 },
        // OI at the opposing wall is BUILDING → no clean break read.
        putWallOiChange: 6000,
      }),
    );
    expect(r.levelState.classification).not.toBe("TRAP");
    expect(r.levelState.classification).toBe("UNCLEAR");
  });

  test("a close beyond the level with the opposing wall unwinding IS a REAL_BREAKOUT", () => {
    const r = evaluateReversalRole(
      bullishReversal({
        sweeps: [],
        lastCandle: { o: 24970, h: 24985, l: 24890, c: 24900, v: 1200 },
        putWallOiChange: -6000,
      }),
    );
    expect(r.levelState.classification).toBe("REAL_BREAKOUT");
    // A real break kills the idea.
    expect(r.bottomLine).toBe("SKIP");
  });

  test("a sweep that closed back inside IS a TRAP", () => {
    const r = evaluateReversalRole(bullishReversal());
    expect(r.levelState.classification).toBe("TRAP");
  });
});
