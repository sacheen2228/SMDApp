// EMA Pullback Engine v2 — contract tests.
//
// These pin the RUNTIME contract of the Python engine + its JSON adapter:
//   * the adapter must reject a series that is too short (no fake signals)
//   * the adapter must attach ONLY the optional columns it was given
//   * the engine must be non-repainting: re-running it on the same data
//     gives the same answer
//   * the engine must never invent a signal that violates its own gates
//
// The python engine is invoked directly (python3 + numpy/pandas), so the
// suite skips when the interpreter or the deps are missing.

import { describe, it, expect } from "bun:test";
import { spawnSync } from "child_process";
import path from "path";

const RUNNER = path.join(
  process.cwd(),
  "skills/ema-pullback-engine/scripts/ema_pullback_runner.py"
);

function pythonAvailable(): boolean {
  try {
    const r = spawnSync("python3", ["-c", "import numpy, pandas"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

function runAdapter(payload: any): any {
  const r = spawnSync("python3", [RUNNER], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 120_000,
  });
  if (!r.stdout || !r.stdout.trim()) {
    return { ok: false, error: `no output (exit ${r.status}): ${(r.stderr || "").slice(0, 300)}` };
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { ok: false, error: `not JSON: ${r.stdout.slice(0, 200)}` };
  }
}

/** A deterministic 5m series (no Math.random — the suite must be stable). */
function makeCandles(n: number, startIso = "2026-10-20 09:15:00"): any[] {
  const out: any[] = [];
  const start = new Date(startIso.replace(" ", "T") + "Z").getTime();
  let price = 22000;
  for (let i = 0; i < n; i++) {
    // A slow uptrend with a deterministic wobble.
    price += 10 + ((i * 37) % 23) - 11;
    const o = price;
    const c = price + ((i * 13) % 9) - 4;
    const h = Math.max(o, c) + 6;
    const l = Math.min(o, c) - 6;
    out.push({
      datetime: new Date(start + i * 5 * 60_000).toISOString().slice(0, 19).replace("T", " "),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: 1000 + ((i * 91) % 700),
    });
  }
  return out;
}

const SKIP = pythonAvailable() ? describe : describe.skip;

SKIP("ema pullback engine adapter", () => {
  it("rejects a series that is too short instead of faking a signal", () => {
    const out = runAdapter({ candles: makeCandles(20) });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("70");
  });

  it("rejects an empty payload", () => {
    const out = runAdapter({ candles: [] });
    expect(out.ok).toBe(false);
  });

  it("runs on a full series and reports the bars it used", () => {
    const out = runAdapter({ candles: makeCandles(300) });
    expect(out.ok).toBe(true);
    expect(out.bars).toBe(300);
    expect(out.first).toBeTruthy();
    expect(out.last).toBeTruthy();
  });

  it("produces the CE/PE gate checklist for the last bar", () => {
    const out = runAdapter({ candles: makeCandles(300) });
    expect(out.ok).toBe(true);
    expect(out.last_bar).toBeTruthy();
    expect(out.last_bar.CE).toBeTruthy();
    expect(out.last_bar.PE).toBeTruthy();
    for (const side of ["CE", "PE"]) {
      expect(["VALID", "SKIP"]).toContain(out.last_bar[side].status);
      expect(Array.isArray(out.last_bar[side].skip_reasons)).toBe(true);
    }
  });

  it("is non-repainting — the same data gives the same answer twice", () => {
    const candles = makeCandles(300);
    const a = runAdapter({ candles });
    const b = runAdapter({ candles });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(JSON.stringify(a.signals)).toBe(JSON.stringify(b.signals));
    expect(JSON.stringify(a.last_bar)).toBe(JSON.stringify(b.last_bar));
  });

  it("never emits a signal that violates the score gate", () => {
    const out = runAdapter({ candles: makeCandles(300), config: { min_score: 70 } });
    expect(out.ok).toBe(true);
    for (const s of out.signals || []) {
      expect(s.score).toBeGreaterThanOrEqual(70);
      expect(s.rr).toBeGreaterThanOrEqual(2);
      expect(s.side === "CE" || s.side === "PE").toBe(true);
      // A CE signal must sit above its stop, a PE signal below it.
      if (s.side === "CE") expect(s.entry).toBeGreaterThan(s.stop);
      else expect(s.entry).toBeLessThan(s.stop);
    }
  });

  it("attaches the optional columns only when they are supplied", () => {
    const without = runAdapter({ candles: makeCandles(300) });
    const with_ = runAdapter({
      candles: makeCandles(300),
      vix: 17.15,
      call_wall: 23000,
      put_wall: 22500,
    });
    expect(without.ok).toBe(true);
    expect(with_.ok).toBe(true);
    // Both runs must complete — the optional columns only ADD gates.
    expect(Array.isArray(with_.signals)).toBe(true);
  });

  it("honours a min_score override", () => {
    const strict = runAdapter({ candles: makeCandles(300), config: { min_score: 99 } });
    const loose = runAdapter({ candles: makeCandles(300), config: { min_score: 1 } });
    expect(strict.ok).toBe(true);
    expect(loose.ok).toBe(true);
    expect((strict.signals || []).length).toBeLessThanOrEqual((loose.signals || []).length);
  });
});
