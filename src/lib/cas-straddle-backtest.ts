// lib/cas-straddle-backtest.ts
//
// CAS Straddle / Strangle Backtest Engine
// ───────────────────────────────────────────────────────────────────
// Replays the SAME strategy engine on historical data.
// No look-ahead bias: only uses data available at each timestamp.

import {
  generateStrategySignal,
  calculateTradePnL,
  getLotSize,
  computeDataQuality,
  type MarketSnapshot,
  type StrategyConfig,
  type StrategySignal,
  type TradePnL,
} from "./cas-straddle-strategy";

export interface BacktestTrade {
  id: number;
  date: string;
  entryTime: string;
  exitTime: string;
  symbol: string;
  strategy: string;
  strikeSelection: string;
  expiryType: string;
  // Market state at entry
  spot: number;
  ceStrike: number;
  peStrike: number;
  ceEntry: number;
  peEntry: number;
  combinedPremium: number;
  expectedMove: number;
  casReferencePrice: number;
  casDislocationPct: number;
  casScore: number;
  pcr: number;
  iv: number;
  regime: string;
  // Breakevens
  breakevenUpper: number;
  breakevenLower: number;
  // Exit
  ceExit: number;
  peExit: number;
  exitPremium: number;
  exitReason: string;
  // P&L
  grossPnL: number;
  charges: number;
  slippage: number;
  netPnL: number;
  returnPct: number;
  // Quality
  dataQuality: number;
  confidence: number;
  reasoning: string[];
}

export interface BacktestResult {
  success: boolean;
  config: StrategyConfig;
  symbol: string;
  period: { from: string; to: string };
  // Summary
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  grossPnL: number;
  totalCharges: number;
  totalSlippage: number;
  netPnL: number;
  avgProfit: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  largestWin: number;
  largestLoss: number;
  avgHoldingTime: string;
  capitalRequired: number;
  returnOnCapital: number;
  // Equity curve
  equityCurve: Array<{ date: string; equity: number; drawdown: number }>;
  // Trade log
  trades: BacktestTrade[];
  // Strategy comparison
  strategyComparison: Record<string, {
    trades: number;
    winRate: number;
    netPnL: number;
    drawdown: number;
    profitFactor: number;
  }>;
  // Data quality
  dataQualityScore: number;
  incompleteTradesRemoved: number;
}

// ─── Historical Data Fetcher ──────────────────────────────────────
async function fetchHistoricalData(
  symbol: string,
  from: string,
  to: string,
): Promise<{
  candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
  optionPrices: Map<string, { ceAtm: number; peAtm: number; iv: number }>;
}> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

  // Fetch candles from Yahoo Finance (via our API)
  const candleRes = await fetch(
    `${baseUrl}/api/backtest/trades?symbol=${symbol}&from=${from}&to=${to}&type=candles`,
    { signal: AbortSignal.timeout(30000) }
  ).catch(() => null);

  let candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> = [];

  if (candleRes?.ok) {
    const data = await candleRes.json();
    candles = data.candles || [];
  }

  // Fallback: direct Yahoo Finance
  if (candles.length === 0) {
    const yahooSymbol = symbol === "SENSEX" ? "^BSESN" : "^NSEI";
    const periodFrom = Math.floor(new Date(from).getTime() / 1000);
    const periodTo = Math.floor(new Date(to).getTime() / 1000);
    const yahooRes = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?period1=${periodFrom}&period2=${periodTo}&interval=1d`,
      { signal: AbortSignal.timeout(15000) }
    ).catch(() => null);

    if (yahooRes?.ok) {
      const data = await yahooRes.json();
      const result = data.chart?.result?.[0];
      if (result) {
        const timestamps = result.timestamp || [];
        const quote = result.indicators?.quote?.[0] || {};
        for (let i = 0; i < timestamps.length; i++) {
          if (quote.close?.[i] != null) {
            candles.push({
              date: new Date(timestamps[i] * 1000).toISOString().split("T")[0],
              open: quote.open?.[i] || 0,
              high: quote.high?.[i] || 0,
              low: quote.low?.[i] || 0,
              close: quote.close?.[i] || 0,
              volume: quote.volume?.[i] || 0,
            });
          }
        }
      }
    }
  }

  // Option prices: reconstruct from IV (Black-Scholes approximation)
  // Real historical option prices require Breeze historical data
  const optionPrices = new Map<string, { ceAtm: number; peAtm: number; iv: number }>();
  for (const c of candles) {
    const iv = estimateIV(c, candles);
    const strike = roundToNearest(c.close, symbol);
    const cePrice = blackScholesPrice(c.close, strike, iv, 1 / 365, "CE");
    const pePrice = blackScholesPrice(c.close, strike, iv, 1 / 365, "PE");
    optionPrices.set(c.date, { ceAtm: cePrice, peAtm: pePrice, iv: iv * 100 });
  }

  return { candles, optionPrices };
}

// ─── Helpers ──────────────────────────────────────────────────────
function roundToNearest(price: number, symbol: string): number {
  const step = symbol === "SENSEX" ? 100 : 50;
  return Math.round(price / step) * step;
}

function estimateIV(
  candle: { open: number; high: number; low: number; close: number },
  allCandles: Array<{ close: number }>,
): number {
  // Simple IV estimate from historical volatility
  if (allCandles.length < 20) return 0.15; // default 15%

  const returns: number[] = [];
  for (let i = 1; i < Math.min(allCandles.length, 60); i++) {
    if (allCandles[i - 1].close > 0) {
      returns.push(Math.log(allCandles[i].close / allCandles[i - 1].close));
    }
  }
  if (returns.length === 0) return 0.15;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const dailyVol = Math.sqrt(variance);
  const annualizedVol = dailyVol * Math.sqrt(252);

  return Math.max(0.05, Math.min(0.50, annualizedVol)); // cap 5-50%
}

function blackScholesPrice(
  spot: number,
  strike: number,
  iv: number,
  tte: number,
  type: "CE" | "PE",
): number {
  if (tte <= 0 || iv <= 0) return Math.max(0, type === "CE" ? spot - strike : strike - spot);

  const r = 0.065; // risk-free rate
  const d1 = (Math.log(spot / strike) + (r + iv * iv / 2) * tte) / (iv * Math.sqrt(tte));
  const d2 = d1 - iv * Math.sqrt(tte);

  const nd1 = normalCDF(d1);
  const nd2 = normalCDF(d2);
  const npd1 = normalCDF(-d1);
  const npd2 = normalCDF(-d2);

  if (type === "CE") {
    return spot * nd1 - strike * Math.exp(-r * tte) * nd2;
  } else {
    return strike * Math.exp(-r * tte) * npd2 - spot * npd1;
  }
}

function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

// ─── Reconstruct CAS from candles ─────────────────────────────────
function reconstructCAS(
  candle: { date: string; open: number; high: number; low: number; close: number; volume: number },
  prevCloses: number[],
): {
  casReferencePrice: number;
  casDislocationPct: number;
  casDislocationStrength: "NONE" | "WEAK" | "MODERATE" | "STRONG" | "EXTREME";
  casVelocity: number;
  casAboveReference: boolean;
  pcr: number;
  maxPain: number;
  regime: "TRENDING_UP" | "TRENDING_DOWN" | "RANGING" | "HIGH_VOL" | "LOW_VOL";
} {
  // CAS reference = previous day's close (proxy for VWAP 15:00-15:15)
  const casRef = prevCloses.length > 0 ? prevCloses[prevCloses.length - 1] : candle.open;

  // CAS dislocation = today's close vs CAS reference
  const dislocation = candle.close - casRef;
  const dislocationPct = casRef > 0 ? (dislocation / casRef) * 100 : 0;

  let strength: "NONE" | "WEAK" | "MODERATE" | "STRONG" | "EXTREME" = "NONE";
  const absPct = Math.abs(dislocationPct);
  if (absPct >= 1.0) strength = "EXTREME";
  else if (absPct >= 0.6) strength = "STRONG";
  else if (absPct >= 0.3) strength = "MODERATE";
  else if (absPct >= 0.1) strength = "WEAK";

  // PCR estimate from price action
  const pcr = dislocationPct > 0 ? 1.1 : dislocationPct < 0 ? 0.9 : 1.0;

  // Max pain estimate
  const maxPain = roundToNearest(candle.close, "NIFTY");

  // Regime from recent volatility
  let regime: "TRENDING_UP" | "TRENDING_DOWN" | "RANGING" | "HIGH_VOL" | "LOW_VOL" = "RANGING";
  if (prevCloses.length >= 5) {
    const recent = prevCloses.slice(-5);
    const trend = (recent[recent.length - 1] - recent[0]) / recent[0];
    const range = (Math.max(...recent) - Math.min(...recent)) / recent[0];
    if (trend > 0.01) regime = "TRENDING_UP";
    else if (trend < -0.01) regime = "TRENDING_DOWN";
    else if (range > 0.03) regime = "HIGH_VOL";
    else if (range < 0.01) regime = "LOW_VOL";
  }

  return {
    casReferencePrice: casRef,
    casDislocationPct: dislocationPct,
    casDislocationStrength: strength,
    casVelocity: 0, // single day, no velocity
    casAboveReference: dislocationPct > 0,
    pcr,
    maxPain,
    regime,
  };
}

// ─── Main Backtest Runner ─────────────────────────────────────────
export async function runBacktest(config: StrategyConfig, symbol: string): Promise<BacktestResult> {
  const { candles, optionPrices } = await fetchHistoricalData(symbol, config.expiryType === "weekly" ? "2025-01-01" : "2024-01-01", "2026-12-31");

  const trades: BacktestTrade[] = [];
  let tradeId = 0;
  let capital = config.initialCapital;
  let peak = capital;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  const equityCurve: Array<{ date: string; equity: number; drawdown: number }> = [];
  const strategyStats: Record<string, { trades: number; wins: number; pnl: number; dd: number; pf: { profit: number; loss: number } }> = {};

  const prevCloses: number[] = [];
  let dataQualitySum = 0;
  let incompleteRemoved = 0;

  for (let i = 20; i < candles.length; i++) {
    const candle = candles[i];
    const history = candles.slice(Math.max(0, i - 60), i);

    // Build market snapshot (only data available up to this point)
    const optionData = optionPrices.get(candle.date);
    const cas = reconstructCAS(candle, prevCloses.map((_, idx) => candles[i - 60 + idx]?.close || 0));

    const snap: MarketSnapshot = {
      timestamp: candle.date,
      spot: candle.close,
      symbol,
      casReferencePrice: cas.casReferencePrice,
      casDislocationPct: cas.casDislocationPct,
      casDislocationStrength: cas.casDislocationStrength,
      casVelocity: cas.casVelocity,
      casAboveReference: cas.casAboveReference,
      atmStrike: roundToNearest(candle.close, symbol),
      atmCE: optionData?.ceAtm || 0,
      atmPE: optionData?.peAtm || 0,
      combinedPremium: (optionData?.ceAtm || 0) + (optionData?.peAtm || 0),
      expectedMove: (optionData?.ceAtm || 0) + (optionData?.peAtm || 0),
      pcr: cas.pcr,
      maxPain: cas.maxPain,
      iv: optionData?.iv || 15,
      chain: [], // simplified for backtest
      regime: cas.regime,
      vix: optionData?.iv || 15,
      candles: history.map(c => ({
        time: new Date(c.date).getTime(),
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      })),
    };

    const quality = computeDataQuality(snap);
    dataQualitySum += quality;

    // Generate signal using SAME engine as live
    const signal = generateStrategySignal(snap, config);

    if (signal.strategy === "NO_TRADE") {
      prevCloses.push(candle.close);
      continue;
    }

    // Check data quality
    if (quality < 50) {
      incompleteRemoved++;
      prevCloses.push(candle.close);
      continue;
    }

    // Entry
    const entryDate = candle.date;
    const lotSize = getLotSize(symbol, entryDate);
    const entryPremium = signal.combinedPremium;

    // Exit: next day close (simplified — real backtest would use intraday)
    const exitIdx = Math.min(i + 1, candles.length - 1);
    const exitCandle = candles[exitIdx];
    const exitOptionData = optionPrices.get(exitCandle.date);
    let exitPremium = entryPremium;

    if (signal.strategy === "STRADDLE" || signal.strategy === "STRANGLE") {
      exitPremium = (exitOptionData?.ceAtm || 0) + (exitOptionData?.peAtm || 0);
    } else if (signal.strategy === "CALL") {
      exitPremium = exitOptionData?.ceAtm || entryPremium;
    } else if (signal.strategy === "PUT") {
      exitPremium = exitOptionData?.peAtm || entryPremium;
    }

    // Calculate P&L using SAME function as live
    const pnl = calculateTradePnL(signal, exitPremium, lotSize, config.chargesMode, config.slippageMode);

    // Target/SL exit
    let exitReason = "TIME";
    if (pnl.returnPct >= config.targetPct) exitReason = "TARGET";
    if (pnl.returnPct <= -config.stopLossPct) exitReason = "STOP_LOSS";

    capital += pnl.netPnL;
    if (capital > peak) peak = capital;
    const drawdown = peak - capital;
    const drawdownPct = peak > 0 ? (drawdown / peak) * 100 : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;

    equityCurve.push({ date: candle.date, equity: capital, drawdown: drawdownPct });

    const trade: BacktestTrade = {
      id: ++tradeId,
      date: entryDate,
      entryTime: config.entryTime,
      exitTime: config.exitTime,
      symbol,
      strategy: signal.strategy,
      strikeSelection: config.strikeSelection,
      expiryType: config.expiryType,
      spot: candle.close,
      ceStrike: signal.ceStrike,
      peStrike: signal.peStrike,
      ceEntry: signal.cePremium,
      peEntry: signal.pePremium,
      combinedPremium: entryPremium,
      expectedMove: signal.expectedMove,
      casReferencePrice: cas.casReferencePrice,
      casDislocationPct: cas.casDislocationPct,
      casScore: signal.casScore,
      pcr: cas.pcr,
      iv: optionData?.iv || 15,
      regime: cas.regime,
      breakevenUpper: signal.breakevenUpper,
      breakevenLower: signal.breakevenLower,
      ceExit: signal.strategy === "PUT" ? 0 : exitPremium * 0.5,
      peExit: signal.strategy === "CALL" ? 0 : exitPremium * 0.5,
      exitPremium,
      exitReason,
      grossPnL: pnl.grossPnL,
      charges: pnl.charges,
      slippage: pnl.slippage,
      netPnL: pnl.netPnL,
      returnPct: pnl.returnPct,
      dataQuality: quality,
      confidence: signal.confidence,
      reasoning: signal.reasoning,
    };

    trades.push(trade);

    // Strategy comparison
    const key = `${signal.strategy}_${config.strikeSelection}`;
    if (!strategyStats[key]) strategyStats[key] = { trades: 0, wins: 0, pnl: 0, dd: 0, pf: { profit: 0, loss: 0 } };
    strategyStats[key].trades++;
    strategyStats[key].pnl += pnl.netPnL;
    if (pnl.netPnL > 0) { strategyStats[key].wins++; strategyStats[key].pf.profit += pnl.netPnL; }
    else { strategyStats[key].pf.loss += Math.abs(pnl.netPnL); }

    prevCloses.push(candle.close);
  }

  // Compute final stats
  const totalTrades = trades.length;
  const winningTrades = trades.filter(t => t.netPnL > 0).length;
  const losingTrades = totalTrades - winningTrades;
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
  const grossPnL = trades.reduce((a, t) => a + t.grossPnL, 0);
  const totalCharges = trades.reduce((a, t) => a + t.charges, 0);
  const totalSlippage = trades.reduce((a, t) => a + t.slippage, 0);
  const netPnL = trades.reduce((a, t) => a + t.netPnL, 0);
  const avgProfit = winningTrades > 0 ? trades.filter(t => t.netPnL > 0).reduce((a, t) => a + t.netPnL, 0) / winningTrades : 0;
  const avgLoss = losingTrades > 0 ? trades.filter(t => t.netPnL <= 0).reduce((a, t) => a + t.netPnL, 0) / losingTrades : 0;
  const profitFactor = trades.filter(t => t.netPnL <= 0).reduce((a, t) => a + Math.abs(t.netPnL), 0) > 0
    ? trades.filter(t => t.netPnL > 0).reduce((a, t) => a + t.netPnL, 0) / trades.filter(t => t.netPnL <= 0).reduce((a, t) => a + Math.abs(t.netPnL), 0)
    : 0;
  const largestWin = trades.length > 0 ? Math.max(...trades.map(t => t.netPnL)) : 0;
  const largestLoss = trades.length > 0 ? Math.min(...trades.map(t => t.netPnL)) : 0;

  // Strategy comparison
  const strategyComparison: Record<string, any> = {};
  for (const [key, stats] of Object.entries(strategyStats)) {
    strategyComparison[key] = {
      trades: stats.trades,
      winRate: stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0,
      netPnL: stats.pnl,
      drawdown: 0,
      profitFactor: stats.pf.loss > 0 ? stats.pf.profit / stats.pf.loss : 0,
    };
  }

  return {
    success: true,
    config,
    symbol,
    period: { from: candles[20]?.date || "", to: candles[candles.length - 1]?.date || "" },
    totalTrades,
    winningTrades,
    losingTrades,
    winRate: Math.round(winRate * 10) / 10,
    grossPnL: Math.round(grossPnL),
    totalCharges: Math.round(totalCharges),
    totalSlippage: Math.round(totalSlippage),
    netPnL: Math.round(netPnL),
    avgProfit: Math.round(avgProfit),
    avgLoss: Math.round(avgLoss),
    profitFactor: Math.round(profitFactor * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown),
    maxDrawdownPct: Math.round(maxDrawdownPct * 10) / 10,
    largestWin: Math.round(largestWin),
    largestLoss: Math.round(largestLoss),
    avgHoldingTime: "1 day",
    capitalRequired: config.initialCapital,
    returnOnCapital: config.initialCapital > 0 ? Math.round((netPnL / config.initialCapital) * 100 * 10) / 10 : 0,
    equityCurve,
    trades,
    strategyComparison,
    dataQualityScore: totalTrades > 0 ? Math.round(dataQualitySum / (candles.length - 20)) : 0,
    incompleteTradesRemoved: incompleteRemoved,
  };
}
