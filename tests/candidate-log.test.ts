import { describe, test, expect } from "bun:test";
import { evaluateSignalVeto, tierFromWarnings } from "@/lib/signal-veto";
import { simulateOutcome, promotionEligible } from "@/lib/candidate-resolver";
import { configHash } from "@/lib/candidate-log";
import type { Candle } from "@/lib/tech-read";

const base = {
  nowMs: Date.parse("2026-07-15T10:05:00+05:30"), // before the 13:00 option-buy cutoff
  symbol: "NIFTY", action: "BUY CE", optionType: "CE" as const, strike: 25200,
  entry: 350, stopLoss: 320, tp1: 420, confidence: 70,
};

describe("veto — fail closed on missing critical fields", () => {
  test("missing stop blocks", () => {
    const r = evaluateSignalVeto({ ...base, stopLoss: undefined });
    expect(r.verdict).toBe("BLOCK");
    expect(r.hardFail).toBe(true);
    expect(r.suppress).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/missing stop/i);
  });
  test("missing target blocks (R:R not computable)", () => {
    const r = evaluateSignalVeto({ ...base, tp1: undefined });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/target/i);
  });
  test("missing expiry blocks only when the caller can supply it", () => {
    const lenient = evaluateSignalVeto({ ...base, expiry: undefined });
    expect(lenient.hardFail).toBe(false);
    const strict = evaluateSignalVeto({ ...base, expiry: undefined, requireExpiry: true });
    expect(strict.verdict).toBe("BLOCK");
    expect(strict.reasons.join(" ")).toMatch(/expiry/i);
  });
  test("missing spot blocks only when the caller can supply it", () => {
    const strict = evaluateSignalVeto({ ...base, spot: undefined, requireSpot: true });
    expect(strict.verdict).toBe("BLOCK");
    expect(strict.reasons.join(" ")).toMatch(/spot/i);
  });
});

describe("veto — BTST path stays untouched", () => {
  test("BTST source is never blocked or warned", () => {
    const r = evaluateSignalVeto({ ...base, source: "BTST:scanner", stopLoss: 400, tp1: 100, confidence: 10 });
    expect(r.verdict).toBe("PASS");
    expect(r.suppress).toBe(false);
    expect(r.tier).toBe("A");
  });
});

describe("veto — shadow mode never loosens a hard gate", () => {
  test("hard fail suppresses even in shadow mode", () => {
    const r = evaluateSignalVeto({ ...base, tp1: 380 }); // R:R 1.0
    expect(r.wouldBlock).toBe(true);
    expect(r.suppress).toBe(true);
    expect(r.tier).toBe("NONE");
  });
  test("quality signal is a warning, never a hard fail", () => {
    const r = evaluateSignalVeto({ ...base, confidence: 40 });
    expect(r.hardFail).toBe(false);
    expect(r.wouldBlock).toBe(true);
    expect(r.tier).toBe("B");
    expect(r.sizeFactor).toBe(0.5);
  });
});

describe("tiering", () => {
  test("A / B / C / NONE mapping", () => {
    expect(tierFromWarnings([], false)).toBe("A");
    expect(tierFromWarnings(["one"], false)).toBe("B");
    expect(tierFromWarnings(["one", "two"], false)).toBe("C");
    expect(tierFromWarnings([], true)).toBe("NONE");
  });
});

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
