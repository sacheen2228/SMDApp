// Regression guards for the DIRECTION verdict.
//
// The bug: in a chop regime (dead volume, EMA crosses, no trend) the
// position-structure votes — PCR, max pain, OI shift — were still counted.
// Three correlated structural votes out-voted the ONE live price-action vote
// and the card printed "GO CE 75% conf" with a ★ on the CALL side while the
// tape was falling and the app's own regime badge said "⚠ CHOP 75".
//
// The fix has two layers:
//   1. the positioning votes are CONTEXT — they never vote, in any regime
//      (they are mean-reversion constructs and lag by definition);
//   2. the side comes from the tape (fresh setup + futures flow) and a
//      self-contradicting tape has NO EDGE.
// See tests/dd-desk-side.test.ts for the desk-side engine itself.

import { describe, expect, test } from "bun:test";
import { DailyDerivativesService } from "@/lib/DailyDerivatives";

const svc: any = new DailyDerivativesService();

const base = {
  spot: 84268,
  pcr: 1.06, // put-heavy → structural CALL
  maxPain: 84300, // spot below MP → structural CALL
  topCallOI: [{ oiChange: 943385 }],
  topPutOI: [{ oiChange: 1110632 }], // put ΔOI > call ΔOI → structural CALL
  latestSignals: [
    { time: Date.now(), type: "REVERSAL", side: "SHORT", entry: 84308, stop: 0, targets: [], strength: 20, reason: "" },
  ],
  sentimentScore: 50,
};

function bias(over: any = {}) {
  return svc.computeDirectionBias({ ...base, ...over });
}

describe("direction bias — the positioning votes never decide", () => {
  test("PCR / max pain / OI shift are context in EVERY regime", () => {
    for (const chop of [null, { chop: true, score: 75 }, { chop: false, score: 10 }]) {
      const r = bias({ chop });
      for (const factor of ["PCR", "Max Pain", "OI Shift"]) {
        const v = r.votes.find((x: any) => x.factor === factor);
        expect(v.counted).toBe(false);
        expect(v.detail).toMatch(/context only/i);
      }
    }
  });

  test("in chop the structural votes are not counted", () => {
    const r = bias({ chop: { chop: true, score: 75 } });
    const structural = r.votes.filter((v: any) => ["PCR", "Max Pain", "OI Shift"].includes(v.factor));
    expect(structural.length).toBe(3);
    for (const v of structural) {
      expect(v.counted).toBe(false);
      expect(v.detail).toMatch(/context only/i);
    }
  });

  test("in chop the direction follows the LIVE tape, not the structure", () => {
    const r = bias({ chop: { chop: true, score: 75 }, trend: "DOWN" });
    expect(r.side).toBe("PUT"); // the live signal is a SHORT
    expect(r.callVotes).toBe(0);
    expect(r.putVotes).toBe(1); // the live setup
  });

  test("one live signal never reads as 100% conviction", () => {
    const r = bias({ chop: { chop: true, score: 80 }, trend: "DOWN" });
    expect(r.confidence).toBeLessThanOrEqual(80);
    expect(r.confidence).toBeGreaterThan(0);
  });

  test("the live vote is always counted", () => {
    const r = bias({ chop: { chop: true, score: 75 }, trend: "DOWN" });
    const live = r.votes.find((v: any) => v.factor === "Candles");
    expect(live.vote).toBe("PUT");
    expect(live.counted).not.toBe(false);
  });

  test("a NEUTRAL positioning vote is context too", () => {
    const r = bias({ chop: { chop: true, score: 75 }, pcr: 0.95 });
    const pcr = r.votes.find((v: any) => v.factor === "PCR");
    expect(pcr.vote).toBe("NEUTRAL");
    expect(pcr.counted).toBe(false);
  });

  test("in a trending regime the positioning votes are still context only", () => {
    const r = bias({ chop: { chop: false, score: 10 }, trend: "DOWN" });
    expect(r.side).toBe("PUT"); // the tape decides — not PCR/MP/OI
    expect(r.callVotes).toBe(0);
    expect(r.putVotes).toBe(1); // the live setup
  });

  test("a stale setup does not vote", () => {
    const old = Date.now() - 90 * 60_000;
    const r = bias({
      chop: null,
      cvdVerdict: "UNAVAILABLE",
      latestSignals: [{ ...base.latestSignals[0], time: old }],
    });
    expect(r.side).toBe("NEUTRAL");
    const live = r.votes.find((v: any) => v.factor === "Candles");
    expect(live.vote).toBe("NEUTRAL");
    expect(live.detail).toMatch(/stale/i);
  });
});
