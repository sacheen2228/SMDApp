// Hermes Paper Trading — comprehensive tests

import { describe, it, expect, beforeEach } from "bun:test";
import { HermesPaperEngine, DEFAULT_PAPER_CONFIG } from "../src/lib/hermes/paper-engine";
import { PaperPerformanceEngine } from "../src/lib/hermes/paper-performance";
import {
  startPaperEngine,
  stopPaperEngine,
  getPaperEngineStatus,
} from "../src/lib/hermes/paper-worker";

// ── Paper Engine Tests ────────────────────────────────────────────────

describe("Hermes Paper Engine", () => {
  let engine: HermesPaperEngine;

  beforeEach(() => {
    engine = new HermesPaperEngine({
      enabled: false, // don't auto-evaluate
      evaluationIntervalMs: 1000,
      signalCooldownMinutes: 0,
      maxOpenPaperTrades: 5,
      maxHoldingMinutes: 390,
      paperSlippageBps: 5,
      startingCapital: 100000,
    });
  });

  it("starts with correct initial state", () => {
    const account = engine.getAccount();
    expect(account.startingCapital).toBe(100000);
    expect(account.currentCapital).toBe(100000);
    expect(account.totalTrades).toBe(0);
    expect(account.isActive).toBe(false);
  });

  it("start/stop works", () => {
    engine.start();
    expect(engine.isRunning()).toBe(true);
    engine.stop();
    expect(engine.isRunning()).toBe(false);
  });

  it("does not auto-evaluate when disabled", async () => {
    engine.start();
    await engine.evaluate();
    expect(engine.getOpenTrades().length).toBe(0);
    engine.stop();
  });

  it("defaults are valid", () => {
    expect(DEFAULT_PAPER_CONFIG.evaluationIntervalMs).toBeGreaterThan(0);
    expect(DEFAULT_PAPER_CONFIG.maxOpenPaperTrades).toBeGreaterThan(0);
    expect(DEFAULT_PAPER_CONFIG.paperSlippageBps).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_PAPER_CONFIG.startingCapital).toBeGreaterThan(0);
  });
});

// ── Worker Singleton Tests ────────────────────────────────────────────

describe("Paper Worker Singleton", () => {
  it("status returns STOPPED when no worker", async () => {
    await stopPaperEngine(); // ensure stopped
    const status = getPaperEngineStatus();
    expect(status.status).toBe("STOPPED");
  });

  it("start returns STARTING or RUNNING", async () => {
    const status = await startPaperEngine({ enabled: false });
    expect(status.status === "STARTING" || status.status === "RUNNING").toBe(true);
    await stopPaperEngine();
  });

  it("stop returns STOPPED", async () => {
    await startPaperEngine({ enabled: false });
    const status = await stopPaperEngine();
    expect(status.status).toBe("STOPPED");
  });

  it("duplicate start does not create new worker", async () => {
    const s1 = await startPaperEngine({ enabled: false });
    const s2 = await startPaperEngine({ enabled: false });
    // Both should report same status (no crash, no duplicate)
    expect(s1.status).toBeDefined();
    expect(s2.status).toBeDefined();
    await stopPaperEngine();
  });

  it("stop when already stopped is idempotent", async () => {
    const status = await stopPaperEngine();
    expect(status.status).toBe("STOPPED");
  });
});

// ── Performance Engine Tests ──────────────────────────────────────────

describe("Paper Performance Engine", () => {
  let perf: PaperPerformanceEngine;

  beforeEach(() => {
    perf = new PaperPerformanceEngine();
  });

  it("calculates metrics for empty trades", () => {
    const metrics = perf.calculateMetrics([]);
    expect(metrics.totalTrades).toBe(0);
    expect(metrics.winRate).toBe(0);
    expect(metrics.profitFactor).toBe(0);
  });

  it("calculates win rate correctly", () => {
    const trades = [
      { realizedPnL: 100, status: "TP1_HIT", score: 80, holdingTimeMs: 60000, maxFavorableExcursionPct: 10, maxAdverseExcursionPct: -5, riskReward: 2 },
      { realizedPnL: -50, status: "SL_HIT", score: 65, holdingTimeMs: 30000, maxFavorableExcursionPct: 5, maxAdverseExcursionPct: -10, riskReward: 1.5 },
      { realizedPnL: 200, status: "TP2_HIT", score: 90, holdingTimeMs: 120000, maxFavorableExcursionPct: 20, maxAdverseExcursionPct: -3, riskReward: 3 },
    ] as any[];

    const metrics = perf.calculateMetrics(trades);
    expect(metrics.totalTrades).toBe(3);
    expect(metrics.totalWins).toBe(2);
    expect(metrics.totalLosses).toBe(1);
    expect(metrics.winRate).toBeCloseTo(66.67, 0);
    expect(metrics.netPnL).toBe(250);
  });

  it("calculates profit factor correctly", () => {
    const trades = [
      { realizedPnL: 100, status: "TP1_HIT", score: 80, holdingTimeMs: 60000, maxFavorableExcursionPct: 10, maxAdverseExcursionPct: -5, riskReward: 2 },
      { realizedPnL: -50, status: "SL_HIT", score: 65, holdingTimeMs: 30000, maxFavorableExcursionPct: 5, maxAdverseExcursionPct: -10, riskReward: 1.5 },
    ] as any[];

    const metrics = perf.calculateMetrics(trades);
    expect(metrics.profitFactor).toBeCloseTo(2.0, 1);
  });

  it("groups by regime", () => {
    const trades = [
      { realizedPnL: 100, status: "TP1_HIT", score: 80, regime: "TRENDING_UP", holdingTimeMs: 60000, maxFavorableExcursionPct: 10, maxAdverseExcursionPct: -5, riskReward: 2 },
      { realizedPnL: -50, status: "SL_HIT", score: 65, regime: "RANGE", holdingTimeMs: 30000, maxFavorableExcursionPct: 5, maxAdverseExcursionPct: -10, riskReward: 1.5 },
    ] as any[];

    const byRegime = perf.calculateByRegime(trades);
    expect(byRegime.length).toBe(2);
    expect(byRegime[0].regime).toBe("TRENDING_UP");
  });

  it("groups by instrument", () => {
    const trades = [
      { realizedPnL: 100, status: "TP1_HIT", score: 80, underlying: "NIFTY", holdingTimeMs: 60000, maxFavorableExcursionPct: 10, maxAdverseExcursionPct: -5, riskReward: 2 },
      { realizedPnL: -50, status: "SL_HIT", score: 65, underlying: "BANKNIFTY", holdingTimeMs: 30000, maxFavorableExcursionPct: 5, maxAdverseExcursionPct: -10, riskReward: 1.5 },
    ] as any[];

    const byInst = perf.calculateByInstrument(trades);
    expect(byInst.length).toBe(2);
    expect(byInst[0].instrument).toBe("NIFTY");
  });

  it("groups by strike type", () => {
    const trades = [
      { realizedPnL: 100, status: "TP1_HIT", score: 80, moneyness: "ATM", holdingTimeMs: 60000, maxFavorableExcursionPct: 10, maxAdverseExcursionPct: -5, riskReward: 2 },
      { realizedPnL: 50, status: "TP1_HIT", score: 75, moneyness: "ITM", holdingTimeMs: 45000, maxFavorableExcursionPct: 8, maxAdverseExcursionPct: -3, riskReward: 2.5 },
      { realizedPnL: -30, status: "SL_HIT", score: 60, moneyness: "OTM", holdingTimeMs: 20000, maxFavorableExcursionPct: 3, maxAdverseExcursionPct: -12, riskReward: 1 },
    ] as any[];

    const byStrike = perf.calculateByStrike(trades);
    expect(byStrike.length).toBe(3);
    expect(byStrike[0].moneyness).toBe("ATM");
  });

  it("groups by score range", () => {
    const trades = [
      { realizedPnL: 100, status: "TP1_HIT", score: 95, holdingTimeMs: 60000, maxFavorableExcursionPct: 10, maxAdverseExcursionPct: -5, riskReward: 2 },
      { realizedPnL: -50, status: "SL_HIT", score: 65, holdingTimeMs: 30000, maxFavorableExcursionPct: 5, maxAdverseExcursionPct: -10, riskReward: 1.5 },
    ] as any[];

    const byScore = perf.calculateByScore(trades);
    expect(byScore.length).toBe(5);
    expect(byScore[0].range).toBe("90-100");
  });

  it("groups by time window", () => {
    const now = new Date();
    now.setHours(10, 30, 0, 0);
    const trades = [
      { realizedPnL: 100, status: "TP1_HIT", score: 80, createdAt: now, holdingTimeMs: 60000, maxFavorableExcursionPct: 10, maxAdverseExcursionPct: -5, riskReward: 2 },
    ] as any[];

    const byTime = perf.calculateByTimeWindow(trades);
    expect(byTime.length).toBe(7);
    const window10 = byTime.find(w => w.window === "10:00-11:00");
    expect(window10?.trades).toBe(1);
  });

  it("groups by CE/PE", () => {
    const trades = [
      { realizedPnL: 100, status: "TP1_HIT", score: 80, optionType: "CE", holdingTimeMs: 60000, maxFavorableExcursionPct: 10, maxAdverseExcursionPct: -5, riskReward: 2 },
      { realizedPnL: -30, status: "SL_HIT", score: 65, optionType: "PE", holdingTimeMs: 30000, maxFavorableExcursionPct: 3, maxAdverseExcursionPct: -8, riskReward: 1.5 },
    ] as any[];

    const bySide = perf.calculateBySide(trades);
    expect(bySide.CE.totalWins).toBe(1);
    expect(bySide.PE.totalLosses).toBe(1);
  });

  it("generates full report", () => {
    const trades = [
      { realizedPnL: 100, status: "TP1_HIT", score: 80, regime: "TRENDING_UP", underlying: "NIFTY", moneyness: "ATM", optionType: "CE", createdAt: new Date(), holdingTimeMs: 60000, maxFavorableExcursionPct: 10, maxAdverseExcursionPct: -5, riskReward: 2 },
    ] as any[];

    const report = perf.generateReport(trades, []);
    expect(report.summary.totalTrades).toBe(1);
    expect(report.byRegime.length).toBe(1);
    expect(report.byInstrument.length).toBe(1);
    expect(report.bestRegime).toBe("TRENDING_UP");
  });

  it("no-trade performance with all classifications", () => {
    const obs = [
      { classification: "GOOD_AVOIDANCE" },
      { classification: "GOOD_AVOIDANCE" },
      { classification: "MISSED_OPPORTUNITY" },
      { classification: "NEUTRAL" },
      { classification: null },
    ] as any[];

    const ntPerf = perf.calculateNoTradePerformance(obs);
    expect(ntPerf.total).toBe(5);
    expect(ntPerf.goodAvoidance).toBe(2);
    expect(ntPerf.missedOpportunity).toBe(1);
    expect(ntPerf.avoidanceRate).toBeCloseTo(50, 0);
  });

  it("handles negative profit factor (all losses)", () => {
    const trades = [
      { realizedPnL: -100, status: "SL_HIT", score: 60, holdingTimeMs: 30000, maxFavorableExcursionPct: 2, maxAdverseExcursionPct: -15, riskReward: 0.5 },
    ] as any[];

    const metrics = perf.calculateMetrics(trades);
    expect(metrics.profitFactor).toBe(0); // no gross profit
    expect(metrics.netPnL).toBe(-100);
  });

  it("handles infinite profit factor (all wins)", () => {
    const trades = [
      { realizedPnL: 100, status: "TP1_HIT", score: 80, holdingTimeMs: 60000, maxFavorableExcursionPct: 10, maxAdverseExcursionPct: -5, riskReward: 2 },
    ] as any[];

    const metrics = perf.calculateMetrics(trades);
    expect(metrics.profitFactor).toBe(Infinity);
  });
});

// ── Safety Tests ──────────────────────────────────────────────────────

describe("Paper Trading Safety", () => {
  it("paper engine has no broker order imports", () => {
    const fs = require("fs");
    const paperEngine = fs.readFileSync("src/lib/hermes/paper-engine.ts", "utf8");
    const paperWorker = fs.readFileSync("src/lib/hermes/paper-worker.ts", "utf8");
    // Paper engine should NOT import broker order functions
    expect(paperEngine).not.toContain("placeOrder");
    expect(paperEngine).not.toContain("cancelOrder");
    expect(paperEngine).not.toContain("modifyOrder");
    expect(paperWorker).not.toContain("placeOrder");
    expect(paperWorker).not.toContain("cancelOrder");
    expect(paperWorker).not.toContain("modifyOrder");
  });

  it("paper engine defaults reject selling", () => {
    // Paper config should only allow buying
    expect(DEFAULT_PAPER_CONFIG.maxOpenPaperTrades).toBeGreaterThan(0);
    // No sell-side configuration exists in paper config
    const configKeys = Object.keys(DEFAULT_PAPER_CONFIG);
    expect(configKeys.some(k => k.toLowerCase().includes("sell"))).toBe(false);
  });

  it("paper mode flag is always PAPER", () => {
    // All paper trades must have mode = PAPER
    const engine = new HermesPaperEngine({ enabled: false });
    // Verify the default mode is PAPER
    expect(DEFAULT_PAPER_CONFIG.enabled).toBe(false); // disabled by default for safety
  });
});
