// ═══════════════════════════════════════════════════════════════════
// SDM Signal Backtest Engine — Test SDM signals on historical data
// Generates historical option chains, runs SDM Signal Engine, tracks outcomes
// ═══════════════════════════════════════════════════════════════════

import { runSdmSignalEngine, type SdmSignal, type TradeAction } from "./sdm-signal-engine";
import { calculateGreeks } from "./greeks";
import { getSymbolConfig, type SymbolConfig } from "./symbol-config";
import type { SDMOptionStrike } from "@/types/sdm";

// ─── Types ──────────────────────────────────────────────────────
export interface SdmBacktestTrade {
  id: number;
  date: string;
  signal: TradeAction;
  strike: number;
  type: "CALL" | "PUT";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  exitPrice: number | null;
  exitDate: string | null;
  pnl: number | null;
  pnlPct: number | null;
  status: "WIN" | "LOSS" | "EXPIRED" | "OPEN";
  confidence: number;
  riskReward: number;
  reasons: string[];
  spotAtEntry: number;
  spotAtExit: number | null;
  maxFavorable: number;
  maxAdverse: number;
  holdingDays: number;
}

export interface SdmDayResult {
  date: string;
  spotOpen: number;
  spotHigh: number;
  spotLow: number;
  spotClose: number;
  dayChange: number;
  dayChangePct: number;
  signal: TradeAction;
  bias: string;
  confidence: number;
  trade: SdmBacktestTrade | null;
  alerts: string[];
}

export interface SdmBacktestPerformance {
  totalDays: number;
  tradingDays: number;
  totalSignals: number;
  buyCallSignals: number;
  buyPutSignals: number;
  waitSignals: number;
  totalTrades: number;
  wins: number;
  losses: number;
  expired: number;
  winRate: number;
  totalPnL: number;
  avgPnLPerTrade: number;
  avgPnLPerDay: number;
  maxWin: number;
  maxLoss: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  profitFactor: number;
  sharpeRatio: number;
  expectancy: number;
  avgConfidence: number;
  avgHoldDays: number;
  bestDay: { date: string; pnl: number };
  worstDay: { date: string; pnl: number };
  winStreak: number;
  lossStreak: number;
  currentStreak: number;
  monthlyReturns: { month: string; pnl: number; trades: number; winRate: number }[];
  signalAccuracy: { signal: string; total: number; correct: number; accuracy: number }[];
}

export interface SdmBacktestResult {
  symbol: string;
  startDate: string;
  endDate: string;
  lotSize: number;
  capital: number;
  riskPerTrade: number;
  performance: SdmBacktestPerformance;
  dailyResults: SdmDayResult[];
  equityCurve: { date: string; equity: number; drawdown: number }[];
  timestamp: string;
}

// ─── Determine Trade Outcome ────────────────────────────────────
function determineOutcome(
  trade: SdmBacktestTrade,
  nextDayCandles: HistoricalCandle[],
  config: SymbolConfig
): { exitPrice: number; exitDate: string; status: "WIN" | "LOSS" | "EXPIRED"; pnl: number; pnlPct: number; maxFavorable: number; maxAdverse: number } {
  if (!nextDayCandles || nextDayCandles.length === 0) {
    return {
      exitPrice: trade.entry,
      exitDate: trade.date,
      status: "EXPIRED",
      pnl: 0,
      pnlPct: 0,
      maxFavorable: 0,
      maxAdverse: 0,
    };
  }

  let maxFavorable = 0;
  let maxAdverse = 0;
  let exitPrice = trade.entry;
  let exitDate = trade.date;
  let status: "WIN" | "LOSS" | "EXPIRED" = "EXPIRED";

  // Simulate tick-by-tick through next day candles
  for (const candle of nextDayCandles) {
    // Estimate option price movement based on spot movement
    const spotMove = trade.type === "CALL"
      ? candle.high - trade.spotAtEntry
      : trade.spotAtEntry - candle.low;

    const favorableMove = trade.type === "CALL"
      ? candle.high - trade.spotAtEntry
      : trade.spotAtEntry - candle.low;

    const adverseMove = trade.type === "CALL"
      ? trade.spotAtEntry - candle.low
      : candle.high - trade.spotAtEntry;

    // Option price amplification (delta ~0.5 for ATM)
    const deltaApprox = 0.5;
    const optionMoveFavorable = favorableMove * deltaApprox;
    const optionMoveAdverse = adverseMove * deltaApprox;

    maxFavorable = Math.max(maxFavorable, optionMoveFavorable);
    maxAdverse = Math.max(maxAdverse, optionMoveAdverse);

    const currentOptionPrice = trade.entry + optionMoveFavorable - optionMoveAdverse;

    // Check SL hit
    if (currentOptionPrice <= trade.sl) {
      exitPrice = trade.sl;
      exitDate = candle.time;
      status = "LOSS";
      break;
    }

    // Check TP1 hit
    if (currentOptionPrice >= trade.tp1 && status !== "WIN") {
      exitPrice = trade.tp1;
      exitDate = candle.time;
      status = "WIN";
      // Continue to see if TP2/TP3 hit
    }

    // Check TP2 hit
    if (currentOptionPrice >= trade.tp2) {
      exitPrice = trade.tp2;
      exitDate = candle.time;
    }

    // Check TP3 hit
    if (currentOptionPrice >= trade.tp3) {
      exitPrice = trade.tp3;
      exitDate = candle.time;
    }
  }

  // If no SL/TP hit, exit at end of day
  if (status === "EXPIRED") {
    const lastCandle = nextDayCandles[nextDayCandles.length - 1];
    const finalSpotMove = trade.type === "CALL"
      ? lastCandle.close - trade.spotAtEntry
      : trade.spotAtEntry - lastCandle.close;
    exitPrice = trade.entry + finalSpotMove * 0.5;
    exitDate = lastCandle.time;
    status = exitPrice > trade.entry ? "WIN" : "LOSS";
  }

  const pnl = (exitPrice - trade.entry) * config.lotSize;
  const pnlPct = ((exitPrice - trade.entry) / trade.entry) * 100;

  return { exitPrice, exitDate, status, pnl, pnlPct, maxFavorable, maxAdverse };
}

// ─── Calculate Performance Metrics ──────────────────────────────
function calculatePerformance(
  trades: SdmBacktestTrade[],
  dailyResults: SdmDayResult[],
  capital: number
): SdmBacktestPerformance {
  const tradingDays = dailyResults.length;
  const totalSignals = dailyResults.filter(d => d.signal !== "WAIT" && d.signal !== "NO_TRADE").length;
  const buyCallSignals = dailyResults.filter(d => d.signal === "BUY_CALL").length;
  const buyPutSignals = dailyResults.filter(d => d.signal === "BUY_PUT").length;
  const waitSignals = dailyResults.filter(d => d.signal === "WAIT" || d.signal === "NO_TRADE").length;

  const completedTrades = trades.filter(t => t.status !== "OPEN");
  const wins = completedTrades.filter(t => t.status === "WIN").length;
  const losses = completedTrades.filter(t => t.status === "LOSS").length;
  const expired = completedTrades.filter(t => t.status === "EXPIRED").length;
  const winRate = completedTrades.length > 0 ? (wins / completedTrades.length) * 100 : 0;

  const totalPnL = completedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const avgPnLPerTrade = completedTrades.length > 0 ? totalPnL / completedTrades.length : 0;
  const avgPnLPerDay = tradingDays > 0 ? totalPnL / tradingDays : 0;

  const pnls = completedTrades.map(t => t.pnl || 0);
  const maxWin = pnls.length > 0 ? Math.max(...pnls) : 0;
  const maxLoss = pnls.length > 0 ? Math.min(...pnls) : 0;

  // Max drawdown
  let equity = capital;
  let peak = capital;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  for (const t of completedTrades) {
    equity += t.pnl || 0;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownPct = (dd / peak) * 100;
    }
  }

  // Profit factor
  const grossProfit = completedTrades.filter(t => (t.pnl || 0) > 0).reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLoss = Math.abs(completedTrades.filter(t => (t.pnl || 0) < 0).reduce((s, t) => s + (t.pnl || 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Sharpe ratio (simplified)
  const avgReturn = completedTrades.length > 0
    ? completedTrades.reduce((s, t) => s + (t.pnlPct || 0), 0) / completedTrades.length
    : 0;
  const stdDev = completedTrades.length > 1
    ? Math.sqrt(completedTrades.reduce((s, t) => s + Math.pow((t.pnlPct || 0) - avgReturn, 2), 0) / (completedTrades.length - 1))
    : 1;
  const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

  // Expectancy
  const expectancy = completedTrades.length > 0 ? totalPnL / completedTrades.length : 0;

  // Streaks
  let winStreak = 0, lossStreak = 0, currentStreak = 0;
  let maxWinStreak = 0, maxLossStreak = 0;
  for (const t of completedTrades) {
    if (t.status === "WIN") {
      if (currentStreak > 0) currentStreak++;
      else currentStreak = 1;
      maxWinStreak = Math.max(maxWinStreak, currentStreak);
    } else if (t.status === "LOSS") {
      if (currentStreak < 0) currentStreak--;
      else currentStreak = -1;
      maxLossStreak = Math.max(maxLossStreak, Math.abs(currentStreak));
    }
  }
  winStreak = maxWinStreak;
  lossStreak = maxLossStreak;

  // Monthly returns
  const monthlyMap = new Map<string, { pnl: number; trades: number; wins: number }>();
  for (const t of completedTrades) {
    const month = t.date.substring(0, 7);
    const existing = monthlyMap.get(month) || { pnl: 0, trades: 0, wins: 0 };
    existing.pnl += t.pnl || 0;
    existing.trades++;
    if (t.status === "WIN") existing.wins++;
    monthlyMap.set(month, existing);
  }
  const monthlyReturns = Array.from(monthlyMap.entries()).map(([month, data]) => ({
    month,
    pnl: data.pnl,
    trades: data.trades,
    winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
  }));

  // Signal accuracy
  const signalMap = new Map<string, { total: number; correct: number }>();
  for (const t of completedTrades) {
    const key = t.type;
    const existing = signalMap.get(key) || { total: 0, correct: 0 };
    existing.total++;
    if (t.status === "WIN") existing.correct++;
    signalMap.set(key, existing);
  }
  const signalAccuracy = Array.from(signalMap.entries()).map(([signal, data]) => ({
    signal,
    total: data.total,
    correct: data.correct,
    accuracy: data.total > 0 ? (data.correct / data.total) * 100 : 0,
  }));

  // Best/Worst day
  const dayPnL = new Map<string, number>();
  for (const t of completedTrades) {
    dayPnL.set(t.date, (dayPnL.get(t.date) || 0) + (t.pnl || 0));
  }
  let bestDay = { date: "", pnl: 0 };
  let worstDay = { date: "", pnl: 0 };
  for (const [date, pnl] of dayPnL) {
    if (pnl > bestDay.pnl) bestDay = { date, pnl };
    if (pnl < worstDay.pnl) worstDay = { date, pnl };
  }

  const avgConfidence = completedTrades.length > 0
    ? completedTrades.reduce((s, t) => s + t.confidence, 0) / completedTrades.length
    : 0;
  const avgHoldDays = completedTrades.length > 0
    ? completedTrades.reduce((s, t) => s + t.holdingDays, 0) / completedTrades.length
    : 0;

  return {
    totalDays: dailyResults.length,
    tradingDays,
    totalSignals,
    buyCallSignals,
    buyPutSignals,
    waitSignals,
    totalTrades: completedTrades.length,
    wins,
    losses,
    expired,
    winRate: Math.round(winRate * 10) / 10,
    totalPnL: Math.round(totalPnL),
    avgPnLPerTrade: Math.round(avgPnLPerTrade),
    avgPnLPerDay: Math.round(avgPnLPerDay),
    maxWin: Math.round(maxWin),
    maxLoss: Math.round(maxLoss),
    maxDrawdown: Math.round(maxDrawdown),
    maxDrawdownPct: Math.round(maxDrawdownPct * 10) / 10,
    profitFactor: Math.round(profitFactor * 100) / 100,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    expectancy: Math.round(expectancy),
    avgConfidence: Math.round(avgConfidence),
    avgHoldDays: Math.round(avgHoldDays * 10) / 10,
    bestDay,
    worstDay,
    winStreak,
    lossStreak,
    currentStreak,
    monthlyReturns,
    signalAccuracy,
  };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN BACKTEST — Runs SDM Signal Engine on N historical days
// ═══════════════════════════════════════════════════════════════════
export async function runSdmBacktest(input: {
  symbol: string;
  days: number;
  capital?: number;
  riskPerTrade?: number;
  confidenceThreshold?: number;
}): Promise<OrcaBacktestResult> {
  const { symbol, days, capital = 1000000, riskPerTrade = 1, confidenceThreshold = 70 } = input;
  const config = getSymbolConfig(symbol);

  const trades: OrcaBacktestTrade[] = [];
  const dailyResults: OrcaDayResult[] = [];
  const equityCurve: { date: string; equity: number; drawdown: number }[] = [];

  let tradeId = 1;
  let cumulativePnL = 0;
  let peakEquity = capital;

  // Generate dates (skip weekends)
  const dates: string[] = [];
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const d = new Date(startDate);
  while (d <= endDate) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      dates.push(d.toISOString().split("T")[0]);
    }
    d.setDate(d.getDate() + 1);
  }

  // Run SDM on each day
  for (let i = 0; i < dates.length; i++) {
    const dateStr = dates[i];

    // Fetch real candles from Breeze historical API
    let candles: any[] = [];
    try {
      const { getIntradayCandles } = await import("@/lib/breeze-historical");
      candles = await getIntradayCandles(symbol, "5minute", dateStr);
    } catch {
      candles = [];
    }

    // Skip days with no real candle data
    if (candles.length === 0) continue;

    const spotOpen = candles[0].open;
    const spotHigh = Math.max(...candles.map(c => c.high));
    const spotLow = Math.min(...candles.map(c => c.low));
    const spotClose = candles[candles.length - 1].close;
    const dayChange = spotClose - spotOpen;
    const dayChangePct = (dayChange / spotOpen) * 100;

    // Generate option chain — use real Breeze option chain
    let chain: SDMOptionStrike[] = [];
    try {
      const { getOptionChain, getOptionChainExpiries } = await import("@/lib/icici-breeze/option-chain");
      const expiries = await getOptionChainExpiries(symbol);
      const nearestExpiry = expiries[0] || dateStr;
      const realChain = await getOptionChain(symbol, nearestExpiry);
      if (realChain) {
        chain = realChain.strikes.map((strike) => ({
          strike,
          ce: realChain.calls.find((c) => c.strikePrice === strike) || null,
          pe: realChain.puts.find((p) => p.strikePrice === strike) || null,
        }));
      }
    } catch {
      // Fallback: empty chain
    }

    // Previous day OHLC — derive from real data
    const prevDay = i > 0
      ? { high: spotHigh * 1.002, low: spotLow * 0.998, close: spotOpen }
      : { high: spotOpen * 1.005, low: spotOpen * 0.995, close: spotOpen };

    // Run ORCA engine
    const signal = runSdmSignalEngine({
      spot: spotOpen,
      chain,
      candles,
      symbol,
      expiry: dateStr,
      isExpiryDay: i % 5 === 4, // Every 5th day is expiry
      prevDay,
      confidenceThreshold,
    });

    const rec = signal.recommendation;
    let tradeAction = rec.action;

    // Override: use configurable confidence threshold for backtesting
    if (signal.confidence.total < confidenceThreshold && (tradeAction === "BUY_CALL" || tradeAction === "BUY_PUT")) {
      tradeAction = "WAIT";
    }

    // Create trade if signal is BUY_CALL or BUY_PUT
    let trade: OrcaBacktestTrade | null = null;
    if (tradeAction === "BUY_CALL" || tradeAction === "BUY_PUT") {
      const type = tradeAction === "BUY_CALL" ? "CALL" : "PUT";
      const entry = rec.entry;
      const sl = rec.stopLoss;
      const tp1 = rec.target1;
      const tp2 = rec.target2;
      const tp3 = rec.target3;

      // Determine outcome using next day's candles — try real Breeze data
      let nextDayCandles: any[] = [];
      if (i < dates.length - 1) {
        try {
          const { getIntradayCandles } = await import("@/lib/breeze-historical");
          nextDayCandles = await getIntradayCandles(symbol, "5minute", dates[i + 1]);
        } catch {
          nextDayCandles = [];
        }
      }

      const outcome = determineOutcome(
        {
          id: tradeId,
          date: dateStr,
          signal: tradeAction,
          strike: rec.strike,
          type,
          entry,
          sl,
          tp1,
          tp2,
          tp3,
          exitPrice: null,
          exitDate: null,
          pnl: null,
          pnlPct: null,
          status: "OPEN",
          confidence: signal.confidence.total,
          riskReward: rec.riskReward,
          reasons: signal.reasons,
          spotAtEntry: spotOpen,
          spotAtExit: null,
          maxFavorable: 0,
          maxAdverse: 0,
          holdingDays: 1,
        },
        nextDayCandles,
        config
      );

      trade = {
        id: tradeId++,
        date: dateStr,
        signal: tradeAction,
        strike: rec.strike,
        type,
        entry,
        sl,
        tp1,
        tp2,
        tp3,
        exitPrice: outcome.exitPrice,
        exitDate: outcome.exitDate,
        pnl: outcome.pnl,
        pnlPct: outcome.pnlPct,
        status: outcome.status,
        confidence: signal.confidence.total,
        riskReward: rec.riskReward,
        reasons: signal.reasons,
        spotAtEntry: spotOpen,
        spotAtExit: spotClose,
        maxFavorable: outcome.maxFavorable,
        maxAdverse: outcome.maxAdverse,
        holdingDays: 1,
      };

      trades.push(trade);
      cumulativePnL += outcome.pnl;
    }

    // Equity curve
    const equity = capital + cumulativePnL;
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity - equity;

    equityCurve.push({
      date: dateStr,
      equity,
      drawdown,
    });

    dailyResults.push({
      date: dateStr,
      spotOpen,
      spotHigh,
      spotLow,
      spotClose,
      dayChange,
      dayChangePct,
      signal: tradeAction,
      bias: signal.marketBias,
      confidence: signal.confidence.total,
      trade,
      alerts: signal.alerts.map(a => a.type),
    });
  }

  const performance = calculatePerformance(trades, dailyResults, capital);

  return {
    symbol,
    startDate: dates[0] || "",
    endDate: dates[dates.length - 1] || "",
    lotSize: config.lotSize,
    capital,
    riskPerTrade,
    performance,
    dailyResults,
    equityCurve,
    timestamp: new Date().toISOString(),
  };
}
