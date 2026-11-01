import { describe, test, expect, afterAll, beforeEach } from "bun:test";
import { selectWinner } from "../src/lib/quant/quant-signal-engine";
import { confirmWithChain } from "../src/lib/quant/quant-engine";
import { effectiveTuning, setQuantRuntimeConfig, getQuantRuntimeConfig, __resetQuantRuntimeConfigForTests } from "../src/lib/quant/quant-runtime-config";
import type { QuantStrategySignal, QuantRegimeResult, QuantFeatures } from "../src/lib/quant/quant-types";
import type { CanonicalOptionChain } from "@/lib/data-layer/chains/option-chain";

beforeEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
});
afterAll(() => {
  __resetQuantRuntimeConfigForTests();
});

const regime: QuantRegimeResult = { regime: "TRENDING_UP", confidence: 0.8, measurements: {}, reasons: ["test"] };
const features: QuantFeatures = {} as QuantFeatures;

function sig(strategy: string, direction: any, score: number, eligible = true): QuantStrategySignal {
  return { strategy, direction, eligible, score, evidence: [], rejectionReasons: [] };
}

describe("high-accuracy tuning gates", () => {
  test("effectiveTuning defaults to baseline when file absent", () => {
    __resetQuantRuntimeConfigForTests();
    const t = effectiveTuning();
    expect(t.minScore).toBe(55);
    expect(t.requireChainConfirm).toBe(false);
    expect(t.maxTradesPerDay).toBeNull(); // unlimited — quality gates only
    expect(t.maxConcurrentPositions).toBeNull();
  });

  test("effectiveTuning reads strict values from the file", () => {
    setQuantRuntimeConfig({ tuning: { minScore: 70, minRewardRisk: 2, maxTradesPerDay: null, maxConcurrentPositions: null, requireChainConfirm: true } });
    const t = effectiveTuning();
    expect(t.minScore).toBe(70);
    expect(t.minRewardRisk).toBe(2);
    expect(t.maxTradesPerDay).toBeNull();
    expect(t.maxConcurrentPositions).toBeNull();
    expect(t.requireChainConfirm).toBe(true);
    __resetQuantRuntimeConfigForTests();
  });

  test("explicit null caps mean unlimited (not 'absent')", () => {
    setQuantRuntimeConfig({ tuning: { maxTradesPerDay: null, maxConcurrentPositions: null } });
    const t = effectiveTuning();
    expect(t.maxTradesPerDay).toBeNull();
    expect(t.maxConcurrentPositions).toBeNull();
    __resetQuantRuntimeConfigForTests();
  });

  test("selectWinner honours minScore param — 78.6 wins at 70, 60 does not", () => {
    const strong = selectWinner([sig("TREND_CONTINUATION", "BUY_CE", 78.6)], regime, features, 70);
    expect(strong.winner?.strategy).toBe("TREND_CONTINUATION");
    const weak = selectWinner([sig("TREND_CONTINUATION", "BUY_CE", 60)], regime, features, 70);
    expect(weak.winner).toBeNull();
    // baseline default still accepts 60
    const base = selectWinner([sig("TREND_CONTINUATION", "BUY_CE", 60)], regime, features);
    expect(base.winner?.strategy).toBe("TREND_CONTINUATION");
  });

  test("confirmWithChain — missing chain fails closed", () => {
    const r = confirmWithChain("BUY_CE", null);
    expect(r.confirmed).toBe(false);
    expect(r.evidence).toContain("unavailable");
  });

  test("confirmWithChain — non-option direction is n/a-confirmed", () => {
    const r = confirmWithChain("BUY", { underlying: "X", spot: 100, expiry: null, strikes: [], asOf: "", isEod: false, source: "test", fallbackUsed: false } as unknown as CanonicalOptionChain);
    expect(r.confirmed).toBe(true);
    expect(r.evidence).toContain("n/a");
  });

  test("confirmWithChain — heavy call writing above spot is AGAINST a CE buy", () => {
    const strikes = [];
    for (let k = 0; k <= 10; k++) {
      const strike = 22000 + k * 100;
      strikes.push({
        strike,
        ce: k >= 5
          ? { ltp: 50, volume: 1000, oi: 500000, oiChange: 250000, iv: 0.14, delta: 0.2 } // massive fresh call writing overhead
          : { ltp: 200, volume: 500, oi: 100000, oiChange: -50000, iv: 0.14, delta: 0.8 },
        pe: { ltp: 80, volume: 400, oi: 80000, oiChange: -20000, iv: 0.15, delta: -0.3 },
      });
    }
    const chain = { underlying: "NIFTY", spot: 22480, expiry: "27-Oct-2026", strikes, asOf: "", isEod: false, source: "test", fallbackUsed: false } as unknown as CanonicalOptionChain;
    const r = confirmWithChain("BUY_CE", chain);
    expect(r.confirmed).toBe(false);
    expect(r.evidence.startsWith("against")).toBe(true);
  });
});
