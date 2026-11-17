import { describe, test, expect } from "bun:test";
import { emaCrossAdxAtr, ema, type Candle } from "@/lib/DailyDerivatives";

// Synthetic candle builders — deterministic, no Math.random.
const bar = (time: number, open: number, high: number, low: number, close: number): Candle => ({
  time, open, high, low, close, volume: 1000,
});

/** Flat-ish series around `base` for `n` bars with a small daily range. */
function flat(n: number, base = 100, amp = 0.4, t0 = 0): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = base + ((i % 5) - 2) * (amp / 2);
    out.push(bar(t0 + i, c - 0.1, c + amp, c - amp, c));
  }
  return out;
}

/** Steady climb of `step` per bar starting from the last close of `prev`. */
function climb(prev: Candle[], n: number, step = 1.2, range = 0.8): Candle[] {
  const out = [...prev];
  let c = prev[prev.length - 1].close;
  const t0 = out.length;
  for (let i = 0; i < n; i++) {
    const open = c;
    c = open + step;
    out.push(bar(t0 + i, open, c + range, open - 0.2, c));
  }
  return out;
}

function types(signals: { type: string }[]): string[] {
  return [...new Set(signals.map((s) => s.type))];
}

describe("Daily Derivatives signal setups", () => {
  test("EMA 9/15 crossover fires on a trend birth (adxMinCross floor)", () => {
    // Established downtrend (ADX high), then a gradual recovery: EMA9 crosses
    // up while ADX is still elevated from the decline — the exact regime the
    // adxMinCross floor exists for (cross at trend inception, ADX ramping).
    let series: Candle[] = [];
    let c = 120;
    for (let i = 0; i < 22; i++) {
      const open = c;
      c = open - 0.9;
      series.push(bar(i, open, open + 0.3, c - 0.4, c));
    }
    const t0 = series.length;
    let r = series[series.length - 1].close;
    for (let i = 0; i < 14; i++) {
      const open = r;
      r = open + 0.7;
      series.push(bar(t0 + i, open - 0.1, r + 0.4, open - 0.3, r));
    }
    const { signals } = emaCrossAdxAtr(series);
    const cross = signals.filter((s) => s.type === "CROSSOVER" && s.side === "LONG");
    expect(cross.length).toBeGreaterThan(0);
    expect(cross[0].reason).toContain("EMA9 crossed above EMA15");
    expect(Number.isFinite(cross[0].strength)).toBe(true);
  });

  test("EMA pullback fires and a wick-reclaim bar is labelled rejection", () => {
    // Established climb, then one bar that wicks into the fast EMA and reclaims.
    let series = climb(flat(20), 25, 1.1);
    const closes = series.map((x) => x.close);
    const e9 = ema(closes, 9);
    const e15 = ema(closes, 15);
    const i = series.length;
    const prevClose = series[i - 1].close;
    // Exact post-bar EMAs for a candidate close (SMA-seeded recursion step).
    const close = prevClose + 0.6;
    const f = close * (2 / 10) + e9[i - 1]! * (1 - 2 / 10);
    const s = close * (2 / 16) + e15[i - 1]! * (1 - 2 / 16);
    const open = close - 0.5;
    const low = Math.max(f - 0.8, s - 0.2); // pierces fast EMA, holds above slow − tol
    const high = open + 0.3;
    series = [...series, bar(i, open, high, low, close)];

    const { signals } = emaCrossAdxAtr(series);
    const pulls = signals.filter((s) => s.type === "PULLBACK" && s.side === "LONG");
    expect(pulls.length).toBeGreaterThan(0);
    expect(pulls[pulls.length - 1].reason).toMatch(/Pullback to EMA zone|EMA rejection/);
  });

  test("breakout retest & confirmation emits RETEST after a breakout", () => {
    // Climb → breakout bar above the 20-bar high → pullback that holds the level.
    let series = climb(flat(20), 16, 1.1); // climb so ADX/DI are healthy past warmup
    // breakout bar: big expansion above the recent high
    const last = series[series.length - 1];
    const hh = Math.max(...series.slice(-20).map((c) => c.high));
    const bo = series.length;
    series = [...series, bar(bo, last.close, hh + 3, last.close - 0.5, hh + 2.6)];
    // two retest bars: dip into the broken level, close back above it
    let c = hh + 2.6;
    for (let j = 0; j < 3; j++) {
      const t = series.length;
      const open = c;
      c = open - 0.4;
      const low = hh - 0.3 + j * 0.4; // touches the old resistance
      const close = hh + 0.8; // confirms it as support
      series = [...series, bar(t, open, open + 0.3, Math.min(low, open - 0.5), close)];
      c = close;
    }

    const { signals } = emaCrossAdxAtr(series);
    const retests = signals.filter((s) => s.type === "RETEST");
    expect(retests.length).toBeGreaterThan(0);
    expect(retests[0].side).toBe("LONG");
    expect(retests[0].reason).toContain("support");
    // structure: stop below the retest low / level
    expect(retests[0].stop).toBeLessThan(retests[0].entry);
  });

  test("bull trap: sweep of the range high that closes back inside → FAKEOUT SHORT", () => {
    // 30 flat bars (range high ~101), then a sweep bar that pokes above and closes red inside.
    const series = flat(30, 100, 0.5);
    const hh = Math.max(...series.slice(-20).map((c) => c.high));
    const last = series[series.length - 1];
    const t = series.length;
    const sweep = bar(t, last.close, hh + 1.5, last.close - 0.6, hh - 0.7); // wick above, close below
    const { signals } = emaCrossAdxAtr([...series, sweep]);

    const traps = signals.filter((s) => s.type === "FAKEOUT" && s.side === "SHORT");
    expect(traps.length).toBeGreaterThan(0);
    expect(traps[0].reason).toContain("Bull trap");
    expect(traps[0].stop).toBeGreaterThan(traps[0].entry); // short geometry
  });

  test("bear trap: sweep of the range low that closes back inside → FAKEOUT LONG", () => {
    const series = flat(30, 100, 0.5);
    const ll = Math.min(...series.slice(-20).map((c) => c.low));
    const last = series[series.length - 1];
    const t = series.length;
    const sweep = bar(t, ll + 0.2, ll + 0.9, ll - 1.5, ll + 0.7); // bull bar: close > open
    const { signals } = emaCrossAdxAtr([...series, sweep]);

    const traps = signals.filter((s) => s.type === "FAKEOUT" && s.side === "LONG");
    expect(traps.length).toBeGreaterThan(0);
    expect(traps[0].reason).toContain("Bear trap");
    expect(traps[0].stop).toBeLessThan(traps[0].entry); // long geometry
  });

  test("trend reversal: structure break + EMA flip + DI after an established run", () => {
    // Rise → shallow pullback that prints a swing low → crash bar that flips
    // EMA9 below EMA15, closes below the swing low with DI bearish.
    let series: Candle[] = [];
    let c = 100;
    for (let i = 0; i < 36; i++) {
      const open = c;
      c = open + 1.4;
      series.push(bar(i, open, c + 0.5, open - 0.2, c));
    }
    // shallow pullback → swing low
    const p1 = series[series.length - 1];
    series.push(bar(series.length, p1.close, p1.close + 0.2, p1.close - 2.2, p1.close - 1.8));
    const p2 = series[series.length - 1];
    series.push(bar(series.length, p2.close, p2.close + 0.3, p2.close - 1.6, p2.close - 1.2)); // swing low
    const p3 = series[series.length - 1];
    series.push(bar(series.length, p3.close, p3.close + 1.0, p3.close - 0.3, p3.close + 0.6)); // recovery
    // crash: sustained red bars below the swing low (enough to flip EMA9/15)
    const p4 = series[series.length - 1];
    series.push(bar(series.length, p4.close, p4.close + 0.3, p4.close - 4.5, p4.close - 4.2));
    let pc = series[series.length - 1];
    for (let j = 0; j < 4; j++) {
      const open = pc.close;
      const close = open - 5.0;
      series.push(bar(series.length, open, open + 0.2, close - 0.5, close));
      pc = series[series.length - 1];
    }

    const { signals } = emaCrossAdxAtr(series);
    const rev = signals.filter((s) => s.type === "REVERSAL" && s.side === "SHORT");
    expect(rev.length).toBeGreaterThan(0);
    expect(rev[0].reason).toContain("swing low");
    expect(rev[0].stop).toBeGreaterThan(rev[0].entry); // short geometry
  });

  test("consolidation breakout is annotated as such", () => {
    // Rise → tight 10-bar consolidation → expansion bar out of the range.
    let series = climb(flat(16), 14, 1.3);
    const base = series[series.length - 1].close;
    for (let j = 0; j < 10; j++) {
      const t = series.length;
      const wob = j % 2 === 0 ? 0.3 : -0.3;
      series = [...series, bar(t, base + wob, base + 0.6, base - 0.6, base + wob + (j % 3) * 0.1)];
    }
    const last = series[series.length - 1];
    const t = series.length;
    // expansion bar out of the consolidation ceiling
    series = [...series, bar(t, last.close, last.close + 3.2, last.close - 0.4, last.close + 2.8)];

    const { signals } = emaCrossAdxAtr(series);
    const bos = signals.filter((s) => s.type === "BREAKOUT" && s.side === "LONG");
    expect(bos.length).toBeGreaterThan(0);
    expect(bos.some((s) => s.reason.includes("Consolidation breakout"))).toBe(true);
  });

  test("every signal carries finite strength, valid stop and ≥1 target", () => {
    const series = climb(flat(25), 35, 1.2);
    const { signals } = emaCrossAdxAtr(series);
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) {
      expect(Number.isFinite(s.strength)).toBe(true);
      expect(s.targets.length).toBeGreaterThanOrEqual(1);
      if (s.side === "LONG") expect(s.stop).toBeLessThan(s.entry);
      else expect(s.stop).toBeGreaterThan(s.entry);
      expect(types([s]).length).toBe(1);
    }
  });
});
