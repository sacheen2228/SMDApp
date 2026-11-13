/// <reference types="bun-types" />
// MC confidence gate — pure Monte Carlo + gate semantics.
// Offline: gap ≥ 0.05 lifted 478-signal accuracy 39.1% → 62.1%.

import { describe, it, expect } from "bun:test";
import {
  monteCarloBracket,
  istDecisionMinutes,
  clampToSession,
  mcBlocksAlert,
  MC_CONFIG,
  type McBar,
} from "@/lib/mc-confidence-gate";

function bar(date: string, hh: number, mm: number, o: number, h: number, l: number, c: number): McBar {
  const t = `${date} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
  return { date, time: t, open: o, high: h, low: l, close: c, volume: 1000 };
}

/** Synthetic prior sessions: steady up-drift 5m bars for `days` dates. */
function upBars(days: string[], start = 100): McBar[] {
  const out: McBar[] = [];
  let px = start;
  for (const d of days) {
    let t = 9 * 60 + 15;
    px = start;
    for (let i = 0; i < 75; i++) {
      const o = px;
      const c = px * 1.0008; // ~+0.08% per 5m → strong long edge
      const h = Math.max(o, c) * 1.0002;
      const l = Math.min(o, c) * 0.9998;
      out.push(bar(d, Math.floor(t / 60), t % 60, o, h, l, c));
      px = c;
      t += 5;
    }
  }
  return out;
}

/** Steady down-drift. */
function downBars(days: string[], start = 100): McBar[] {
  const out: McBar[] = [];
  for (const d of days) {
    let t = 9 * 60 + 15;
    let px = start;
    for (let i = 0; i < 75; i++) {
      const o = px;
      const c = px * 0.9992;
      const h = Math.max(o, c) * 1.0002;
      const l = Math.min(o, c) * 0.9998;
      out.push(bar(d, Math.floor(t / 60), t % 60, o, h, l, c));
      px = c;
      t += 5;
    }
  }
  return out;
}

const DAYS = [
  "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30",
  "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-11",
];

describe("monteCarloBracket", () => {
  it("returns unavailable with no bars or no prior dates", () => {
    const r1 = monteCarloBracket([], [], 100, "LONG", 12 * 60);
    expect(r1.available).toBe(false);

    const r2 = monteCarloBracket(upBars(DAYS), [], 100, "LONG", 12 * 60);
    expect(r2.available).toBe(false);
  });

  it("is deterministic for the same seed (same result twice)", () => {
    const bars = upBars(DAYS);
    const a = monteCarloBracket(bars, DAYS, 100, "LONG", 12 * 60);
    const b = monteCarloBracket(bars, DAYS, 100, "LONG", 12 * 60);
    expect(a.available).toBe(true);
    expect(a.pTarget).toBe(b.pTarget);
    expect(a.pStop).toBe(b.pStop);
    expect(a.gap).toBe(b.gap);
  });

  it("up-drift pool → LONG gap > SHORT gap", () => {
    const bars = upBars(DAYS);
    const long = monteCarloBracket(bars, DAYS, 100, "LONG", 12 * 60);
    const short = monteCarloBracket(bars, DAYS, 100, "SHORT", 12 * 60);
    expect(long.available).toBe(true);
    expect(short.available).toBe(true);
    expect(long.gap).toBeGreaterThan(short.gap);
  });

  it("down-drift pool → SHORT gap > LONG gap", () => {
    const bars = downBars(DAYS);
    const long = monteCarloBracket(bars, DAYS, 100, "LONG", 12 * 60);
    const short = monteCarloBracket(bars, DAYS, 100, "SHORT", 12 * 60);
    expect(short.gap).toBeGreaterThan(long.gap);
  });

  it("gaps are probabilities in [-1,1] and pT+pS+pN ≈ 1", () => {
    const r = monteCarloBracket(upBars(DAYS), DAYS, 100, "LONG", 13 * 60);
    expect(r.available).toBe(true);
    expect(r.pTarget).toBeGreaterThanOrEqual(0);
    expect(r.pTarget).toBeLessThanOrEqual(1);
    expect(r.pStop).toBeGreaterThanOrEqual(0);
    expect(r.pStop).toBeLessThanOrEqual(1);
    expect(r.pTarget + r.pStop + r.pNeither).toBeCloseTo(1, 5);
    expect(r.gap).toBeCloseTo(r.pTarget - r.pStop, 10);
  });

  it("thins out when prior sessions are too few (minNonEmptySlots)", () => {
    const oneDay = ["2026-11-06"];
    // Floor above any single-session slot count → unavailable, n=0.
    const r = monteCarloBracket(upBars(oneDay), oneDay, 100, "LONG", 12 * 60, {
      ...MC_CONFIG,
      minNonEmptySlots: 200,
      replays: 50,
    });
    expect(r.available).toBe(false);
    expect(r.n).toBe(0);
    expect(r.gap).toBe(0);
  });

  it("rejects invalid decision minute (before session)", () => {
    const r = monteCarloBracket(upBars(DAYS), DAYS, 100, "LONG", 8 * 60);
    expect(r.available).toBe(false);
  });

  it("uses configured replays count", () => {
    const r = monteCarloBracket(upBars(DAYS), DAYS, 100, "LONG", 12 * 60, {
      ...MC_CONFIG,
      replays: 100,
    });
    expect(r.n).toBe(100);
  });
});

describe("mcBlocksAlert", () => {
  it("blocks only on explicit fail", () => {
    expect(mcBlocksAlert(false)).toBe(true);
    expect(mcBlocksAlert(true)).toBe(false);
    expect(mcBlocksAlert(null)).toBe(false);
    expect(mcBlocksAlert(undefined)).toBe(false);
  });
});

describe("istDecisionMinutes", () => {
  it("returns minutes in [0, 1439]", () => {
    const m = istDecisionMinutes(new Date("2026-11-13T07:30:00.000Z")); // 13:00 IST
    expect(m).toBeGreaterThanOrEqual(0);
    expect(m).toBeLessThan(1440);
    // 07:30 UTC = 13:00 IST
    expect(m).toBe(13 * 60);
  });
});

describe("clampToSession", () => {
  it("clamps pre-open and after-close into the cash session", () => {
    expect(clampToSession(8 * 60)).toBe(9 * 60 + 20);
    expect(clampToSession(16 * 60)).toBe(15 * 60 + 20);
    expect(clampToSession(22 * 60 + 30)).toBe(15 * 60 + 20); // after-hours wall clock
    expect(clampToSession(12 * 60)).toBe(12 * 60);
    expect(clampToSession(NaN)).toBe(9 * 60 + 20);
  });

  it("after-hours wall clock still yields a valid MC entry slot", () => {
    const bars = upBars(DAYS);
    const decisionMin = clampToSession(istDecisionMinutes(new Date("2026-11-13T18:00:00.000Z"))); // 23:30 IST
    const r = monteCarloBracket(bars, DAYS, 100, "LONG", decisionMin);
    expect(r.available).toBe(true);
  });
});
