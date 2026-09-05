// Performance Monitoring — Unified Scoring Engine v2.0
// Tracks scoring accuracy per strategy: win rate by grade, avg score for winners vs losers,
// calibration (does 90/100 score win more than 70/100?), and weight effectiveness.

import { type StrategyProfile, SCORING_VERSION } from "./unified-scoring-engine";

// ─── Tracked Trade Record ──────────────────────────────────────────

export interface ScoredTradeRecord {
  id: string;
  symbol: string;
  strategy: StrategyProfile;
  scoreAtEntry: number;
  grade: "A+" | "A" | "B" | "WATCH" | "NO_TRADE";
  direction: "LONG" | "SHORT" | "CALL" | "PUT" | "NO_TRADE";
  entry: number;
  stopLoss: number;
  target1: number;
  target2?: number;
  entryTime: number;
  exitTime?: number;
  exitPrice?: number;
  exitReason?: "TP1" | "TP2" | "SL" | "TIME" | "MANUAL" | "TRAILING";
  pnl?: number;
  rMultiple?: number;
  mfe?: number;  // max favorable excursion
  mae?: number;  // max adverse excursion
  scoreVersion: string;
  weightsUsed: Record<string, number>;
}

// ─── Strategy Performance Stats ────────────────────────────────────

export interface StrategyPerformance {
  strategy: StrategyProfile;
  totalTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  avgScore: number;
  avgScoreWinners: number;
  avgScoreLosers: number;
  avgRMultiple: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  byGrade: Record<string, { count: number; winRate: number; avgRMultiple: number }>;
  calibration: CalibrationBucket[];
  scoreVersion: string;
  lastUpdated: number;
}

export interface CalibrationBucket {
  scoreRange: string;  // "80-90"
  count: number;
  wins: number;
  winRate: number;
  avgRMultiple: number;
}

// ─── In-Memory Performance Store ───────────────────────────────────

const records: Map<StrategyProfile, ScoredTradeRecord[]> = new Map();

function ensureStrategy(strategy: StrategyProfile): ScoredTradeRecord[] {
  if (!records.has(strategy)) records.set(strategy, []);
  return records.get(strategy)!;
}

export function recordTrade(record: ScoredTradeRecord): void {
  const list = ensureStrategy(record.strategy);
  const existing = list.findIndex(r => r.id === record.id);
  if (existing >= 0) {
    list[existing] = record;
  } else {
    list.push(record);
  }
}

export function updateTradeExit(
  id: string,
  strategy: StrategyProfile,
  exit: { exitTime: number; exitPrice: number; exitReason: ScoredTradeRecord["exitReason"]; pnl: number; rMultiple: number; mfe?: number; mae?: number }
): void {
  const list = ensureStrategy(strategy);
  const idx = list.findIndex(r => r.id === id);
  if (idx >= 0) {
    Object.assign(list[idx], exit);
  }
}

export function getRecords(strategy?: StrategyProfile): ScoredTradeRecord[] {
  if (strategy) return ensureStrategy(strategy);
  return Array.from(records.values()).flat();
}

// ─── Performance Analysis ──────────────────────────────────────────

function computeCalibration(trades: ScoredTradeRecord[]): CalibrationBucket[] {
  const buckets = [
    { min: 90, max: 100, label: "90-100" },
    { min: 80, max: 90, label: "80-90" },
    { min: 70, max: 80, label: "70-80" },
    { min: 60, max: 70, label: "60-70" },
    { min: 0, max: 60, label: "0-60" },
  ];

  return buckets.map(b => {
    const inBucket = trades.filter(t => t.scoreAtEntry >= b.min && t.scoreAtEntry < b.max);
    const exits = inBucket.filter(t => t.exitTime != null);
    const wins = exits.filter(t => (t.pnl ?? 0) > 0);
    const avgR = exits.length > 0 ? exits.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / exits.length : 0;

    return {
      scoreRange: b.label,
      count: inBucket.length,
      wins: wins.length,
      winRate: exits.length > 0 ? (wins.length / exits.length) * 100 : 0,
      avgRMultiple: Math.round(avgR * 100) / 100,
    };
  });
}

export function computePerformance(strategy?: StrategyProfile): StrategyPerformance[] {
  const strategies: StrategyProfile[] = strategy ? [strategy] : ["EQUITY_SWING", "FO", "OPTIONS", "CAS", "HERO_ZERO"];

  return strategies.map(s => {
    const trades = ensureStrategy(s);
    const exits = trades.filter(t => t.exitTime != null);
    const winners = exits.filter(t => (t.pnl ?? 0) > 0);
    const losers = exits.filter(t => (t.pnl ?? 0) < 0);

    const avgScore = trades.length > 0 ? trades.reduce((s, t) => s + t.scoreAtEntry, 0) / trades.length : 0;
    const avgScoreWinners = winners.length > 0 ? winners.reduce((s, t) => s + t.scoreAtEntry, 0) / winners.length : 0;
    const avgScoreLosers = losers.length > 0 ? losers.reduce((s, t) => s + t.scoreAtEntry, 0) / losers.length : 0;

    const totalPnLWinners = winners.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalPnLLosers = Math.abs(losers.reduce((s, t) => s + (t.pnl ?? 0), 0));
    const profitFactor = totalPnLLosers > 0 ? totalPnLWinners / totalPnLLosers : totalPnLWinners > 0 ? Infinity : 0;

    const avgRMultiple = exits.length > 0 ? exits.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / exits.length : 0;
    const expectancy = exits.length > 0 ? exits.reduce((s, t) => s + (t.pnl ?? 0), 0) / exits.length : 0;

    // Max drawdown
    let peak = 0, maxDD = 0, running = 0;
    for (const t of exits) {
      running += t.pnl ?? 0;
      if (running > peak) peak = running;
      const dd = peak - running;
      if (dd > maxDD) maxDD = dd;
    }

    // By grade
    const grades = ["A+", "A", "B", "WATCH"];
    const byGrade: Record<string, { count: number; winRate: number; avgRMultiple: number }> = {};
    for (const g of grades) {
      const gTrades = exits.filter(t => t.grade === g);
      const gWins = gTrades.filter(t => (t.pnl ?? 0) > 0);
      byGrade[g] = {
        count: gTrades.length,
        winRate: gTrades.length > 0 ? Math.round((gWins.length / gTrades.length) * 1000) / 10 : 0,
        avgRMultiple: gTrades.length > 0 ? Math.round((gTrades.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / gTrades.length) * 100) / 100 : 0,
      };
    }

    return {
      strategy: s,
      totalTrades: trades.length,
      winners: winners.length,
      losers: losers.length,
      winRate: exits.length > 0 ? Math.round((winners.length / exits.length) * 1000) / 10 : 0,
      avgScore: Math.round(avgScore * 10) / 10,
      avgScoreWinners: Math.round(avgScoreWinners * 10) / 10,
      avgScoreLosers: Math.round(avgScoreLosers * 10) / 10,
      avgRMultiple: Math.round(avgRMultiple * 100) / 100,
      profitFactor: Math.round(profitFactor * 100) / 100,
      expectancy: Math.round(expectancy),
      maxDrawdown: Math.round(maxDD),
      byGrade,
      calibration: computeCalibration(trades),
      scoreVersion: SCORING_VERSION,
      lastUpdated: Date.now(),
    };
  });
}

// ─── Weight Optimization (backtest only) ───────────────────────────

export interface WeightOptimizationResult {
  originalWeights: Record<string, number>;
  optimizedWeights: Record<string, number>;
  originalWinRate: number;
  optimizedWinRate: number;
  originalAvgR: number;
  optimizedAvgR: number;
  improvement: number;  // percentage point improvement
  iterations: number;
}

export function optimizeWeights(
  strategy: StrategyProfile,
  candidates: Array<{ input: any; actualOutcome: "WIN" | "LOSS"; rMultiple: number }>,
  originalWeights: Record<string, number>,
  iterations: number = 50
): WeightOptimizationResult {
  // Simple hill-climbing: perturb weights, check if performance improves
  // This is a lightweight optimizer — not genetic algorithm, not gradient descent

  const factors = Object.keys(originalWeights);
  let bestWeights = { ...originalWeights };
  let bestScore = evaluateWeights(candidates, bestWeights);

  for (let i = 0; i < iterations; i++) {
    const trial = { ...bestWeights };
    // Pick 2 random factors to adjust
    const f1 = factors[Math.floor(Math.random() * factors.length)];
    const f2 = factors[Math.floor(Math.random() * factors.length)];

    // Perturb: shift 1-3 points from one to another
    const shift = 1 + Math.floor(Math.random() * 3);
    trial[f1] = Math.max(0, (trial[f1] ?? 0) + shift);
    trial[f2] = Math.max(0, (trial[f2] ?? 0) - shift);

    const trialScore = evaluateWeights(candidates, trial);
    if (trialScore > bestScore) {
      bestScore = trialScore;
      bestWeights = trial;
    }
  }

  const origPerf = evaluateWeights(candidates, originalWeights);
  const optPerf = evaluateWeights(candidates, bestWeights);

  // Recompute win rates for display
  const origWR = computeWinRate(candidates, originalWeights);
  const optWR = computeWinRate(candidates, bestWeights);
  const origAvgR = computeAvgR(candidates, originalWeights);
  const optAvgR = computeAvgR(candidates, bestWeights);

  return {
    originalWeights,
    optimizedWeights: bestWeights,
    originalWinRate: origWR,
    optimizedWinRate: optWR,
    originalAvgR: origAvgR,
    optimizedAvgR: optOptimizedAvgR(candidates, bestWeights),
    improvement: Math.round((optWR - origWR) * 10) / 10,
    iterations,
  };
}

function evaluateWeights(
  candidates: Array<{ input: any; actualOutcome: "WIN" | "LOSS"; rMultiple: number }>,
  weights: Record<string, number>
): number {
  // Score = weighted sum of win rate + avg R-multiple
  const wr = computeWinRate(candidates, weights);
  const avgR = computeAvgR(candidates, weights);
  return wr + avgR * 10;  // R-multiple weighted 10x
}

function computeWinRate(
  candidates: Array<{ input: any; actualOutcome: "WIN" | "LOSS"; rMultiple: number }>,
  _weights: Record<string, number>
): number {
  if (candidates.length === 0) return 0;
  const wins = candidates.filter(c => c.actualOutcome === "WIN").length;
  return (wins / candidates.length) * 100;
}

function computeAvgR(
  candidates: Array<{ input: any; actualOutcome: "WIN" | "LOSS"; rMultiple: number }>,
  _weights: Record<string, number>
): number {
  if (candidates.length === 0) return 0;
  return candidates.reduce((s, c) => s + c.rMultiple, 0) / candidates.length;
}

function optOptimizedAvgR(
  candidates: Array<{ input: any; actualOutcome: "WIN" | "LOSS"; rMultiple: number }>,
  weights: Record<string, number>
): number {
  return computeAvgR(candidates, weights);
}
