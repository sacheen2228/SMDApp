/// <reference types="bun-types" />
// TDD for the signal-persistence layer that stabilises the BUY CE / BUY PE
// card. These tests confirm:
//   • a raw signal is NOT shown until it persists (minConfirmations +
//     minPersistenceMs);
//   • a reversal needs confirmation + hysteresis (not blocked, validated);
//   • below the confidence floor the card reads NO TRADE;
//   • stale data invalidates to WAIT.
// Time is injected explicitly so tests are deterministic.

import { describe, test, expect, beforeEach } from "bun:test";
import {
  updateSignal,
  resetSignalState,
  CONFIG,
  type SignalRec,
} from "@/lib/signal-persistence";

function rec(overrides: Partial<SignalRec> = {}): SignalRec {
  return {
    direction: "CALL",
    confidence: 75,
    entry: 157,
    sl: 125.6,
    tp1: 219.8,
    tp2: 251.2,
    tp3: 282.6,
    strike: 24750,
    tradeGrade: "A",
    reason: "Bullish PCR",
    riskReward: 2,
    ...overrides,
  };
}

const T0 = 1_793_950_000_000; // fixed epoch ms (arbitrary)

beforeEach(() => {
  resetSignalState();
});

describe("initial signal shows immediately (only flips need confirmation)", () => {
  test("first raw CALL → card shows BUY CALL immediately", () => {
    const { rec: out, showDirection, status } = updateSignal(rec(), T0);
    expect(showDirection).toBe(true);
    expect(out.direction).toBe("CALL");
    expect(out.confidence).toBe(75);
    expect(status).toBe("confirmed");
  });

  test("first raw PUT → card shows BUY PUT immediately", () => {
    const r = updateSignal(rec({ direction: "PUT", confidence: 80 }), T0);
    expect(r.showDirection).toBe(true);
    expect(r.rec.direction).toBe("PUT");
    expect(r.status).toBe("confirmed");
  });

  test("repeating the same CALL keeps levels sticky (no flicker)", () => {
    updateSignal(rec(), T0);
    const r1 = updateSignal(rec({ entry: 160 }), T0 + 10_000);
    expect(r1.showDirection).toBe(true);
    // 10s < levelStaleMs and 160 vs 157 = 1.9% < levelMovePct → levels stay
    expect(r1.rec.entry).toBe(157);
    expect(r1.rec.direction).toBe("CALL");
  });
});

describe("confirmation required only for flips", () => {
  test("confirmed CALL keeps levels sticky on subsequent CALLs", () => {
    updateSignal(rec(), T0); // initial CALL shown immediately
    const r = updateSignal(rec({ entry: 160 }), T0 + 130_000);
    expect(r.showDirection).toBe(true);
    // 130s < levelStaleMs and 160 vs 157 = 1.9% < levelMovePct → levels stay
    expect(r.rec.entry).toBe(157);
    expect(r.rec.direction).toBe("CALL");
  });
});

describe("reversals require confirmation + hysteresis", () => {
  test("opposing PUT starts as pending (keeps showing CALL)", () => {
    updateSignal(rec(), T0);
    updateSignal(rec(), T0 + 10_000);
    updateSignal(rec(), T0 + 130_000); // confirmed CALL
    const r = updateSignal(rec({ direction: "PUT" }), T0 + 140_000);
    expect(r.showDirection).toBe(true);
    expect(r.rec.direction).toBe("CALL"); // still showing CALL
    expect(r.status).toBe("reversal pending");
  });

  test("PUT confirmed flips to PUT when persistence + hysteresis met", () => {
    updateSignal(rec(), T0);
    updateSignal(rec(), T0 + 10_000);
    updateSignal(rec(), T0 + 130_000); // confirmed CALL conf 75
    // PUT must beat CALL by hysteresisMargin (8): 75 + 8 = 83
    updateSignal(rec({ direction: "PUT", confidence: 90 }), T0 + 150_000); // count=1
    updateSignal(rec({ direction: "PUT", confidence: 90 }), T0 + 160_000); // count=2
    const r = updateSignal(
      rec({ direction: "PUT", confidence: 90 }),
      T0 + 270_000,
    ); // count=3, elapsed 120s since pending start (150s)
    expect(r.showDirection).toBe(true);
    expect(r.status).toBe("reversal confirmed");
    expect(r.rec.direction).toBe("PUT");
    expect(r.rec.confidence).toBe(90);
  });

  test("PUT below hysteresis margin does NOT flip (reversal pending)", () => {
    updateSignal(rec(), T0);
    updateSignal(rec(), T0 + 10_000);
    updateSignal(rec(), T0 + 130_000); // confirmed CALL conf 75
    // PUT conf 80 < 75+8=83 → hysteresis fails
    updateSignal(rec({ direction: "PUT", confidence: 80 }), T0 + 150_000);
    updateSignal(rec({ direction: "PUT", confidence: 80 }), T0 + 160_000);
    const r = updateSignal(
      rec({ direction: "PUT", confidence: 80 }),
      T0 + 270_000,
    );
    expect(r.showDirection).toBe(true);
    expect(r.rec.direction).toBe("CALL"); // still CALL
    expect(r.status).toBe("reversal pending");
  });
});

describe("confidence floor", () => {
  test("CALL below floor (60) → NO TRADE", () => {
    updateSignal(rec({ confidence: 50 }), T0);
    updateSignal(rec({ confidence: 50 }), T0 + 10_000);
    const r = updateSignal(rec({ confidence: 50 }), T0 + 130_000);
    expect(r.showDirection).toBe(false);
    expect(r.rec.direction).toBe("CALL");
  });

  test("PUT below floor (65) → NO TRADE", () => {
    updateSignal(rec({ direction: "PUT", confidence: 60 }), T0);
    updateSignal(rec({ direction: "PUT", confidence: 60 }), T0 + 10_000);
    const r = updateSignal(
      rec({ direction: "PUT", confidence: 60 }),
      T0 + 130_000,
    );
    expect(r.showDirection).toBe(false);
  });
});

describe("raw WAIT holds the confirmed direction", () => {
  test("CALL confirmed, then raw WAIT → keeps CALL (holding)", () => {
    updateSignal(rec(), T0);
    updateSignal(rec(), T0 + 10_000);
    updateSignal(rec(), T0 + 130_000); // confirmed CALL
    const r = updateSignal(rec({ direction: "WAIT" }), T0 + 140_000);
    expect(r.showDirection).toBe(true);
    expect(r.rec.direction).toBe("CALL");
    expect(r.status).toBe("holding (raw WAIT)");
  });
});

describe("staleness invalidation", () => {
  test("no fresh data beyond staleMs → WAIT", () => {
    updateSignal(rec(), T0);
    updateSignal(rec(), T0 + 10_000);
    updateSignal(rec(), T0 + 130_000); // confirmed CALL
    const r = updateSignal(rec(), T0 + 130_000 + CONFIG.staleMs + 1_000);
    expect(r.showDirection).toBe(false);
    expect(r.rec.direction).toBe("WAIT");
    expect(r.status).toBe("stale");
  });
});

describe("symbol-scoped state (no cross-symbol leak)", () => {
  test("switching symbol resets the confirmed direction", () => {
    updateSignal(rec(), T0, undefined, "NIFTY");
    updateSignal(rec(), T0 + 10_000, undefined, "NIFTY");
    updateSignal(rec(), T0 + 130_000, undefined, "NIFTY"); // confirmed CALL on NIFTY

    // BANKNIFTY first signal must lock immediately — not hold NIFTY's CALL
    const r = updateSignal(
      rec({ direction: "PUT", confidence: 80 }),
      T0 + 140_000,
      undefined,
      "BANKNIFTY",
    );
    expect(r.status).toBe("confirmed");
    expect(r.rec.direction).toBe("PUT");
    expect(r.showDirection).toBe(true);
  });

  test("same symbol keeps its own confirmed state across calls", () => {
    updateSignal(rec(), T0, undefined, "NIFTY");
    updateSignal(rec(), T0 + 10_000, undefined, "NIFTY");
    updateSignal(rec(), T0 + 130_000, undefined, "NIFTY");
    const r = updateSignal(rec({ entry: 160 }), T0 + 140_000, undefined, "NIFTY");
    expect(r.rec.direction).toBe("CALL");
    expect(r.status).toBe("confirmed");
  });

  test("resetSignalState also clears the symbol key", () => {
    updateSignal(rec(), T0, undefined, "NIFTY");
    resetSignalState();
    const r = updateSignal(
      rec({ direction: "PUT", confidence: 80 }),
      T0 + 1000,
      undefined,
      "NIFTY",
    );
    expect(r.status).toBe("confirmed");
    expect(r.rec.direction).toBe("PUT");
  });
});
