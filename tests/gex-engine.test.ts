/// <reference types="bun-types" />
// DEX/GEX engine unit tests — verify calculation inputs, units, and sign
// conventions. These tests use synthetic inputs; real exchange values have
// NOT been independently reconciled.
import { describe, test, expect } from "bun:test";
import { calculateGEX, findGammaFlip, findGammaWalls } from "@/lib/gex-engine";

function strike(input: {
  strike: number;
  ceGamma?: number | null;
  ceOI?: number | null;
  peGamma?: number | null;
  peOI?: number | null;
}) {
  return {
    strike: input.strike,
    ce: input.ceGamma != null || input.ceOI != null
      ? { gamma: input.ceGamma, oi: input.ceOI }
      : null,
    pe: input.peGamma != null || input.peOI != null
      ? { gamma: input.peGamma, oi: input.peOI }
      : null,
  };
}

describe("calculateGEX — per-strike gamma exposure", () => {
  const spot = 25000;
  const spotSquared = spot * spot; // 625,000,000

  test("CE gamma × OI × spot² × 0.01", () => {
    // gamma=0.001, OI=1000 → callGEX = 0.001 × 1000 × 625,000,000 × 0.01 = 6,250,000
    const result = calculateGEX([strike({ strike: 25000, ceGamma: 0.001, ceOI: 1000, peGamma: 0.0005, peOI: 500 })], spot);
    // callGEX=6.25M, putGEX=-1.5625M, netGEX=4.6875M
    expect(result.totalGEX).toBeCloseTo(4_687_500, 0);
  });

  test("PE gamma is negated", () => {
    // CE gamma tiny → putGEX dominates → totalGEX is negative
    const result = calculateGEX([strike({ strike: 25000, ceGamma: 0.00000001, ceOI: 1, peGamma: 0.001, peOI: 1000 })], spot);
    expect(result.totalGEX).toBeLessThan(-6_000_000);
  });

  test("missing gamma or OI returns null and is skipped", () => {
    const result = calculateGEX([strike({ strike: 25000 }), strike({ strike: 25100, ceGamma: 0.001, ceOI: 100 })], spot);
    expect(result.status).toBe("DEGRADED");
    expect(result.totalGEX).toBe(0);
  });

  test("zero gamma returns null and is skipped", () => {
    const result = calculateGEX([strike({ strike: 25000, ceGamma: 0, ceOI: 1000 }), strike({ strike: 25100, ceGamma: 0.001, ceOI: 100 })], spot);
    expect(result.status).toBe("DEGRADED");
  });
});

describe("findGammaWalls — top gamma walls", () => {
  const spot = 25000;

  test("returns top 3 walls by absolute GEX", () => {
    const chain = [
      { ...strike({ strike: 24500, ceGamma: 0.002, ceOI: 1000 }), pe: { gamma: 0.0005, oi: 500 } },
      { ...strike({ strike: 25500, peGamma: 0.001, peOI: 5000 }), ce: { gamma: 0.0005, oi: 500 } },
      { ...strike({ strike: 25000, ceGamma: 0.0005, ceOI: 2000 }), pe: { gamma: 0.0005, oi: 500 } },
      { ...strike({ strike: 26000, peGamma: 0.0001, peOI: 100 }), ce: { gamma: 0.0005, oi: 500 } },
    ];
    const walls = findGammaWalls(chain, spot, 3);
    expect(walls.length).toBe(3);
    // Largest absolute GEX first
    expect(walls[0].gex).toBeGreaterThanOrEqual(walls[1].gex);
    expect(walls[1].gex).toBeGreaterThanOrEqual(walls[2].gex);
  });
});

describe("findGammaFlip — cumulative GEX zero crossing", () => {
  const spot = 25000;

  test("returns spot when no flip found", () => {
    const chain = [
      { ...strike({ strike: 24500, ceGamma: 0.001, ceOI: 1000 }), pe: { gamma: 0.0005, oi: 500 } },
      { ...strike({ strike: 25500, ceGamma: 0.001, ceOI: 1000 }), pe: { gamma: 0.0005, oi: 500 } },
    ];
    expect(findGammaFlip(chain, spot)).toBe(spot);
  });

  test("interpolates between strikes when cumulative crosses zero", () => {
    const chain = [
      // Net negative at 24000, net positive at 25000 → flip at 25000
      { ...strike({ strike: 24000, ceGamma: 0.000001, ceOI: 1 }), pe: { gamma: 0.001, peOI: 1000 } },
      { ...strike({ strike: 25000, ceGamma: 0.001, ceOI: 1000 }), pe: { gamma: 0.000001, peOI: 1 } },
    ];
    const flip = findGammaFlip(chain, spot);
    expect(flip).toBeCloseTo(25000, 0);
  });
});

describe("calculateGEX — full engine", () => {
  const spot = 25000;

  test("aggregates totalGEX and classifies dealer regime", () => {
    const chain = [
      // Large negative netGEX at lower strike → cumulative crosses zero below spot
      strike({ strike: 24500, ceGamma: 0.0001, ceOI: 50, peGamma: 0.002, peOI: 2000 }),
      strike({ strike: 25000, ceGamma: 0.005, ceOI: 5000, peGamma: 0.0001, peOI: 50 }),
      strike({ strike: 25500, ceGamma: 0.001, ceOI: 1000, peGamma: 0.0001, peOI: 100 }),
    ];
    const result = calculateGEX(chain, spot);
    // -24.97M + 156.22M + 6.19M = 137.44M
    expect(result.totalGEX).toBeCloseTo(137_437_500, 0);
    expect(result.status).toBe("OK");
    // Cumulative GEX crosses zero below spot → spot > gammaFlip → LONG_GAMMA
    expect(result.dealerRegime).toBe("LONG_GAMMA");
  });

  test("DEGRADED status when fewer than 3 valid strikes", () => {
    const chain = [strike({ strike: 25000, ceGamma: 0.001, ceOI: 1000, peGamma: 0.0005, peOI: 500 })];
    const result = calculateGEX(chain, spot);
    expect(result.status).toBe("DEGRADED");
  });

  test("zero or missing greeks produce empty result", () => {
    const chain = [strike({ strike: 25000 })];
    const result = calculateGEX(chain, spot);
    expect(result.totalGEX).toBe(0);
    expect(result.gammaFlip).toBe(spot);
    expect(result.dealerRegime).toBe("SHORT_GAMMA"); // spot <= gammaFlip(=spot)
    expect(result.status).toBe("DEGRADED");
  });

  test("dealer bias from nearest CE wall → BEARISH", () => {
    const chain = [
      // CE wall at 25050 (dist 50), no PE wall at this strike
      { ...strike({ strike: 25050, ceGamma: 0.001, ceOI: 1000 }), pe: { gamma: null, oi: null } },
      // PE wall at 24900 (dist 100), no CE wall at this strike
      { ...strike({ strike: 24900, peGamma: 0.001, peOI: 1000 }), ce: { gamma: null, oi: null } },
    ];
    const result = calculateGEX(chain, spot);
    // CE wall at 25050 (dist 50) vs PE wall at 24900 (dist 100) → CE closer → BEARISH
    expect(result.dealerBias).toBe("BEARISH");
  });

  test("dealer bias from nearest PE wall → BULLISH", () => {
    const chain = [
      // PE wall at 24900 (dist 100), no CE wall at this strike
      { ...strike({ strike: 24900, peGamma: 0.001, peOI: 1000 }), ce: { gamma: null, oi: null } },
      // CE wall at 25500 (dist 500), no PE wall at this strike
      { ...strike({ strike: 25500, ceGamma: 0.001, ceOI: 100 }), pe: { gamma: null, oi: null } },
    ];
    const result = calculateGEX(chain, spot);
    // PE wall closer → BULLISH
    expect(result.dealerBias).toBe("BULLISH");
  });
});
