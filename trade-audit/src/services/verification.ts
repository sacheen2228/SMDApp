import { AggregateStats, SessionBreakdown, StrategyBreakdown, SymbolBreakdown, TradeRecord, TradeVerification } from "../types";
import { istDatePart, nowIst } from "../utils/ist";

/**
 * Per-trade verification heuristics, computed the moment a trade closes.
 *
 * These run on the data this engine actually has (entry/SL/TP levels, MFE,
 * MAE, which targets were hit, exit reason). Two items from the original
 * spec — "did price reverse after exit" and "did another strategy have a
 * better signal" — need a continuous post-exit price feed and cross-strategy
 * correlation respectively, neither of which exists yet in this pass. They're
 * left as extension points (see README) rather than faked.
 */
export function verifyClosedTrade(
  trade: Pick<TradeRecord, "entryPrice" | "stopLoss" | "tp1" | "tp2" | "tp3" | "mfe" | "mae" | "tp1Hit" | "tp2Hit" | "tp3Hit"> & {
    exitReason: string;
    grossPnl: number;
    netPnl: number;
    rMultiple: number;
  }
): TradeVerification {
  const notes: string[] = [];
  const win = trade.netPnl > 0;

  const riskDistance = Math.abs(trade.entryPrice - trade.stopLoss);
  const mfeRatio = riskDistance > 0 ? (trade.mfe ?? 0) / riskDistance : 0;
  const maeRatio = riskDistance > 0 ? (trade.mae ?? 0) / riskDistance : 0;

  // Entry quality
  let entryQuality: TradeVerification["entryQuality"] = "unknown";
  if (maeRatio < 0.25) {
    entryQuality = "good";
    notes.push(`Adverse excursion stayed under 25% of the stop distance (${(maeRatio * 100).toFixed(0)}%).`);
  } else if (maeRatio >= 0.25 && win) {
    entryQuality = "late";
    notes.push(`Trade won but had to absorb ${(maeRatio * 100).toFixed(0)}% of the stop distance in heat first — entry may have chased the move.`);
  } else if (!win && mfeRatio < 0.25) {
    entryQuality = "early";
    notes.push(`Trade lost with minimal favourable move (MFE only ${(mfeRatio * 100).toFixed(0)}% of risk) — signal may have fired before real confirmation.`);
  }

  // Stop-loss assessment
  let slAssessment: TradeVerification["slAssessment"] = "unknown";
  if (win && maeRatio < 0.3) {
    slAssessment = "too_wide";
    notes.push("Price never came close to the stop — a tighter stop would likely have still let this trade play out.");
  } else if (trade.exitReason === "stop_loss") {
    slAssessment = "appropriate";
  }

  // Target assessment
  let tpAssessment: TradeVerification["tpAssessment"] = "unknown";
  if (trade.tp3Hit) {
    tpAssessment = "appropriate";
  } else if (win && trade.tp1Hit && !trade.tp2Hit) {
    const tp1Distance = Math.abs(trade.tp1 - trade.entryPrice);
    const mfeDistance = trade.mfe ?? 0;
    if (tp1Distance > 0 && mfeDistance > tp1Distance * 1.3) {
      tpAssessment = "too_conservative";
      notes.push("Price moved well beyond TP1 after exit-eligible levels were hit — target sizing may have been conservative.");
    } else {
      tpAssessment = "appropriate";
    }
  } else if (!trade.tp1Hit) {
    tpAssessment = "unreached";
  } else {
    tpAssessment = "appropriate";
  }

  return { win, entryQuality, slAssessment, tpAssessment, notes };
}

function safeDiv(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

export function computeAggregateStats(trades: TradeRecord[]): AggregateStats {
  const today = istDatePart(nowIst());
  const closed = trades.filter((t) => t.status === "closed");
  const open = trades.filter((t) => t.status === "open");

  const wins = closed.filter((t) => (t.netPnl ?? 0) > 0);
  const losses = closed.filter((t) => (t.netPnl ?? 0) <= 0);

  const grossProfit = wins.reduce((sum, t) => sum + (t.netPnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + (t.netPnl ?? 0), 0));
  const netPnl = grossProfit - grossLoss;

  const avgR = closed.length ? closed.reduce((sum, t) => sum + (t.rMultiple ?? 0), 0) / closed.length : 0;
  const expectancy = closed.length ? netPnl / closed.length : 0;
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(3)) : null;

  // Equity curve / max drawdown, walked in chronological (exit) order.
  const chronological = [...closed].sort(
    (a, b) => Date.parse(a.exitTime ?? a.createdAtIst) - Date.parse(b.exitTime ?? b.createdAtIst)
  );
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let maxDrawdownPct: number | null = null;
  for (const t of chronological) {
    equity += t.netPnl ?? 0;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPct = peak !== 0 ? Number(((drawdown / peak) * 100).toFixed(2)) : null;
    }
  }

  const byStrategy = groupByStrategy(closed);
  const bySymbol = groupBySymbol(closed);
  const byMarketSession = groupBySession(closed);

  const sortedByPnl = [...byStrategy].sort((a, b) => b.netPnl - a.netPnl);

  return {
    totalTrades: trades.length,
    openTrades: open.length,
    closedTrades: closed.length,
    todaysTrades: trades.filter((t) => istDatePart(t.createdAtIst) === today).length,
    wins: wins.length,
    losses: losses.length,
    winRate: Number(winRate.toFixed(2)),
    avgR: Number(avgR.toFixed(3)),
    expectancy: Number(expectancy.toFixed(2)),
    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    profitFactor,
    netPnl: Number(netPnl.toFixed(2)),
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    maxDrawdownPct,
    bestStrategy: sortedByPnl.length ? { strategyId: sortedByPnl[0].strategyId, netPnl: sortedByPnl[0].netPnl } : null,
    worstStrategy: sortedByPnl.length
      ? { strategyId: sortedByPnl[sortedByPnl.length - 1].strategyId, netPnl: sortedByPnl[sortedByPnl.length - 1].netPnl }
      : null,
    byStrategy,
    bySymbol,
    byMarketSession,
  };
}

function groupByStrategy(closed: TradeRecord[]): StrategyBreakdown[] {
  const map = new Map<string, TradeRecord[]>();
  for (const t of closed) {
    const arr = map.get(t.strategyId) ?? [];
    arr.push(t);
    map.set(t.strategyId, arr);
  }
  return Array.from(map.entries()).map(([strategyId, list]) => {
    const wins = list.filter((t) => (t.netPnl ?? 0) > 0);
    const losses = list.filter((t) => (t.netPnl ?? 0) <= 0);
    const grossProfit = wins.reduce((s, t) => s + (t.netPnl ?? 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.netPnl ?? 0), 0));
    return {
      strategyId,
      trades: list.length,
      wins: wins.length,
      losses: losses.length,
      winRate: Number(safeDiv(wins.length, list.length).toFixed(4)) * 100,
      avgR: Number((list.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / list.length).toFixed(3)),
      netPnl: Number((grossProfit - grossLoss).toFixed(2)),
      profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(3)) : null,
    };
  });
}

function groupBySymbol(closed: TradeRecord[]): SymbolBreakdown[] {
  const map = new Map<string, TradeRecord[]>();
  for (const t of closed) {
    const arr = map.get(t.symbol) ?? [];
    arr.push(t);
    map.set(t.symbol, arr);
  }
  return Array.from(map.entries()).map(([symbol, list]) => {
    const wins = list.filter((t) => (t.netPnl ?? 0) > 0).length;
    return {
      symbol,
      trades: list.length,
      winRate: Number(safeDiv(wins, list.length).toFixed(4)) * 100,
      netPnl: Number(list.reduce((s, t) => s + (t.netPnl ?? 0), 0).toFixed(2)),
    };
  });
}

function groupBySession(closed: TradeRecord[]): SessionBreakdown[] {
  const map = new Map<string, TradeRecord[]>();
  for (const t of closed) {
    const arr = map.get(t.marketSession) ?? [];
    arr.push(t);
    map.set(t.marketSession, arr);
  }
  return Array.from(map.entries()).map(([marketSession, list]) => {
    const wins = list.filter((t) => (t.netPnl ?? 0) > 0).length;
    return {
      marketSession,
      trades: list.length,
      winRate: Number(safeDiv(wins, list.length).toFixed(4)) * 100,
      netPnl: Number(list.reduce((s, t) => s + (t.netPnl ?? 0), 0).toFixed(2)),
    };
  });
}
