/// <reference types="bun-types" />
// Wall calibration unit tests — verifies the three wall types (OI / Gamma /
// Trade-plan) are kept separate, distance/expiry/confluence are computed, and
// missing inputs degrade to UNAVAILABLE (never a fabricated zero).
// Gamma walls are DERIVED (BS-derived Greeks), not exchange-verified.
import { describe, test, expect } from "bun:test";
import { calibrateWalls, type TradePlanCard } from "@/lib/DailyDerivatives";

const SPOT = 25000;
const EXPIRY = "2026-11-27";

function plan(over: {
  optionType: "CE" | "PE";
  strike: number;
  tradable?: boolean;
  lots?: number;
}): TradePlanCard {
  return {
    optionType: over.optionType,
    strike: over.strike,
    entry: 100,
    stopLoss: 85,
    targets: [115, 130, 150],
    rr: 2,
    lots: over.lots ?? 1,
    deployed: 100000,
    riskAmount: 5000,
    tradable: over.tradable ?? true,
    otmSteps: 1,
    reason: "test plan",
  } as TradePlanCard;
}

function gammaWall(input: { strike: number; type: "CE" | "PE"; gex: number; oi: number }) {
  return input;
}

describe("calibrateWalls — three wall types kept separate", () => {
  test("splits gamma walls into strongest CALL and PUT walls", () => {
    const r = calibrateWalls({
      strikes: [],
      spot: SPOT,
      expiry: EXPIRY,
      tradePlans: [],
      preferredSide: null,
      gammaWalls: [
        gammaWall({ strike: 25200, type: "CE", gex: 5_000_000, oi: 1000 }),
        gammaWall({ strike: 24800, type: "PE", gex: 3_000_000, oi: 800 }),
        gammaWall({ strike: 25500, type: "CE", gex: 1_000_000, oi: 200 }),
      ],
      oiCallWall: 25500,
      oiPutWall: 24500,
    });
    expect(r.gammaCallWall).not.toBeNull();
    expect(r.gammaCallWall!.strike).toBe(25200);
    expect(r.gammaCallWall!.side).toBe("CALL");
    expect(r.gammaCallWall!.magnitude).toBe(5_000_000);
    expect(r.gammaPutWall).not.toBeNull();
    expect(r.gammaPutWall!.strike).toBe(24800);
    expect(r.gammaPutWall!.side).toBe("PUT");
    expect(r.gammaPutWall!.magnitude).toBe(3_000_000);
  });

  test("distance from spot is |strike - spot|", () => {
    const r = calibrateWalls({
      strikes: [],
      spot: SPOT,
      expiry: EXPIRY,
      tradePlans: [],
      preferredSide: null,
      gammaWalls: [gammaWall({ strike: 25200, type: "CE", gex: 1_000_000, oi: 100 })],
      oiCallWall: 0,
      oiPutWall: 0,
    });
    expect(r.gammaCallWall!.distance).toBe(200);
  });

  test("trade-blocking wall is nearest opposing-side plan strike", () => {
    const r = calibrateWalls({
      strikes: [],
      spot: SPOT,
      expiry: EXPIRY,
      tradePlans: [plan({ optionType: "PE", strike: 25100 }), plan({ optionType: "CE", strike: 24900 })],
      preferredSide: "CALL",
      gammaWalls: [],
      oiCallWall: 0,
      oiPutWall: 0,
    });
    expect(r.tradeBlockingWall).not.toBeNull();
    expect(r.tradeBlockingWall!.strike).toBe(25100);
    expect(r.tradeBlockingWall!.side).toBe("PUT");
    expect(r.tradeBlockingWall!.distance).toBe(100);
  });

  test("trade-blocking wall null when no opposing plan", () => {
    const r = calibrateWalls({
      strikes: [],
      spot: SPOT,
      expiry: EXPIRY,
      tradePlans: [plan({ optionType: "CE", strike: 24900 })],
      preferredSide: "CALL",
      gammaWalls: [],
      oiCallWall: 0,
      oiPutWall: 0,
    });
    expect(r.tradeBlockingWall).toBeNull();
  });

  test("trade-blocking wall null when no preferred side", () => {
    const r = calibrateWalls({
      strikes: [],
      spot: SPOT,
      expiry: EXPIRY,
      tradePlans: [plan({ optionType: "PE", strike: 25100 })],
      preferredSide: null,
      gammaWalls: [],
      oiCallWall: 0,
      oiPutWall: 0,
    });
    expect(r.tradeBlockingWall).toBeNull();
  });

  test("missing gamma walls → both gamma walls null (never zero)", () => {
    const r = calibrateWalls({
      strikes: [],
      spot: SPOT,
      expiry: EXPIRY,
      tradePlans: [],
      preferredSide: null,
      gammaWalls: [],
      oiCallWall: 0,
      oiPutWall: 0,
    });
    expect(r.gammaCallWall).toBeNull();
    expect(r.gammaPutWall).toBeNull();
  });

  test("gamma walls are DERIVED (BS-derived Greeks), not VERIFIED/exchange-verified", () => {
    const r = calibrateWalls({
      strikes: [],
      spot: SPOT,
      expiry: EXPIRY,
      tradePlans: [],
      preferredSide: null,
      gammaWalls: [gammaWall({ strike: 25200, type: "CE", gex: 1_000_000, oi: 100 })],
      oiCallWall: 0,
      oiPutWall: 0,
    });
    expect(r.gammaCallWall).not.toBeNull();
    expect(r.gammaCallWall!.status).toBe("DERIVED");
    expect(r.gammaCallWall!.source).toBe("GEX");
  });

  test("every wall carries nearest expiry", () => {
    const r = calibrateWalls({
      strikes: [],
      spot: SPOT,
      expiry: EXPIRY,
      tradePlans: [],
      preferredSide: null,
      gammaWalls: [gammaWall({ strike: 25200, type: "CE", gex: 1_000_000, oi: 100 })],
      oiCallWall: 0,
      oiPutWall: 0,
    });
    expect(r.gammaCallWall!.expiry).toBe(EXPIRY);
    expect(r.gammaCallWall!.expiryContribution).toBe("nearest");
  });

  test("confluence ALIGNED (OI/Γ co-located) when OI and gamma walls share a side", () => {
    const r = calibrateWalls({
      strikes: [],
      spot: SPOT,
      expiry: EXPIRY,
      tradePlans: [],
      preferredSide: null,
      gammaWalls: [gammaWall({ strike: 25200, type: "CE", gex: 1_000_000, oi: 100 })],
      oiCallWall: 25500,
      oiPutWall: 100,
    });
    expect(r.wallConfluence).toBe("ALIGNED");
  });

  test("confluence CONFLICT when OI and gamma walls oppose", () => {
    const r = calibrateWalls({
      strikes: [],
      spot: SPOT,
      expiry: EXPIRY,
      tradePlans: [],
      preferredSide: null,
      gammaWalls: [gammaWall({ strike: 24800, type: "PE", gex: 1_000_000, oi: 100 })],
      oiCallWall: 25500,
      oiPutWall: 100,
    });
    expect(r.wallConfluence).toBe("CONFLICT");
  });

  test("confluence NONE when no walls", () => {
    const r = calibrateWalls({
      strikes: [],
      spot: SPOT,
      expiry: EXPIRY,
      tradePlans: [],
      preferredSide: null,
      gammaWalls: [],
      oiCallWall: 0,
      oiPutWall: 0,
    });
    expect(r.wallConfluence).toBe("NONE");
  });

  test("zero-magnitude gamma wall is treated as missing", () => {
    const r = calibrateWalls({
      strikes: [],
      spot: SPOT,
      expiry: EXPIRY,
      tradePlans: [],
      preferredSide: null,
      gammaWalls: [gammaWall({ strike: 25200, type: "CE", gex: 0, oi: 100 })],
      oiCallWall: 0,
      oiPutWall: 0,
    });
    expect(r.gammaCallWall).toBeNull();
  });
});
