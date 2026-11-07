/// <reference types="bun-types" />
// TDD for /api/signal-explain (TheTradeCartel integration — "why CE/PE/WAIT"
// panel embedded in the Terminal tab). Tests the row serializer that turns
// candidate_log records (JSON-string columns) into a safe API payload.

import { describe, it, expect } from "bun:test";
import { serializeCandidate } from "@/app/api/signal-explain/route";

describe("serializeCandidate", () => {
  it("parses JSON-string columns (warnings, fails, layerStates)", () => {
    const row = serializeCandidate({
      ts: "2026-11-07T10:00:00.000Z",
      source: "SMART_MONEY:terminal",
      symbol: "NIFTY",
      direction: "call",
      strike: 24000,
      confidence: 72,
      calibratedConfidence: 66,
      rr: 2.4,
      delta: 0.42,
      regime: "trend",
      sessionWindow: "morning",
      gateVerdict: "TRADE",
      tier: "A",
      warnings: JSON.stringify(["half-size"]),
      fails: JSON.stringify([]),
      layerStates: JSON.stringify({ flow: "unknown", structure: "agree" }),
      sent: true,
      wouldBlock: false,
      simOutcomeR: 1.2,
      configHash: "abc123",
    });
    expect(row.warnings).toEqual(["half-size"]);
    expect(row.fails).toEqual([]);
    expect(row.layerStates).toEqual({ flow: "unknown", structure: "agree" });
    expect(row.gateVerdict).toBe("TRADE");
    expect(row.tier).toBe("A");
    expect(row.sent).toBe(true);
    expect(row.simOutcomeR).toBe(1.2);
  });

  it("tolerates malformed JSON instead of throwing", () => {
    const row = serializeCandidate({
      symbol: "NIFTY",
      warnings: "{not json",
      fails: "[broken",
      layerStates: "also not json",
    });
    expect(row.warnings).toEqual([]);
    expect(row.fails).toEqual([]);
    expect(row.layerStates).toBeNull();
  });

  it("tolerates already-parsed objects (defensive)", () => {
    const row = serializeCandidate({
      symbol: "NIFTY",
      warnings: ["a"],
      layerStates: { flow: "agree" },
    });
    expect(row.warnings).toEqual(["a"]);
    expect(row.layerStates).toEqual({ flow: "agree" });
  });

  it("defaults missing optional fields safely", () => {
    const row = serializeCandidate({ symbol: "BANKNIFTY" });
    expect(row.symbol).toBe("BANKNIFTY");
    expect(row.warnings).toEqual([]);
    expect(row.fails).toEqual([]);
    expect(row.layerStates).toBeNull();
    expect(row.gateVerdict).toBeNull();
    expect(row.confidence).toBeNull();
    expect(row.sent).toBe(false);
    expect(row.wouldBlock).toBe(false);
  });
});
