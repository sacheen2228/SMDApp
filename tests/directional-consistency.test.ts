import { describe, it, expect } from "bun:test";
import {
  checkDirectionalConsistency,
  type DirectionalEvidence,
} from "@/lib/directional-consistency";

function ev(over: Partial<DirectionalEvidence> = {}): DirectionalEvidence {
  return {
    ema: { alignment: "TRANSITIONAL", direction: "NEUTRAL" },
    macd: { direction: "NEUTRAL" },
    structure: { direction: "NEUTRAL", trend: "RANGE" },
    momentum: { direction: "NEUTRAL" },
    vwap: { side: "NA" },
    reversal: null,
    ...over,
  };
}

const bullishStack: Partial<DirectionalEvidence> = {
  ema: { alignment: "BULLISH", direction: "BULLISH" },
  macd: { direction: "BULLISH" },
  structure: { direction: "BULLISH", trend: "UP" },
};

const bearishStack: Partial<DirectionalEvidence> = {
  ema: { alignment: "BEARISH", direction: "BEARISH" },
  macd: { direction: "BEARISH" },
  structure: { direction: "BEARISH", trend: "DOWN" },
};

describe("checkDirectionalConsistency", () => {
  it("accepts a CE when EMA, MACD and structure all agree bullish", () => {
    const r = checkDirectionalConsistency("CE", ev(bullishStack));
    expect(r.verdict).toBe("CONSISTENT");
    expect(r.conflicts).toHaveLength(0);
  });

  it("accepts a PE when EMA, MACD and structure all agree bearish", () => {
    const r = checkDirectionalConsistency("PE", ev(bearishStack));
    expect(r.verdict).toBe("CONSISTENT");
  });

  it("rejects a PE when EMA, MACD and structure are bullish", () => {
    const r = checkDirectionalConsistency("PE", ev(bullishStack));
    expect(r.verdict).toBe("CONFLICT");
    expect(r.conflicts.length).toBeGreaterThan(0);
    expect(r.conflicts.join(" ")).toContain("EMA");
  });

  it("rejects a CE when EMA, MACD and structure are bearish", () => {
    const r = checkDirectionalConsistency("CE", ev(bearishStack));
    expect(r.verdict).toBe("CONFLICT");
  });

  it("accepts a PE against a bullish stack when a bearish reversal is confirmed", () => {
    const r = checkDirectionalConsistency(
      "PE",
      ev({
        ...bullishStack,
        reversal: {
          confirmed: true,
          evidence: ["CHOCH_DOWN on a closed 5m candle", "break below the last swing low"],
        },
      }),
    );
    expect(r.verdict).toBe("REVERSAL_CONFIRMED");
    expect(r.conflicts.length).toBeGreaterThan(0);
  });

  it("does not accept a reversal with only one piece of evidence", () => {
    const r = checkDirectionalConsistency(
      "PE",
      ev({
        ...bullishStack,
        reversal: { confirmed: true, evidence: ["CHOCH_DOWN"] },
      }),
    );
    expect(r.verdict).toBe("CONFLICT");
  });

  it("allows an early reversal when EMA50 has not yet flipped", () => {
    // EMA stack still transitional (EMA50 lagging), structure + momentum bullish
    const r = checkDirectionalConsistency(
      "CE",
      ev({
        ema: { alignment: "TRANSITIONAL", direction: "NEUTRAL" },
        macd: { direction: "NEUTRAL" },
        structure: { direction: "BULLISH", trend: "UP" },
        momentum: { direction: "BULLISH" },
        vwap: { side: "ABOVE" },
      }),
    );
    expect(r.verdict).toBe("CONSISTENT");
  });

  it("still blocks a CE when the EMA stack has fully turned bearish without reversal proof", () => {
    const r = checkDirectionalConsistency(
      "CE",
      ev({
        ema: { alignment: "BEARISH", direction: "BEARISH" },
        structure: { direction: "BULLISH", trend: "UP" },
        momentum: { direction: "BULLISH" },
      }),
    );
    expect(r.verdict).toBe("CONFLICT");
  });

  it("allows a CE when the EMA stack has fully turned bearish AND a reversal is confirmed", () => {
    const r = checkDirectionalConsistency(
      "CE",
      ev({
        ema: { alignment: "BEARISH", direction: "BEARISH" },
        structure: { direction: "BULLISH", trend: "UP" },
        momentum: { direction: "BULLISH" },
        reversal: {
          confirmed: true,
          evidence: ["CHOCH_UP on a closed 5m candle", "reclaim of the EMA21 zone"],
        },
      }),
    );
    expect(r.verdict).toBe("REVERSAL_CONFIRMED");
  });

  it("is INSUFFICIENT when there is not enough evidence to judge", () => {
    const r = checkDirectionalConsistency("CE", ev());
    expect(r.verdict).toBe("INSUFFICIENT");
  });

  it("never forces a direction on a conflict", () => {
    const r = checkDirectionalConsistency("PE", ev(bullishStack));
    expect(r.verdict).not.toBe("CONSISTENT");
    expect(r.requiredEvidence.length).toBeGreaterThan(0);
  });
});
