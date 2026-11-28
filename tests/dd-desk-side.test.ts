/// <reference types="bun-types" />
// The DD tab's DESK SIDE — the side the desk actually acts on.
//
// The bug this guards (SENSEX 26-Nov-2026, 13:53 IST):
//   Direction block  → "GO CE"   (PCR + max pain + OI shift out-voted the tape)
//   Trade plan      → "★ PREFERRED (PUT)"  (the hysteresis lock's side)
//   CVD             → "BUYER CONTROL"      (real traded volume — against the ★)
//   Both cards      → "⏳ WAIT"             (the decision engine was right)
// One screen, three different verdicts. The ★ is what the desk acts on, and it
// was stale: the lock could survive a whole session of contradiction because
// its pending counter RESET every time the noisy majority flickered back.
//
// The rules this file locks in:
//   1. the side comes from the TAPE (fresh price action + futures flow);
//   2. positioning (PCR / max pain / OI shift) is context — it NEVER votes;
//   3. a tape that disagrees with itself has NO EDGE (never a coin flip);
//   4. the headline, the CVD badge and the ★ all read ONE side;
//   5. the ★ cannot outlive a sustained contradiction (max-hold);
//   6. a conflicted / quiet tape RELEASES the ★ instead of holding it;
//   7. the ★ only ever lands on a TAKE card.

import { describe, expect, test, beforeEach } from "bun:test";
import {
  computeDeskSide,
  resolvePreferredSide,
  __resetPreferredLocksForTests,
  DailyDerivativesService,
  DESK_MAX_SIGNAL_AGE_MS,
} from "@/lib/DailyDerivatives";

const T0 = 1_793_950_000_000;

beforeEach(() => {
  __resetPreferredLocksForTests();
});

// ── computeDeskSide — the tape decides ────────────────────────────────

describe("computeDeskSide — the side comes from the tape", () => {
  test("a fresh setup with the trend behind it → that side, high confidence", () => {
    const r = computeDeskSide({
      tape: { side: "PUT", ageMs: 10 * 60_000, label: "PULLBACK SHORT @ 84071" },
      trend: "DOWN",
    });
    expect(r.side).toBe("PUT");
    expect(r.conflict).toBe(false);
    expect(r.confidence).toBeGreaterThanOrEqual(70);
  });

  test("a setup against the trend keeps the side but cuts the confidence", () => {
    const r = computeDeskSide({
      tape: { side: "PUT", ageMs: 10 * 60_000 },
      trend: "UP",
    });
    expect(r.side).toBe("PUT");
    expect(r.confidence).toBeLessThan(70);
    expect(r.reasons.join(" ")).toMatch(/against the UP trend/i);
  });

  test("a stale setup does not vote (the tape must be live)", () => {
    const r = computeDeskSide({
      tape: { side: "PUT", ageMs: DESK_MAX_SIGNAL_AGE_MS + 60_000 },
      trend: "DOWN",
    });
    expect(r.side).toBe("NEUTRAL");
    expect(r.confidence).toBe(0);
    expect(r.reasons.join(" ")).toMatch(/stale/i);
  });

  test("no setup at all → NO EDGE (a trend without a trigger is not a trade)", () => {
    const r = computeDeskSide({ tape: null, trend: "UP" });
    expect(r.side).toBe("NEUTRAL");
    expect(r.confidence).toBe(0);
  });

  test("the futures flow is NOT an input — it stays display-only", () => {
    const r = computeDeskSide({
      tape: { side: "PUT", ageMs: 10 * 60_000 },
      trend: "DOWN",
      cvdVerdict: "BULLISH",
    } as any);
    expect(r.side).toBe("PUT");
  });
});

// ── resolvePreferredSide — the ★ must not go stale ───────────────────

describe("resolvePreferredSide — the lock cannot outlive the tape", () => {
  test("first read confirms immediately", () => {
    const r = resolvePreferredSide("NIFTY", "CALL", T0);
    expect(r.side).toBe("CALL");
    expect(r.status).toBe("confirmed");
  });

  test("one opposing read is pending only", () => {
    resolvePreferredSide("NIFTY", "CALL", T0);
    const r = resolvePreferredSide("NIFTY", "PUT", T0 + 15_000);
    expect(r.side).toBe("CALL");
    expect(r.status).toBe("pending");
  });

  test("SUSTAINED opposition flips the ★ even when the polls flicker", () => {
    // The stale-★ bug: the noisy majority kept flipping CALL↔PUT, which reset
    // the pending counter every time, so the confirmed side survived all day.
    resolvePreferredSide("NIFTY", "PUT", T0);
    resolvePreferredSide("NIFTY", "CALL", T0 + 60_000);
    resolvePreferredSide("NIFTY", "PUT", T0 + 120_000); // flicker back
    resolvePreferredSide("NIFTY", "CALL", T0 + 180_000);
    // The opposition has now run 3 minutes against the confirmed PUT.
    const r = resolvePreferredSide("NIFTY", "CALL", T0 + 300_000);
    expect(r.side).toBe("CALL");
    expect(r.status).toBe("confirmed");
  });

  test("a conflicted tape RELEASES the ★ immediately (no grace)", () => {
    resolvePreferredSide("NIFTY", "PUT", T0);
    const r = resolvePreferredSide("NIFTY", null, T0 + 5_000, { conflict: true });
    expect(r.side).toBeNull();
    expect(r.status).toBe("none");
  });

  test("a quiet tape holds the ★ briefly, then releases it", () => {
    resolvePreferredSide("NIFTY", "CALL", T0);
    const held = resolvePreferredSide("NIFTY", null, T0 + 15_000);
    expect(held.side).toBe("CALL");
    resolvePreferredSide("NIFTY", null, T0 + 60_000);
    const released = resolvePreferredSide("NIFTY", null, T0 + 2 * 60_000 + 30_000);
    expect(released.side).toBeNull();
    expect(released.status).toBe("none");
  });

  test("symbols stay independent", () => {
    resolvePreferredSide("NIFTY", "CALL", T0);
    const s = resolvePreferredSide("SENSEX", "PUT", T0);
    expect(s.side).toBe("PUT");
  });
});

// ── computeDirectionBias — positioning never votes ────────────────────

describe("computeDirectionBias — positioning is context, never a vote", () => {
  const svc: any = new DailyDerivativesService();
  const base = {
    spot: 84057,
    pcr: 0.96,
    maxPain: 84100,
    topCallOI: [{ oiChange: 1084992 }],
    topPutOI: [{ oiChange: 1138758 }],
    latestSignals: [
      { time: Date.now(), type: "PULLBACK", side: "SHORT", entry: 84071, stop: 0, targets: [], strength: 51, reason: "" },
    ],
    sentimentScore: 50,
  };

  function bias(over: any = {}) {
    return svc.computeDirectionBias({ ...base, trend: "DOWN", ...over });
  }

  test("PCR / max pain / OI shift are shown but NOT counted", () => {
    const r = bias();
    for (const factor of ["PCR", "Max Pain", "OI Shift", "Sentiment"]) {
      const v = r.votes.find((x: any) => x.factor === factor);
      expect(v.counted).toBe(false);
      expect(v.detail).toMatch(/context only/i);
    }
  });

  test("the tape vote is counted", () => {
    const r = bias();
    const v = r.votes.find((x: any) => x.factor === "Candles");
    expect(v.counted).not.toBe(false);
    expect(v.vote).toBe("PUT");
  });

  test("the side follows the tape, not the positioning", () => {
    // The live tape is SHORT; PCR + max pain + OI shift all lean CALL.
    const r = bias({ trend: "DOWN" });
    expect(r.side).toBe("PUT");
    expect(r.callVotes).toBe(0);
    expect(r.putVotes).toBe(1);
  });

  test("no fresh setup → NEUTRAL, whatever the positioning says", () => {
    const r = bias({ trend: "UP", latestSignals: [] });
    expect(r.side).toBe("NEUTRAL");
    expect(r.confidence).toBe(0);
  });
});
