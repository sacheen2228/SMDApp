// Backtest Report — simulate trade outcomes across 1-25 lots
// Shows PnL matrix, risk metrics, and lot-size optimization

"use client";

import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Shield,
  AlertTriangle,
  Calculator,
} from "lucide-react";

interface BacktestProps {
  trades: any[];
  symbol: string;
}

interface SimResult {
  lots: number;
  totalQty: number;
  totalPnL: number;
  maxDrawdown: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  expectancy: number;
  riskOfRuin: number;
  kellyPct: number;
}

function getLotSize(symbol: string): number {
  const map: Record<string, number> = {
    NIFTY: 75,
    BANKNIFTY: 35,
    FINNIFTY: 40,
    MIDCPNIFTY: 100,
    SENSEX: 20,
  };
  return map[symbol] || 75;
}

function simulateLots(
  closedTrades: any[],
  lotSize: number,
  lots: number
): SimResult {
  const qty = lotSize * lots;
  let totalPnL = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let wins = 0;
  let losses = 0;
  let totalWin = 0;
  let totalLoss = 0;

  for (const t of closedTrades) {
    const pnl = (t.pnl ?? 0) * (lots); // pnl is per-lot from tracker
    totalPnL += pnl;
    if (totalPnL > peak) peak = totalPnL;
    const dd = peak - totalPnL;
    if (dd > maxDrawdown) maxDrawdown = dd;

    if (pnl > 0) {
      wins++;
      totalWin += pnl;
    } else if (pnl < 0) {
      losses++;
      totalLoss += Math.abs(pnl);
    }
  }

  const total = wins + losses;
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  const avgWin = wins > 0 ? totalWin / wins : 0;
  const avgLoss = losses > 0 ? totalLoss / losses : 0;
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 99 : 0;
  const expectancy = total > 0 ? totalPnL / total : 0;

  // Kelly criterion
  const winProb = winRate / 100;
  const lossProb = 1 - winProb;
  const b = avgLoss > 0 ? avgWin / avgLoss : 0;
  const kelly = b > 0 ? ((winProb * b - lossProb) / b) * 100 : 0;

  // Risk of ruin (simplified)
  const riskOfRuin =
    winRate > 50
      ? Math.max(0, Math.pow((1 - winRate / 100) / (winRate / 100), lots * 2) * 100)
      : 50;

  return {
    lots,
    totalQty: qty,
    totalPnL: Math.round(totalPnL),
    maxDrawdown: Math.round(maxDrawdown),
    winRate: Math.round(winRate * 10) / 10,
    avgWin: Math.round(avgWin),
    avgLoss: Math.round(avgLoss),
    profitFactor: Math.round(profitFactor * 100) / 100,
    expectancy: Math.round(expectancy),
    riskOfRuin: Math.round(Math.min(100, riskOfRuin)),
    kellyPct: Math.round(Math.min(50, Math.max(0, kelly)) * 10) / 10,
  };
}

export function BacktestReport({ trades, symbol }: BacktestProps) {
  const lotSize = getLotSize(symbol);
  const [selectedLots, setSelectedLots] = useState<number | null>(null);

  const closedTrades = useMemo(
    () =>
      trades.filter(
        (t) =>
          t.status === "tp_hit" ||
          t.status === "sl_hit" ||
          t.pnl !== 0
      ),
    [trades]
  );

  const results = useMemo(() => {
    if (closedTrades.length === 0) return [];
    return Array.from({ length: 25 }, (_, i) =>
      simulateLots(closedTrades, lotSize, i + 1)
    );
  }, [closedTrades, lotSize]);

  const optimal = useMemo(() => {
    if (results.length === 0) return null;
    // Find lots with best expectancy and acceptable risk
    return results.reduce((best, r) => {
      if (r.riskOfRuin > 20) return best;
      if (!best) return r;
      if (r.expectancy > best.expectancy) return r;
      return best;
    }, results[0] || null);
  }, [results]);

  if (closedTrades.length === 0) {
    return (
      <Card className="border-border/50">
        <CardContent className="p-4 text-center">
          <Calculator className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No closed trades to backtest</p>
          <p className="text-[10px] text-muted-foreground mt-1">
            Take some trades to see the backtest report
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/50">
      <CardContent className="p-3 space-y-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-cyan-500" />
          <span className="text-xs font-bold">Backtest Report</span>
          <Badge variant="outline" className="text-[8px] text-muted-foreground">
            {closedTrades.length} trades | Lot: {lotSize}
          </Badge>
        </div>

        {/* Optimal Recommendation */}
        {optimal && (
          <div className="rounded-lg bg-cyan-500/5 border border-cyan-500/20 p-2.5 space-y-1">
            <div className="flex items-center gap-1.5">
              <Shield className="h-3.5 w-3.5 text-cyan-500" />
              <span className="text-[10px] font-bold text-cyan-500">OPTIMAL LOT SIZE</span>
            </div>
            <div className="flex items-baseline gap-3">
              <span className="text-2xl font-black text-cyan-500">{optimal.lots}</span>
              <span className="text-xs text-muted-foreground">lots ({optimal.totalQty} qty)</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[10px]">
              <div>
                <p className="text-muted-foreground">PnL</p>
                <p className={`font-bold ${optimal.totalPnL >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                  {optimal.totalPnL >= 0 ? "+" : ""}₹{optimal.totalPnL.toLocaleString("en-IN")}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Win Rate</p>
                <p className="font-bold">{optimal.winRate}%</p>
              </div>
              <div>
                <p className="text-muted-foreground">Risk of Ruin</p>
                <p className={`font-bold ${optimal.riskOfRuin > 10 ? "text-red-500" : "text-emerald-500"}`}>
                  {optimal.riskOfRuin}%
                </p>
              </div>
            </div>
          </div>
        )}

        {/* PnL Matrix — 1 to 25 lots */}
        <div className="space-y-1.5">
          <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">
            PnL by Lot Size
          </div>
          <div className="overflow-x-auto">
            <div className="grid grid-cols-5 gap-1 min-w-[200px]">
              {results.map((r) => {
                const isSelected = selectedLots === r.lots;
                const isOpt = optimal?.lots === r.lots;
                return (
                  <button
                    key={r.lots}
                    onClick={() => setSelectedLots(isSelected ? null : r.lots)}
                    className={`rounded-md p-1.5 text-center border transition-all ${
                      isSelected
                        ? "border-cyan-500 bg-cyan-500/10"
                        : isOpt
                          ? "border-cyan-500/30 bg-cyan-500/5"
                          : "border-border/50 hover:border-border"
                    }`}
                  >
                    <p className="text-[8px] text-muted-foreground">{r.lots}L</p>
                    <p className={`text-[10px] font-bold tabular-nums ${
                      r.totalPnL > 0 ? "text-emerald-500" : r.totalPnL < 0 ? "text-red-500" : "text-muted-foreground"
                    }`}>
                      {r.totalPnL >= 0 ? "+" : ""}{r.totalPnL >= 1000 ? `${(r.totalPnL / 1000).toFixed(1)}K` : r.totalPnL}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Selected Lot Detail */}
        {selectedLots && (() => {
          const r = results[selectedLots - 1];
          if (!r) return null;
          return (
            <div className="rounded-lg border border-border/50 p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold">{r.lots} Lot{r.lots > 1 ? "s" : ""} ({r.totalQty} qty)</span>
                {optimal?.lots === r.lots && (
                  <Badge className="text-[8px] bg-cyan-500/20 text-cyan-500 border-cyan-500/30">OPTIMAL</Badge>
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total PnL</span>
                  <span className={`font-bold ${r.totalPnL >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                    {r.totalPnL >= 0 ? "+" : ""}₹{r.totalPnL.toLocaleString("en-IN")}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Max Drawdown</span>
                  <span className="font-bold text-red-500">-₹{r.maxDrawdown.toLocaleString("en-IN")}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Win Rate</span>
                  <span className="font-bold">{r.winRate}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Profit Factor</span>
                  <span className={`font-bold ${r.profitFactor >= 1.5 ? "text-emerald-500" : r.profitFactor >= 1 ? "text-yellow-500" : "text-red-500"}`}>
                    {r.profitFactor}x
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Avg Win</span>
                  <span className="font-bold text-emerald-500">+₹{r.avgWin}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Avg Loss</span>
                  <span className="font-bold text-red-500">-₹{r.avgLoss}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Expectancy</span>
                  <span className={`font-bold ${r.expectancy >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                    ₹{r.expectancy}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Kelly %</span>
                  <span className="font-bold text-cyan-500">{r.kellyPct}%</span>
                </div>
                <div className="flex justify-between col-span-2">
                  <span className="text-muted-foreground">Risk of Ruin</span>
                  <span className={`font-bold ${r.riskOfRuin > 20 ? "text-red-500" : r.riskOfRuin > 10 ? "text-yellow-500" : "text-emerald-500"}`}>
                    {r.riskOfRuin}%
                  </span>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Risk Legend */}
        <div className="flex items-center gap-3 text-[8px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-emerald-500/60" /> Low Risk (&lt;5%)</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-yellow-500/60" /> Medium (5-20%)</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-red-500/60" /> High (&gt;20%)</span>
        </div>
      </CardContent>
    </Card>
  );
}
