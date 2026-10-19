import { describe, test, expect } from "bun:test";
import { getSnapshot, putSnapshot, isFresh, cachedLayers, cacheStats, buildSnapshot, prune, TF_TTL_MS } from "@/lib/tech-cache";
import { structureLayer, triggerLayer, type Candle } from "@/lib/tech-read";

function upCandles(n = 40): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const base = 24700 + i * 10;
    out.push({ t: i * 86_400_000, o: base, h: base + 60, l: base - 50, c: base + 15 });
  }
  return out;
}

describe("tech-cache — O(1) reads, staleness never blocks", () => {
  test("a miss returns stale, not a throw", () => {
    const r = cachedLayers("NIFTY", "15m", "call", structureLayer, triggerLayer);
    expect(r.stale).toBe(true);
    expect(r.structure).toBeUndefined();
  });

  test("a built snapshot is served from memory and stays fresh within one bar", () => {
    const now = Date.now();
    const snap = buildSnapshot("TESTIDX", "15m", upCandles(), now);
    expect(snap).not.toBeNull();
    const got = getSnapshot("TESTIDX", "15m");
    expect(got).toBeDefined();
    expect(isFresh(got, "15m", now + TF_TTL_MS["15m"] - 1000)).toBe(true);
    expect(isFresh(got, "15m", now + TF_TTL_MS["15m"] + 1000)).toBe(false);
  });

  test("cached layers come from the cached read with evidence", () => {
    const now = Date.now();
    buildSnapshot("TESTIDX2", "15m", upCandles(), now);
    const r = cachedLayers("TESTIDX2", "15m", "call", structureLayer, triggerLayer);
    expect(r.stale).toBe(false);
    expect(r.structure?.state).toBeDefined();
    expect(r.structure?.evidence).toBeTruthy();
  });

  test("cache stats report fresh/stale counts and pruning removes dead entries", () => {
    const now = Date.now();
    buildSnapshot("TESTIDX3", "5m", upCandles(), now);
    const st = cacheStats(now);
    expect(st.symbols).toBeGreaterThan(0);
    expect(st.fresh + st.stale + st.errors).toBe(st.symbols);
    expect(prune(now + TF_TTL_MS["5m"] * 3)).toBeGreaterThan(0);
  });
});
