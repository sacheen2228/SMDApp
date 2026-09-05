import { describe, it, expect, beforeEach } from "bun:test";
import {
  recordTrade,
  updateTradeExit,
  getRecords,
  computePerformance,
  type ScoredTradeRecord,
} from "../src/lib/performance-monitor";
import {
  freezeScore,
  getFrozenScore,
  getAllFrozenScores,
  removeFrozenScore,
  compareScoreAtEntry,
  getScoreStability,
  type FrozenScore,
} from "../src/lib/score-frozen";
import { scoreTrade, type MarketDataInput } from "../src/lib/unified-scoring-engine";

// ─── Performance Monitor Tests ─────────────────────────────────────

describe("Performance Monitor", () => {
  it("records and retrieves trades", () => {
    const record: ScoredTradeRecord = {
      id: "test-1",
      symbol: "NIFTY",
      strategy: "FO",
      scoreAtEntry: 85,
      grade: "A",
      direction: "CALL",
      entry: 200,
      stopLoss: 150,
      target1: 300,
      entryTime: Date.now(),
      scoreVersion: "2.0",
      weightsUsed: {},
    };
    recordTrade(record);
    const records = getRecords("FO");
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records.find(r => r.id === "test-1")).toBeTruthy();
  });

  it("updates trade exit", () => {
    const record: ScoredTradeRecord = {
      id: "test-exit",
      symbol: "NIFTY",
      strategy: "EQUITY_SWING",
      scoreAtEntry: 75,
      grade: "B",
      direction: "LONG",
      entry: 100,
      stopLoss: 90,
      target1: 120,
      entryTime: Date.now(),
      scoreVersion: "2.0",
      weightsUsed: {},
    };
    recordTrade(record);
    updateTradeExit("test-exit", "EQUITY_SWING", {
      exitTime: Date.now() + 60000,
      exitPrice: 115,
      exitReason: "TP1",
      pnl: 1500,
      rMultiple: 1.5,
    });
    const updated = getRecords("EQUITY_SWING").find(r => r.id === "test-exit");
    expect(updated?.exitPrice).toBe(115);
    expect(updated?.pnl).toBe(1500);
    expect(updated?.rMultiple).toBe(1.5);
  });

  it("computes performance stats", () => {
    // Record a few trades
    for (let i = 0; i < 5; i++) {
      const record: ScoredTradeRecord = {
        id: `perf-test-${i}`,
        symbol: "NIFTY",
        strategy: "OPTIONS",
        scoreAtEntry: 70 + i * 5,
        grade: i >= 3 ? "A" : "B",
        direction: "CALL",
        entry: 100,
        stopLoss: 90,
        target1: 120,
        entryTime: Date.now() - (5 - i) * 100000,
        exitTime: i < 4 ? Date.now() - (4 - i) * 100000 : undefined,
        exitPrice: i < 4 ? (i % 2 === 0 ? 115 : 85) : undefined,
        pnl: i < 4 ? (i % 2 === 0 ? 1500 : -1500) : undefined,
        rMultiple: i < 4 ? (i % 2 === 0 ? 1.5 : -1.5) : undefined,
        scoreVersion: "2.0",
        weightsUsed: {},
      };
      recordTrade(record);
    }
    const perf = computePerformance("OPTIONS");
    expect(perf.length).toBe(1);
    expect(perf[0].strategy).toBe("OPTIONS");
    expect(perf[0].totalTrades).toBeGreaterThanOrEqual(5);
  });
});

// ─── Score Frozen Tests ────────────────────────────────────────────

describe("Score Frozen at Entry", () => {
  it("freezes and retrieves score", () => {
    const input: MarketDataInput = {
      symbol: "NIFTY",
      strategy: "FO",
      direction: "BULLISH",
      spot: 24500,
      entryPrice: 200,
      stopLoss: 150,
      target1: 300,
    };
    const decision = scoreTrade(input);
    const frozen = freezeScore("trade-frozen-1", decision, {
      spotAtEntry: 24500,
      vixAtEntry: 14,
      lotSize: 50,
    });
    expect(frozen.score).toBe(decision.score);
    expect(frozen.grade).toBe(decision.grade);
    expect(frozen.spotAtEntry).toBe(24500);
    expect(frozen.frozenAt).toBeGreaterThan(0);

    const retrieved = getFrozenScore("trade-frozen-1");
    expect(retrieved).toBeTruthy();
    expect(retrieved?.score).toBe(decision.score);
  });

  it("compares frozen vs live score", () => {
    const input: MarketDataInput = {
      symbol: "NIFTY",
      strategy: "FO",
      direction: "BULLISH",
      spot: 24500,
      entryPrice: 200,
      stopLoss: 150,
      target1: 300,
    };
    const decision = scoreTrade(input);
    freezeScore("trade-compare-1", decision, { spotAtEntry: 24500 });

    const currentDecision = scoreTrade({ ...input, spot: 24600 });
    const comparison = compareScoreAtEntry("trade-compare-1", currentDecision);
    expect(comparison).toBeTruthy();
    expect(comparison?.frozenScore).toBe(decision.score);
    expect(comparison?.scoreDelta).toBeDefined();
    expect(comparison?.interpretation).toBeDefined();
  });

  it("detects score stability", () => {
    const frozen: FrozenScore = {
      tradeId: "stability-test",
      symbol: "NIFTY",
      strategy: "FO",
      direction: "LONG",
      score: 80,
      grade: "A",
      scoreBreakdown: [],
      hardGatesAtEntry: { passed: true, gates: [], failedGates: [], warningGates: [] },
      weightsUsed: {},
      scoringVersion: "2.0",
      entryPrice: 200,
      stopLoss: 150,
      target1: 300,
      riskReward: 2,
      spotAtEntry: 24500,
      frozenAt: Date.now(),
    };

    expect(getScoreStability(frozen, 82)).toBe("STABLE");
    expect(getScoreStability(frozen, 70)).toBe("DRIFTING");
    expect(getScoreStability(frozen, 50)).toBe("DIVERGED");
  });

  it("removes frozen score", () => {
    const input: MarketDataInput = {
      symbol: "NIFTY",
      strategy: "FO",
      direction: "BULLISH",
      spot: 24500,
    };
    const decision = scoreTrade(input);
    freezeScore("trade-remove-1", decision);
    expect(getFrozenScore("trade-remove-1")).toBeTruthy();
    const removed = removeFrozenScore("trade-remove-1");
    expect(removed).toBe(true);
    expect(getFrozenScore("trade-remove-1")).toBeUndefined();
  });
});
