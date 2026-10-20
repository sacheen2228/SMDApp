/// <reference types="bun-types" />
// The plan side must be read from the STOP, not from the target.
//
// THREE consumers must agree:
//   • the app monitor      — src/lib/activeTradeTracker.ts  planSide()
//   • the signal veto      — src/lib/signal-veto.ts         vetoPlanSide()
//   • the audit sidecar    — trade-audit/src/utils/sizing.ts inferPlanSide()
//
// The veto and the sidecar already read the STOP first ("the stop is the risk
// side, so a stop-out is ALWAYS a loss"). The app read the TARGET first and
// only broke the tie with the stop — so on an INCOHERENT plan (stop and target
// on the SAME side of the entry) the app treated a stop-out as a WIN.
//
// The real inverted plan that produced the bug:
//   entry 440.55 · stop 67.59 · target 178.06   (both levels BELOW the entry)
//
// Read from the target  → "SHORT" → the stop at 67.59 is ABOVE the entry →
//                          the stop-out books a ₹24,242 WIN.
// Read from the stop    → "LONG"  → the stop at 67.59 is BELOW the entry →
//                          the stop-out books a LOSS. Correct.
import { describe, test, expect } from "bun:test";
import {
  planSide,
  planPnlPoints,
  detectPlanHit,
  stopFillPrice,
} from "@/lib/activeTradeTracker";
import { vetoPlanSide } from "@/lib/signal-veto";

/** The real inverted plan from the ledger (stop and target on the same side). */
const INCOHERENT = { entry: 440.55, sl: 67.59, tp1: 178.06 };

/** A normal long option plan: stop below, target above. */
const LONG_PLAN = { entry: 100, sl: 95, tp1: 110 };

/** A mirrored (bearish) plan: stop above, target below. */
const MIRRORED_PLAN = { entry: 100, sl: 105, tp1: 90 };

describe("planSide — the STOP decides the side", () => {
  test("a long plan (stop below the entry) is LONG", () => {
    expect(planSide(LONG_PLAN)).toBe("LONG");
  });

  test("a mirrored plan (stop above the entry) is SHORT", () => {
    expect(planSide(MIRRORED_PLAN)).toBe("SHORT");
  });

  test("an INCOHERENT plan follows the STOP, not the target", () => {
    expect(planSide(INCOHERENT)).toBe("LONG");
    // the veto reads the same geometry
    expect(vetoPlanSide(INCOHERENT.entry, INCOHERENT.sl)).toBe("LONG");
  });

  test("the app and the veto never disagree on the side", () => {
    const plans = [LONG_PLAN, MIRRORED_PLAN, INCOHERENT, { entry: 50, sl: 50, tp1: 60 }];
    for (const p of plans) {
      const vetoSide = vetoPlanSide(p.entry, p.sl);
      if (!vetoSide) continue; // the veto needs a usable stop
      expect(planSide(p)).toBe(vetoSide);
    }
  });

  test("a stop-out on an incoherent plan is a LOSS, never a win", () => {
    expect(planPnlPoints(INCOHERENT, INCOHERENT.sl)).toBeLessThan(0);
    expect(planPnlPoints(INCOHERENT, INCOHERENT.tp1)).toBeLessThan(0);
  });

  test("the stop is hit before the target on an incoherent plan", () => {
    // At the stop level the trade is stopped out (a loss) …
    expect(detectPlanHit(INCOHERENT, INCOHERENT.sl)).toBe("SL_HIT");
    // … and the target is a target hit (a win) because the plan is a LONG.
    expect(detectPlanHit(INCOHERENT, INCOHERENT.tp1)).toBe("TP1_HIT");
  });

  test("the stop fill is the stop level (never the entry)", () => {
    expect(stopFillPrice(INCOHERENT, INCOHERENT.sl)).toBeCloseTo(INCOHERENT.sl, 5);
  });
});
