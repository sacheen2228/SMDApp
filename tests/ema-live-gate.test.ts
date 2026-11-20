import { describe, test, expect } from "bun:test";
import { evaluateEmaLiveVeto, type EmaLiveVetoInput } from "@/lib/ema-live-gate";

function base(over: Partial<EmaLiveVetoInput> = {}): EmaLiveVetoInput {
  return {
    live: true,
    tradeDirection: "BULLISH",
    emaStructure: {
      alignment: "BULLISH",
      direction: "BULLISH",
      dataQuality: "LIVE",
      lastCandleTime: Date.now(),
    },
    directionalCheck: "CONSISTENT",
    optionsConfirmation: "SUPPORTIVE",
    ...over,
  };
}

describe("ema-live-gate — live veto on scanner alerts", () => {
  test("flag OFF → never blocks (shadow display only)", () => {
    expect(evaluateEmaLiveVeto(base({ live: false, optionsConfirmation: "ADVERSE", directionalCheck: "CONFLICT" }))).toEqual({
      block: false,
    });
  });

  test("clean agreement → pass", () => {
    expect(evaluateEmaLiveVeto(base())).toEqual({ block: false });
  });

  test("options ADVERSE → BLOCK", () => {
    const r = evaluateEmaLiveVeto(base({ optionsConfirmation: "ADVERSE" }));
    expect(r.block).toBe(true);
    expect(r.reason).toMatch(/options/i);
  });

  test("directional CONFLICT → BLOCK", () => {
    const r = evaluateEmaLiveVeto(base({ directionalCheck: "CONFLICT" }));
    expect(r.block).toBe(true);
    expect(r.reason).toMatch(/conflict/i);
  });

  test("full BEARISH stack against a BULLISH trade → BLOCK", () => {
    const r = evaluateEmaLiveVeto(
      base({ emaStructure: { alignment: "BEARISH", direction: "BEARISH", dataQuality: "LIVE", lastCandleTime: Date.now() } }),
    );
    expect(r.block).toBe(true);
    expect(r.reason).toMatch(/oppose/i);
  });

  test("full BULLISH stack against a BEARISH trade → BLOCK", () => {
    const r = evaluateEmaLiveVeto(
      base({
        tradeDirection: "BEARISH",
        emaStructure: { alignment: "BULLISH", direction: "BULLISH", dataQuality: "LIVE", lastCandleTime: Date.now() },
        directionalCheck: "CONSISTENT",
        optionsConfirmation: "SUPPORTIVE",
      }),
    );
    expect(r.block).toBe(true);
  });

  test("TRANSITIONAL stack does NOT block on alignment alone (EMA50 lag)", () => {
    const r = evaluateEmaLiveVeto(
      base({ emaStructure: { alignment: "TRANSITIONAL", direction: "NEUTRAL", dataQuality: "LIVE", lastCandleTime: Date.now() } }),
    );
    expect(r).toEqual({ block: false });
  });

  test("missing EMA data → fail-open pass", () => {
    expect(evaluateEmaLiveVeto(base({ emaStructure: null, directionalCheck: null, optionsConfirmation: null }))).toEqual({
      block: false,
    });
  });

  test("stale EMA data → fail-open pass (never invent a veto)", () => {
    const r = evaluateEmaLiveVeto(
      base({
        emaStructure: { alignment: "BEARISH", direction: "BEARISH", dataQuality: "STALE", lastCandleTime: Date.now() - 3 * 3600_000 },
        directionalCheck: "CONFLICT",
      }),
    );
    // stale → no data to judge → pass (do not block on stale conflict either)
    expect(r).toEqual({ block: false });
  });

  test("INSUFFICIENT quality → fail-open", () => {
    const r = evaluateEmaLiveVeto(
      base({ emaStructure: { alignment: "MIXED", direction: "NEUTRAL", dataQuality: "INSUFFICIENT", lastCandleTime: null } }),
    );
    expect(r).toEqual({ block: false });
  });

  test("INCONCLUSIVE options alone does not block", () => {
    expect(evaluateEmaLiveVeto(base({ optionsConfirmation: "INCONCLUSIVE" }))).toEqual({ block: false });
  });

  test("REVERSAL_CONFIRMED directional verdict passes", () => {
    expect(evaluateEmaLiveVeto(base({ directionalCheck: "REVERSAL_CONFIRMED" }))).toEqual({ block: false });
  });
});
