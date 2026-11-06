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

describe("initial signal is not shown immediately", () => {
  test("first raw CALL stays pending → card reads WAIT/NO TRADE", () => {
    const { rec: out, showDirection, status } = updateSignal(rec(), T0);
    expect(showDirection).toBe(false);
    expect(out.direction).toBe("WAIT");
    expect(status).toBe("new signal pending");
  });

  test("repeating the same CALL without enough time still stays pending", () => {
    updateSignal(rec(), T0);
    const r1 = updateSignal(rec(), T0 + 10_000); // +10s, count=2
    expect(r1.showDirection).toBe(false);
    expect(r1.status).toBe("new signal pending");
  });
});

describe("confirmation flips to a directional call", () => {
  test("CALL confirmed after minConfirmations + minPersistenceMs", () => {
    updateSignal(rec(), T0);
    updateSignal(rec(), T0 + 10_000); // count=2, elapsed 10s
    const r = updateSignal(rec(), T0 + 130_000); // count=3, elapsed 130s >= 120s
    expect(r.showDirection).toBe(true);
    expect(r.status).toBe("confirmed");
    expect(r.rec.direction).toBe("CALL");
    expect(r.rec.confidence).toBe(75);
  });

  test("confirmed CALL keeps refreshing levels on subsequent CALLs", () => {
    updateSignal(rec(), T0);
    updateSignal(rec(), T0 + 10_000);
    updateSignal(rec(), T0 + 130_000); // confirmed CALL @ 157
    const r = updateSignal(rec({ entry: 160 }), T0 + 140_000);
    expect(r.showDirection).toBe(true);
    expect(r.rec.entry).toBe(160);
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

  test("PUT below floor (70) → NO TRADE", () => {
    updateSignal(rec({ direction: "PUT", confidence: 65 }), T0);
    updateSignal(rec({ direction: "PUT", confidence: 65 }), T0 + 10_000);
    const r = updateSignal(
      rec({ direction: "PUT", confidence: 65 }),
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
