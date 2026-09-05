// ─── Real Trade Backtest Engine ───────────────────────────────────────
// Takes every recorded trade from the audit sidecar, fetches real historical
// candles for the trade's symbol+period, and replays price action to compute
// what actually happened (MFE, MAE, TP/SL hits, actual P&L).
//
// No Math.random() — deterministic replay against real market data.

import { getTrades, TradeRecord, TradeFilters } from '@/lib/trade-audit-client';

// ─── Direct Yahoo Finance candle fetch (bypasses Breeze timeout) ─────
function getYahooSymbol(symbol: string): string {
  const map: Record<string, string> = {
    NIFTY: '^NSEI', BANKNIFTY: '^NSEBANK', FINNIFTY: '^CNXFIN',
    MIDCPNIFTY: '^NSEMDCP50', SENSEX: '^BSESN', BANKEX: '^BSESN',
    // MCX Commodity → Yahoo US futures equivalents
    CRUDEOIL: 'CL=F', CRUDEOILM: 'CL=F',
    NATURALGAS: 'NG=F', NATGASMINI: 'NG=F',
    GOLD: 'GC=F', GOLDM: 'GC=F', GOLDGUINEA: 'GC=F',
    SILVER: 'SI=F', SILVERM: 'SI=F', SILVERMIC: 'SI=F',
  };
  return map[symbol.toUpperCase()] || `${symbol.toUpperCase()}.NS`;
}

async function fetchCandlesDirect(
  symbol: string,
  interval: string = '1d',
  limit: number = 1000
): Promise<Candle[]> {
  const yahooSymbol = getYahooSymbol(symbol);
  const range = interval === '5m' ? '5d' : interval === '15m' ? '1mo' : interval === '1h' ? '3mo' : '1y';
  const yahooInterval = interval === '1h' ? '60m' : interval;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=${yahooInterval}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return [];

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]) return [];

    const ts = result.timestamp;
    const q = result.indicators.quote[0];
    const candles: Candle[] = [];

    for (let i = 0; i < ts.length; i++) {
      const close = q.close?.[i];
      if (close == null) continue;
      candles.push({
        time: ts[i],
        open: q.open?.[i] ?? close,
        high: q.high?.[i] ?? close,
        low: q.low?.[i] ?? close,
        close,
        volume: q.volume?.[i] || 0,
      });
    }
    return candles.slice(-limit);
  } catch {
    return [];
  }
}

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Types ───────────────────────────────────────────────────────────────

export interface BacktestedTrade {
  id: string;
  strategyId: string;
  symbol: string;
  instrumentType: string;
  entryTime: string;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number | null;
  tp3: number | null;
  trendDirection: string;
  signalConfidence: number;

  // Backtest results (from real candles)
  actualExitPrice: number | null;
  actualExitTime: string | null;
  actualExitReason: string | null;
  actualMfe: number;
  actualMae: number;
  actualTp1Hit: boolean;
  actualTp2Hit: boolean;
  actualTp3Hit: boolean;
  actualSlHit: boolean;
  actualPnl: number | null;
  actualRMultiple: number | null;
  holdingCandles: number;

  // Comparison with recorded
  recordedPnl: number | null;
  recordedStatus: string;
  pnlDifference: number | null;

  // Quality
  dataQuality: 'REAL' | 'PARTIAL' | 'NO_DATA';
  candleCount: number;
}

export interface BacktestSummary {
  totalTrades: number;
  backtestableTrades: number;
  noDataTrades: number;

  // Actual performance (from candle replay)
  actualWinRate: number;
  actualNetPnl: number;
  actualAvgRMultiple: number;
  actualProfitFactor: number;
  actualMaxDrawdown: number;
  actualAvgWin: number;
  actualAvgLoss: number;

  // Comparison with recorded
  avgPnlDifference: number;
  correlationWithRecorded: number;

  // By strategy
  byStrategy: Record<string, {
    trades: number;
    winRate: number;
    netPnl: number;
    avgR: number;
    profitFactor: number;
  }>;

  // By symbol
  bySymbol: Record<string, {
    trades: number;
    winRate: number;
    netPnl: number;
  }>;

  // Equity curve
  equityCurve: Array<{ tradeIndex: number; equity: number; symbol: string; pnl: number }>;

  // Distribution
  pnlDistribution: Array<{ range: string; count: number }>;
  rDistribution: Array<{ range: string; count: number }>;
}

// ─── Main Backtest Function ──────────────────────────────────────────────

export async function backtestAllTrades(
  filters?: TradeFilters & { maxTrades?: number }
): Promise<{ trades: BacktestedTrade[]; summary: BacktestSummary }> {
  // 1. Fetch trades from audit sidecar
  const maxTrades = filters?.maxTrades || 100;
  let allTrades: TradeRecord[] = [];

  const result = await getTrades({
    ...filters,
    status: 'closed',
    page: 1,
    pageSize: maxTrades,
  });
  allTrades = result.items.slice(0, maxTrades);

  if (allTrades.length === 0) {
    return {
      trades: [],
      summary: emptySummary(),
    };
  }

  // 2. Group trades by symbol to batch candle fetches
  const tradesBySymbol = new Map<string, TradeRecord[]>();
  for (const trade of allTrades) {
    const key = trade.symbol;
    if (!tradesBySymbol.has(key)) tradesBySymbol.set(key, []);
    tradesBySymbol.get(key)!.push(trade);
  }

  // 3. Fetch candles per symbol (batch by unique symbols)
  const candleCache = new Map<string, Candle[]>();
  const symbolEntries = Array.from(tradesBySymbol.entries());

  // Fetch in parallel, 5 at a time to avoid rate limits
  for (let i = 0; i < symbolEntries.length; i += 5) {
    const batch = symbolEntries.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(async ([symbol, trades]) => {
        // Find earliest entry and latest exit for date range
        const allTimes = trades.flatMap(t => {
          const entryMs = new Date(t.createdAtIst || t.entryTime).getTime();
          const exitMs = t.exitTime ? new Date(t.exitTime).getTime() : Date.now();
          return [entryMs, exitMs];
        });
        const earliest = Math.min(...allTimes);
        const latest = Math.max(...allTimes);

        // Fetch daily candles for the full range + buffer
        const startDate = new Date(earliest - 7 * 24 * 60 * 60 * 1000); // 7 day buffer
        const endDate = new Date(latest + 1 * 24 * 60 * 60 * 1000);

        // Use intraday candles for recent trades, daily for older ones
        const holdingDays = (latest - earliest) / (24 * 60 * 60 * 1000);
        const daysAgo = (Date.now() - earliest) / (24 * 60 * 60 * 1000);
        let interval = '1d';
        if (daysAgo <= 5 && holdingDays < 1) interval = '5m';
        else if (daysAgo <= 30 && holdingDays < 7) interval = '15m';
        else if (daysAgo <= 90) interval = '1h';

        const candles = await fetchCandlesDirect(symbol, interval, 1000);
        return { symbol, candles };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        candleCache.set(r.value.symbol, r.value.candles);
      }
    }
  }

  // 4. Backtest each trade
  const backtestedTrades: BacktestedTrade[] = [];

  for (const trade of allTrades) {
    const candles = candleCache.get(trade.symbol) || [];
    const bt = backtestSingleTrade(trade, candles);
    backtestedTrades.push(bt);
  }

  // 5. Compute summary
  const summary = computeSummary(backtestedTrades);

  return { trades: backtestedTrades, summary };
}

// ─── Backtest Single Trade ───────────────────────────────────────────────

function backtestSingleTrade(trade: TradeRecord, candles: Candle[]): BacktestedTrade {
  const entryTime = new Date(trade.createdAtIst || trade.entryTime).getTime();
  const exitTime = trade.exitTime ? new Date(trade.exitTime).getTime() : null;

  // Filter candles to trade window (entry to exit + buffer)
  const windowStart = entryTime;
  const windowEnd = exitTime || Date.now();
  const tradeCandles = candles.filter(c => {
    const t = c.time * 1000; // convert seconds to ms
    return t >= windowStart - 60_000 && t <= windowEnd + 60_000;
  });

  if (tradeCandles.length === 0) {
    return {
      id: trade.id,
      strategyId: trade.strategyId,
      symbol: trade.symbol,
      instrumentType: trade.instrumentType,
      entryTime: trade.createdAtIst || trade.entryTime,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      tp1: trade.tp1,
      tp2: trade.tp2,
      tp3: trade.tp3,
      trendDirection: trade.trendDirection,
      signalConfidence: trade.signalConfidence,
      actualExitPrice: trade.exitPrice,
      actualExitTime: trade.exitTime,
      actualExitReason: trade.exitReason,
      actualMfe: trade.mfe || 0,
      actualMae: trade.mae || 0,
      actualTp1Hit: trade.tp1Hit,
      actualTp2Hit: trade.tp2Hit,
      actualTp3Hit: trade.tp3Hit,
      actualSlHit: trade.slHit,
      actualPnl: trade.netPnl,
      actualRMultiple: trade.rMultiple,
      holdingCandles: 0,
      recordedPnl: trade.netPnl,
      recordedStatus: trade.status,
      pnlDifference: 0,
      dataQuality: 'NO_DATA',
      candleCount: 0,
    };
  }

  // Simulate trade replay
  const isBuy = trade.trendDirection?.toUpperCase().includes('BULL') ||
    trade.trendDirection?.toUpperCase().includes('UP') ||
    (trade.optionType === 'CE') ||
    (!trade.optionType && trade.side !== 'SELL');

  let maxFavorable = 0;
  let maxAdverse = 0;
  let tp1Hit = false;
  let tp2Hit = false;
  let tp3Hit = false;
  let slHit = false;
  let exitPrice: number | null = null;
  let exitTimeStr: string | null = null;
  let exitReason: string | null = null;
  let holdingCandles = 0;

  const risk = Math.abs(trade.entryPrice - trade.stopLoss);
  if (risk === 0) {
    // Can't backtest without valid SL
    return {
      id: trade.id,
      strategyId: trade.strategyId,
      symbol: trade.symbol,
      instrumentType: trade.instrumentType,
      entryTime: trade.createdAtIst || trade.entryTime,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      tp1: trade.tp1,
      tp2: trade.tp2,
      tp3: trade.tp3,
      trendDirection: trade.trendDirection,
      signalConfidence: trade.signalConfidence,
      actualExitPrice: trade.exitPrice,
      actualExitTime: trade.exitTime,
      actualExitReason: 'INVALID_SL',
      actualMfe: 0,
      actualMae: 0,
      actualTp1Hit: false,
      actualTp2Hit: false,
      actualTp3Hit: false,
      actualSlHit: false,
      actualPnl: null,
      actualRMultiple: null,
      holdingCandles: tradeCandles.length,
      recordedPnl: trade.netPnl,
      recordedStatus: trade.status,
      pnlDifference: 0,
      dataQuality: 'PARTIAL',
      candleCount: tradeCandles.length,
    };
  }

  for (const candle of tradeCandles) {
    holdingCandles++;

    const high = candle.high;
    const low = candle.low;

    if (isBuy) {
      // Track MFE/MAE from entry price
      const favorableFromEntry = high - trade.entryPrice;
      const adverseFromEntry = trade.entryPrice - low;
      maxFavorable = Math.max(maxFavorable, favorableFromEntry);
      maxAdverse = Math.max(maxAdverse, adverseFromEntry);

      // Check SL hit (low touches SL)
      if (low <= trade.stopLoss && !slHit && !exitPrice) {
        slHit = true;
        exitPrice = trade.stopLoss;
        exitTimeStr = new Date(candle.time * 1000).toISOString();
        exitReason = 'SL_HIT';
      }

      // Check TP hits (high touches TP levels) — only if not already exited
      if (!exitPrice) {
        if (trade.tp1 && high >= trade.tp1) tp1Hit = true;
        if (trade.tp2 && high >= trade.tp2) tp2Hit = true;
        if (trade.tp3 && high >= trade.tp3) {
          tp3Hit = true;
          exitPrice = trade.tp3;
          exitTimeStr = new Date(candle.time * 1000).toISOString();
          exitReason = 'TP3_HIT';
        } else if (tp2Hit && trade.tp2) {
          exitPrice = trade.tp2;
          exitTimeStr = new Date(candle.time * 1000).toISOString();
          exitReason = 'TP2_HIT';
        } else if (tp1Hit && trade.tp1 && !trade.tp2) {
          exitPrice = trade.tp1;
          exitTimeStr = new Date(candle.time * 1000).toISOString();
          exitReason = 'TP1_HIT';
        }
      }
    } else {
      // SELL direction
      const favorableFromEntry = trade.entryPrice - low;
      const adverseFromEntry = high - trade.entryPrice;
      maxFavorable = Math.max(maxFavorable, favorableFromEntry);
      maxAdverse = Math.max(maxAdverse, adverseFromEntry);

      // Check SL hit (high touches SL)
      if (high >= trade.stopLoss && !slHit && !exitPrice) {
        slHit = true;
        exitPrice = trade.stopLoss;
        exitTimeStr = new Date(candle.time * 1000).toISOString();
        exitReason = 'SL_HIT';
      }

      // Check TP hits
      if (!exitPrice) {
        if (trade.tp1 && low <= trade.tp1) tp1Hit = true;
        if (trade.tp2 && low <= trade.tp2) tp2Hit = true;
        if (trade.tp3 && low <= trade.tp3) {
          tp3Hit = true;
          exitPrice = trade.tp3;
          exitTimeStr = new Date(candle.time * 1000).toISOString();
          exitReason = 'TP3_HIT';
        } else if (tp2Hit && trade.tp2) {
          exitPrice = trade.tp2;
          exitTimeStr = new Date(candle.time * 1000).toISOString();
          exitReason = 'TP2_HIT';
        } else if (tp1Hit && trade.tp1 && !trade.tp2) {
          exitPrice = trade.tp1;
          exitTimeStr = new Date(candle.time * 1000).toISOString();
          exitReason = 'TP1_HIT';
        }
      }
    }

    // If exited, stop processing
    if (exitPrice) break;
  }

  // If no exit found, use last candle close as exit
  if (!exitPrice && tradeCandles.length > 0) {
    const lastCandle = tradeCandles[tradeCandles.length - 1];
    exitPrice = isBuy ? lastCandle.close : lastCandle.close;
    exitTimeStr = new Date(lastCandle.time * 1000).toISOString();
    exitReason = 'EXPIRED_EOD';
  }

  // Calculate actual P&L
  let actualPnl: number | null = null;
  let actualR: number | null = null;
  if (exitPrice !== null) {
    actualPnl = isBuy
      ? (exitPrice - trade.entryPrice)
      : (trade.entryPrice - exitPrice);
    actualR = risk > 0 ? actualPnl / risk : 0;
  }

  // Compare with recorded
  let pnlDifference: number | null = null;
  if (actualPnl !== null && trade.netPnl !== null) {
    pnlDifference = Math.abs(actualPnl - trade.netPnl);
  }

  return {
    id: trade.id,
    strategyId: trade.strategyId,
    symbol: trade.symbol,
    instrumentType: trade.instrumentType,
    entryTime: trade.createdAtIst || trade.entryTime,
    entryPrice: trade.entryPrice,
    stopLoss: trade.stopLoss,
    tp1: trade.tp1,
    tp2: trade.tp2,
    tp3: trade.tp3,
    trendDirection: trade.trendDirection,
    signalConfidence: trade.signalConfidence,
    actualExitPrice: exitPrice,
    actualExitTime: exitTimeStr,
    actualExitReason: exitReason,
    actualMfe: maxFavorable,
    actualMae: maxAdverse,
    actualTp1Hit: tp1Hit,
    actualTp2Hit: tp2Hit,
    actualTp3Hit: tp3Hit,
    actualSlHit: slHit,
    actualPnl,
    actualRMultiple: actualR,
    holdingCandles,
    recordedPnl: trade.netPnl,
    recordedStatus: trade.status,
    pnlDifference,
    dataQuality: 'REAL',
    candleCount: tradeCandles.length,
  };
}

// ─── Summary Computation ─────────────────────────────────────────────────

function computeSummary(trades: BacktestedTrade[]): BacktestSummary {
  const withData = trades.filter(t => t.dataQuality === 'REAL' && t.actualPnl !== null);
  const noData = trades.filter(t => t.dataQuality === 'NO_DATA');

  const wins = withData.filter(t => t.actualPnl! > 0);
  const losses = withData.filter(t => t.actualPnl! <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.actualPnl!, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.actualPnl!, 0));

  // Equity curve
  let equity = 100000; // starting capital
  const equityCurve: Array<{ tradeIndex: number; equity: number; symbol: string; pnl: number }> = [];
  let maxEquity = equity;
  let maxDrawdown = 0;

  for (let i = 0; i < withData.length; i++) {
    equity += withData[i].actualPnl!;
    equityCurve.push({ tradeIndex: i + 1, equity, symbol: withData[i].symbol, pnl: withData[i].actualPnl! });
    maxEquity = Math.max(maxEquity, equity);
    const dd = maxEquity - equity;
    maxDrawdown = Math.max(maxDrawdown, dd);
  }

  // By strategy
  const byStrategy: Record<string, any> = {};
  for (const t of withData) {
    if (!byStrategy[t.strategyId]) {
      byStrategy[t.strategyId] = { trades: 0, wins: 0, netPnl: 0, rValues: [] };
    }
    byStrategy[t.strategyId].trades++;
    if (t.actualPnl! > 0) byStrategy[t.strategyId].wins++;
    byStrategy[t.strategyId].netPnl += t.actualPnl!;
    if (t.actualRMultiple !== null) byStrategy[t.strategyId].rValues.push(t.actualRMultiple);
  }
  for (const [k, v] of Object.entries(byStrategy)) {
    const strat = v as any;
    strat.winRate = strat.trades > 0 ? (strat.wins / strat.trades) * 100 : 0;
    strat.avgR = strat.rValues.length > 0
      ? strat.rValues.reduce((a: number, b: number) => a + b, 0) / strat.rValues.length
      : 0;
    const stratWins = withData.filter(t => t.strategyId === k && t.actualPnl! > 0);
    const stratLosses = withData.filter(t => t.strategyId === k && t.actualPnl! <= 0);
    const stratGrossProfit = stratWins.reduce((s, t) => s + t.actualPnl!, 0);
    const stratGrossLoss = Math.abs(stratLosses.reduce((s, t) => s + t.actualPnl!, 0));
    strat.profitFactor = stratGrossLoss > 0 ? stratGrossProfit / stratGrossLoss : stratGrossProfit > 0 ? Infinity : 0;
    delete strat.rValues;
  }

  // By symbol
  const bySymbol: Record<string, any> = {};
  for (const t of withData) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, wins: 0, netPnl: 0 };
    bySymbol[t.symbol].trades++;
    if (t.actualPnl! > 0) bySymbol[t.symbol].wins++;
    bySymbol[t.symbol].netPnl += t.actualPnl!;
  }
  for (const v of Object.values(bySymbol)) {
    v.winRate = v.trades > 0 ? (v.wins / v.trades) * 100 : 0;
  }

  // P&L distribution
  const pnlRanges = ['-5000+', '-2000 to -5000', '-500 to -2000', '-500 to 0', '0 to 500', '500 to 2000', '2000 to 5000', '5000+'];
  const pnlDistribution = pnlRanges.map(range => ({ range, count: 0 }));
  for (const t of withData) {
    const pnl = t.actualPnl!;
    if (pnl <= -5000) pnlDistribution[0].count++;
    else if (pnl <= -2000) pnlDistribution[1].count++;
    else if (pnl <= -500) pnlDistribution[2].count++;
    else if (pnl < 0) pnlDistribution[3].count++;
    else if (pnl <= 500) pnlDistribution[4].count++;
    else if (pnl <= 2000) pnlDistribution[5].count++;
    else if (pnl <= 5000) pnlDistribution[6].count++;
    else pnlDistribution[7].count++;
  }

  // R-multiple distribution
  const rRanges = ['<-2R', '-2R to -1R', '-1R to 0', '0 to 1R', '1R to 2R', '2R to 3R', '>3R'];
  const rDistribution = rRanges.map(range => ({ range, count: 0 }));
  for (const t of withData) {
    const r = t.actualRMultiple || 0;
    if (r < -2) rDistribution[0].count++;
    else if (r < -1) rDistribution[1].count++;
    else if (r < 0) rDistribution[2].count++;
    else if (r < 1) rDistribution[3].count++;
    else if (r < 2) rDistribution[4].count++;
    else if (r < 3) rDistribution[5].count++;
    else rDistribution[6].count++;
  }

  // Correlation with recorded trades
  const bothPnl = withData.filter(t => t.recordedPnl !== null);
  let correlation = 0;
  if (bothPnl.length > 2) {
    const actuals = bothPnl.map(t => t.actualPnl!);
    const recorded = bothPnl.map(t => t.recordedPnl!);
    const meanA = actuals.reduce((a, b) => a + b, 0) / actuals.length;
    const meanR = recorded.reduce((a, b) => a + b, 0) / recorded.length;
    let num = 0, denA = 0, denR = 0;
    for (let i = 0; i < actuals.length; i++) {
      const da = actuals[i] - meanA;
      const dr = recorded[i] - meanR;
      num += da * dr;
      denA += da * da;
      denR += dr * dr;
    }
    correlation = denA > 0 && denR > 0 ? num / Math.sqrt(denA * denR) : 0;
  }

  const avgRValues = withData.filter(t => t.actualRMultiple !== null).map(t => t.actualRMultiple!);

  return {
    totalTrades: trades.length,
    backtestableTrades: withData.length,
    noDataTrades: noData.length,
    actualWinRate: withData.length > 0 ? (wins.length / withData.length) * 100 : 0,
    actualNetPnl: withData.reduce((s, t) => s + (t.actualPnl || 0), 0),
    actualAvgRMultiple: avgRValues.length > 0 ? avgRValues.reduce((a, b) => a + b, 0) / avgRValues.length : 0,
    actualProfitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    actualMaxDrawdown: maxDrawdown,
    actualAvgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    actualAvgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    avgPnlDifference: withData.length > 0
      ? withData.filter(t => t.pnlDifference !== null).reduce((s, t) => s + t.pnlDifference!, 0) /
        Math.max(1, withData.filter(t => t.pnlDifference !== null).length)
      : 0,
    correlationWithRecorded: correlation,
    byStrategy,
    bySymbol,
    equityCurve,
    pnlDistribution,
    rDistribution,
  };
}

function emptySummary(): BacktestSummary {
  return {
    totalTrades: 0,
    backtestableTrades: 0,
    noDataTrades: 0,
    actualWinRate: 0,
    actualNetPnl: 0,
    actualAvgRMultiple: 0,
    actualProfitFactor: 0,
    actualMaxDrawdown: 0,
    actualAvgWin: 0,
    actualAvgLoss: 0,
    avgPnlDifference: 0,
    correlationWithRecorded: 0,
    byStrategy: {},
    bySymbol: {},
    equityCurve: [],
    pnlDistribution: [],
    rDistribution: [],
  };
}
