// Multi-Day Backtest Engine
// Runs breakout strategy + SDM OI/Greek quality scoring across N days
// Shows true performance: win rate, equity curve, drawdown, Sharpe

import {
  CandlestickBreakoutIndia,
  type BreakoutSignal,
  type Candle,
} from "@/lib/candlestick-breakout";
import { getLotSize } from "@/lib/symbol-config";
import {
  getBacktestDataProvider,
  createBacktestRunMeta,
  type BacktestProviderMeta,
  type BacktestDataSource,
} from "@/lib/market/data-provider";

// ─── Types ──────────────────────────────────────────────────────
export interface HistoricalCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface BacktestTrade {
  id: number;
  date: string;
  type: "CALL" | "PUT";
  direction: "bullish" | "bearish";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  entryTime: string;
  exitTime: string | null;
  exitPrice: number | null;
  pnl: number | null;
  pnlPct: number | null;
  status: "WIN" | "LOSS" | "EXPIRED" | "PARTIAL" | "OPEN";
  signal: BreakoutSignal;
  candleIndex: number;
  holdBars: number;
  qualityGrade: string;
  qualityScore: number;
  oiScore: number;
  greekScore: number;
  combinedScore: number;
  lotSize: number;
  riskAmount: number;
  riskReward: number;
}

export interface DayBacktestResult {
  date: string;
  dayOHLC: {
    open: number;
    high: number;
    low: number;
    close: number;
    change: number;
    changePct: number;
  };
  signals: number;
  trades: BacktestTrade[];
  dailyPnL: number;
  dailyWinRate: number;
  cumulativePnL: number;
}

export interface BacktestPerformance {
  totalDays: number;
  tradingDays: number;
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
  kellyPct: number;
  avgHoldBars: number;
  bestDay: { date: string; pnl: number };
  worstDay: { date: string; pnl: number };
  winStreak: number;
  lossStreak: number;
  gradeDistribution: Record<string, number>;
  monthlyReturns: { month: string; pnl: number; trades: number }[];
}

export interface FullBacktestResult {
  symbol: string;
  startDate: string;
  endDate: string;
  performance: BacktestPerformance;
  dailyResults: DayBacktestResult[];
  equityCurve: { date: string; equity: number; drawdown: number }[];
  providerMeta: BacktestProviderMeta;
  timestamp: string;
}

// ─── OI/Greek Simulation ───────────────────────────────────────
// Simulates OI/Greek quality scores from candle patterns
// In production, this would use real historical OI snapshots

function simulateOIScore(
  candles: HistoricalCandle[],
  candleIndex: number,
  direction: "bullish" | "bearish"
): { oiScore: number; greekScore: number; qualityGrade: string; qualityScore: number } {
  if (candleIndex < 5) {
    return { oiScore: 50, greekScore: 50, qualityGrade: "C", qualityScore: 50 };
  }

  // Volume analysis for OI proxy
  const recentCandles = candles.slice(Math.max(0, candleIndex - 10), candleIndex + 1);
  const avgVol = recentCandles.reduce((s, c) => s + c.volume, 0) / recentCandles.length;
  const currentVol = candles[candleIndex].volume;
  const volRatio = currentVol / avgVol;

  // Price momentum for Greek proxy
  const lookback = candles.slice(Math.max(0, candleIndex - 5), candleIndex);
  const momentum = lookback.length > 0
    ? (candles[candleIndex].close - lookback[0].open) / lookback[0].open
    : 0;

  // OI Score (0-100): based on volume confirmation + price alignment
  let oiScore = 50;
  if (direction === "bullish") {
    // Bullish: want high volume + price up
    if (volRatio > 1.5 && momentum > 0) oiScore = 75 + Math.min(20, volRatio * 5);
    else if (volRatio > 1.2 && momentum > 0) oiScore = 65 + Math.min(10, volRatio * 3);
    else if (volRatio > 1.0) oiScore = 55;
    else oiScore = 40;
  } else {
    // Bearish: want high volume + price down
    if (volRatio > 1.5 && momentum < 0) oiScore = 75 + Math.min(20, volRatio * 5);
    else if (volRatio > 1.2 && momentum < 0) oiScore = 65 + Math.min(10, volRatio * 3);
    else if (volRatio > 1.0) oiScore = 55;
    else oiScore = 40;
  }

  // Greek Score (0-100): based on volatility + momentum consistency
  const recentRange = recentCandles.map((c) => c.high - c.low);
  const avgRange = recentRange.reduce((s, r) => s + r, 0) / recentRange.length;
  const currentRange = candles[candleIndex].high - candles[candleIndex].low;
  const rangeRatio = currentRange / (avgRange || 1);

  let greekScore = 50;
  if (direction === "bullish" && momentum > 0) {
    greekScore = 55 + Math.min(35, rangeRatio * 15 + Math.abs(momentum) * 500);
  } else if (direction === "bearish" && momentum < 0) {
    greekScore = 55 + Math.min(35, rangeRatio * 15 + Math.abs(momentum) * 500);
  } else {
    greekScore = 35 + Math.min(15, rangeRatio * 10);
  }

  // Combined quality score
  const qualityScore = Math.round(oiScore * 0.5 + greekScore * 0.5);
  let qualityGrade = "D";
  if (qualityScore >= 90) qualityGrade = "A+";
  else if (qualityScore >= 80) qualityGrade = "A";
  else if (qualityScore >= 65) qualityGrade = "B";
  else if (qualityScore >= 50) qualityGrade = "C";

  return { oiScore: Math.min(100, Math.max(0, oiScore)), greekScore: Math.min(100, Math.max(0, greekScore)), qualityGrade, qualityScore: Math.min(100, Math.max(0, qualityScore)) };
}

// ─── Trade Simulation ──────────────────────────────────────────
function simulateTrade(
  signal: BreakoutSignal,
  candles: HistoricalCandle[],
  entryIndex: number,
  symbol: string,
  dateStr: string,
  qualityScore: number,
  qualityGrade: string,
  oiScore: number,
  greekScore: number
): BacktestTrade {
  const lotSize = getLotSize(symbol) || 65;

  const entry = signal.entryPrice || signal.level;
  const sl = signal.slPrice || (signal.direction === "bullish" ? entry * 0.995 : entry * 1.005);
  const tp1 = signal.targetPrice || (signal.direction === "bullish" ? entry * 1.005 : entry * 0.995);
  const tp2 = signal.direction === "bullish" ? entry + (entry - sl) * 2.5 : entry - (sl - entry) * 2.5;
  const tp3 = signal.direction === "bullish" ? entry + (entry - sl) * 4.0 : entry - (sl - entry) * 4.0;

  // Risk per trade: 1% of 10L capital
  const capital = 1000000;
  const riskAmount = Math.round(capital * 0.01);

  let exitPrice: number | null = null;
  let exitTime: string | null = null;
  let status: "WIN" | "LOSS" | "EXPIRED" | "PARTIAL" | "OPEN" = "OPEN";
  let holdBars = 0;

  for (let i = entryIndex + 1; i < candles.length; i++) {
    holdBars++;
    const candle = candles[i];

    if (signal.direction === "bullish") {
      if (candle.low <= sl) {
        exitPrice = sl;
        exitTime = candle.time;
        status = "LOSS";
        break;
      }
      if (candle.high >= tp1) {
        exitPrice = tp1;
        exitTime = candle.time;
        status = "WIN";
        break;
      }
    } else {
      if (candle.high >= sl) {
        exitPrice = sl;
        exitTime = candle.time;
        status = "LOSS";
        break;
      }
      if (candle.low <= tp1) {
        exitPrice = tp1;
        exitTime = candle.time;
        status = "WIN";
        break;
      }
    }
  }

  if (status === "OPEN") {
    const lastCandle = candles[candles.length - 1];
    exitPrice = lastCandle.close;
    exitTime = lastCandle.time;
    status = "EXPIRED";
  }

  const priceDiff = signal.direction === "bullish"
    ? (exitPrice! - entry)
    : (entry - exitPrice!);
  const pnl = Math.round(priceDiff * lotSize);
  const pnlPct = Math.round((priceDiff / entry) * 10000) / 100;
  const riskReward = Math.abs(tp1 - entry) / Math.abs(entry - sl);

  return {
    id: signal.timestamp ? new Date(signal.timestamp).getTime() + entryIndex : Date.now() + entryIndex,
    date: dateStr,
    type: signal.direction === "bullish" ? "CALL" : "PUT",
    direction: signal.direction,
    entry: Math.round(entry * 100) / 100,
    sl: Math.round(sl * 100) / 100,
    tp1: Math.round(tp1 * 100) / 100,
    tp2: Math.round(tp2 * 100) / 100,
    tp3: Math.round(tp3 * 100) / 100,
    entryTime: candles[entryIndex].time,
    exitTime,
    exitPrice: exitPrice ? Math.round(exitPrice * 100) / 100 : null,
    pnl,
    pnlPct,
    status,
    signal,
    candleIndex: entryIndex,
    holdBars,
    qualityGrade,
    qualityScore,
    oiScore,
    greekScore,
    combinedScore: Math.round((signal.confidence || 50) * 0.4 + qualityScore * 0.6),
    lotSize,
    riskAmount,
    riskReward: Math.round(riskReward * 100) / 100,
  };
}

// ─── Performance Calculator ────────────────────────────────────
function computePerformance(
  dailyResults: DayBacktestResult[],
  allTrades: BacktestTrade[]
): BacktestPerformance {
  const tradingDays = dailyResults.filter((d) => d.trades.length > 0).length;
  const wins = allTrades.filter((t) => t.status === "WIN").length;
  const losses = allTrades.filter((t) => t.status === "LOSS").length;
  const expired = allTrades.filter((t) => t.status === "EXPIRED").length;
  const totalPnL = allTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const avgPnLPerTrade = allTrades.length > 0 ? Math.round(totalPnL / allTrades.length) : 0;
  const avgPnLPerDay = tradingDays > 0 ? Math.round(totalPnL / tradingDays) : 0;

  const winTrades = allTrades.filter((t) => t.pnl && t.pnl > 0);
  const lossTrades = allTrades.filter((t) => t.pnl && t.pnl < 0);
  const maxWin = winTrades.length > 0 ? Math.max(...winTrades.map((t) => t.pnl || 0)) : 0;
  const maxLoss = lossTrades.length > 0 ? Math.min(...lossTrades.map((t) => t.pnl || 0)) : 0;

  const grossProfit = winTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLoss = Math.abs(lossTrades.reduce((s, t) => s + (t.pnl || 0), 0));
  const profitFactor = grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : grossProfit > 0 ? 999 : 0;

  // Equity curve + max drawdown
  let equity = 1000000; // 10L starting capital
  let peak = equity;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  for (const trade of allTrades) {
    equity += trade.pnl || 0;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownPct = Math.round((dd / peak) * 10000) / 100;
    }
  }

  // Sharpe ratio (simplified: using daily returns)
  const dailyPnls = dailyResults.filter((d) => d.trades.length > 0).map((d) => d.dailyPnL);
  const avgDaily = dailyPnls.length > 0 ? dailyPnls.reduce((s, p) => s + p, 0) / dailyPnls.length : 0;
  const stdDev = dailyPnls.length > 1
    ? Math.sqrt(dailyPnls.reduce((s, p) => s + Math.pow(p - avgDaily, 2), 0) / (dailyPnls.length - 1))
    : 1;
  const sharpeRatio = stdDev > 0 ? Math.round((avgDaily / stdDev) * 100) / 100 : 0;

  // Expectancy
  const winRate = allTrades.length > 0 ? wins / allTrades.length : 0;
  const avgWin = winTrades.length > 0 ? grossProfit / winTrades.length : 0;
  const avgLoss = lossTrades.length > 0 ? grossLoss / lossTrades.length : 0;
  const expectancy = Math.round(winRate * avgWin - (1 - winRate) * avgLoss);

  // Kelly percentage
  const kellyPct = avgWin > 0 && avgLoss > 0
    ? Math.round(((winRate * avgWin - (1 - winRate) * avgLoss) / avgWin) * 100)
    : 0;

  // Best/worst day
  const sortedDays = [...dailyResults].filter((d) => d.trades.length > 0).sort((a, b) => b.dailyPnL - a.dailyPnL);
  const bestDay = sortedDays.length > 0 ? { date: sortedDays[0].date, pnl: sortedDays[0].dailyPnL } : { date: "", pnl: 0 };
  const worstDay = sortedDays.length > 0 ? { date: sortedDays[sortedDays.length - 1].date, pnl: sortedDays[sortedDays.length - 1].dailyPnL } : { date: "", pnl: 0 };

  // Win/loss streaks
  let winStreak = 0, lossStreak = 0, maxWinStreak = 0, maxLossStreak = 0;
  for (const t of allTrades) {
    if (t.status === "WIN") {
      winStreak++;
      lossStreak = 0;
    } else if (t.status === "LOSS") {
      lossStreak++;
      winStreak = 0;
    } else {
      winStreak = 0;
      lossStreak = 0;
    }
    if (winStreak > maxWinStreak) maxWinStreak = winStreak;
    if (lossStreak > maxLossStreak) maxLossStreak = lossStreak;
  }

  // Grade distribution
  const gradeDist: Record<string, number> = {};
  for (const t of allTrades) {
    gradeDist[t.qualityGrade] = (gradeDist[t.qualityGrade] || 0) + 1;
  }

  // Monthly returns
  const monthlyMap: Record<string, { pnl: number; trades: number }> = {};
  for (const t of allTrades) {
    const month = t.date.substring(0, 7);
    if (!monthlyMap[month]) monthlyMap[month] = { pnl: 0, trades: 0 };
    monthlyMap[month].pnl += t.pnl || 0;
    monthlyMap[month].trades++;
  }
  const monthlyReturns = Object.entries(monthlyMap)
    .map(([month, data]) => ({ month, ...data }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // Average hold bars
  const avgHoldBars = allTrades.length > 0
    ? Math.round(allTrades.reduce((s, t) => s + t.holdBars, 0) / allTrades.length)
    : 0;

  return {
    totalDays: dailyResults.length,
    tradingDays,
    totalTrades: allTrades.length,
    wins,
    losses,
    expired,
    winRate: allTrades.length > 0 ? Math.round((wins / allTrades.length) * 100) : 0,
    totalPnL,
    avgPnLPerTrade,
    avgPnLPerDay,
    maxWin,
    maxLoss,
    maxDrawdown,
    maxDrawdownPct,
    profitFactor,
    sharpeRatio,
    expectancy,
    kellyPct,
    avgHoldBars,
    bestDay,
    worstDay,
    winStreak: maxWinStreak,
    lossStreak: maxLossStreak,
    gradeDistribution: gradeDist,
    monthlyReturns,
  };
}

// ─── Main Multi-Day Backtest ───────────────────────────────────
// Detects breakouts from price action directly (rolling range breakout)
// + feeds through strategy engine for S/R level confirmation

interface PriceActionBreakout {
  direction: "bullish" | "bearish";
  level: number;
  levelName: string;
  pattern: string;
  confidence: number;
  entryPrice: number;
  slPrice: number;
  targetPrice: number;
  riskReward: number;
  timestamp: string;
  candleIndex: number;
}

function detectPriceActionBreakouts(
  candles: HistoricalCandle[],
  prevDay: { high: number; low: number; close: number }
): PriceActionBreakout[] {
  const breakouts: PriceActionBreakout[] = [];
  if (candles.length < 15) return breakouts;

  const lookback = 10; // rolling window

  for (let i = lookback; i < candles.length; i++) {
    const window = candles.slice(i - lookback, i);
    const rangeHigh = Math.max(...window.map((c) => c.high));
    const rangeLow = Math.min(...window.map((c) => c.low));
    const current = candles[i];
    const previous = candles[i - 1];

    // Bullish breakout: close above rolling range high
    if (previous.close <= rangeHigh && current.close > rangeHigh) {
      const breakPct = (current.close - rangeHigh) / rangeHigh;
      if (breakPct > 0.0005) { // min 0.05% break
        const bodySize = current.close - current.open;
        const range = current.high - current.low;
        const bodyRatio = range > 0 ? bodySize / range : 0;

        // Confidence based on body ratio + volume
        const avgVol = window.reduce((s, c) => s + c.volume, 0) / window.length;
        const volRatio = current.volume / avgVol;
        let confidence = 50;
        if (bodyRatio > 0.5) confidence += 15; // strong body
        if (bodyRatio > 0.7) confidence += 10;
        if (volRatio > 1.5) confidence += 15; // high volume
        if (volRatio > 2.0) confidence += 10;
        if (current.close > prevDay.high) confidence += 10; // above PDH

        // Pattern detection
        let pattern = "breakout";
        if (bodyRatio > 0.7 && current.close > current.open) pattern = "bullish_engulfing";
        else if (current.low === Math.min(...window.map((c) => c.low))) pattern = "hammer";

        const entry = current.close;
        const sl = Math.min(current.low, rangeLow);
        const risk = entry - sl;
        const target = entry + risk * 1.5;

        breakouts.push({
          direction: "bullish",
          level: rangeHigh,
          levelName: `Range_High_${i}`,
          pattern,
          confidence: Math.min(95, confidence),
          entryPrice: entry,
          slPrice: sl,
          targetPrice: target,
          riskReward: 1.5,
          timestamp: current.timestamp.toISOString(),
          candleIndex: i,
        });
      }
    }

    // Bearish breakout: close below rolling range low
    if (previous.close >= rangeLow && current.close < rangeLow) {
      const breakPct = (rangeLow - current.close) / rangeLow;
      if (breakPct > 0.0005) {
        const bodySize = current.open - current.close;
        const range = current.high - current.low;
        const bodyRatio = range > 0 ? bodySize / range : 0;

        const avgVol = window.reduce((s, c) => s + c.volume, 0) / window.length;
        const volRatio = current.volume / avgVol;
        let confidence = 50;
        if (bodyRatio > 0.5) confidence += 15;
        if (bodyRatio > 0.7) confidence += 10;
        if (volRatio > 1.5) confidence += 15;
        if (volRatio > 2.0) confidence += 10;
        if (current.close < prevDay.low) confidence += 10;

        let pattern = "breakout";
        if (bodyRatio > 0.7 && current.close < current.open) pattern = "bearish_engulfing";
        else if (current.high === Math.max(...window.map((c) => c.high))) pattern = "shooting_star";

        const entry = current.close;
        const sl = Math.max(current.high, rangeHigh);
        const risk = sl - entry;
        const target = entry - risk * 1.5;

        breakouts.push({
          direction: "bearish",
          level: rangeLow,
          levelName: `Range_Low_${i}`,
          pattern,
          confidence: Math.min(95, confidence),
          entryPrice: entry,
          slPrice: sl,
          targetPrice: target,
          riskReward: 1.5,
          timestamp: current.timestamp.toISOString(),
          candleIndex: i,
        });
      }
    }
  }

  return breakouts;
}

export async function runMultiDayBacktest(
  symbol: string,
  startDate: string,
  endDate: string
): FullBacktestResult {
  const allTrades: BacktestTrade[] = [];
  const dailyResults: DayBacktestResult[] = [];
  const equityCurve: { date: string; equity: number; drawdown: number }[] = [];

  const requested = (process.env.BACKTEST_DATA_SOURCE as BacktestDataSource) || "auto";
  const providerMeta = createBacktestRunMeta(requested);
  const dataProvider = getBacktestDataProvider(requested, providerMeta);

  let cumulativePnL = 0;
  let equity = 1000000;
  let peak = equity;

  // Iterate each day
  const startParts = startDate.split("-").map(Number);
  const endParts = endDate.split("-").map(Number);
  const start = new Date(startParts[0], startParts[1] - 1, startParts[2]);
  const end = new Date(endParts[0], endParts[1] - 1, endParts[2]);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    // Skip weekends
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;

    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    // Fetch candles via the data provider (recorded history → live Breeze)
    let candles: any[] = [];
    try {
      const res = await dataProvider.getIntradayCandles(symbol, "5minute", dateStr);
      candles = res.candles as any[];
    } catch {
      candles = [];
    }

    // If no real candles (market closed or Breeze failed), skip this day
    if (candles.length === 0) {
      continue;
    }

    const prevDay = {
      high: Math.max(...candles.map((c) => c.high)),
      low: Math.min(...candles.map((c) => c.low)),
      close: candles[candles.length - 1]?.close || candles[0]?.close || 0,
    };
    // Day OHLC
    const dayOpen = candles[0].open;
    const dayClose = candles[candles.length - 1].close;
    const dayHigh = Math.max(...candles.map((c) => c.high));
    const dayLow = Math.min(...candles.map((c) => c.low));

    // Use actual opening gap as Gift Nifty proxy for backtesting
    // (real Gift Nifty data is not available for historical dates)
    const giftNiftyPrice = prevDay.close > 0 ? dayOpen : prevDay.close;

    // Detect breakouts from price action
    const paBreakouts = detectPriceActionBreakouts(candles, prevDay);

    // Also run strategy engine for S/R confirmation
    const strategy = new CandlestickBreakoutIndia({
      min_break_pct: 0.003,
      volume_mult: 1.5,
      min_confidence: 60,
      rr_target: 1.5,
      sl_buffer: 0.002,
    });
    strategy.sr.setPreviousDay(prevDay.high, prevDay.low, prevDay.close);
    strategy.sr.setGiftNiftyBias(giftNiftyPrice, prevDay.close);

    // Feed candles to strategy for S/R level tracking
    for (const candle of candles) {
      strategy.onTick({
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        timestamp: candle.timestamp.toISOString(),
      });
    }

    const srLevels = strategy.sr.getAllLevels();

    // Convert price action breakouts to signal format
    const signals: BreakoutSignal[] = paBreakouts.map((pa) => ({
      type: "BREAKOUT_SIGNAL" as const,
      direction: pa.direction,
      pattern: pa.pattern,
      level: pa.level,
      levelName: pa.levelName,
      entryPrice: pa.entryPrice,
      slPrice: pa.slPrice,
      targetPrice: pa.targetPrice,
      riskReward: pa.riskReward,
      confidence: pa.confidence,
      strike: Math.round(pa.entryPrice / 50) * 50,
      optionType: pa.direction === "bullish" ? "CE" : "PE",
      action: pa.direction === "bullish" ? "BUY_CE" : "BUY_PE",
      timestamp: pa.timestamp,
    }));

    // Simulate trades with OI/Greek quality scoring
    const dayTrades: BacktestTrade[] = [];
    for (const signal of signals) {
      const signalTime = new Date(signal.timestamp);
      const candleIndex = candles.findIndex((c) => c.timestamp.getTime() === signalTime.getTime());

      if (candleIndex >= 0 && candleIndex < candles.length - 1) {
        const { oiScore, greekScore, qualityGrade, qualityScore } = simulateOIScore(
          candles, candleIndex, signal.direction
        );

        // Only take trades with quality >= 50 (same gate as SDM)
        if (qualityScore >= 50) {
          const trade = simulateTrade(
            signal, candles, candleIndex, symbol, dateStr,
            qualityScore, qualityGrade, oiScore, greekScore
          );
          dayTrades.push(trade);
          allTrades.push(trade);
        }
      }
    }

    // Daily P&L
    const dailyPnL = dayTrades.reduce((s, t) => s + (t.pnl || 0), 0);
    const dailyWins = dayTrades.filter((t) => t.status === "WIN").length;
    const dailyWinRate = dayTrades.length > 0 ? Math.round((dailyWins / dayTrades.length) * 100) : 0;

    cumulativePnL += dailyPnL;
    equity += dailyPnL;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;

    equityCurve.push({ date: dateStr, equity, drawdown });

    dailyResults.push({
      date: dateStr,
      dayOHLC: {
        open: Math.round(dayOpen * 100) / 100,
        high: Math.round(dayHigh * 100) / 100,
        low: Math.round(dayLow * 100) / 100,
        close: Math.round(dayClose * 100) / 100,
        change: Math.round((dayClose - dayOpen) * 100) / 100,
        changePct: Math.round(((dayClose - dayOpen) / dayOpen) * 10000) / 100,
      },
      signals: signals.length,
      trades: dayTrades,
      dailyPnL,
      dailyWinRate,
      cumulativePnL,
    });
  }

  const performance = computePerformance(dailyResults, allTrades);

  return {
    symbol,
    startDate,
    endDate,
    performance,
    dailyResults,
    equityCurve,
    providerMeta,
    timestamp: new Date().toISOString(),
  };
}
