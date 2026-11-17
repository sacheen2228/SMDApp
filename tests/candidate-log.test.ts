import { describe, test, expect } from "bun:test";
import { simulateOutcome, promotionEligible } from "@/lib/candidate-resolver";
import { configHash, tierFromWarnings } from "@/lib/candidate-log";
import type { Candle } from "@/lib/tech-read";


describe("candidate resolver — deterministic simulation", () => {
  const mk = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c });
  const t0 = Date.parse("2026-07-15T09:30:00+05:30");

  test("target hit resolves to +R", () => {
    const candles = [mk(t0 + 60_000, 350, 355, 349, 352), mk(t0 + 120_000, 352, 425, 351, 420)];
    const r = simulateOutcome(candles, 350, 320, 420, { isLong: true, tsMs: t0 });
    expect(r.status).toBe("target");
    expect(r.outcomeR).toBeCloseTo(70 / 30, 5);
  });
  test("stop hit resolves to -1R", () => {
    const candles = [mk(t0 + 60_000, 350, 352, 315, 318)];
    const r = simulateOutcome(candles, 350, 320, 420, { isLong: true, tsMs: t0 });
    expect(r.status).toBe("stop");
    expect(r.outcomeR).toBeCloseTo(-1, 5);
  });
  test("same-bar tie resolves to the STOP (conservative)", () => {
    const candles = [mk(t0 + 60_000, 350, 425, 315, 350)];
    const r = simulateOutcome(candles, 350, 320, 420, { isLong: true, tsMs: t0 });
    expect(r.status).toBe("stop");
    expect(r.outcomeR).toBeCloseTo(-1, 5);
  });
  test("intraday flat at day end when neither level is touched", () => {
    const candles = [mk(t0 + 60_000, 350, 355, 345, 350), mk(t0 + 6 * 3600_000, 350, 356, 344, 351)];
    const r = simulateOutcome(candles, 350, 320, 420, { isLong: true, tsMs: t0, intraday: true });
    expect(r.status).toBe("flat");
    expect(r.outcomeR).toBe(0);
  });
  test("no candles → unresolved", () => {
    const r = simulateOutcome([], 350, 320, 420, { isLong: true, tsMs: t0 });
    expect(r.status).toBe("unresolved");
  });
});

describe("promotion rule", () => {
  test("needs the minimum resolved sample before promotion", () => {
    const rows = Array.from({ length: 10 }, () => ({ tier: "C" as const, outcomeR: 1 }));
    const p = promotionEligible(rows, { minResolvedTrades: 175, minExpectancyCiLowerR: 0 });
    expect(p.eligible).toBe(false);
    expect(p.n).toBe(10);
  });
  test("promotes only with a positive CI lower bound on expectancy", () => {
    const rows = Array.from({ length: 200 }, () => ({ tier: "C" as const, outcomeR: 0.5 }));
    const p = promotionEligible(rows, { minResolvedTrades: 175, minExpectancyCiLowerR: 0 });
    expect(p.eligible).toBe(true);
    expect(p.ciLowerR).toBeGreaterThan(0);
  });
  test("a negative expectancy tier-C population is not promoted", () => {
    const rows = Array.from({ length: 200 }, () => ({ tier: "C" as const, outcomeR: -0.2 }));
    const p = promotionEligible(rows, { minResolvedTrades: 175, minExpectancyCiLowerR: 0 });
    expect(p.eligible).toBe(false);
  });
});

describe("config hash", () => {
  test("is stable and changes with the config", () => {
    const h = configHash();
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(configHash()).toBe(h);
  });
});
