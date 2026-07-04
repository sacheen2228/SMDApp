// ═══════════════════════════════════════════════════════════════════
// ORCA Backtest Panel — Historical performance of ORCA AI signals
// Shows: Win rate, P&L, equity curve, trade list, signal accuracy
// ═══════════════════════════════════════════════════════════════════

"use client";

import { useEffect, useState, useCallback } from "react";
import type { OrcaBacktestResult } from "@/lib/orca-backtest";
import { getSymbolConfig } from "@/lib/symbol-config";

interface OrcaBacktestProps {
  symbol: string;
}

export function OrcaBacktestPanel({ symbol }: OrcaBacktestProps) {
  const [result, setResult] = useState<OrcaBacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [capital, setCapital] = useState(1000000);

  const runBacktest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/orca-backtest?symbol=${symbol}&days=${days}&capital=${capital}`
      );
      const json = await res.json();
      if (json.success && json.result) {
        setResult(json.result);
      } else {
        setError(json.error || "Backtest failed");
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [symbol, days, capital]);

  useEffect(() => {
    runBacktest();
  }, [runBacktest]);

  const config = getSymbolConfig(symbol);

  if (loading && !result) {
    return (
      <div className="flex items-center justify-center h-64 text-xs text-muted-foreground">
        <div className="text-center">
          <div className="animate-pulse text-lg mb-2">Running Backtest</div>
          <div>Analyzing {days} days of ORCA signals...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-destructive text-xs">
        <div className="font-bold mb-1">Backtest Error</div>
        <div>{error}</div>
        <button onClick={runBacktest} className="mt-2 text-primary underline">
          Retry
        </button>
      </div>
    );
  }

  if (!result) return null;

  const perf = result.performance;
  const trades = result.dailyResults.filter((d) => d.trade).map((d) => d.trade!);

  return (
    <div className="space-y-3 text-xs">
      {/* ═══ HEADER ═══ */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="font-mono font-bold text-sm text-primary">
            ORCA BACKTEST
          </div>
          <span className="text-muted-foreground">
            {result.startDate} → {result.endDate}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value))}
            className="h-6 text-[10px] bg-muted border rounded px-1"
          >
            <option value={10}>10 Days</option>
            <option value={20}>20 Days</option>
            <option value={30}>30 Days</option>
            <option value={60}>60 Days</option>
          </select>
          <button
            onClick={runBacktest}
            className="h-6 text-[10px] bg-primary text-primary-foreground px-2 rounded"
            disabled={loading}
          >
            {loading ? "Running..." : "Run"}
          </button>
        </div>
      </div>

      {/* ═══ PERFORMANCE SUMMARY ═══ */}
      <div className="grid grid-cols-4 gap-2">
        <div className="p-2 bg-secondary/50 rounded">
          <div className="text-[10px] text-muted-foreground">Total Trades</div>
          <div className="font-bold text-lg">{perf.totalTrades}</div>
          <div className="text-[10px] text-muted-foreground">
            {perf.buyCallSignals} CALL / {perf.buyPutSignals} PUT /{" "}
            {perf.waitSignals} WAIT
          </div>
        </div>
        <div className="p-2 bg-secondary/50 rounded">
          <div className="text-[10px] text-muted-foreground">Win Rate</div>
          <div
            className={`font-bold text-lg ${
              perf.winRate >= 60
                ? "text-emerald-400"
                : perf.winRate >= 50
                ? "text-yellow-400"
                : "text-red-400"
            }`}
          >
            {perf.winRate}%
          </div>
          <div className="text-[10px] text-muted-foreground">
            {perf.wins}W / {perf.losses}L / {perf.expired}E
          </div>
        </div>
        <div className="p-2 bg-secondary/50 rounded">
          <div className="text-[10px] text-muted-foreground">Total P&L</div>
          <div
            className={`font-bold text-lg ${
              perf.totalPnL >= 0 ? "text-emerald-400" : "text-red-400"
            }`}
          >
            {perf.totalPnL >= 0 ? "+" : ""}₹
            {perf.totalPnL.toLocaleString("en-IN")}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Avg: ₹{perf.avgPnLPerTrade}/trade
          </div>
        </div>
        <div className="p-2 bg-secondary/50 rounded">
          <div className="text-[10px] text-muted-foreground">Sharpe</div>
          <div
            className={`font-bold text-lg ${
              perf.sharpeRatio >= 1
                ? "text-emerald-400"
                : perf.sharpeRatio >= 0
                ? "text-yellow-400"
                : "text-red-400"
            }`}
          >
            {perf.sharpeRatio}
          </div>
          <div className="text-[10px] text-muted-foreground">
            PF: {perf.profitFactor} | Exp: ₹{perf.expectancy}
          </div>
        </div>
      </div>

      {/* ═══ RISK METRICS ═══ */}
      <div className="grid grid-cols-4 gap-2">
        <div className="p-2 bg-secondary/30 rounded">
          <div className="text-[10px] text-muted-foreground">Max Win</div>
          <div className="text-emerald-400">
            +₹{perf.maxWin.toLocaleString("en-IN")}
          </div>
        </div>
        <div className="p-2 bg-secondary/30 rounded">
          <div className="text-[10px] text-muted-foreground">Max Loss</div>
          <div className="text-red-400">
            ₹{perf.maxLoss.toLocaleString("en-IN")}
          </div>
        </div>
        <div className="p-2 bg-secondary/30 rounded">
          <div className="text-[10px] text-muted-foreground">Max Drawdown</div>
          <div className="text-red-400">
            ₹{perf.maxDrawdown.toLocaleString("en-IN")} ({perf.maxDrawdownPct}%)
          </div>
        </div>
        <div className="p-2 bg-secondary/30 rounded">
          <div className="text-[10px] text-muted-foreground">Avg Confidence</div>
          <div className="text-blue-400">{perf.avgConfidence}%</div>
          <div className="text-[10px] text-muted-foreground">
            Avg Hold: {perf.avgHoldDays}d
          </div>
        </div>
      </div>

      {/* ═══ EQUITY CURVE ═══ */}
      <div className="p-2 bg-secondary/30 rounded">
        <div className="text-[10px] text-muted-foreground mb-1 font-bold">
          EQUITY CURVE
        </div>
        <div className="flex items-end gap-px h-16">
          {result.equityCurve.map((point, i) => {
            const minEq = Math.min(
              ...result.equityCurve.map((p) => p.equity)
            );
            const maxEq = Math.max(
              ...result.equityCurve.map((p) => p.equity)
            );
            const range = maxEq - minEq || 1;
            const height =
              ((point.equity - minEq) / range) * 100;
            const isProfit = point.equity >= result.capital;
            return (
              <div
                key={i}
                className={`flex-1 min-w-[2px] rounded-t ${
                  isProfit ? "bg-emerald-500" : "bg-red-500"
                }`}
                style={{ height: `${Math.max(4, height)}%` }}
                title={`${point.date}: ₹${point.equity.toLocaleString("en-IN")}`}
              />
            );
          })}
        </div>
        <div className="flex justify-between text-[9px] text-muted-foreground mt-1">
          <span>{result.equityCurve[0]?.date}</span>
          <span>
            Start: ₹{result.capital.toLocaleString("en-IN")} → End: ₹
            {(
              result.capital + perf.totalPnL
            ).toLocaleString("en-IN")}
          </span>
          <span>{result.equityCurve[result.equityCurve.length - 1]?.date}</span>
        </div>
      </div>

      {/* ═══ SIGNAL ACCURACY ═══ */}
      <div className="grid grid-cols-2 gap-2">
        <div className="p-2 bg-secondary/30 rounded">
          <div className="text-[10px] text-muted-foreground mb-1 font-bold">
            SIGNAL ACCURACY
          </div>
          {perf.signalAccuracy.map((sa) => (
            <div key={sa.signal} className="flex justify-between text-[10px]">
              <span>{sa.signal}</span>
              <span>
                {sa.correct}/{sa.total} (
                {sa.accuracy.toFixed(1)}%)
              </span>
            </div>
          ))}
        </div>
        <div className="p-2 bg-secondary/30 rounded">
          <div className="text-[10px] text-muted-foreground mb-1 font-bold">
            MONTHLY RETURNS
          </div>
          <div className="space-y-0.5 max-h-20 overflow-auto">
            {perf.monthlyReturns.map((mr) => (
              <div key={mr.month} className="flex justify-between text-[10px]">
                <span>{mr.month}</span>
                <span
                  className={
                    mr.pnl >= 0 ? "text-emerald-400" : "text-red-400"
                  }
                >
                  {mr.pnl >= 0 ? "+" : ""}₹
                  {mr.pnl.toLocaleString("en-IN")} ({mr.trades}T,{" "}
                  {mr.winRate.toFixed(0)}% WR)
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ═══ TRADE LIST ═══ */}
      <div className="p-2 bg-secondary/30 rounded">
        <div className="text-[10px] text-muted-foreground mb-1 font-bold">
          TRADE LIST ({trades.length} trades)
        </div>
        <div className="max-h-48 overflow-auto">
          <table className="w-full text-[10px]">
            <thead className="sticky top-0 bg-secondary">
              <tr className="text-muted-foreground">
                <th className="text-left p-1">Date</th>
                <th className="text-left p-1">Type</th>
                <th className="text-right p-1">Strike</th>
                <th className="text-right p-1">Entry</th>
                <th className="text-right p-1">Exit</th>
                <th className="text-right p-1">P&L</th>
                <th className="text-right p-1">Conf</th>
                <th className="text-center p-1">Status</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} className="border-t border-border/30">
                  <td className="p-1">{t.date}</td>
                  <td className="p-1">
                    <span
                      className={
                        t.type === "CALL" ? "text-emerald-400" : "text-red-400"
                      }
                    >
                      {t.type}
                    </span>
                  </td>
                  <td className="text-right p-1">{t.strike}</td>
                  <td className="text-right p-1">₹{t.entry.toFixed(2)}</td>
                  <td className="text-right p-1">
                    ₹{t.exitPrice?.toFixed(2) || "—"}
                  </td>
                  <td
                    className={`text-right p-1 font-bold ${
                      (t.pnl || 0) >= 0 ? "text-emerald-400" : "text-red-400"
                    }`}
                  >
                    {t.pnl !== null
                      ? `${t.pnl >= 0 ? "+" : ""}₹${t.pnl.toLocaleString(
                          "en-IN"
                        )}`
                      : "—"}
                  </td>
                  <td className="text-right p-1">{t.confidence}%</td>
                  <td className="text-center p-1">
                    <span
                      className={`px-1 rounded ${
                        t.status === "WIN"
                          ? "bg-emerald-500/20 text-emerald-400"
                          : t.status === "LOSS"
                          ? "bg-red-500/20 text-red-400"
                          : "bg-yellow-500/20 text-yellow-400"
                      }`}
                    >
                      {t.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ═══ BEST/WORST ═══ */}
      <div className="grid grid-cols-2 gap-2">
        <div className="p-2 bg-emerald-500/5 border border-emerald-500/20 rounded">
          <div className="text-[10px] text-emerald-400 font-bold">
            BEST DAY
          </div>
          <div>
            {perf.bestDay.date}:{" "}
            <span className="text-emerald-400">
              +₹{perf.bestDay.pnl.toLocaleString("en-IN")}
            </span>
          </div>
        </div>
        <div className="p-2 bg-red-500/5 border border-red-500/20 rounded">
          <div className="text-[10px] text-red-400 font-bold">WORST DAY</div>
          <div>
            {perf.worstDay.date}:{" "}
            <span className="text-red-400">
              ₹{perf.worstDay.pnl.toLocaleString("en-IN")}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
