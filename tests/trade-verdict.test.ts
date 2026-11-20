import { describe, test, expect } from "bun:test";
import { evaluateTradeVerdict, type TradeVerdictInput } from "@/lib/trade-verdict";

function cash(over: Partial<TradeVerdictInput> = {}): TradeVerdictInput {
  return {
    kind: "cash",
    confidence: 72,
    riskReward: 2.4,
    direction: "BULLISH",
    unifiedDecision: "TRADE",
    hardGatesPassed: true,
    emaStructure: {
      alignment: "BULLISH",
      direction: "BULLISH",
      dataQuality: "LIVE",
      lastCandleTime: Date.now(),
    },
    directionalCheck: "CONSISTENT",
    optionsConfirmation: "SUPPORTIVE",
    engineScore: 80,
    softScore: 70,
    nowMs: Date.now(),
    ...over,
  };
}

describe("trade-verdict — CONFIRM / WAIT / SKIP", () => {
  test("clean cash setup → CONFIRM", () => {
    expect(evaluateTradeVerdict(cash()).verdict).toBe("CONFIRM");
  });

  test("R:R below cash floor (2.0) → SKIP", () => {
    const r = evaluateTradeVerdict(cash({ riskReward: 1.4 }));
    expect(r.verdict).toBe("SKIP");
    expect(r.reasons.join(" ")).toMatch(/R:R/i);
  });

  test("confidence below cash floor (50) → SKIP", () => {
    const r = evaluateTradeVerdict(cash({ confidence: 42 }));
    expect(r.verdict).toBe("SKIP");
    expect(r.reasons.join(" ")).toMatch(/confidence/i);
  });

  test("option kind uses R:R ≥1.5 and confidence ≥65", () => {
    expect(evaluateTradeVerdict(cash({ kind: "option", riskReward: 1.6, confidence: 70 })).verdict).toBe("CONFIRM");
    expect(evaluateTradeVerdict(cash({ kind: "option", riskReward: 1.4 })).verdict).toBe("SKIP");
    expect(evaluateTradeVerdict(cash({ kind: "option", confidence: 60 })).verdict).toBe("SKIP");
  });

  test("EMA live veto block → SKIP", () => {
    const r = evaluateTradeVerdict(cash({
      emaStructure: { alignment: "BEARISH", direction: "BEARISH", dataQuality: "LIVE", lastCandleTime: Date.now() },
    }));
    expect(r.verdict).toBe("SKIP");
    expect(r.reasons.join(" ")).toMatch(/EMA/i);
  });

  test("directional CONFLICT → SKIP", () => {
    const r = evaluateTradeVerdict(cash({ directionalCheck: "CONFLICT" }));
    expect(r.verdict).toBe("SKIP");
    expect(r.reasons.join(" ")).toMatch(/conflict/i);
  });

  test("options ADVERSE → SKIP", () => {
    const r = evaluateTradeVerdict(cash({ optionsConfirmation: "ADVERSE" }));
    expect(r.verdict).toBe("SKIP");
    expect(r.reasons.join(" ")).toMatch(/ADVERSE/i);
  });

  test("confidence in wait band (50–64 cash) → WAIT", () => {
    const r = evaluateTradeVerdict(cash({ confidence: 55 }));
    expect(r.verdict).toBe("WAIT");
    expect(r.waits.join(" ")).toMatch(/confidence/i);
  });

  test("directional INSUFFICIENT → WAIT (not SKIP)", () => {
    const r = evaluateTradeVerdict(cash({ directionalCheck: "INSUFFICIENT" }));
    expect(r.verdict).toBe("WAIT");
  });

  test("options INCONCLUSIVE → WAIT", () => {
    const r = evaluateTradeVerdict(cash({ optionsConfirmation: "INCONCLUSIVE" }));
    expect(r.verdict).toBe("WAIT");
  });

  test("unifiedDecision WAIT → WAIT even when scores are high", () => {
    const r = evaluateTradeVerdict(cash({ unifiedDecision: "WAIT" }));
    expect(r.verdict).toBe("WAIT");
  });

  test("unifiedDecision NO_TRADE + hardGatesPassed false → SKIP", () => {
    const r = evaluateTradeVerdict(cash({ unifiedDecision: "NO_TRADE", hardGatesPassed: false }));
    expect(r.verdict).toBe("SKIP");
  });

  test("NEUTRAL direction → WAIT", () => {
    const r = evaluateTradeVerdict(cash({ direction: "NEUTRAL" }));
    expect(r.verdict).toBe("WAIT");
  });

  test("missing EMA fields fail-open (no block from absence alone)", () => {
    const r = evaluateTradeVerdict(cash({ emaStructure: null, directionalCheck: null, optionsConfirmation: null }));
    expect(r.verdict).toBe("CONFIRM");
  });

  test("hard SKIP beats soft WAIT (low RR + low confidence stays SKIP)", () => {
    const r = evaluateTradeVerdict(cash({ riskReward: 0.5, confidence: 40, directionalCheck: "INSUFFICIENT" }));
    expect(r.verdict).toBe("SKIP");
  });

  test("grade/totalScore not required — engineScore 0 still CONFIRMs when other gates pass", () => {
    const r = evaluateTradeVerdict(cash({ engineScore: 0, softScore: 0 }));
    expect(r.verdict).toBe("CONFIRM");
  });
});
