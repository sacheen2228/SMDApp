import { describe, it, expect } from "bun:test";
import {
  confirmOptions,
  type OptionsConfirmationInput,
} from "@/lib/options-confirmation";

function base(over: Partial<OptionsConfirmationInput> = {}): OptionsConfirmationInput {
  return {
    underlyingPrice: 100,
    underlyingChangePct: 1.0,
    pcr: 1.05,
    pcrPrevious: 1.0,
    callOi: 500_000,
    putOi: 520_000,
    callOiChange: 20_000,
    putOiChange: -5_000,
    atmCall: { ltp: 10, previousLtp: 9, volume: 5000, oiChange: 20_000 },
    atmPut: { ltp: 8, previousLtp: 8.5, volume: 4000, oiChange: -5_000 },
    dataQuality: "LIVE",
    isIntraday: true,
    oiSnapshotType: "INTRADAY",
    ...over,
  };
}

describe("confirmOptions", () => {
  it("never labels PCR below 0.9 as automatic call writing", () => {
    const r = confirmOptions(
      base({ pcr: 0.8, callOiChange: 0, putOiChange: 0 }),
    );
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reasons.join(" ")).not.toContain("call writing");
    expect(r.reasons.join(" ")).not.toContain("Call writing");
  });

  it("never infers seller positioning from PCR alone", () => {
    const r = confirmOptions(
      base({ pcr: 1.4, callOiChange: 0, putOiChange: 0 }),
    );
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reasons.join(" ")).not.toContain("put writing");
  });

  it("is INCONCLUSIVE on stale data", () => {
    const r = confirmOptions(base({ dataQuality: "STALE" }));
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reasons.join(" ")).toContain("stale");
  });

  it("is INCONCLUSIVE when the chain is unavailable", () => {
    const r = confirmOptions(base({ dataQuality: "UNAVAILABLE" }));
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  it("refuses to use EOD OI as intraday confirmation", () => {
    const r = confirmOptions(base({ oiSnapshotType: "EOD", isIntraday: true }));
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reasons.join(" ")).toContain("EOD");
  });

  it("is INCONCLUSIVE when the previous premium is unknown", () => {
    const r = confirmOptions(
      base({ atmCall: { ltp: 10, previousLtp: 0, volume: 5000, oiChange: 20_000 } }),
    );
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  it("is INCONCLUSIVE when OI change is below the significance threshold", () => {
    const r = confirmOptions(
      base({
        callOiChange: 100,
        putOiChange: -50,
        atmCall: { ltp: 10, previousLtp: 9, volume: 5000, oiChange: 100 },
      }),
    );
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  it("classifies rising OI with rising premium as long buildup (supportive for CE)", () => {
    const r = confirmOptions(
      base({
        underlyingChangePct: 1.2,
        callOiChange: 40_000,
        atmCall: { ltp: 11, previousLtp: 10, volume: 9000, oiChange: 40_000 },
      }),
    );
    expect(r.verdict).toBe("SUPPORTIVE");
    expect(r.direction).toBe("BULLISH");
    expect(r.legClass.ce).toBe("LONG_BUILDUP");
  });

  it("classifies rising OI with falling premium as short buildup (adverse for CE)", () => {
    const r = confirmOptions(
      base({
        underlyingChangePct: -1.0,
        callOiChange: 40_000,
        atmCall: { ltp: 9, previousLtp: 10, volume: 9000, oiChange: 40_000 },
      }),
    );
    expect(r.verdict).toBe("ADVERSE");
    expect(r.direction).toBe("BEARISH");
    expect(r.legClass.ce).toBe("SHORT_BUILDUP");
  });

  it("classifies falling OI with rising premium as short covering", () => {
    const r = confirmOptions(
      base({
        underlyingChangePct: 1.0,
        callOiChange: -40_000,
        atmCall: { ltp: 11, previousLtp: 10, volume: 9000, oiChange: -40_000 },
      }),
    );
    expect(r.legClass.ce).toBe("SHORT_COVERING");
  });

  it("classifies falling OI with falling premium as long unwinding", () => {
    const r = confirmOptions(
      base({
        underlyingChangePct: -1.0,
        callOiChange: -40_000,
        atmCall: { ltp: 9, previousLtp: 10, volume: 9000, oiChange: -40_000 },
      }),
    );
    expect(r.legClass.ce).toBe("LONG_UNWINDING");
  });

  it("reports the PCR trend", () => {
    const r = confirmOptions(base({ pcr: 1.2, pcrPrevious: 1.0 }));
    expect(r.pcrTrend).toBe("RISING");
    const f = confirmOptions(base({ pcr: 0.9, pcrPrevious: 1.1 }));
    expect(f.pcrTrend).toBe("FALLING");
    const s = confirmOptions(base({ pcr: 1.0, pcrPrevious: 1.0 }));
    expect(s.pcrTrend).toBe("FLAT");
  });

  it("reports PCR as UNKNOWN when there is no previous reading", () => {
    const r = confirmOptions(base({ pcrPrevious: null }));
    expect(r.pcrTrend).toBe("UNKNOWN");
  });

  it("carries the Greeks of the ATM leg when they are known", () => {
    const r = confirmOptions(
      base({
        atmCall: {
          ltp: 11,
          previousLtp: 10,
          volume: 9000,
          oiChange: 40_000,
          delta: 0.52,
          gamma: 0.002,
          theta: -4.2,
          vega: 0.08,
          iv: 14.5,
        },
      }),
    );
    expect(r.greeks.ce?.delta).toBe(0.52);
    expect(r.greeks.ce?.theta).toBe(-4.2);
    expect(r.greeks.ce?.gamma).toBe(0.002);
    expect(r.greeks.ce?.vega).toBe(0.08);
  });

  it("is INCONCLUSIVE when the chain is entirely missing", () => {
    const r = confirmOptions(
      base({
        pcr: null,
        callOi: 0,
        putOi: 0,
        callOiChange: 0,
        putOiChange: 0,
        atmCall: null,
        atmPut: null,
      }),
    );
    expect(r.verdict).toBe("INCONCLUSIVE");
  });
});
