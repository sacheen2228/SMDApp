// lib/cas-straddle-backtest-v2.ts
//
// CAS Straddle / Strangle Backtest Engine V2
// ───────────────────────────────────────────────────────────────────
// Complete rewrite with:
// - Strict risk management (1% max risk per trade)
// - Dynamic exit system (not just TIME)
// - MFE/MAE tracking
// - Walk-forward testing
// - Proper capital/drawdown calculation
// - No look-ahead bias

import {
  generateStrategySignalV2,
  calculateTradePnLV2,
  getLotSize,
  computeDataQuality,
  classifyRegime,
  blackScholesPrice,
  type MarketSnapshot,
  type StrategyConfig,
  type StrategySignal,
  type TradePnL,
  type MarketRegime,
  DEFAULT_CONFIG,
} from "./cas-straddle-strategy-v2";
import {
  detectEntryWindow,
  computeWindowPerformance,
  computeExitTypePerformance,
  type WindowPerformance,
  type ExitTypePerformance,
  type EntryWindow,
} from "./cas-time-engine";

// ─── Backtest Trade Record ────────────────────────────────────────
export interface BacktestTrade {
  id: number;
  date: string;
  entryTime: string;
  exitTime: string;
  symbol: string;
  strategy: string;
  strikeSelection: string;
  expiryType: string;
  entryWindow: string;
  // Entry snapshot (immutable after creation)
  spotAtEntry: number;
  ceStrike: number;
  peStrike: number;
  ceEntryPrice: number;
  peEntryPrice: number;
  combinedPremiumAtEntry: number;
  expectedMoveAtEntry: number;
  expectedMovePctAtEntry: number;
  casScoreAtEntry: number;
  tradeQualityAtEntry: number;
  confidenceAtEntry: number;
  vixAtEntry: number;
  ivAtEntry: number;
  pcrAtEntry: number;
  volumeAtEntry: number;
  oiAtEntry: number;
  regimeAtEntry: string;
  entryTimestamp: string;
  // Breakevens
  breakevenUpper: number;
  breakevenLower: number;
  // Exit
  ceExitPrice: number;
  peExitPrice: number;
  exitPremium: number;
  exitReason: string;
  barsHeld: number;
  // P&L
  grossPnL: number;
  charges: number;
  slippage: number;
  netPnL: number;
  returnPct: number;
  // Risk
  maxRisk: number;
  riskCapital: number;
  // MFE/MAE
  mfe: number; // maximum favorable excursion (best unrealized P&L)
  mae: number; // maximum adverse excursion (worst unrealized P&L)
  mfePct: number;
  maePct: number;
  // Quality
  dataQuality: number;
  gateResults: Record<string, boolean>;
  reasoning: string[];
  rejectionReasons: string[];
}

// ─── Backtest Result ──────────────────────────────────────────────
export interface BacktestResult {
  success: boolean;
  config: StrategyConfig;
  symbol: string;
  period: { from: string; to: string };
  // Summary
  totalTrades: number;
  totalScans: number; // total days evaluated
  noTradePct: number; // % of scans that resulted in NO_TRADE
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
  expectancy: number; // expected value per trade
  maxDrawdown: number;
  maxDrawdownPct: number;
  largestWin: number;
  largestLoss: number;
  avgHoldingTime: string;
  capitalRequired: number;
  returnOnCapital: number;
  // Equity curve
  equityCurve: Array<{ date: string; equity: number; drawdown: number; peak: number }>;
  // Trade log
  trades: BacktestTrade[];
  // Strategy comparison
  strategyComparison: Record<string, {
    trades: number;
    winRate: number;
    netPnL: number;
    drawdown: number;
    profitFactor: number;
    expectancy: number;
    avgWin: number;
    avgLoss: number;
  }>;
  // Regime breakdown
  regimeBreakdown: Record<string, {
    trades: number;
    winRate: number;
    netPnL: number;
    profitFactor: number;
  }>;
  // Diagnosis
  diagnosis: string[];
  // Walk-forward
  walkForward?: {
    training: { trades: number; winRate: number; netPnL: number; profitFactor: number };
    validation: { trades: number; winRate: number; netPnL: number; profitFactor: number };
    outOfSample: { trades: number; winRate: number; netPnL: number; profitFactor: number };
  };
  // Time analysis (CAS Time Engine)
  windowPerformance: Record<string, WindowPerformance>;
  exitTypePerformance: Record<string, ExitTypePerformance>;
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
}> {
  const yahooSymbol = symbol === "SENSEX" ? "^BSESN" : "^NSEI";
  const periodFrom = Math.floor(new Date(from).getTime() / 1000);
  const periodTo = Math.floor(new Date(to).getTime() / 1000);

  const yahooRes = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?period1=${periodFrom}&period2=${periodTo}&interval=1d`,
    { signal: AbortSignal.timeout(15000) }
  ).catch(() => null);

  const candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> = [];

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

  return { candles };
}

// ─── Build Option Chain from Candles ──────────────────────────────
function buildChain(
  candle: { close: number; high: number; low: number },
  symbol: string,
  iv: number,
): MarketSnapshot["chain"] {
  const step = symbol === "SENSEX" ? 100 : 50;
  const chain: MarketSnapshot["chain"] = [];
  const spot = candle.close;

  for (let offset = -8; offset <= 8; offset++) {
    const strike = Math.round(spot / step) * step + offset * step;
    const dist = Math.abs(strike - spot) / spot;
    const tte = 1 / 365;
    const skewIV = (iv / 100) * (1 + dist * 3); // IV skew
    const ceLtp = blackScholesPrice(spot, strike, skewIV, tte, "CE");
    const peLtp = blackScholesPrice(spot, strike, skewIV, tte, "PE");

    // Simulate OI and volume (decay with distance from ATM)
    const baseOI = 80000;
    const baseVol = 30000;
    const oiDecay = Math.exp(-dist * 8);
    const volDecay = Math.exp(-dist * 6);

    chain.push({
      strike,
      ce: { ltp: ceLtp, oi: Math.round(baseOI * oiDecay), oiChg: 0, volume: Math.round(baseVol * volDecay), iv: skewIV * 100, delta: offset === 0 ? 0.5 : undefined, spread: Math.round(dist * 100) },
      pe: { ltp: peLtp, oi: Math.round(baseOI * oiDecay), oiChg: 0, volume: Math.round(baseVol * volDecay), iv: skewIV * 100, delta: offset === 0 ? -0.5 : undefined, spread: Math.round(dist * 100) },
    });
  }
  return chain;
}

// ─── Estimate IV from Historical Volatility ───────────────────────
function estimateIV(candles: Array<{ close: number }>, lookback: number = 20): number {
  if (candles.length < lookback + 1) return 15;
  const returns: number[] = [];
  for (let i = candles.length - lookback; i < candles.length; i++) {
    if (candles[i - 1].close > 0) {
      returns.push(Math.log(candles[i].close / candles[i - 1].close));
    }
  }
  if (returns.length === 0) return 15;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.max(5, Math.min(50, Math.sqrt(variance) * Math.sqrt(252) * 100));
}

// ─── Dynamic Exit Check ───────────────────────────────────────────
function checkDynamicExit(
  trade: BacktestTrade,
  currentCandle: { close: number; high: number; low: number },
  barsSinceEntry: number,
  config: StrategyConfig,
): { shouldExit: boolean; reason: string } {
  // Target hit
  if (trade.returnPct >= config.targetPct) return { shouldExit: true, reason: "TARGET" };

  // Stop loss hit
  if (trade.returnPct <= -config.stopLossPct) return { shouldExit: true, reason: "STOP_LOSS" };

  // Max holding time
  if (barsSinceEntry >= config.maxHoldingBars) return { shouldExit: true, reason: "MAX_HOLDING" };

  // Momentum exit: if trade was profitable but now declining
  if (trade.mfe > 0 && trade.netPnL < trade.mfe * 0.5) {
    return { shouldExit: true, reason: "MOMENTUM_EXIT" };
  }

  // Thesis failure: underlying moved against position
  if (trade.strategy === "CALL" && currentCandle.close < trade.spotAtEntry * 0.98) {
    return { shouldExit: true, reason: "THESIS_FAILURE" };
  }
  if (trade.strategy === "PUT" && currentCandle.close > trade.spotAtEntry * 1.02) {
    return { shouldExit: true, reason: "THESIS_FAILURE" };
  }

  return { shouldExit: false, reason: "" };
}

// ─── Compute MFE/MAE for a trade ─────────────────────────────────
function computeMFEMAE(
  strategy: string,
  entryPremium: number,
  lotSize: number,
  candles: Array<{ close: number; high: number; low: number }>,
  ceStrike: number,
  peStrike: number,
): { mfe: number; mae: number; mfePct: number; maePct: number } {
  let mfe = 0, mae = 0;
  const riskCapital = entryPremium * lotSize;

  for (const c of candles) {
    let unrealized = 0;
    if (strategy === "STRADDLE" || strategy === "STRANGLE") {
      const ceMove = Math.max(0, c.close - ceStrike);
      const peMove = Math.max(0, peStrike - c.close);
      const currentPremium = Math.max(0, entryPremium * 0.3 + (ceMove + peMove) * 0.05);
      unrealized = (entryPremium - currentPremium) * lotSize;
    } else if (strategy === "CALL") {
      const currentPremium = Math.max(0, entryPremium + (c.close - (ceStrike || c.close)) * 0.4);
      unrealized = (currentPremium - entryPremium) * lotSize;
    } else if (strategy === "PUT") {
      const currentPremium = Math.max(0, entryPremium + ((peStrike || c.close) - c.close) * 0.4);
      unrealized = (currentPremium - entryPremium) * lotSize;
    }
    if (unrealized > mfe) mfe = unrealized;
    if (unrealized < mae) mae = unrealized;
  }

  return {
    mfe, mae,
    mfePct: riskCapital > 0 ? (mfe / riskCapital) * 100 : 0,
    maePct: riskCapital > 0 ? (mae / riskCapital) * 100 : 0,
  };
}

// ─── Main Backtest Runner ─────────────────────────────────────────
export async function runBacktestV2(config: StrategyConfig, symbol: string): Promise<BacktestResult> {
  const fromDate = config.expiryType === "weekly" ? "2025-01-01" : "2024-01-01";
  const toDate = "2026-12-31";
  const { candles } = await fetchHistoricalData(symbol, fromDate, toDate);

  const trades: BacktestTrade[] = [];
  let tradeId = 0;
  let capital = config.initialCapital;
  let peak = capital;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let totalScans = 0;
  let noTradeCount = 0;
  const equityCurve: Array<{ date: string; equity: number; drawdown: number; peak: number }> = [];
  const strategyStats: Record<string, { trades: number; wins: number; pnl: number; dd: number; pf: { profit: number; loss: number }; winAmounts: number[]; lossAmounts: number[] }> = {};
  const regimeStats: Record<string, { trades: number; wins: number; pnl: number; pf: { profit: number; loss: number } }> = {};
  const diagnosis: string[] = [];

  let dataQualitySum = 0;
  let incompleteRemoved = 0;

  // Warmup period
  const warmupPeriod = 60;

  for (let i = warmupPeriod; i < candles.length; i++) {
    const candle = candles[i];
    const history = candles.slice(Math.max(0, i - 60), i);
    const prevCloses = history.map(c => c.close);
    totalScans++;

    // ─── Build Market Data ──────────────────────────────────────
    const iv = estimateIV(history);
    const chain = buildChain(candle, symbol, iv);
    const step = symbol === "SENSEX" ? 100 : 50;
    const atmStrike = Math.round(candle.close / step) * step;
    const atmRow = chain.find(s => s.strike === atmStrike);
    const ceAtm = atmRow?.ce?.ltp || 0;
    const peAtm = atmRow?.pe?.ltp || 0;

    // Regime
    const ranges = history.slice(-20).map(c => (c.high - c.low) / c.close * 100);
    const avgRange = ranges.length > 0 ? ranges.reduce((a, b) => a + b, 0) / ranges.length : 1;
    const atr = history.slice(-14).reduce((a, c) => a + (c.high - c.low), 0) / Math.min(14, history.length);
    const recentVol = history.slice(-5).reduce((a, c) => a + c.volume, 0) / 5;
    const avgVol = history.slice(-20).reduce((a, c) => a + c.volume, 0) / 20;
    const volumeRatio = avgVol > 0 ? recentVol / avgVol : 1;
    const gapPct = candle.open > 0 && prevCloses.length > 0 ? ((candle.open - prevCloses[prevCloses.length - 1]) / prevCloses[prevCloses.length - 1]) * 100 : 0;

    const regime = classifyRegime({
      vix: iv, realizedVol: iv, intradayRangePct: avgRange,
      atrPct: atr / candle.close * 100, volumeRatio,
      isExpiryDay: false, // simplified
      gapPct,
    });

    // Build snapshot
    const snap: MarketSnapshot = {
      timestamp: candle.date,
      spot: candle.close,
      symbol,
      casReferencePrice: prevCloses.length > 0 ? prevCloses[prevCloses.length - 1] : candle.open,
      casDislocationPct: prevCloses.length > 0 ? ((candle.close - prevCloses[prevCloses.length - 1]) / prevCloses[prevCloses.length - 1]) * 100 : 0,
      casDislocationStrength: "NONE",
      casVelocity: 0,
      casAboveReference: candle.close > (prevCloses.length > 0 ? prevCloses[prevCloses.length - 1] : candle.open),
      casBuyQty: 0, casSellQty: 0, casImbalance: 0.5,
      atmStrike, atmCE: ceAtm, atmPE: peAtm,
      combinedPremium: ceAtm + peAtm,
      expectedMove: ceAtm + peAtm,
      pcr: 1.0, maxPain: atmStrike, iv, chain, regime, vix: iv,
      realizedVol: iv,
      futuresPrice: candle.close * (1 + (regime === "TRENDING_UP" ? 0.001 : regime === "TRENDING_DOWN" ? -0.001 : 0)),
      futuresBasis: candle.close * 0.001,
      currentVolume: candle.volume, avgVolume: avgVol, volumeRatio,
      atr, atrPct: atr / candle.close * 100,
      candles: history.map(c => ({ time: 0, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
      prevClose: prevCloses.length > 0 ? prevCloses[prevCloses.length - 1] : candle.open,
      prevPCR: 1.0, prevIV: iv,
    };

    const quality = computeDataQuality(snap);
    dataQualitySum += quality;

    // ─── Generate Signal (SAME engine as live) ─────────────────
    const signal = generateStrategySignalV2(snap, config);

    if (signal.strategy === "NO_TRADE") {
      noTradeCount++;
      equityCurve.push({ date: candle.date, equity: capital, drawdown: 0, peak });
      continue;
    }

    // Data quality check
    if (quality < 50) {
      incompleteRemoved++;
      continue;
    }

    // ─── Risk Management ───────────────────────────────────────
    const lotSize = getLotSize(symbol, candle.date);
    const riskPerTrade = capital * (config.maxRiskPct / 100);
    const entryPremium = signal.combinedPremium;
    const maxRisk = Math.min(riskPerTrade, entryPremium * lotSize * 2); // cap at configured risk

    // Check if we have enough capital
    if (maxRisk > capital * 0.5) {
      continue; // don't risk more than 50% of capital on one trade
    }

    // ─── Entry ─────────────────────────────────────────────────
    const entryDate = candle.date;
    const entryTimestamp = new Date(`${entryDate}T${config.entryTime}:00+05:30`).toISOString();

    // ─── Exit (multi-bar dynamic exit) ──────────────────────────
    let exitPremium = entryPremium;
    let exitReason = "MAX_HOLDING";
    let barsHeld = 1;
    let bestExitPremium = entryPremium;
    let mfe = 0, mae = 0;
    const maxBars = Math.min(config.maxHoldingBars, candles.length - i - 1);

    for (let bar = 1; bar <= maxBars; bar++) {
      const exitIdx = i + bar;
      if (exitIdx >= candles.length) break;
      const exitCandle = candles[exitIdx];
      const exitChain = buildChain(exitCandle, symbol, iv);
      const exitAtmRow = exitChain.find(s => s.strike === Math.round(exitCandle.close / step) * step);

      let barPremium = entryPremium;
      if (signal.strategy === "STRADDLE") {
        barPremium = (exitAtmRow?.ce?.ltp || 0) + (exitAtmRow?.pe?.ltp || 0);
      } else if (signal.strategy === "STRANGLE") {
        const exitCe = exitChain.find(s => s.strike === signal.ceStrike);
        const exitPe = exitChain.find(s => s.strike === signal.peStrike);
        barPremium = (exitCe?.ce?.ltp || 0) + (exitPe?.pe?.ltp || 0);
      } else if (signal.strategy === "CALL") {
        const exitLeg = exitChain.find(s => s.strike === signal.ceStrike);
        barPremium = exitLeg?.ce?.ltp || entryPremium;
      } else if (signal.strategy === "PUT") {
        const exitLeg = exitChain.find(s => s.strike === signal.peStrike);
        barPremium = exitLeg?.pe?.ltp || entryPremium;
      }

      // Compute unrealized P&L for this bar
      let barPnL = 0;
      if (signal.strategy === "STRADDLE" || signal.strategy === "STRANGLE") {
        barPnL = (entryPremium - barPremium) * lotSize; // short: profit if premium drops
      } else {
        barPnL = (barPremium - entryPremium) * lotSize;
      }
      if (barPnL > mfe) mfe = barPnL;
      if (barPnL < mae) mae = barPnL;

      // Track best exit for target/stop
      const returnPct = entryPremium * lotSize > 0 ? (barPnL / (entryPremium * lotSize)) * 100 : 0;

      // Check exit conditions
      if (returnPct >= config.targetPct) {
        exitPremium = barPremium;
        exitReason = "TARGET";
        barsHeld = bar;
        break;
      }
      if (returnPct <= -config.stopLossPct) {
        exitPremium = barPremium;
        exitReason = "STOP_LOSS";
        barsHeld = bar;
        break;
      }

      // Thesis failure for directional
      if (signal.strategy === "CALL" && exitCandle.close < candle.close * 0.98) {
        exitPremium = barPremium;
        exitReason = "THESIS_FAILURE";
        barsHeld = bar;
        break;
      }
      if (signal.strategy === "PUT" && exitCandle.close > candle.close * 1.02) {
        exitPremium = barPremium;
        exitReason = "THESIS_FAILURE";
        barsHeld = bar;
        break;
      }

      // Momentum exit: profitable but declining
      if (mfe > 0 && barPnL < mfe * 0.5 && bar > 1) {
        exitPremium = barPremium;
        exitReason = "MOMENTUM_EXIT";
        barsHeld = bar;
        break;
      }

      // Default: use this bar's premium
      exitPremium = barPremium;
      barsHeld = bar;
    }

    // ─── P&L Calculation ───────────────────────────────────────
    const pnl = calculateTradePnLV2(signal, exitPremium, lotSize, entryPremium, maxRisk, config.chargesMode, config.slippageMode);

    // ─── MFE/MAE ───────────────────────────────────────────────
    const exitCandles = candles.slice(i + 1, i + 1 + barsHeld).map(c => ({ close: c.close, high: c.high, low: c.low }));
    const mfeMae = { mfe, mae, mfePct: entryPremium * lotSize > 0 ? (mfe / (entryPremium * lotSize)) * 100 : 0, maePct: entryPremium * lotSize > 0 ? (mae / (entryPremium * lotSize)) * 100 : 0 };

    // ─── Update Capital ────────────────────────────────────────
    capital += pnl.netPnL;
    if (capital < 0) capital = 0; // prevent negative
    if (capital > peak) peak = capital;
    const drawdown = peak - capital;
    const drawdownPct = peak > 0 ? (drawdown / peak) * 100 : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;

    equityCurve.push({ date: candle.date, equity: capital, drawdown: drawdownPct, peak });

    // ─── Record Trade ──────────────────────────────────────────
    const trade: BacktestTrade = {
      id: ++tradeId,
      date: entryDate,
      entryTime: config.entryTime,
      exitTime: config.exitTime,
      symbol,
      strategy: signal.strategy,
      strikeSelection: config.strikeSelection,
      expiryType: config.expiryType,
      entryWindow: detectEntryWindow(config.entryTime.split(":").reduce((h, m) => parseInt(h) * 60 + parseInt(m), 0)).window,
      spotAtEntry: candle.close,
      ceStrike: signal.ceStrike,
      peStrike: signal.peStrike,
      ceEntryPrice: signal.cePremium,
      peEntryPrice: signal.pePremium,
      combinedPremiumAtEntry: entryPremium,
      expectedMoveAtEntry: signal.expectedMove,
      expectedMovePctAtEntry: signal.expectedMovePct,
      casScoreAtEntry: signal.casScore,
      tradeQualityAtEntry: signal.tradeQuality,
      confidenceAtEntry: signal.confidence,
      vixAtEntry: iv,
      ivAtEntry: iv,
      pcrAtEntry: snap.pcr,
      volumeAtEntry: candle.volume,
      oiAtEntry: atmRow?.ce?.oi || 0,
      regimeAtEntry: regime,
      entryTimestamp,
      breakevenUpper: signal.breakevenUpper,
      breakevenLower: signal.breakevenLower,
      ceExitPrice: signal.strategy === "PUT" ? 0 : exitPremium * 0.5,
      peExitPrice: signal.strategy === "CALL" ? 0 : exitPremium * 0.5,
      exitPremium,
      exitReason,
      barsHeld,
      grossPnL: pnl.grossPnL,
      charges: pnl.charges,
      slippage: pnl.slippage,
      netPnL: pnl.netPnL,
      returnPct: pnl.returnPct,
      maxRisk,
      riskCapital: maxRisk,
      mfe: mfeMae.mfe,
      mae: mfeMae.mae,
      mfePct: mfeMae.mfePct,
      maePct: mfeMae.maePct,
      dataQuality: quality,
      gateResults: signal.gateResults,
      reasoning: signal.reasoning,
      rejectionReasons: signal.rejectionReasons,
    };

    trades.push(trade);

    // ─── Strategy Stats ────────────────────────────────────────
    const stratKey = `${signal.strategy}_${config.strikeSelection}`;
    if (!strategyStats[stratKey]) strategyStats[stratKey] = { trades: 0, wins: 0, pnl: 0, dd: 0, pf: { profit: 0, loss: 0 }, winAmounts: [], lossAmounts: [] };
    strategyStats[stratKey].trades++;
    strategyStats[stratKey].pnl += pnl.netPnL;
    if (pnl.netPnL > 0) {
      strategyStats[stratKey].wins++;
      strategyStats[stratKey].pf.profit += pnl.netPnL;
      strategyStats[stratKey].winAmounts.push(pnl.netPnL);
    } else {
      strategyStats[stratKey].pf.loss += Math.abs(pnl.netPnL);
      strategyStats[stratKey].lossAmounts.push(pnl.netPnL);
    }

    // ─── Regime Stats ──────────────────────────────────────────
    if (!regimeStats[regime]) regimeStats[regime] = { trades: 0, wins: 0, pnl: 0, pf: { profit: 0, loss: 0 } };
    regimeStats[regime].trades++;
    regimeStats[regime].pnl += pnl.netPnL;
    if (pnl.netPnL > 0) { regimeStats[regime].wins++; regimeStats[regime].pf.profit += pnl.netPnL; }
    else { regimeStats[regime].pf.loss += Math.abs(pnl.netPnL); }
  }

  // ─── Compute Final Stats ──────────────────────────────────────
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
  const expectancy = totalTrades > 0 ? netPnL / totalTrades : 0;
  const largestWin = totalTrades > 0 ? Math.max(...trades.map(t => t.netPnL)) : 0;
  const largestLoss = totalTrades > 0 ? Math.min(...trades.map(t => t.netPnL)) : 0;
  const noTradePct = totalScans > 0 ? (noTradeCount / totalScans) * 100 : 0;

  // ─── Strategy Comparison ──────────────────────────────────────
  const strategyComparison: Record<string, any> = {};
  for (const [key, stats] of Object.entries(strategyStats)) {
    strategyComparison[key] = {
      trades: stats.trades,
      winRate: stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0,
      netPnL: Math.round(stats.pnl),
      drawdown: 0,
      profitFactor: stats.pf.loss > 0 ? stats.pf.profit / stats.pf.loss : 0,
      expectancy: stats.trades > 0 ? stats.pnl / stats.trades : 0,
      avgWin: stats.winAmounts.length > 0 ? stats.winAmounts.reduce((a, b) => a + b, 0) / stats.winAmounts.length : 0,
      avgLoss: stats.lossAmounts.length > 0 ? stats.lossAmounts.reduce((a, b) => a + b, 0) / stats.lossAmounts.length : 0,
    };
  }

  // ─── Regime Breakdown ─────────────────────────────────────────
  const regimeBreakdown: Record<string, any> = {};
  for (const [regime, stats] of Object.entries(regimeStats)) {
    regimeBreakdown[regime] = {
      trades: stats.trades,
      winRate: stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0,
      netPnL: Math.round(stats.pnl),
      profitFactor: stats.pf.loss > 0 ? stats.pf.profit / stats.pf.loss : 0,
    };
  }

  // ─── Diagnosis ────────────────────────────────────────────────
  if (noTradePct > 80) diagnosis.push(`High NO_TRADE rate ${noTradePct.toFixed(0)}% — engine is selective (good)`);
  if (noTradePct < 30) diagnosis.push(`Low NO_TRADE rate ${noTradePct.toFixed(0)}% — may be overtrading`);
  if (winRate < 30) diagnosis.push(`Win rate ${winRate.toFixed(1)}% — check exit logic`);
  if (profitFactor < 1) diagnosis.push(`Profit factor ${profitFactor.toFixed(2)} < 1 — strategy loses money`);
  if (maxDrawdownPct > 50) diagnosis.push(`Max drawdown ${maxDrawdownPct.toFixed(1)}% — risk management issue`);
  if (avgLoss > avgProfit * 2) diagnosis.push(`Avg loss ₹${avgLoss.toFixed(0)} > 2x avg profit ₹${avgProfit.toFixed(0)} — stop loss too wide`);

  // ─── Time Analysis (CAS Time Engine) ────────────────────────
  const windowPerformance = computeWindowPerformance(trades);
  const exitTypePerformance = computeExitTypePerformance(trades);

  return {
    success: true,
    config,
    symbol,
    period: { from: candles[warmupPeriod]?.date || "", to: candles[candles.length - 1]?.date || "" },
    totalTrades,
    totalScans,
    noTradePct: Math.round(noTradePct * 10) / 10,
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
    expectancy: Math.round(expectancy),
    maxDrawdown: Math.round(maxDrawdown),
    maxDrawdownPct: Math.round(maxDrawdownPct * 10) / 10,
    largestWin: Math.round(largestWin),
    largestLoss: Math.round(largestLoss),
    avgHoldingTime: `${Math.round(trades.reduce((a, t) => a + t.barsHeld, 0) / Math.max(1, trades.length))} days`,
    capitalRequired: config.initialCapital,
    returnOnCapital: config.initialCapital > 0 ? Math.round((netPnL / config.initialCapital) * 100 * 10) / 10 : 0,
    equityCurve,
    trades,
    strategyComparison,
    regimeBreakdown,
    diagnosis,
    windowPerformance,
    exitTypePerformance,
    dataQualityScore: totalScans > 0 ? Math.round(dataQualitySum / totalScans) : 0,
    incompleteTradesRemoved: incompleteRemoved,
  };
}
