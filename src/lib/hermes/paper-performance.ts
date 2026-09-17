// Hermes Paper Performance Engine — deterministic analytics
// No ML, no optimization. Pure measurement.

import type { PaperTrade, NoTradeObservation, PaperAccount } from "./paper-engine";

// ── Types ─────────────────────────────────────────────────────────────

export interface PerformanceMetrics {
  // Summary
  totalSignals: number;
  totalTrades: number;
  totalWins: number;
  totalLosses: number;
  totalBreakeven: number;
  totalOpen: number;
  winRate: number;
  lossRate: number;

  // P&L
  grossProfit: number;
  grossLoss: number;
  netPnL: number;
  profitFactor: number;
  expectancy: number;

  // Averages
  avgWinner: number;
  avgLoser: number;
  avgRR: number;
  avgHoldingTimeMs: number;

  // Risk
  maxDrawdown: number;
  maxDrawdownPct: number;

  // Strike results
  tp1HitRate: number;
  tp2HitRate: number;
  tp3HitRate: number;
  slHitRate: number;

  // Score analysis
  avgScore: number;
  avgWinningScore: number;
  avgLosingScore: number;

  // MFE/MAE
  avgMFE: number;
  avgMAE: number;
  avgMFEPct: number;
  avgMAEPct: number;
}

export interface RegimePerformance {
  regime: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnL: number;
  profitFactor: number;
  expectancy: number;
  avgScore: number;
}

export interface InstrumentPerformance {
  instrument: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnL: number;
  profitFactor: number;
  avgMFE: number;
  avgMAE: number;
}

export interface StrikePerformance {
  moneyness: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnL: number;
  avgMFE: number;
  avgMAE: number;
  avgHoldingTimeMs: number;
}

export interface ScorePerformance {
  range: string;
  trades: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  avgPnL: number;
}

export interface TimePerformance {
  window: string;
  trades: number;
  winRate: number;
  netPnL: number;
}

export interface NoTradePerformance {
  total: number;
  goodAvoidance: number;
  missedOpportunity: number;
  neutral: number;
  avoidanceRate: number;
  missedOpportunityRate: number;
}

export interface PerformanceReport {
  period: { from: Date; to: Date };
  summary: PerformanceMetrics;
  byRegime: RegimePerformance[];
  byInstrument: InstrumentPerformance[];
  byStrike: StrikePerformance[];
  byScore: ScorePerformance[];
  byTimeWindow: TimePerformance[];
  bySide: { CE: PerformanceMetrics; PE: PerformanceMetrics };
  noTrade: NoTradePerformance;
  bestRegime: string;
  bestInstrument: string;
  bestStrikeType: string;
  bestScoreRange: string;
  bestTimeWindow: string;
  worstRegime: string;
  worstInstrument: string;
  worstStrikeType: string;
  worstScoreRange: string;
  worstTimeWindow: string;
}

// ── Performance Engine ────────────────────────────────────────────────

export class PaperPerformanceEngine {
  calculateMetrics(trades: PaperTrade[]): PerformanceMetrics {
    const closed = trades.filter(t => t.status !== "OPEN" && t.status !== "CANCELLED");
    const wins = closed.filter(t => (t.realizedPnL || 0) > 0);
    const losses = closed.filter(t => (t.realizedPnL || 0) < 0);
    const breakeven = closed.filter(t => (t.realizedPnL || 0) === 0);
    const open = trades.filter(t => t.status === "OPEN");

    const grossProfit = wins.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + (t.realizedPnL || 0), 0));
    const netPnL = grossProfit - grossLoss;

    const tp1 = closed.filter(t => t.status === "TP1_HIT" || t.status === "TP2_HIT" || t.status === "TP3_HIT");
    const tp2 = closed.filter(t => t.status === "TP2_HIT" || t.status === "TP3_HIT");
    const tp3 = closed.filter(t => t.status === "TP3_HIT");
    const sl = closed.filter(t => t.status === "SL_HIT");

    return {
      totalSignals: trades.length,
      totalTrades: closed.length,
      totalWins: wins.length,
      totalLosses: losses.length,
      totalBreakeven: breakeven.length,
      totalOpen: open.length,
      winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
      lossRate: closed.length > 0 ? (losses.length / closed.length) * 100 : 0,
      grossProfit,
      grossLoss,
      netPnL,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      expectancy: closed.length > 0 ? netPnL / closed.length : 0,
      avgWinner: wins.length > 0 ? grossProfit / wins.length : 0,
      avgLoser: losses.length > 0 ? grossLoss / losses.length : 0,
      avgRR: this.calculateAvgRR(closed),
      avgHoldingTimeMs: closed.length > 0 ? closed.reduce((sum, t) => sum + (t.holdingTimeMs || 0), 0) / closed.length : 0,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
      tp1HitRate: closed.length > 0 ? (tp1.length / closed.length) * 100 : 0,
      tp2HitRate: closed.length > 0 ? (tp2.length / closed.length) * 100 : 0,
      tp3HitRate: closed.length > 0 ? (tp3.length / closed.length) * 100 : 0,
      slHitRate: closed.length > 0 ? (sl.length / closed.length) * 100 : 0,
      avgScore: trades.length > 0 ? trades.reduce((sum, t) => sum + t.score, 0) / trades.length : 0,
      avgWinningScore: wins.length > 0 ? wins.reduce((sum, t) => sum + t.score, 0) / wins.length : 0,
      avgLosingScore: losses.length > 0 ? losses.reduce((sum, t) => sum + t.score, 0) / losses.length : 0,
      avgMFE: closed.length > 0 ? closed.reduce((sum, t) => sum + (t.maxFavorableExcursionPct || 0), 0) / closed.length : 0,
      avgMAE: closed.length > 0 ? closed.reduce((sum, t) => sum + Math.abs(t.maxAdverseExcursionPct || 0), 0) / closed.length : 0,
      avgMFEPct: closed.length > 0 ? closed.reduce((sum, t) => sum + (t.maxFavorableExcursionPct || 0), 0) / closed.length : 0,
      avgMAEPct: closed.length > 0 ? closed.reduce((sum, t) => sum + Math.abs(t.maxAdverseExcursionPct || 0), 0) / closed.length : 0,
    };
  }

  private calculateAvgRR(trades: PaperTrade[]): number {
    const withRR = trades.filter(t => t.riskReward && t.riskReward > 0);
    return withRR.length > 0 ? withRR.reduce((sum, t) => sum + (t.riskReward || 0), 0) / withRR.length : 0;
  }

  calculateByRegime(trades: PaperTrade[]): RegimePerformance[] {
    const regimes = new Map<string, PaperTrade[]>();
    for (const trade of trades) {
      const regime = trade.regime || "UNKNOWN";
      if (!regimes.has(regime)) regimes.set(regime, []);
      regimes.get(regime)!.push(trade);
    }

    return Array.from(regimes.entries()).map(([regime, regimeTrades]) => {
      const metrics = this.calculateMetrics(regimeTrades);
      return {
        regime,
        trades: metrics.totalTrades,
        wins: metrics.totalWins,
        losses: metrics.totalLosses,
        winRate: metrics.winRate,
        netPnL: metrics.netPnL,
        profitFactor: metrics.profitFactor,
        expectancy: metrics.expectancy,
        avgScore: metrics.avgScore,
      };
    }).sort((a, b) => b.netPnL - a.netPnL);
  }

  calculateByInstrument(trades: PaperTrade[]): InstrumentPerformance[] {
    const instruments = new Map<string, PaperTrade[]>();
    for (const trade of trades) {
      const inst = trade.underlying || "UNKNOWN";
      if (!instruments.has(inst)) instruments.set(inst, []);
      instruments.get(inst)!.push(trade);
    }

    return Array.from(instruments.entries()).map(([instrument, instTrades]) => {
      const metrics = this.calculateMetrics(instTrades);
      return {
        instrument,
        trades: metrics.totalTrades,
        wins: metrics.totalWins,
        losses: metrics.totalLosses,
        winRate: metrics.winRate,
        netPnL: metrics.netPnL,
        profitFactor: metrics.profitFactor,
        avgMFE: metrics.avgMFE,
        avgMAE: metrics.avgMAE,
      };
    }).sort((a, b) => b.netPnL - a.netPnL);
  }

  calculateByStrike(trades: PaperTrade[]): StrikePerformance[] {
    const strikes = new Map<string, PaperTrade[]>();
    for (const trade of trades) {
      const key = trade.moneyness || "UNKNOWN";
      if (!strikes.has(key)) strikes.set(key, []);
      strikes.get(key)!.push(trade);
    }

    return Array.from(strikes.entries()).map(([moneyness, strikeTrades]) => {
      const metrics = this.calculateMetrics(strikeTrades);
      return {
        moneyness,
        trades: metrics.totalTrades,
        wins: metrics.totalWins,
        losses: metrics.totalLosses,
        winRate: metrics.winRate,
        netPnL: metrics.netPnL,
        avgMFE: metrics.avgMFE,
        avgMAE: metrics.avgMAE,
        avgHoldingTimeMs: metrics.avgHoldingTimeMs,
      };
    }).sort((a, b) => b.netPnL - a.netPnL);
  }

  calculateByScore(trades: PaperTrade[]): ScorePerformance[] {
    const ranges = [
      { label: "90-100", min: 90, max: 100 },
      { label: "80-89", min: 80, max: 89 },
      { label: "70-79", min: 70, max: 79 },
      { label: "60-69", min: 60, max: 69 },
      { label: "<60", min: 0, max: 59 },
    ];

    return ranges.map(range => {
      const inRange = trades.filter(t => t.score >= range.min && t.score <= range.max);
      const metrics = this.calculateMetrics(inRange);
      return {
        range: range.label,
        trades: metrics.totalTrades,
        winRate: metrics.winRate,
        profitFactor: metrics.profitFactor,
        expectancy: metrics.expectancy,
        avgPnL: metrics.totalTrades > 0 ? metrics.netPnL / metrics.totalTrades : 0,
      };
    });
  }

  calculateByTimeWindow(trades: PaperTrade[]): TimePerformance[] {
    const windows = [
      "09:15-10:00", "10:00-11:00", "11:00-12:00", "12:00-13:00",
      "13:00-14:00", "14:00-15:00", "15:00-15:30",
    ];

    return windows.map(window => {
      const [start, end] = window.split("-");
      const [sh, sm] = start.split(":").map(Number);
      const [eh, em] = end.split(":").map(Number);
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;

      const inWindow = trades.filter(t => {
        const d = new Date(t.createdAt);
        const mins = d.getHours() * 60 + d.getMinutes();
        return mins >= startMin && mins < endMin;
      });

      const metrics = this.calculateMetrics(inWindow);
      return {
        window,
        trades: metrics.totalTrades,
        winRate: metrics.winRate,
        netPnL: metrics.netPnL,
      };
    });
  }

  calculateBySide(trades: PaperTrade[]): { CE: PerformanceMetrics; PE: PerformanceMetrics } {
    const ce = trades.filter(t => t.optionType === "CE");
    const pe = trades.filter(t => t.optionType === "PE");
    return {
      CE: this.calculateMetrics(ce),
      PE: this.calculateMetrics(pe),
    };
  }

  calculateNoTradePerformance(observations: NoTradeObservation[]): NoTradePerformance {
    const classified = observations.filter(o => o.classification);
    const goodAvoidance = classified.filter(o => o.classification === "GOOD_AVOIDANCE").length;
    const missedOpp = classified.filter(o => o.classification === "MISSED_OPPORTUNITY").length;
    const neutral = classified.filter(o => o.classification === "NEUTRAL").length;

    return {
      total: observations.length,
      goodAvoidance,
      missedOpportunity: missedOpp,
      neutral,
      avoidanceRate: classified.length > 0 ? (goodAvoidance / classified.length) * 100 : 0,
      missedOpportunityRate: classified.length > 0 ? (missedOpp / classified.length) * 100 : 0,
    };
  }

  generateReport(
    trades: PaperTrade[],
    noTradeObs: NoTradeObservation[],
    fromDate?: Date,
    toDate?: Date
  ): PerformanceReport {
    const filtered = fromDate
      ? trades.filter(t => t.createdAt >= fromDate)
      : trades;
    const filteredObs = fromDate
      ? noTradeObs.filter(o => o.createdAt >= fromDate)
      : noTradeObs;

    const summary = this.calculateMetrics(filtered);
    const byRegime = this.calculateByRegime(filtered);
    const byInstrument = this.calculateByInstrument(filtered);
    const byStrike = this.calculateByStrike(filtered);
    const byScore = this.calculateByScore(filtered);
    const byTimeWindow = this.calculateByTimeWindow(filtered);
    const bySide = this.calculateBySide(filtered);
    const noTrade = this.calculateNoTradePerformance(filteredObs);

    return {
      period: {
        from: fromDate || new Date(Math.min(...filtered.map(t => t.createdAt.getTime()))),
        to: toDate || new Date(),
      },
      summary,
      byRegime,
      byInstrument,
      byStrike,
      byScore,
      byTimeWindow,
      bySide,
      noTrade,
      bestRegime: byRegime[0]?.regime || "—",
      bestInstrument: byInstrument[0]?.instrument || "—",
      bestStrikeType: byStrike[0]?.moneyness || "—",
      bestScoreRange: byScore.sort((a, b) => b.expectancy - a.expectancy)[0]?.range || "—",
      bestTimeWindow: byTimeWindow.sort((a, b) => b.netPnL - a.netPnL)[0]?.window || "—",
      worstRegime: byRegime[byRegime.length - 1]?.regime || "—",
      worstInstrument: byInstrument[byInstrument.length - 1]?.instrument || "—",
      worstStrikeType: byStrike[byStrike.length - 1]?.moneyness || "—",
      worstScoreRange: byScore.sort((a, b) => a.expectancy - b.expectancy)[0]?.range || "—",
      worstTimeWindow: byTimeWindow.sort((a, b) => a.netPnL - b.netPnL)[0]?.window || "—",
    };
  }
}
